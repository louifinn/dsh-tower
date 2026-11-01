# Blockers and failure codes

`tower_preflight` returns `{ok:false, blockers:[{code, detail}]}`. `tower_merge` and `tower_rebase`
return the same shape for operation failures. Codes are stable; the detail is human-facing. The
tables below define 32 stable blocker/failure codes.

The review blockers below (`no-review`, `review-mission-mismatch`, `not-clean`, `review-hold`,
`review-not-approved`, `tip-moved`, `review-exemption-invalid`) exist only when `review.mode` is
`required`. With `off` or `optional` no review blocker is produced; `off` additionally removes
`tower_review` and refuses reviewer spawn.

## Gate blockers (26)

| Code | Meaning / next action |
|---|---|
| `mission-missing` | Unknown mission id. Check `tower_status`. |
| `mission-not-completed` | Mission is not `completed`; only a completed mission (ready for preflight/merge) merges. |
| `tasks-open` | Open tasks remain; the worker must finish or `task_drop` with a reason. |
| `blockers-present` | The mission has blockers; clear them after resolving. |
| `no-check-evidence` | `gates.requireChecks` is enabled and the completion report has no `checks`. Return the completed mission to `active`, re-run `tower_complete` with checks, then review again. |
| `branch-missing` | No worktree/branch yet: spawn a worker first. |
| `stale-base` | The branch does not contain the base tip: run `tower_rebase`. |
| `read-only-survey` | Survey mission changed files; survey missions must be read-only. |
| `out-of-scope` | Changed files outside the mission scope; widen scope deliberately or revert. On a case-sensitive checkout a case-only mismatch is still rejected and the detail names the scope entry it would match if case were folded. |
| `base-dirty` | The main checkout has uncommitted changes the merge would overwrite. |
| `deps-unmerged` | A dependency mission is not satisfied: a build dependency must be `merged`/`abandoned`, while a survey dependency is satisfied at `completed` (archived entries included). |
| `no-review` | `review.mode:required` and no review exists on the branch: spawn a reviewer (or disable the review gate). |
| `review-mission-mismatch` | `review.mode:required` and the latest review belongs to another mission. |
| `not-clean` | `review.mode:required` and latest review is `p1-Nitems`/`p2-Nitems`; another round is required. Verdicts from later routes of the same round are appended to it instead of flipping the mission again. |
| `review-hold` | `review.mode:required` and latest review recommends hold; a later clean review must supersede it. |
| `review-not-approved` | `review.mode:required` and latest clean review says `fix-then-merge` or `hold`; only `merge` approves. |
| `tip-moved` | `review.mode:required` and the branch changed after review; review again (or use a clean rebase waiver). |
| `worker-busy` | A roster agent for this mission is running; wait or retire it. |
| `worker-status-unknown` | The parent catalog is unavailable, so a live roster agent cannot be proven stopped; retry after the catalog recovers or adopt it. |
| `base-wrong-branch` | The main checkout is not on the recorded base branch. |
| `branch-owned-by-closed-missions` | The mission is already merged/abandoned; re-plan under a new title. |
| `worker-stale` | A roster worker for this mission has no catalog activity beyond `spawn.staleMs`; adopt it (or interrupt it only if it is actually running) before merge. |
| `tests-missing` | `gates.requireTests` is enabled and there is no passing discovery receipt for the current branch tip; run `tower_test` or `tower_complete`. |
| `tests-failed` | The latest discovery receipt failed or did not meet minCount/required checks. Fix the tests and re-run. |
| `review-exemption-invalid` | `review.mode:required` and the mission requests `reviewPolicy:"none"` while `gates.allowReviewExemption` is off (or the reason is missing). |
| `merge-intent-pending` | A merge intent was recorded before a crash/failure; run `tower_merge` to reconcile before another gate. |

## Merge failures (4)

| Code | Meaning / next action |
|---|---|
| `merge-conflict` | Real index conflict; the mission is `blocked`. Resolve, restore the mission to `active`/`completed`, retry. |
| `merge-hook-failed` | A hook/process failed before a commit existed; repository restored, mission stays `completed`. Retry; `timeout: true` means the git process timed out. Raise `timeoutMs` for slow hooks. |
| `merge-shape` | Git produced unexpected merge parents; inspect the repository, do not force. |
| `batch-invalid` | A batch id/member/receipt/check reference is invalid or close evidence is incomplete. |

A merge that already landed is **not** a blocker: `tower_merge` records it (`reconciled`,
`alreadyLanded`) or recovers it (`recoveredFromFailure`, `warnings`).

## Rebase failures (3; `worker-busy` shared)

| Code | Meaning / next action |
|---|---|
| `worktree-dirty` | Commit or discard worktree changes, then retry. |
| `rebase-conflict` | A real conflict; the mission is `blocked`. Resolve manually, return it to `active`, retry. |
| `worker-busy` | An agent is running for this mission; wait or retire it first. |

`tower_rebase` returns `alreadyMerged: true` when the branch is already contained in the base; call
`tower_merge` to record the landed merge.
