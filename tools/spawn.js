// tower_spawn: provision and start a worker/reviewer.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError, classifyError } from '../domain/errors.js'
import { SpawnInput } from '../domain/contracts/tool-inputs/index.js'
import { defaultPresetFor, shapeFor } from '../domain/shapes/index.js'
import { DEFAULT_ROLE, ROLES as ROLE_ENUM, SPAWN_OUTCOME, isCompletedStopReason, isSpawnAdmission } from '../domain/vocabulary.js'
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
      'Spawn a worker or reviewer for a mission. Workers use the mission shape\'s preset (tower-worker for a build, tower-survey for a read-only shared survey, tower-survey-sandbox for a detached survey with survey.sandbox=detached); reviewers require a completed build mission and use the read-only tower-reviewer preset, and the reviewer role is refused when review.mode is off. A build provisions (or reuses) the mission git worktree and branch; a shared survey runs in the shared checkout because it reads one commit; a detached survey provisions (or reuses) a disposable detached worktree at its readCommit with no branch. Generates a self-contained briefing (including dependency survey result evidence) and starts a background subagent. The child final report is delivered back to this session; tower_roster shows authoritative activity. Records the agent in the roster; reviewer spawns get a disposable detached checkout at the recorded branch tip, and the verdict is stamped with that commit (never a live worktree HEAD). Returns immediately unless wait=true.', parameters: SpawnInput,
    aliases: {"missionId":["id"],"waitMs":["wait_ms"]},
    requiresMissionId: true, board: true, output: output(SCHEMAS.spawn),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'spawn tower agents')
      const role = args.role ?? DEFAULT_ROLE
      if (!ROLE_ENUM.includes(role)) throw new TowerToolError('invalid-argument', `role must be one of ${ROLE_ENUM.join('|')}`)
      // Repository config (if any) already overrides the profile config here.
      const config = tower.config
      const context = await tower.missionContext(args.missionId)
      assertSpawnableMission({ role, context, config })
      const shape = shapeFor(context.mission.kind)
      // #148 W2: the shape resolves its preset from tuning config, so a detached
      // survey gets the sandbox preset and a shared survey stays read-only.
      // #149 W4: role resolution (preset row, model route, placement, briefing)
      // is one contract, orthogonal to the shape that supplies the facts.
      const shapePreset = defaultPresetFor(context.mission.kind, config, context.mission)
      const roleSpawn = resolveRoleSpawn(role, { config, shape, shapePreset })
      if (!roleSpawn) throw new TowerToolError('invalid-argument', `role must be one of ${ROLE_ENUM.join('|')}`)
      const preset = roleSpawn.preset
      const model = roleSpawn.model
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
        const takeover = await precheckWorkerOwnership({ role, tower, ctx, view, missionId: args.missionId, takeover: args.takeover, maxLiveWorkers: config.spawn.maxLiveWorkers, budget: backoff.budget, observeActivity })
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

        let activation = null
        let agentId = null
        let entry = null
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
        requestedWaitMs: args.waitMs ?? 180000,
        textOf,
      })
    },
  })
}
