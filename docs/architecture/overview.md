# Architecture and state machine

## Components

The bundle is all-or-nothing: `cordis.patch.yml` inserts one `tower-bundle` `cordis:group` row whose
internal sections are the Host plugin, the skills provider, and the worker/reviewer presets. The
group is the only user-facing component; disabling it disables every section together, so no preset
or skill can remain mounted while the `tower_*` tools are gone.

```
Host plugin (index.js)
 ├─ /tower command + Tower mode (guard, prompt section, tower_mode/tower_control, /tower reload)
 ├─ lib/tools.js  -> shared registration helpers + 27 registered repository tools
 │                   (+ tower_reload while dev.hotReload is on; fails reload-unavailable without HMR)
 └─ lib/tower.js  -> orchestration surface; delegates to use-case modules
       ├─ lib/tower/init.js, provision.js, merge.js, rebase.js, teardown.js
       ├─ lib/tower/review.js, findings.js, batch.js, messages.js, roster.js
       ├─ lib/tower/plan.js, mission.js, checkCompletion.js, spawn.js, recording.js
       └─ lib/tower/gate.js, read.js, board.js, missionContext.js, enrichedMissions.js
 adapters (the only I/O):
       lib/adapters/store-fs.js   the only lib module importing node:fs
       lib/adapters/vcs-git.js    the only lib module importing node:child_process
       lib/adapters/default.js    composition root: store, vcs, clock, ids
 infrastructure:
       lib/store.js           repo-scoped lock + atomic JSON + activity.jsonl
       lib/git.js             bounded git commands + timeout classification
       lib/config.js          Schemastery config + profile/repo layers
       lib/errors.js          stable, structural tool error catalog
       lib/workspaceLock.js   optional one-Tower-session-per-repository advisory lock
       lib/hmr.js             optional DSH HMR bridge (tower_reload / /tower reload)
       lib/modeStore.js       per-agent Tower mode persistence
 pure domain modules (no fs/git):
       lib/domain/mission.js    statuses, transitions, pause causes
       lib/domain/gate.js       completion and merge-gate snapshot decisions
       lib/domain/scope.js      glob/scope validation and overlap
       lib/domain/summary.js    mission/finding summaries
       lib/domain/planning.js   mission numbering, dependency DAG, auto-deps
       lib/domain/state.js      load-time state validation
       lib/domain/report.js     board rendering
       lib/domain/roster.js     roster predicates
 tools layer:
       lib/tools.js             registration + shared helpers
       lib/tools/*.js           one module per tool, TypeBox input schema + handler
       lib/toolSchema.js        TypeBox helpers (enumOf preserves JSON Schema enum)
       lib/schemas.js           output schemas
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
| `<git-common-dir>/dsh-tower/state.lock` | single-writer state lock (dead-PID reclaimed, live lock reported) |
| `<git-common-dir>/dsh-tower/git.lock` | repo-scoped serialization for git mutations outside the state lock |
| `<git-common-dir>/dsh-tower/lock-holds.jsonl` | state/git lock-hold telemetry |
| `<checkout parent>/.dsh-tower-worktrees/<hash>/<missionId>` | mission worktree |
| `$DSH_HOME/tower-mode/modes.json` | Tower mode per agent/session |
| `$DSH_HOME/tower-mode/modes.lock` | mode-store single-writer lock |

`state.json` and `modes.json` both use an atomic write (temp + rename), token-checked lock release,
dead-PID reclamation, and bounded lock waits. `state.json` is the mission persistence contract;
`modes.json` is the per-agent mode contract; neither is written without its own lock.

## Layering rules

`npm run architecture:check` (also in CI) enforces the rules as **errors**:

- `domain/**` must not import I/O or adapters (`domain-pure`).
- Only `lib/adapters/vcs-git.js` may import `node:child_process`, and only
  `lib/adapters/store-fs.js` may import `node:fs` (`child-process-surface`, `fs-surface`).
- `tools/**` must stay thin and free of status/type literals (`tools-thin`, `tools-vocabulary`).
- Aggregate files have size ceilings; top-level mutable state is limited to explicit composition
  roots (`aggregate-size`, `ambient-state`).

A fixture test seeds one violation per rule, so a rule that cannot fail is itself a test failure.

## Known #56 gaps

The child issues are closed, but the epic's remaining definition-of-done items are tracked here:

- Pure domain share is currently about **7%** (roughly 760 of 10,900 lib lines), below the 35%
  target. Raising it requires moving transition/gate/validation logic out of the use-case modules,
  not just moving files.
- `state.json` and `modes.json` share the same atomic/lock/dead-PID semantics but still have two
  implementations (`lib/store.js` and `lib/modeStore.js`). Unifying them behind one persistence
  contract remains a follow-up.
- The fitness rules use the current `lib/tools/**` layout; the future thin `tools/**` layer is only
  checked when that directory exists.


