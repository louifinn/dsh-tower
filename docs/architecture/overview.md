# Architecture and state machine

## Components

The bundle is all-or-nothing: `cordis.patch.yml` inserts one `tower-bundle` `cordis:group` row whose
internal sections are the Host plugin, the skills provider, and the worker/reviewer presets. The
group is the only user-facing component; disabling it disables every section together, so no preset
or skill can remain mounted while the `tower_*` tools are gone.

```
Host plugin (index.js)
 ├─ /tower command + Tower mode (guard, prompt section, tower_mode/tower_control, /tower reload)
 ├─ tools/index.js  -> shared registration helpers + 27 registered repository tools
 │                    (+ tower_reload while dev.hotReload is on; fails reload-unavailable without HMR)
 └─ app/tower.js   -> orchestration surface; delegates to use-case modules
       ├─ app/init.js, provision.js, merge.js, rebase.js, teardown.js
       ├─ app/review.js, findings.js, batch.js, messages.js, roster.js
       ├─ app/plan.js, mission.js, checkCompletion.js, spawn.js, recording.js
       └─ app/gate.js, read.js, board.js, missionContext.js, enrichedMissions.js
 adapters (the only I/O):
       adapters/store-fs.js   the only module importing node:fs
       adapters/vcs-git.js    the only module importing node:child_process
       adapters/default.js    composition root: store, vcs, clock, ids
 infrastructure (lib/):
       lib/store.js           repo-scoped lock + atomic JSON + activity.jsonl
       lib/git.js             bounded git commands + timeout classification
       lib/config.js          profile/repo config layers over the pure schema
       lib/workspaceLock.js   optional one-Tower-session-per-repository advisory lock
       lib/hmr.js             optional DSH HMR bridge (tower_reload / /tower reload)
       lib/modeStore.js       per-agent Tower mode persistence
 pure domain modules (no fs/git):
       domain/errors.js     stable, structural tool error catalog
       domain/batch.js      batch admission create/close/summary validation
       domain/config/schema.js  Schemastery config schema, defaults, validation
       domain/contracts/outputs.js  tool output-schema catalog
       domain/mission.js    statuses, transitions, pause causes
       domain/gate.js       completion and merge-gate snapshot decisions
       domain/scope.js      glob/scope validation and overlap
       domain/summary.js    mission/finding summaries
       domain/planning.js   mission numbering, dependency DAG, auto-deps
       domain/state.js      load-time state validation
       domain/report.js     board rendering
       domain/roster.js     roster predicates
 tools layer:
       tools/index.js           registration + shared helpers
       tools/*.js               one module per tool, TypeBox input schema + handler
       tools/schema.js          TypeBox helpers (enumOf preserves JSON Schema enum)
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
- Only `adapters/vcs-git.js` may import `node:child_process`, and only
  `adapters/store-fs.js` may import `node:fs` (`child-process-surface`, `fs-surface`).
- `tools/**` must stay thin and free of status/type literals (`tools-thin`, `tools-vocabulary`);
  `tools/index.js` is the registration aggregator and is exempt from the thinness rule.
- Aggregate files have size ceilings; top-level mutable state is limited to explicit composition
  roots (`aggregate-size`, `ambient-state`). The per-tool ceiling is 200 lines, with the
  aggregator and `tools/spawn.js` allowed at the aggregate ceiling until they are split.

A fixture test seeds one violation per rule, so a rule that cannot fail is itself a test failure.

## Known #56 gaps

The child issues are closed, but the epic's remaining definition-of-done items are tracked here:

- Pure domain share is currently about **17%** (roughly 2,125 of 12,600 source lines), below the 35%
  target. P2a moved the already-pure modules (`batch`, `errors`, the config schema, output schemas)
  into `domain/`; reaching 35% still requires moving transition/gate/validation logic out of the
  use-case modules, not just moving files.
- `state.json` and `modes.json` now share `lib/persistence.js` atomic/lock/dead-PID primitives;
  `lib/store.js` and `lib/modeStore.js` are thin path/merge layers over that contract.
- The `tools/**` fitness rules now target the top-level layer. `tools/spawn.js` (374 lines) is still
  above the 200-line per-tool target; splitting it remains follow-up work.


