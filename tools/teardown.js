// tower_teardown — remove eligible mission worktrees.
// 
// Input: TeardownInput (dryRun, force, exclude) from contracts.
// Output: removed/kept decisions for every mission.
// Authorization: tower only; live agents always keep their worktree.
// Side effects: removes worktrees/branches, persists activity.
// Failure modes: dirty without force, branch delete failure.
// Pure eligibility decisions live in domain/integration.
// See docs/reference/tools.generated.md for the public shape.
// tower_teardown: remove eligible mission worktrees.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TeardownInput } from '../domain/contracts/tool-inputs/index.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, actorFor: any, requireTowerActor: any, observeActivity: any }} deps
 */
export function registerTeardownTool(ctx, deps) {
  const { define, actorFor, requireTowerActor, observeActivity } = deps
  define(ctx, {
    name: 'tower_teardown',
    description:
      'Remove eligible merged/abandoned mission worktrees. A running agent is always kept; dirty worktrees need force; exclude skips named missions; dry_run previews. Due terminal missions are archived under dsh-tower/archive, never deleted.',
    parameters: TeardownInput,
    aliases: {"dry_run":["dryRun"]},
    board: true,
    output: output(SCHEMAS.teardown),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'tear down worktrees')
      const { activity } = await observeActivity(ctx, tower)
      return tower.teardown({
        force: args.force === true,
        exclude: args.exclude,
        dryRun: args.dry_run === true,
        activity,
      })
    },
  })
}
