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
import { parseNumstat } from '../../domain/read/views.js'

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
  const view = await tower.diff({ missionId: args.missionId, maxBytes: args.maxBytes, actor })
  if (args.stat !== true) return view
  // #211: `stat:true` reports per-file line counts and never patch bytes. The
  // numstat range is the same merge-base..branch-tip range the view resolved,
  // so authorization and the reviewer binding above still gate the read.
  const numstat = await tower.git(tower.root, ['diff', '--numstat', `${view.mergeBase}..${view.branchTip}`])
  const { patch: _patch, truncated: _truncated, ...rest } = view
  return { ...rest, stat: parseNumstat(numstat) }
}
