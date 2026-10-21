// tower_test: run declared worktree test discovery.
import { Tower } from '../tower.js'
import { SCHEMAS, output } from '../schemas.js'
import { TowerToolError } from '../errors.js'

export function registerTestTool(ctx, deps) {
  const { define, actorFor, requireKnownActor, runMissionDiscovery } = deps
  define(ctx, {
    name: 'tower_test',
    description:
      'Run the mission worktree\'s declared tower.testDiscovery (package.json) and record the receipt. Returns ok:false with diagnostics when discovery fails; does not change mission status. Use tower_complete for automatic admission checks.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missionId: { type: 'string', description: 'Mission id, e.g. M1 (alias: id).' },
        id: { type: 'string', description: 'Alias for missionId.' },
      },
      required: ['repoRoot', 'missionId'],
      additionalProperties: false,
    },
    aliases: { missionId: ['id'] },
    requiresMissionId: true,
    output: output(SCHEMAS.test),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireKnownActor(actor, 'tower_test')
      const context = await tower.missionContext(args.missionId)
      if (!context.mission.worktree) throw new TowerToolError('invalid-transition', `mission ${args.missionId} has no worktree`)
      if (actor.role === 'reviewer') throw new TowerToolError('not-authorized', 'reviewers may not run test discovery')
      if (actor.role === 'worker' && context.mission.owner && context.mission.owner !== actor.name) {
        throw new TowerToolError('not-authorized', `worker ${actor.name} does not own mission ${args.missionId}`)
      }
      await tower.assertWorktree(context.mission.worktree)
      const discovery = await runMissionDiscovery(tower, context.mission)
      if (!discovery.configured) {
        return {
          ok: false,
          configured: false,
          error: discovery.error ?? 'tower.testDiscovery is not configured in the worktree package.json',
          tests: [],
          commands: [],
        }
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
