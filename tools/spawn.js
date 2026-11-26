// tower_spawn: provision and start a worker/reviewer.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
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
import {
  SPAWN_PHASE_PENDING,
  activateAndRecordSpawn,
  buildAgentOptions,
  createSpawnPreflightRecorder,
  provisionSpawnPlacement,
  waitForSpawnResult,
  withSpawnDeadline,
} from '../app/spawn-support.js'
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
      /** @type {any} */
      let tower = null
      const missionId = /** @type {string} */ (args.missionId)
      // #237: one activity line per phase, never per poll — see the recorder.
      const preflight = createSpawnPreflightRecorder({ missionId })
      // #237: every phase of the pre-flight runs under ONE deadline, and the
      // deadline is retuned to `spawn.preflightTimeoutMs` the moment the
      // repository config resolves. The abort signal is forwarded to the reads
      // that accept one, but the deadline does not depend on cooperation: a read
      // that ignores its signal still cannot hold the caller.
      return withSpawnDeadline({
        signal: exec.signal,
        phase: SPAWN_PHASE_PENDING,
        onPhase: preflight.onPhase,
        // A caller stuck in the queue is reported as `queue`, with the wait and
        // the depth it saw — not as the phase the previous spawn reached.
        details: preflight.details,
        run: async ({ signal, reach, retune }) => {
          reach('open')
          tower = await deps.openTower(args.repoRoot)
          preflight.attach(tower)
          reach('resolve')
          const actor = await actorFor(tower, exec)
          requireTowerActor(actor, 'spawn tower agents')
          // #215: refuse a checkout that is not state.base before provisioning.
          await tower.assertBaseCheckout('tower_spawn')
          const role = args.role ?? DEFAULT_ROLE
          // Repository config (if any) already overrides the profile config here.
          const config = tower.config
          // #237: the bound the caller configured applies from here on, including
          // the provisioning and activation phases below — not just the reads.
          retune(config.spawn?.preflightTimeoutMs)
          const context = await tower.missionContext(missionId)
          assertSpawnableMission({ role, context, config })
          const shape = shapeFor(context.mission.kind)
          // #148/#149: the shape resolves its preset from config; role resolution (row,
          // model route, placement, briefing) is one contract orthogonal to the facts.
          const shapePreset = defaultPresetFor(context.mission.kind, config, context.mission)
          const roleSpawn = resolveRoleSpawn(role, { config, shape, shapePreset })
          if (!roleSpawn) throw new TowerToolError('invalid-argument', `role must be one of ${ROLE_ENUM.join('|')}`)
          const { preset, model } = roleSpawn
          // #237: the pre-flight awaits the same queue every other spawn awaits, so
          // the queue is part of the bound: a call that cannot get the slot within
          // the deadline fails as `spawn-unavailable` `phase: 'queue'` instead of
          // running its pre-flight late against a state it no longer describes.
          reach('queue')
          const spawned = await enqueueSpawn(tower.root, async () => {
            reach('observe')
            const observed = await observeActivity(ctx, tower, { signal })
            await tower.reconcileObservedInactive(observed.activity)
            const backoff = spawnBackoffState(tower.root, config.spawn.maxLiveWorkers)
            if (backoff.blockedUntil > Date.now()) {
              const seconds = Math.ceil((backoff.blockedUntil - Date.now()) / 1000)
              throw new TowerToolError('provider-cooldown', `provider cooldown active; retry in ${seconds}s (${backoff.failures} recent failures)`)
            }
            reach('roster')
            const view = await tower.rosterView()
            const name = resolveRosterName({ role, missionId, requested: args.name, roster: view.roster })
            const replacing = args.op === SPAWN_OP.takeover
            reach('ownership')
            const takeover = await precheckWorkerOwnership({
              role, tower, ctx, view, missionId, takeover: replacing,
              maxLiveWorkers: config.spawn.maxLiveWorkers, budget: backoff.budget, observeActivity, signal,
            })
            reach('services')
            const { subagents, provider } = await precheckSpawnServices({
              tower, ctx, config, preset, actor, exec, inspectLeases: deps.inspectLeases,
              // #131: the app layer only needs the row fact; the root owns the registry.
              leaseComponent: deps.leaseComponent,
            })
            reach('provision')
            const { mission, worktree, cwd, branch, review, briefing, provisioning, created, sandbox } = await provisionSpawnPlacement(tower, {
              role,
              context,
              missionId,
              name,
              worktreeRoot: args.worktreeRoot,
              includeDirtyBase: args.includeDirtyBase,
              instructions: args.instructions,
            })
            const agentOptions = buildAgentOptions(model)
            reach('discovery')
            if (roleSpawnDiscovery(role, shape) && isSpawnAdmission(tower.config.tests?.admission)) {
              const discovery = await runMissionDiscovery(tower, mission)
              if (discovery.configured && discovery.receipt.ok !== true) {
                throw new TowerToolError(
                  'tests-failed',
                  `test admission failed for ${mission.id}: ${discovery.receipt.error}; no child was started`,
                )
              }
            }
            return activateAndRecordSpawn({
              tower, subagents, provider, preset, name, exec, briefing, cwd, branch, review,
              mission, role, config, agentOptions, takeover, worktree, sandbox,
              provisioning, created, reach, recordSpawnSuccess, recordSpawnThrottle,
            })
          }, {
            timeoutMs: config.spawn?.preflightTimeoutMs,
            onQueue: preflight.onQueue,
            onWait: preflight.onWait,
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
    },
  })
}
