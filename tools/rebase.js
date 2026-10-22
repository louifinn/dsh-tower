// A clean rebase may waive re-review by binding the old reviewed tip.
// tower_rebase — rebase a mission branch onto the base.
// 
// Input: RebaseInput (missionId/id) from domain contracts.
// Output: old/new tips, base tip, review-waiver decision.
// Authorization: tower only; ownership and cleanliness are checked.
// Side effects: git rebase, abort/cleanup, state/activity writes.
// Failure modes: conflict, stale-base, tip-moved, dirty worktree.
// Pure intent/waiver decisions live in domain/integration.
// See docs/reference/tools.generated.md for the public shape.
// tower_rebase: rebase a mission branch inside its worktree.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { RebaseInput } from '../domain/contracts/tool-inputs/index.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, actorFor: any, requireTowerActor: any, observeActivity: any }} deps
 */
export function registerRebaseTool(ctx, deps) {
  // openTower is injected by the composition root (#69).
  const { define, actorFor, requireTowerActor, observeActivity } = deps
  define(ctx, {
    name: 'tower_rebase',
    description:
      'Rebase a mission branch onto the current base tip inside its own worktree. Refuses while its worker is running or the worktree is dirty. A clean conflict-free rebase waives re-review for the old review; a conflict is aborted and the mission is marked blocked. If the branch is already contained in the base, it returns alreadyMerged and leaves the branch untouched so tower_merge can record the landed merge.',
    parameters: RebaseInput,
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    board: true,
    output: output(SCHEMAS.rebase),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'rebase missions')
      const { activity } = await observeActivity(ctx, tower)
      return tower.rebase({ missionId: args.missionId, activity })
    },
  })
}
