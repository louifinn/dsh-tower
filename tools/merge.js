// The merge command uses the exact reviewed commit, never a mutable branch name.
// tower_merge — integrate a reviewed mission branch.
// 
// Input: MergeInput (missionId/id, timeoutMs) from domain contracts.
// Output: merged commit, parents, review evidence, blockers.
// Authorization: tower only; the gate is re-evaluated.
// Side effects: git merge, state/activity writes, cleanup on failure.
// Failure modes: merge-conflict, merge-hook-failed, merge-shape.
// The pure intent/shape decisions live in domain/integration.
// See docs/reference/tools.generated.md for the public shape.
// tower_merge: merge a mission branch into the recorded base.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { MergeInput } from '../domain/contracts/tool-inputs/index.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, actorFor: any, requireTowerActor: any, observeActivity: any }} deps
 */
export function registerMergeTool(ctx, deps) {
  // openTower is injected by the composition root (#69).
  const { define, actorFor, requireTowerActor, observeActivity } = deps
  define(ctx, {
    name: 'tower_merge',
    description:
      'Merge a mission branch into the recorded base with --no-ff after the gate passes, or reconcile an already-landed merge. A failed gate returns blocker codes; hook failures and content conflicts are reported separately. Tower-only.',
    parameters: MergeInput,
    aliases: {"missionId":["id"],"timeoutMs":["timeout_ms"]},
    requiresMissionId: true,
    board: true,
    output: output(SCHEMAS.merge),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'merge missions')
      const { activity, parentStatus } = await observeActivity(ctx, tower)
      return tower.merge({ missionId: args.missionId, activity, parentStatus, timeoutMs: args.timeoutMs })
    },
  })
}
