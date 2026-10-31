// tower_test: run declared worktree test discovery.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { TestInput } from '../domain/contracts/tool-inputs/index.js'
import { isReviewerRole, isWorkerRole } from '../domain/vocabulary.js'

/**
 * @param {any} ctx
 * @param {{
 *   define: import('../types/index.js').DefineTool,
 *   openTower: any,
 *   actorFor: any,
 *   requireKnownActor: any,
 *   runMissionDiscovery: any,
 * }} deps
 */
export function registerTestTool(ctx, deps) {
  const { define, actorFor, requireKnownActor, runMissionDiscovery } = deps
  define(ctx, {
    name: 'tower_test',
    description:
      'Run the mission worktree\'s declared tower.testDiscovery (package.json) and record the receipt. Returns ok:false with diagnostics when discovery fails; does not change mission status. Use tower_complete for automatic admission checks.',
    parameters: TestInput,
    aliases: { missionId: ['id'] },
    requiresMissionId: true,
    output: output(SCHEMAS.test),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireKnownActor(actor, 'tower_test')
      const context = await tower.missionContext(args.missionId)
      if (!context.mission.worktree) throw new TowerToolError('invalid-transition', `mission ${args.missionId} has no worktree`)
      if (isReviewerRole(actor.role)) throw new TowerToolError('not-authorized', 'reviewers may not run test discovery')
      if (isWorkerRole(actor.role) && context.mission.owner && context.mission.owner !== actor.name) {
        throw new TowerToolError('not-authorized', `worker ${actor.name} does not own mission ${args.missionId}`)
      }
      await tower.assertWorktree(context.mission.worktree)
      const discovery = await runMissionDiscovery(tower, context.mission)
      if (!discovery.configured) {
        // #136: the `tower-tests` row is the switch. When the row is off, say so
        // and say how to turn it back on; never report the repository as
        // "not configured" for a component cause.
        const error = discovery.disabledBy
          ? `test discovery is unavailable: ${discovery.reason ?? `disabled by component ${discovery.disabledBy}`}; enable the ${discovery.disabledBy} component in the plugin page and restart DSH`
          : discovery.error ?? 'tower.testDiscovery is not configured in the worktree package.json'
        return { ok: false, configured: false, error, tests: [], commands: [] }
      }
      const receipt = discovery.receipt
      return {
        ok: receipt.ok === true,
        configured: true,
        treeTip: receipt.treeTip ?? null,
        tests: receipt.tests ?? [],
        commands: receipt.commands ?? [],
        error: receipt.error ?? undefined,
        receipt,
        checks: discovery.check ? [discovery.check] : [],
      }
    },
  })
}
