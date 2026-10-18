# Blockers and failure codes

`tower_preflight` returns `{ok:false, blockers:[{code, detail}]}`. `tower_merge` and `tower_rebase`
return the same shape for operation failures. Codes are stable; the detail is human-facing.

## Gate blockers (19)

| Code | Meaning / next action |
|---|---|
| `mission-missing` | Unknown mission id. Check `tower_status`. |
| `mission-not-completed` | Mission is not `completed`; only a completed mission (awaiting review) merges. |
| `tasks-open` | Open tasks remain; the worker must finish or `task_drop` with a reason. |
| `blockers-present` | The mission has blockers; clear them after resolving. |
| `branch-missing` | No worktree/branch yet: spawn a worker first. |
| `stale-base` | The branch does not contain the base tip: run `tower_rebase`. |
| `read-only-survey` | Survey mission changed files; survey missions must be read-only. |
| `out-of-scope` | Changed files outside the mission scope; widen scope deliberately or revert. |
| `base-dirty` | The main checkout has uncommitted changes the merge would overwrite. |
| `deps-unmerged` | A dependency mission is not merged/abandoned. |
| `no-review` | No review on the branch: spawn a reviewer. |
| `review-mission-mismatch` | The latest review belongs to another mission. |
| `not-clean` | Latest review is `p1-Nitems`/`p2-Nitems`; another round is required. |
| `review-hold` | Latest review recommends hold; a later clean review must supersede it. |
| `review-not-approved` | Latest clean review says `fix-then-merge` or `hold`; only `merge` approves. |
| `tip-moved` | The branch changed after review; review again (or use a clean rebase waiver). |
| `worker-busy` | A roster agent for this mission is running; wait or retire it. |
| `base-wrong-branch` | The main checkout is not on the recorded base branch. |
| `branch-owned-by-closed-missions` | The mission is already merged/abandoned; re-plan under a new title. |

## Merge failures (3)

| Code | Meaning / next action |
|---|---|
| `merge-conflict` | Real index conflict; the mission is `blocked`. Resolve, restore the mission to `active`/`completed`, retry. |
| `merge-hook-failed` | A hook/process failed before a commit existed; repository restored, mission stays `completed`. Retry; `timeout: true` means the git process timed out. Raise `timeoutMs` for slow hooks. |
| `merge-shape` | Git produced unexpected merge parents; inspect the repository, do not force. |

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
