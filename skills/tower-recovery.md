# Tower recovery playbook

Read `tower_preflight` and the last failure before changing anything.

## Merge hook failed or timed out (`merge-hook-failed`)

The merge commit was not created; the repository was restored. Re-run `tower_merge`. For slow
`pre-merge-commit` hooks pass a larger `timeoutMs` (default 15 minutes).

## Merge commit landed but the call failed (`recoveredFromFailure`)

The mission is already recorded as merged. Do not merge again; run `tower_teardown`.

## Merge already landed earlier (`reconciled` / `alreadyMerged`)

`tower_merge` detects the existing merge commit or a branch contained in the base and records it.
Only a clean/merge review qualifies; otherwise ask for a fresh review.

## Merge blocked with `stale-base`

Run `tower_rebase` inside the mission worktree, then `tower_preflight` and `tower_merge`.
If the branch was already contained in the base, rebase returns `alreadyMerged` and leaves it
untouched — call `tower_merge` to record it.

## `state.lock` reports another writer

Wait, then retry. Never delete the lock while a writer may be active; if the process is gone,
remove `<git-common-dir>/dsh-tower/state.lock` deliberately and retry.

## Worktree missing or dirty

`tower_status` shows the expected path and branch. Re-add a missing worktree only from Git if the
branch still exists; do not delete a branch you have not reviewed. Dirty worktrees require an
explicit teardown `force` decision.

## Reset a repository's Tower state

Only when no mission is in flight and you accept losing mission history: stop all agents, remove
`<git-common-dir>/dsh-tower/`, then `tower_init` again. Worktrees and branches must be cleaned
manually.
