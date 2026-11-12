// Read-only mission branch view, served as `tower_inspect` `view: "diff"`.
// Callers must treat the patch as read-only evidence.
// The view never checks out or mutates the mission branch.
// Reviewers may use it without holding the state lock.
//
// Output: merge base, changed files, commits, capped patch.
// Authorization: tower, reviewer, or assigned worker may inspect.
// Side effects: none; it never writes state, git, or the repository.
// Failure modes: unknown mission, missing worktree, stale branch.
// Errors are classified as [tower:<code>] by the registry.
// The patch cap is enforced by the pure read projection.
// See docs/reference/tools.generated.md for the public shape.
import { TowerToolError } from '../../domain/errors.js'
import { isUnknownRole } from '../../domain/vocabulary.js'

/**
 * @param {any} args
 * @param {any} exec
 * @param {any} actor
 * @param {{ openTower: any }} deps
 */
export async function runDiffView(args, exec, actor, deps) {
  // Defence in depth: the kernel already resolved and authorized this call
  // (including mission participation). Never re-resolve a different actor
  // here, because the reviewer binding must match the authorized actor.
  if (!actor || isUnknownRole(actor.role)) {
    throw new TowerToolError('not-authorized', 'tower_inspect view "diff" requires a registered roster agent or the tower')
  }
  const tower = await deps.openTower(args.repoRoot)
  // A reviewer's diff is bound to its recorded review commit (#149 W3).
  return tower.diff({ missionId: args.missionId, maxBytes: args.maxBytes, actor })
}
