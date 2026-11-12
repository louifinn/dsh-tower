# Tower recovery playbook

Read `tower_inspect` with `view: "preflight"` and the last failure before changing anything.

## Merge hook failed or timed out (`merge-hook-failed`)

The merge commit was not created; the repository was restored. Re-run `tower_merge`. For slow
`pre-merge-commit` hooks pass a larger `timeoutMs` (default 15 minutes).

## Merge commit landed but the call failed (`recoveredFromFailure`)

The mission is already recorded as merged. Do not merge again; run `tower_teardown`.

## Merge already landed earlier (`reconciled` / `alreadyMerged`)

`tower_merge` detects the existing merge commit or a branch contained in the base and records it.
Only a clean/merge review qualifies; otherwise ask for a fresh review.

## Merge blocked with `stale-base`

Run `tower_rebase` inside the mission worktree, then `tower_inspect` with `view: "preflight"` and `tower_merge`.
If the branch was already contained in the base, rebase returns `alreadyMerged` and leaves it
untouched — call `tower_merge` to record it.

## `state.lock` reports another writer

Wait and retry; a live writer must never be interrupted. If the holder is provably dead, use a
supported recovery path (or ask the human to run one) that verifies the PID is gone and takes a
backup first. **Do not delete `state.lock` or the state directory from this playbook.**

## Worktree missing or dirty

`tower_inspect` with `view: "status"` shows the expected path and branch. Re-add a missing worktree only from Git if the
branch still exists; do not delete a branch you have not reviewed. Dirty worktrees require an
explicit teardown `force` decision.

## A new session is not the Tower owner

Tower tools reject a session that is not `state.towerAgentId` with
`[tower:not-authorized] ... repository owner is <id>`. When the previous session has finished, run
`/tower takeover <reason>` in the new session. It is the human path and works even with
`mode.allowAgentControl:false`. If the previous owner is still live, or live roster agents or a foreign
workspace lock remain, the takeover refuses with `[tower:owner-live]` / `[tower:owner-busy]`; stop the
live work first. A model may request the same transfer with `tower_mode({active:"takeover", authorization:"<audit ref>"})` after
the human approves the dialog. Do not delete the state directory to change owners.

## Reset a repository's Tower state

**Do not delete `<git-common-dir>/dsh-tower/` from this playbook.** That directory contains mission,
review, roster, finding and activity history; deleting it can lose unrecoverable work. Stop and ask
the human to inspect `tower_inspect` with `view: "doctor"`, take a backup, and decide on a controlled repair. Worktrees and
branches must be cleaned only after that decision.
