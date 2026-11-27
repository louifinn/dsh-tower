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

## A spawn that appears hung

A `tower_spawn` call used to be able to hang before it wrote anything: the queue for the repository
or one of its pre-flight reads (the descendant catalog, the roster, the preset list, provisioning)
could never settle, so no roster row, worktree or `reserve` entry appeared and the mission stayed
`planned` with no trace of why. The pre-flight is now bounded by `spawn.preflightTimeoutMs`
(default 30000), so the same situation ends the call instead of holding it. The same bound also
stops the pre-flight *between* its writes, so an expiry is a clean stop rather than a race the caller
loses to steps that keep going.

- **What the caller sees.** The tool returns `[tower:spawn-unavailable]` with
  `details: {phase, elapsedMs, rollback}`. `phase` names the step that stalled — `queue` for a wait
  behind another spawn, `observe`/`roster`/`ownership`/`services` for the catalog and roster reads,
  `provision` for the worktree, `discovery` for test admission, `reserve`/`activate`/`record` for the
  writes. A cancelled caller gets the same error code with a `cancelled` message. While the call is
  in flight the tower's activity log narrates it, so a hung spawn is legible from the log alone: each
  phase transition appends `pre-flight <phase> after <n>ms`, and a call that had to wait behind
  another appends `pre-flight queued <n>ms behind <n> other spawn(s)` when it starts running.
- **What `tower_inspect({view:"status"})` shows.** `spawn.depth` is how many spawns hold or wait for
  the repository's spawn slot and `spawn.oldestWaitMs` is the oldest wait; both are read-only
  snapshots, so a wedged queue is visible from another session while the first call is still stuck.
  `spawn.budget` and `spawn.blockedUntil` still carry the provider-cooldown state.
- **What was released, and what may be left.** The refusal releases every write the pre-flight had
  already made — the roster reservation it wrote, the worktree it created, a detached sandbox — and
  reports each one in `details.rollback` as `released`, `removed` or `none`; when a step could not be
  undone it is reported as `kept` with the path and the reason, and only then is anything left for
  you to clean up. A worktree the mission already owned before the call is never removed, because it
  is not this call's to delete. If `rollback` names a kept reservation, the next spawn's pre-check
  reaps it once it has been stalled for `STALLED_RESERVATION_GRACE_MS` (60s), so waiting that long and
  retrying is one option; removing the checkout with `tower_teardown` is the other. If `rollback`
  names a kept worktree, `tower_teardown` is the path that also prunes the branch. Nothing else needs
  cleanup, and once the cause is fixed the same call can simply be retried. If the mission is no
  longer `planned`, a child did start: the refusal then reports the activation it could not undo in
  `details.rollback.reservation` and the normal paths apply — see
  [A worker died mid-mission](#a-worker-died-mid-mission).
- **When retrying is safe.** A timeout is not a provider cooldown: it does not count toward
  `spawn.backoff`, so one retry after the service settles is the intended recovery. Raise
  `spawn.preflightTimeoutMs` only for a legitimately slow provisioning step, not to paper over a
  catalog that never answers.

## A worker died mid-mission

A worker that exits without calling `tower_complete` leaves its mission `active` with a roster row the
watchdog marks `stale`. The sweep also records what it left behind — `{at, filesChanged, branch, tip,
dirty, cause?}` — so you never have to reconstruct the death with `git status` and a hunk-by-hunk read of
the diff. Do exactly three things:

1. **Read the residue first.** `tower_inspect({view:"roster",agent:"worker-m1"})` returns the dead row's
   `residue`: how many files changed, on which branch, at which tip, and whether the tree was dirty. That
   record is counts and shas only, never file contents; the same numbers are in `activity.jsonl`
   (`residue worker-m1: 3 file(s) changed on tower/m1-… at 4f2a…`), and the mission carries it as
   `predecessorResidue` so the next worker's briefing opens with it. Only the most recent worker death
   is carried: a later clean death erases the record, and an accepted completion clears it.
2. **Spawn a short-lived bookkeeping worker** with `tower_spawn({missionId:"M1",role:"worker"})` — pass
   `op:"takeover"` once the dead child is no longer running. It inherits the residue sentence, re-runs the
   gates against the tip, and calls `tower_complete` itself. Its report is the handoff you would have
   written by hand.
3. **Let the worker complete the mission.** Never set `status:"completed"` yourself.

Setting the status by hand is refused on purpose, for two reasons. The refusal itself
(`a stopped worker cannot report completion`) carries a `nextAction` naming the bookkeeping-worker route,
because the status is not a label — it is the record. A hand-set completion writes no `completionReport`,
no `checks`, and no `by` attribution, so the mission looks finished while the evidence that justifies
completion (which commit, which gates, who vouches for it) is missing. And a stale row that reports its own
completion is a lie the roster cannot detect: the watchdog marks rows `stale` because the catalog stopped
answering, and `tower_complete` is the one call that proves a worker is alive by producing work. A tower
that accepts a hand-set status loses the only signal that distinguishes "finished" from "abandoned".

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
