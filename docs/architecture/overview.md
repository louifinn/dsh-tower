# Architecture and state machine

## Components

The bundle is all-or-nothing: `cordis.patch.yml` inserts one `tower-bundle` `cordis:group` row whose
internal sections are the Host plugin, the skills provider, and the worker/reviewer presets. The
group is the only user-facing component; disabling it disables every section together, so no preset
or skill can remain mounted while the `tower_*` tools are gone.

```
Host plugin (index.js)
 ├─ /tower command + Tower mode (guard, prompt section, tower_mode/tower_control, /tower reload)
 ├─ lib/tools.js  -> 19 repository tools incl. tower_diff, tower_findings and tower_interrupt
 │                   (+ tower_reload while dev.hotReload is on; fails reload-unavailable without HMR)
 └─ lib/tower.js  -> Tower domain: missions, gates, worktrees, roster, review, findings, merge
       ├─ lib/git.js          minimal git port (execFile, bounded output, timeout classification)
       ├─ lib/store.js        repo-scoped lock + atomic JSON + activity.jsonl
       ├─ lib/config.js       Config schema + profile/repo layers + runtime snapshot
       ├─ lib/errors.js       stable tool error codes and classification
       ├─ lib/workspaceLock.js  optional one-Tower-session-per-repository advisory lock
       ├─ lib/hmr.js          optional DSH HMR bridge (tower_reload / /tower reload)
       └─ lib/modeStore.js    per-agent Tower mode persistence
 pure domain modules (no fs/git):
       lib/domain/mission.js    statuses, transitions, pause causes
       lib/domain/gate.js       completion and merge-gate snapshot decisions
       lib/domain/scope.js      glob/scope validation and overlap
       lib/domain/summary.js    mission/finding summaries
       lib/domain/planning.js   mission numbering, dependency DAG, auto-deps
 tools layer:
       lib/tools.js             registration + shared helpers (503 lines)
       lib/tools/*.js           one module per tool (doctor/recover/test/batch/spawn/...)
       lib/schemas.js           parameter/output schemas
Subagents
 ├─ tower-worker   (dsh-tower/worker)   read/write/edit/pwsh + mission tools + findings
 └─ tower-reviewer (dsh-tower/reviewer) read/glob/grep + tower_diff + review/finding (read-only)
```

The main checkout is the control-tower repo; each mission has a branch `tower/<id>-<slug>` and a
worktree in `.dsh-tower-worktrees/<hash>/<missionId>`. The plugin never operates on the main checkout's
working tree except merge and the read-only diff.

## Mission state machine

```
planned ──spawn worker──▶ active ──tower_complete──▶ completed ──tower_merge──▶ merged
   │                        │  ▲                         │
   │                        │  └──── review round not clean ────┐
   └── abandon ──▶ abandoned│                                   │
                            ├── blocker ──▶ blocked ──active/completed──▶ ...
                            └── pause ─────▶ paused ──active──▶ ...
```

`merged` and `abandoned` are terminal. `tower_mission` may set `blocked → completed`; `merged` is only
set by `tower_merge`/reconciliation.

## Gate pipeline (`tower_preflight`)

1. Mission status must be `completed`; tasks and blockers are checked.
2. The worktree exists; the base tip is an ancestor of the branch tip; changed files are computed
   against the merge base.
3. Survey missions must not change files; build missions must stay inside `scope`.
4. The main checkout must be clean for the files this merge would overwrite and on the base branch.
5. Dependency missions must be merged/abandoned.
6. If `review.requireReview:true` (default false), a review must exist, belong to this mission, be
   clean, approve merge, and be bound to the tip (unless a clean rebase waived it). No worker may be
   running.

## Merge

`tower_merge` runs `git merge --no-ff` with a configurable timeout (default 15 min) and 64 MB buffer.
After the command, regardless of exit status, it inspects `HEAD`:

- merge commit with parents `[baseTip, branchTip]` → record merged (including `recoveredFromFailure`);
- otherwise classify the failure: unmerged index → `merge-conflict` (mission blocked); no unmerged
  entries → `merge-hook-failed` (mission retryable), with abort/reset cleanup.
- If the branch or its reviewed commit is already contained in the base, reconcile instead of merging.

## State files

| Path | Contents |
|---|---|
| `<git-common-dir>/dsh-tower/state.json` | missions, roster, reviews, findings, messages, reviews sequence |
| `<git-common-dir>/dsh-tower/activity.jsonl` | append-only activity |
| `<git-common-dir>/dsh-tower/state.lock` | single-writer lock (stale locks are reported, never stolen) |
| `<checkout parent>/.dsh-tower-worktrees/<hash>/<missionId>` | mission worktree |
| `$DSH_HOME/tower-mode/modes.json` | Tower mode per agent/session |

## Layering rules

`npm run architecture:check` (also in CI) implements the staged rules: `domain/**` must stay free of
I/O and adapters; only allowed adapters may spawn or use fs; `tools/**` must stay thin and free of
status/type literals; aggregate files have size ceilings; and top-level mutable state needs an
explicit allow-list. Rules for not-yet-migrated areas are warnings so the refactor can proceed one
step at a time; each flips to an error in the PR that makes it true. A fixture test seeds one
violation per rule so a rule that cannot fail is itself a test failure.
