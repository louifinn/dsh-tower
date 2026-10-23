// tower_spawn: provision and start a worker/reviewer.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError, classifyError } from '../domain/errors.js'
import { SpawnInput } from '../domain/contracts/tool-inputs/index.js'
import { DEFAULT_ROLE, ROLES as ROLE_ENUM, SPAWN_OUTCOME, isCompletedStopReason, isReviewerRole, isSpawnAdmission, isWorkerRole } from '../domain/vocabulary.js'
import {
  assertSpawnableMission,
  precheckSpawnServices,
  precheckWorkerOwnership,
  resolveRosterName,
} from '../app/spawn-prechecks.js'
import { buildAgentOptions, buildSpawnBriefing, waitForSpawnResult } from '../app/spawn-support.js'

/**
 * @param {any} ctx
 * @param {{
 *   define: import('../types/index.js').DefineTool,
 *   openTower: any,
 *   actorFor: any,
 *   requireTowerActor: any,
 *   enqueueSpawn: any,
 *   observeActivity: any,
 *   spawnBackoffState: any,
 *   recordSpawnThrottle: any,
 *   recordSpawnSuccess: any,
 *   runMissionDiscovery: any,
 *   textOf: any,
 *   inspectLeases: any,
 * }} deps
 */
export function registerSpawnTool(ctx, deps) {
  const {
    define, actorFor, requireTowerActor, enqueueSpawn, observeActivity,
    spawnBackoffState, recordSpawnThrottle, recordSpawnSuccess,
    runMissionDiscovery, textOf,
  } = deps
  define(ctx, {
    name: 'tower_spawn',
    description:
      'Spawn a worker or reviewer for a mission. Workers use the tower-worker preset; reviewers require a completed mission and use the read-only tower-reviewer preset. Provisions (or reuses) the mission git worktree and branch, generates a self-contained briefing, and starts a background subagent in that worktree. The child final report is delivered back to this session; tower_roster shows authoritative activity. Records the agent in the roster; reviewer spawns record the branch tip so a reviewer that modifies the branch cannot submit a review. Returns immediately unless wait=true.',
    parameters: SpawnInput,
    aliases: {"missionId":["id"],"waitMs":["wait_ms"]},
    requiresMissionId: true,
    board: true,
    output: output(SCHEMAS.spawn),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'spawn tower agents')
      const role = args.role ?? DEFAULT_ROLE
      if (!ROLE_ENUM.includes(role)) throw new TowerToolError('invalid-argument', `role must be one of ${ROLE_ENUM.join('|')}`)
      // Repository config (if any) already overrides the profile config here.
      const config = tower.config
      const preset = isReviewerRole(role) ? config.spawn.reviewerPreset : config.spawn.workerPreset
      const model = isReviewerRole(role) ? config.spawn.reviewerModel : config.spawn.workerModel
      const context = await tower.missionContext(args.missionId)
      assertSpawnableMission({ role, context })
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
        const takeover = await precheckWorkerOwnership({
          role, tower, ctx, view, missionId: args.missionId, takeover: args.takeover,
          maxLiveWorkers: config.spawn.maxLiveWorkers, budget: backoff.budget, observeActivity,
        })
        const { subagents, provider } = await precheckSpawnServices({
          tower, ctx, config, preset, actor, exec, inspectLeases: deps.inspectLeases,
        })

        const provisioned = await tower.provision({
          missionId: args.missionId,
          worktreeRoot: args.worktreeRoot,
          includeDirtyBase: args.includeDirtyBase !== false,
        })
        const { mission, worktree } = provisioned
        const briefing = buildSpawnBriefing({ role, towerRoot: tower.root, context, worktree, instructions: args.instructions })
        const agentOptions = buildAgentOptions(model)

        if (isWorkerRole(role) && isSpawnAdmission(tower.config.tests?.admission)) {
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
          cwd: worktree.path,
          branch: worktree.branch,
        })
        try {
          activation = await subagents.startActivation({
            provider,
            label: name,
            request: {
              cwd: worktree.path,
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
            cwd: worktree.path,
            branch: worktree.branch,
            takeover,
          })
          recordSpawnSuccess(tower.root, config.spawn.maxLiveWorkers)
        } catch (error) {
          if (classifyError(error).retryable === true) {
            recordSpawnThrottle(tower.root, config.spawn.maxLiveWorkers)
          }
          // The child may already be running even when recordSpawn failed: stop
          // it and mark the reserved entry failed so it cannot keep writing
          // unobserved.
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
          worktree: { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit },
          created: provisioned.created,
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
