# Operations runbook

## Daily checks

- `tower_inspect` with `view: "status"` — counts, open tasks, roster, unread messages, recent activity.
- `tower_inspect` with `view: "roster"` — live activity; retired agents are recorded but never resumed.
- `tower_inspect` with `view: "preflight"` before every merge.

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
`blocked`; resolve in the worktree, then `tower_mission({clear_blockers:true})` resumes it to `active`, retry.

## Interrupt, stale roster and takeover

A runaway agent: `tower_interrupt({to:"worker-m1",reason:"..."})` interrupts the host subagent turn and
records `state:"interrupted"`. `tower_inspect` with `view: "roster"` shows `stale:true` when an active entry has no catalog
activity beyond `spawn.staleMs`; `tower_init({op:"adopt"})` retires such entries (`retire_missing:false` marks them
`missing` instead). After the old owner is interrupted/failed/missing, spawn a replacement with
`takeover:true`; a still-running owner returns `takeover-refused`.

Adopt judges a row only when its parent's catalog is authoritative: the call must return at least one
descendant. An **empty answer or a failing catalog is not evidence that a child stopped** — a just-spawned
child or a catalog race can answer `[]`, and a throw only says the catalog could not answer (F83). Those
rows are reported in `unjudged` (`{name, missionId, agentId, reason}`) and their observation counters are
left untouched; `parentStatus` carries the per-parent status (`empty: …` / `unavailable: …`) and
`skippedUnknownParents` names the parents that could not judge. Retirement (or `missing` with
`retire_missing:false`) needs **two observations against an authoritative catalog** in which the row is
positively absent. If adopt keeps reporting `empty:` for a session that still has live workers, retry once
the catalog settles; do not force the rows to `retired` by hand.

## Workspace lock

With `mode.workspaceLock:true`, `<git-common-dir>/dsh-tower/tower.lock` names the owning session. A second
Tower session gets `[tower:workspace-busy]`; the message names the lock path, its byte size and mtime.
Heartbeats refresh the lock every `mode.heartbeatMs`. Let the owner run `/tower off`; if the owner is gone,
wait `mode.workspaceStaleMs` (default 5 min) for the stale takeover, or move the record aside with
`tower_recover` (below) rather than deleting it by hand.

A torn record — a session killed between the exclusive create and its write — used to wedge every tool,
`tower_recover` included. It no longer does:

- `tower_recover({action:"status"})` reports `workspaceLock` with `path`, `bytes`, `mtime`, `held`, `self`,
  `stale`, `corrupt`, `unreadable`, `torn`, `aged`, `reclaimable` and the record owner (`pid`, `sessionId`).
- A torn record (zero bytes, whitespace only, or not a lock object) is **reclaimed automatically** once its
  mtime is older than the 30s torn grace window: the next repository tool renames it to
  `tower.lock.recovered-<ts>` and takes the lock. A fresh torn file is not stolen from a writer that may
  still be finishing its write, and a parseable record is never treated as torn.
- `tower_recover({action:"clear-workspace-lock", confirm:"CLEAR_WORKSPACE_LOCK"})` is the manual path.
  Without `force` it moves only a torn record older than the grace window or a record whose PID is provably
  dead; a live holder, an unprovable PID, a fresh torn file and an unreadable file are refused with the lock
  path, size, mtime and an executable next step. `force:true` overrides after you confirm no Tower session is
  writing. The record is always renamed to `tower.lock.recovered-<ts>`, never deleted.
- `tower_recover` runs before the workspace gate, so it stays callable while every other repository tool
  reports `[tower:workspace-busy]`; recovery is still ownership-bound to the Tower session.

## Hot reload

`/tower reload` or `tower_reload` asks DSH HMR to reconcile the profile and reload the Host plugin; the
reload is scheduled after the tool result (`dev.reloadDelayMs`). It fails with `reload-unavailable` on a
profile without HMR. Run `npm run dev:hmr` once to add this checkout to the profile's HMR watch roots
(one DSH restart after the profile patch change); see [hot reload](../guide/hot-reload.md). If a reload
fails, the previous plugin code no longer runs: restart DSH and check the HMR log.

## State lock

`tower state is locked by another writer` means an operation holds `state.lock`. Wait and retry: a
live holder rewrites the record's `at` heartbeat every second, so it is never stolen while it runs.
A stale heartbeat is diagnostic, not a death certificate: a live PID whose heartbeat is silent is
**never reclaimed automatically**, because a slow holder must not lose its update to a clock. Only a
record whose PID is provably dead (ESRCH) is reclaimed, atomically and after byte verification, by
the next mutation.

If a lock never clears, `tower_recover({action:"status"})` reports the owner's `pid`, `startedAt`,
`ageMs` and `heartbeatAgeMs`, and `tower_inspect` with `view: "doctor"` reports the same. `tower_recover
clear-stale-lock` with `confirm:"CLEAR_STALE_LOCK"` moves a provably dead lock to
`state.lock.recovered-<ts>`; add `force: true` to clear a live-but-silent PID (the recycled-PID case)
after confirming no writer is active. The repair always renames, never deletes, so the bytes stay
auditable. Never delete `state.lock` by hand while an agent may still be running.

## Worktrees and teardown

`tower_teardown` removes worktrees only for `merged`/`abandoned` missions; a running agent is always
kept, and a dirty worktree requires `force: true`. Use `dry_run: true` to preview decisions. A missing
worktree can be re-added from its branch with `git worktree add`, but do not do this while the mission
is active without updating the roster.

Orphan cleanup is opt-in: `tower_teardown({orphans: true})` also removes clean checkouts that git
registers but no mission or roster row owns, and empty leftover directories directly under the
worktree root. Those shells are usually the remains of a review checkout whose contents were removed
(the `git worktree remove` step unregistered it while the directory survived, often because a Windows
handle was still open), for example `M12-review-reviewer-a`; doctor's `worktrees-orphans` check names
them and points here. The sweep never touches the main checkout, a state-referenced path, a path
outside the root, a non-empty directory or a registered checkout, and `dry_run: true` previews every
decision. A checkout another tool registered outside the worktree root is foreign to Tower: doctor
names it on a passing row and the sweep keeps it, so reclaim it with the tool that created it. If the
configured store does not expose directory enumeration (the optional `readdir`/`rmdir` capabilities),
neither doctor nor the sweep can see empty shells: doctor warns that the capability is unavailable and
the teardown report carries `leftoversUnavailable` plus a warning, so remove those directories
manually.

## Ownership handoff

State is bound to the session that initialized it (`state.towerAgentId`). When that session is gone,
the new session runs `/tower takeover <reason>`; the human command is always available, even with
`mode.allowAgentControl:false`. A model can request the same transfer through
`tower_mode({active:"takeover", authorization:"<audit ref>"})`, but only from Tower mode and only after an explicit human
approval dialog. Both paths refuse while the previous owner still has Tower mode on with a live
workspace lock ([tower:owner-live]), while live roster agents or a foreign workspace lock exist
([tower:owner-busy]). The transfer keeps all missions, reviews, findings and unread messages, writes
one `takeover` activity line, and releases an orphaned previous-owner lock. There is no automatic
release of ownership. See `tower_inspect` with `view: "doctor"`'s `tower-owner` check for the current facts.

## Stale or corrupt state

If `state.json` is unreadable, stop all agents first. The plugin reports corruption instead of guessing.
For a live repository whose owner session is merely gone, prefer the ownership handoff above; it keeps
history. Restore from a backup if you have one. Removing `<git-common-dir>/dsh-tower/` and re-running
`tower_init` is the last resort: it loses mission history but not Git branches/worktrees.

## Full recovery of a repo's Tower data

Only when no mission is in flight and you accept losing history:

1. Stop all tower agents.
2. Remove merged/abandoned worktrees (`tower_teardown` first when the state is readable).
3. Remove `<git-common-dir>/dsh-tower/`.
4. `tower_init` again; re-plan any work still needed.

## Mode state

Tower mode is stored in `$DSH_HOME/tower-mode/modes.json` (atomic writes, capped entries). If a mode is
stuck, `/tower off`; if the session is gone, remove its entry with the file unlocked and restart DSH.
