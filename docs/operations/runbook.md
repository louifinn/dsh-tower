# Operations runbook

## Daily checks

- `tower_status` — counts, open tasks, roster, unread messages, recent activity.
- `tower_roster` — live activity; retired agents are recorded but never resumed.
- `tower_preflight missionId` before every merge.

## Recover from a failed merge

1. Read the blocker: `merge-hook-failed` (retryable) vs `merge-conflict` (mission blocked) vs
   `merge-shape` (inspect manually).
2. For a slow `pre-merge-commit` hook, retry with a larger timeout:
   `tower_merge({ missionId, timeoutMs: 1800000 })`.
3. If a merge commit landed but the call failed, re-run `tower_merge`; it records the commit
   (`recoveredFromFailure`) or reconciles an already-landed merge (`reconciled`) without a second merge.
4. Never reset or rewrite the base branch by hand while Tower state exists; use Tower tools so state and
   Git stay aligned.

## Recover from a stale branch

`tower_rebase` first. If the branch is already contained in the base it returns `alreadyMerged` and
leaves the branch untouched — then call `tower_merge` to record it. A conflict marks the mission
`blocked`; resolve in the worktree, set the mission back to `active` (or `completed`), retry.

## Interrupt, stale roster and takeover

A runaway agent: `tower_interrupt({to:"worker-m1",reason:"..."})` interrupts the host subagent turn and
records `state:"interrupted"`. `tower_roster` shows `stale:true` when an active entry has no catalog
activity beyond `spawn.staleMs`; `tower_adopt` retires such entries (`retireMissing:false` marks them
`missing` instead). After the old owner is interrupted/failed/missing, spawn a replacement with
`takeover:true`; a still-running owner returns `takeover-refused`.

## Workspace lock

With `mode.workspaceLock:true`, `<git-common-dir>/dsh-tower/tower.lock` names the owning session. A second
Tower session gets `[tower:workspace-busy]`. Let the owner run `/tower off`; if the owner is gone, wait
`mode.workspaceStaleMs` (default 5 min) for the stale takeover, or delete the lock deliberately only after
confirming no Tower session is active. Heartbeats refresh the lock every `mode.heartbeatMs`.

## Hot reload

`/tower reload` or `tower_reload` asks DSH HMR to reconcile the profile and reload the Host plugin; the
reload is scheduled after the tool result (`dev.reloadDelayMs`). It fails with `reload-unavailable` on a
profile without HMR. Run `npm run dev:hmr` once to add this checkout to the profile's HMR watch roots
(one DSH restart after the profile patch change); see [hot reload](../guide/hot-reload.md). If a reload
fails, the previous plugin code no longer runs: restart DSH and check the HMR log.

## State lock

`tower state is locked by another writer` means an operation holds `state.lock`. Wait and retry. Only if
the owning process is gone, remove `<git-common-dir>/dsh-tower/state.lock` deliberately; never delete it
while an agent may still be running.

## Worktrees and teardown

`tower_teardown` removes worktrees only for `merged`/`abandoned` missions; a running agent is always
kept, and a dirty worktree requires `force: true`. Use `dry_run: true` to preview decisions. A missing
worktree can be re-added from its branch with `git worktree add`, but do not do this while the mission
is active without updating the roster.

## Stale or corrupt state

If `state.json` is unreadable, stop all agents first. The plugin reports corruption instead of guessing.
Restore from a backup if you have one; otherwise remove `<git-common-dir>/dsh-tower/` and re-run
`tower_init` — this loses mission history but not Git branches/worktrees.

## Full recovery of a repo's Tower data

Only when no mission is in flight and you accept losing history:

1. Stop all tower agents.
2. Remove merged/abandoned worktrees (`tower_teardown` first when the state is readable).
3. Remove `<git-common-dir>/dsh-tower/`.
4. `tower_init` again; re-plan any work still needed.

## Mode state

Tower mode is stored in `$DSH_HOME/tower-mode/modes.json` (atomic writes, capped entries). If a mode is
stuck, `/tower off`; if the session is gone, remove its entry with the file unlocked and restart DSH.
