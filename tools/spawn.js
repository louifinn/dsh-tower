// tower_spawn: provision and start a worker/reviewer.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError, classifyError } from '../domain/errors.js'
import { SpawnInput } from '../domain/contracts/tool-inputs/index.js'
import { defaultPresetFor, shapeFor } from '../domain/shapes/index.js'
import { DEFAULT_ROLE, ROLES as ROLE_ENUM, SPAWN_OP, SPAWN_OUTCOME, isCompletedStopReason, isSpawnAdmission } from '../domain/vocabulary.js'
import { resolveRoleSpawn, roleSpawnDiscovery } from '../domain/roles.js'
import {
  assertSpawnableMission,
  precheckSpawnServices,
  precheckWorkerOwnership,
  resolveRosterName,
} from '../app/spawn-prechecks.js'
import { buildAgentOptions, provisionSpawnPlacement, waitForSpawnResult } from '../app/spawn-support.js'
import { cleanupReviewCheckout } from '../app/reviewCheckout.js'
/** @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, [key: string]: any }} deps */
export function registerSpawnTool(ctx, deps) {
  const { define, actorFor, requireTowerActor, enqueueSpawn, observeActivity, spawnBackoffState, recordSpawnThrottle, recordSpawnSuccess, runMissionDiscovery, textOf } = deps
  define(ctx, {
    name: 'tower_spawn',
    description:
      'Spawn a worker, survey, or reviewer for a mission (op: spawn, default), or replace a stale live worker entry (op: takeover). Returns when the agent is recorded; wait=true waits for the result. Details: docs/reference/tools.md.', parameters: SpawnInput,
    aliases: { missionId: ['id'] },
    requiresMissionId: true,
    board: true,
    output: output(SCHEMAS.spawn),
    validateArgs(args) {
      const legacy = /** @type {any} */ (args)
      if (legacy.takeover !== undefined) {
        throw new TowerToolError('invalid-argument', 'tower_spawn no longer takes takeover; pass op: "takeover" to replace a live worker entry that is no longer running')
      }
      if (legacy.waitMs !== undefined) {
        throw new TowerToolError('invalid-argument', 'tower_spawn no longer takes waitMs; wait time is bounded by the spawn.maxWaitMs config (default 90000)')
      }
    },
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'spawn tower agents')
      const role = args.role ?? DEFAULT_ROLE
      // Repository config (if any) already overrides the profile config here.
      const config = tower.config
      const context = await tower.missionContext(args.missionId)
      assertSpawnableMission({ role, context, config })
      const shape = shapeFor(context.mission.kind)
      // #148/#149: the shape resolves its preset from config; role resolution (row,
      // model route, placement, briefing) is one contract orthogonal to the facts.
      const shapePreset = defaultPresetFor(context.mission.kind, config, context.mission)
      const roleSpawn = resolveRoleSpawn(role, { config, shape, shapePreset })
      if (!roleSpawn) throw new TowerToolError('invalid-argument', `role must be one of ${ROLE_ENUM.join('|')}`)
      const { preset, model } = roleSpawn
      const spawned = await enqueueSpawn(tower.root, async () => {
        const observed = await observeActivity(ctx, tower)
        await tower.reconcileObservedInactive(observed.activity)
        const backoff = spawnBackoffState(tower.root, config.spawn.maxLiveWorkers)
        if (backoff.blockedUntil > Date.now()) {
          const seconds = Math.ceil((backoff.blockedUntil - Date.now()) / 1000)
          throw new TowerToolError('provider-cooldown', `provider cooldown active; retry in ${seconds}s (${backoff.failures} recent failures)`)
        }
        const view = await tower.rosterView()
        const name = resolveRosterName({ role, missionId: args.missionId, requested: args.name, roster: view.roster })
        const replacing = args.op === SPAWN_OP.takeover
        const takeover = await precheckWorkerOwnership({ role, tower, ctx, view, missionId: args.missionId, takeover: replacing, maxLiveWorkers: config.spawn.maxLiveWorkers, budget: backoff.budget, observeActivity })
        const { subagents, provider } = await precheckSpawnServices({
          tower, ctx, config, preset, actor, exec, inspectLeases: deps.inspectLeases,
          // #131: the app layer only needs the row fact; the root owns the registry.
          leaseComponent: deps.leaseComponent,
        })
        const { mission, worktree, cwd, branch, review, briefing, provisioning, created, sandbox } = await provisionSpawnPlacement(tower, {
          role,
          context,
          missionId: /** @type {string} */ (args.missionId),
          name,
          worktreeRoot: args.worktreeRoot,
          includeDirtyBase: args.includeDirtyBase,
          instructions: args.instructions,
        })
        const agentOptions = buildAgentOptions(model)
        if (roleSpawnDiscovery(role, shape) && isSpawnAdmission(tower.config.tests?.admission)) {
          const discovery = await runMissionDiscovery(tower, mission)
          if (discovery.configured && discovery.receipt.ok !== true) {
            throw new TowerToolError(
              'tests-failed',
              `test admission failed for ${mission.id}: ${discovery.receipt.error}; no child was started`,
            )
          }
        }
        let activation = null, agentId = null, entry = null
        await tower.reserveRoster({
          missionId: mission.id,
          name,
          role,
          parentSessionId: String(exec.agent.id),
          cwd,
          branch,
          reviewCommit: review?.commit,
          reviewCheckout: review?.path,
        })
        try {
          activation = await subagents.startActivation({
            provider,
            label: name,
            request: {
              cwd,
              agentPreset: preset,
              prompt: [{ type: 'text', text: briefing }],
              parent: exec.agent,
              maxDepth: config.spawn.maxDepth ?? 1,
              ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
            },
            signal: exec.signal,
            delivery: 'parent',
          })
          agentId = String(activation.childId)
          entry = await tower.recordSpawn({
            missionId: mission.id,
            name,
            role,
            agentId,
            parentSessionId: String(exec.agent.id),
            cwd,
            branch,
            reviewCommit: review?.commit,
            reviewCheckout: review?.path,
            takeover,
          })
          recordSpawnSuccess(tower.root, config.spawn.maxLiveWorkers)
        } catch (error) {
          if (classifyError(error).retryable === true) {
            recordSpawnThrottle(tower.root, config.spawn.maxLiveWorkers)
          }
          // The child may already be running: stop it and fail the reserved entry.
          if (agentId) {
            try {
              await Promise.resolve(subagents.interrupt(agentId, { kind: 'ancestor', agent: exec.agent }))
            } catch {
              // best effort; the error below is the actionable one
            }
          }
          await tower
            .recordSpawnOutcome({
              missionId: mission.id,
              name,
              state: SPAWN_OUTCOME.failed,
              detail: `spawn failed${agentId ? ` after activation ${agentId}` : ' before activation'}: ${String(error?.message ?? error).slice(0, 300)}`,
            })
            .catch(() => {})
          // A failed review spawn must not leak its detached evidence checkout.
          if (review) {
            await cleanupReviewCheckout(tower, { name, missionId: mission.id }).catch(() => {})
          }
          throw error
        }
        const recordOutcome = (state, detail) =>
          tower.recordSpawnOutcome({ missionId: mission.id, name, state, detail }).catch(() => {})

        const report = {
          name,
          agentId,
          role,
          missionId: mission.id,
          preset,
          provider,
          maxDepth: config.spawn.maxDepth ?? 1,
          ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
          worktree: worktree ? { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit } : null,
          sandbox,
          review: review ? { commit: review.commit, checkout: review.path } : null,
          provisioning,
          created,
          briefingChars: briefing.length,
          takeover,
          rosterEntry: entry,
        }

        return { report, activation, recordOutcome }
      })
      const { report, activation, recordOutcome } = spawned
      if (args.wait !== true) {
        activation.result
          .then((result) => {
            const state = isCompletedStopReason(result?.stopReason) ? SPAWN_OUTCOME.inactive : SPAWN_OUTCOME.failed
            return recordOutcome(state, result?.diagnostic ?? result?.stopReason ?? null)
          })
          .catch((error) => recordOutcome(SPAWN_OUTCOME.failed, String(error?.message ?? error)))
        return report
      }
      return waitForSpawnResult({
        activation,
        report,
        recordOutcome,
        maxWaitMs: config.spawn.maxWaitMs ?? 90000,
        requestedWaitMs: undefined,
        textOf,
      })
    },
  })
}
