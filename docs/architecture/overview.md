# Architecture and state machine

## Components

The bundle is all-or-nothing: `cordis.patch.yml` inserts one `tower-bundle` `cordis:group` row whose
internal sections are the Host plugin, the skills provider, and the worker/reviewer presets. The
group is the only user-facing component; disabling it disables every section together, so no preset
or skill can remain mounted while the `tower_*` tools are gone.

```
Host plugin (index.js)
 ├─ /tower command + Tower mode (guard, prompt section, tower_mode/tower_control, /tower reload)
 ├─ lib/tool-registry.js -> registration aggregator, actor guards, shared helpers
 │                    (+ 27 registered repository tools)
 │                    (+ tower_reload while dev.hotReload is on; fails reload-unavailable without HMR)
 ├─ tools/index.js  -> thin public wiring (re-exports the registry + briefings)
 └─ app/tower.js   -> orchestration surface; delegates to use-case modules
       ├─ app/init.js, provision.js, merge.js, rebase.js, teardown.js
       ├─ app/review.js, findings.js, batch.js, messages.js, roster.js
       ├─ app/plan.js, mission.js, checkCompletion.js, spawn.js, recording.js
       └─ app/gate.js, read.js, board.js, missionContext.js, enrichedMissions.js
 ports (explicit runtime contracts, no implementation):
       ports/contract.js      definePort/assertPort runtime contract primitives
       ports/{store,vcs,clock,ids,config,state,ownership,caseSensitivity,archive}.js
       ports/index.js         PORTS table + assertPorts(deps) injection check
 adapters (the only I/O; implement the ports):
       adapters/store-fs.js   the only module importing node:fs; createStorePort()
       adapters/vcs-git.js    the only module importing node:child_process; createVcsPort()
       adapters/default.js    createDefaultDeps(): the one default port implementation set
 infrastructure (lib/):
       lib/store.js           repo-scoped lock + atomic JSON + activity.jsonl
       lib/git.js             bounded git commands + timeout classification
       lib/config.js          profile/repo config layers over the pure schema
       lib/tower.js           default-deps Tower binding for tests/embedders
       lib/workspaceLock.js   optional one-Tower-session-per-repository advisory lock
       lib/hmr.js             optional DSH HMR bridge (tower_reload / /tower reload)
       lib/modeStore.js       per-agent Tower mode persistence
 pure domain modules (no fs/git):
       domain/errors.js     stable, structural tool error catalog
       domain/batch.js      batch admission create/close/summary validation
       domain/config/schema.js  Schemastery config schema, defaults, validation
       domain/contracts/outputs.js  tool output-schema catalog
       domain/contracts/tool-inputs/  per-area TypeBox input schemas + ToolInputs map
       domain/vocabulary.js  canonical status/type/action enums + predicates
       domain/mission.js    statuses, transitions, pause causes
       domain/gate.js       completion and merge-gate snapshot decisions
       domain/scope.js      glob/scope validation and overlap
       domain/summary.js    mission/finding summaries
       domain/planning.js   mission numbering, dependency DAG, auto-deps
       domain/state.js      load-time state validation
       domain/report.js     board rendering
       domain/roster.js     roster predicates
 tools layer:
       lib/tool-registry.js     registration aggregator + shared guards/helpers
       tools/index.js           thin public wiring (re-exports only)
       tools/*.js               one module per tool, handler + imported input schema
 Subagents
 ├─ tower-worker   (dsh-tower/worker)   read/write/edit/pwsh + mission tools + findings
 └─ tower-reviewer (dsh-tower/reviewer) read/glob/grep + tower_diff + review/finding (read-only)
```


The main checkout is the control-tower repo; each mission has a branch `tower/<id>-<slug>` and a
worktree in `.dsh-tower-worktrees/<hash>/<missionId>`. The plugin never operates on the main checkout's
working tree except merge and the read-only diff.

## Ports and the composition root (#69)

The seam is real, not documented-only. `ports/` exports **runtime contracts**: each module defines a
frozen `{ name, methods }` descriptor plus an `assert*Port` helper, and `ports/index.js` exposes the
`PORTS` table and `assertPorts(deps)`.

`app/**` imports only app siblings, `domain/**`, `ports/**` and `node:path`. Every effectful call goes
through the `deps` object:

| deps member | contract | default implementation |
|---|---|---|
| `store` | StorePort: `pathsFor/exists/ensureDir/readJson/writeJsonAtomic/appendJsonl/withLock/withGitLock/readActivityTail` plus the raw-file and lock primitives `readText/writeText/appendText/rename/renameWithRetry/stat/unlink/readGitLock/gitLockView` | `adapters/store-fs.js` `createStorePort()` |
| `vcs` | VcsPort: `git/tryGit/revParse/isClean/isAncestor/resolveRepo/currentBranch/countCommits/listWorktrees` | `adapters/vcs-git.js` `createVcsPort()` |
| `clock`, `ids` | ClockPort / IdsPort | `adapters/default.js` |
| `config` | ConfigPort: `runtimeConfig/resolveRepoConfig` | `lib/config.js` |
| `state` | StatePort: `loadStateFile` | `lib/stateFile.js` |
| `archive` | ArchivePort: `readIndex/readEntry/writeEntries` | `lib/archive.js` |
| `ownership` | OwnershipPort: `assertOwnership/canonicalPath` | `lib/worktreeOwnership.js` |
| `caseSensitivity` | CaseSensitivityPort: `detect` | `lib/caseSensitivity.js` |

`index.js` is the composition root: it calls `createDefaultDeps()` once and passes the object to
`registerTowerTools`. The registry adopts and validates that object (`assertPorts`) instead of building
its own adapter set, hands every tool an `openTower(repoRoot)` factory bound to those ports, and
`Tower.open(repoRoot, deps)` / `new Tower(repo, config, deps)` validates the object again before use.
`app/tower.js` itself imports no adapter and no `lib/` module. The one piece of lock policy the app and
the store share (the git-mutex budget, #93) is pure and lives in `domain/lockBudget.js`; `lib/store.js`
re-exports it for the infrastructure callers.

`store.rename` and `store.renameWithRetry` are both declared because they are not interchangeable: the
retrying helper has temp-file semantics and removes its source when the rename finally fails, which is
right for a disposable temp file but would destroy the lock bytes `tower_recover` must keep auditable.
The audit rename therefore uses the plain `rename`. The contract test scans `app/**` **and** `tools/**`
for every `deps.<port>.<method>` call and fails if the named port does not declare it, so a tool that
reaches a new port method cannot slip past `assertPorts`.

`lib/` remains the infrastructure layer that implements the adapters' durable behaviour (store, git,
locks, config, archive); #70 retires it by moving the code into the adapters. Until then `lib/` is the
one documented importer of `adapters/**`.

A full mission lifecycle (init → plan → provision → spawn → complete → review → gate → merge →
teardown) runs through the real app use cases on an in-memory store and a scripted vcs:
`tests/ports-lifecycle.test.mjs`. The default adapter set and the in-memory doubles are both asserted
against the same port contracts in `tests/memory-adapters.contract.test.mjs`.

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
5. Dependency missions must be merged/abandoned, except a completed survey dependency which is its terminal success state (#107).
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
| `<git-common-dir>/dsh-tower/state.json` | active missions, roster, reviews, findings, messages, reviews sequence |
| `<git-common-dir>/dsh-tower/archive/index.json` | compact terminal-mission index (ids, status, branch, timestamps) |
| `<git-common-dir>/dsh-tower/archive/<year>.json` | full archived missions plus their linked reviews/findings |
| `<git-common-dir>/dsh-tower/activity.jsonl` | append-only activity |
| `<git-common-dir>/dsh-tower/state.lock` | single-writer state lock (heartbeat reclaim; a recycled PID cannot pin it) |
| `<git-common-dir>/dsh-tower/git.lock` | repo-scoped serialization for git mutations outside the state lock |
| `<git-common-dir>/dsh-tower/lock-holds.jsonl` | state/git lock-hold telemetry |
| `<checkout parent>/.dsh-tower-worktrees/<hash>/<missionId>` | mission worktree |
| `$DSH_HOME/tower-mode/modes.json` | Tower mode per agent/session |
| `$DSH_HOME/tower-mode/modes.lock` | mode-store single-writer lock |

`state.json` and `modes.json` both use an atomic write (temp + rename), token-checked lock release,
heartbeat-based reclamation (a live PID with a silent heartbeat is reclaimed after byte verification;
a live holder that keeps heartbeating is never stolen), and bounded lock waits. `state.json` is the
mission persistence contract; `modes.json` is the per-agent mode contract; neither is written without
its own lock.

## Layering rules

`npm run architecture:check` (also in CI) enforces the rules as **errors**:

- `domain/**` must not import I/O or adapters (`domain-pure`).
- Only `adapters/vcs-git.js` may import `node:child_process`, and only
  `adapters/store-fs.js` may import `node:fs` (`child-process-surface`, `fs-surface`).
  The rule is enforced over the source roots — `lib/`, `app/`, `domain/`, `tools/`,
  `adapters/`, `ports/` — and does not cover `scripts/**`, which holds maintenance
  entry points (release check, mount smoke, docs generators) that may spawn git or npm.
- `tools/**` must stay thin and free of status/type literals (`tools-thin`, `tools-vocabulary`);
  `tools/index.js` is the thin public wiring module (it imports `lib/`, not a `node:` module), while
  registration/shared machinery lives in `lib/tool-registry.js`.
- Aggregate files have size ceilings; top-level mutable state is limited to explicit composition
  roots (`aggregate-size`, `ambient-state`). The per-tool ceiling is 200 lines; `tools/index.js`
  currently sits inside the 40-200 range, so the tools allow-list is empty rather than silently
  exempting the wiring module.
- `app/**` may import only app siblings, `domain/**`, `ports/**` and `node:path` (`app-ports-only`);
  an app module that reaches an adapter or a `lib/` module fails the gate.
- Only the host entries (`index.js`, `worker.js`, `reviewer.js`) and `adapters/**` may import an
  adapter (`composition-root`). `lib/` is the documented infrastructure lapse until #70 retires it;
  `app/`, `tools/`, `domain/` and `ports/` never may.
- Every `ports/**` module must export a runtime contract (`const`/`function`/`class`) and must not
  import an implementation (`port-shape`); a typedef plus `export {}` is no longer accepted.

### Exemptions are justified data

The gate's only exemptions live in `scripts/architecture-waivers.json`; `scripts/architecture.mjs`
keeps no allow-lists of its own. Each entry names the `rule` and `path` and must carry a non-empty
`reason` plus an `owner` or `ref`. An entry missing any of those is itself a blocking
`waiver-contract` violation that names the rule and the path, so a bare path cannot turn the gate
green. The waiver file is a two-key path in `CONTRIBUTING.md`; there is no `reviewBy`/expiry field in
this release, so the reason and the owner are the reviewed decision.

`ambient-state` waivers are narrower than file waivers: they additionally require `match`, the exact
top-level binding (for example `profileRaw`). The scan is statement-aware rather than line-based: it
walks the module's token stream and records every binding of every top-level `let` declaration. A
second declarator (`let profileRaw = {}, evil = 1`), a second statement on the waived binding's line
(`let profileRaw = {}; let evil = 1`), and any new top-level `let` in a previously exempt file are
each their own violation and need their own justified entry. That is why the two process-wide `let`s
in `lib/config.js` and `lib/git.js` are no longer vacuously exempt. Strings, comments, template
literals and regex literals are skipped, and `let` inside a function, block, class or `for (…)`
header is not module-level state.

`domain-pure` and anything under `domain/**` are load-bearing: no waiver may target them, even a
justified one. A `waiver-contract` violation rejects that entry and the underlying rule still fails.

A green run prints `architecture: ok (waivers: N)`; N is the number of entries that actually
suppressed a violation, so a stale waiver is visible in the output and in the tests. The fixture
suite seeds an unjustified waiver (it fails), a justified one (it passes), both same-line bypass
forms — a second declarator and a second statement on the waived binding's line (they fail) — a
justified multi-binding declaration (it passes only when every binding is named), and a new violation
inside each previously exempt file (it fails). A separate fixture seeds one violation per rule, so a
rule that cannot fail is itself a test failure.

## Mount smoke and host internals

`npm run smoke:mount` (#95) boots a real profile through the pinned host instead of mocking the loader.
`scripts/mount-smoke/probe.mjs` is the one file that imports the host's internals — `runProfile` from
`dsh/lib/profile-boot.js` and the layered env from `dsh-app-boot` — because those are the entry points
`dsh` itself calls to compose a profile; the probe uses them to boot without a model, browser, or
session. `scripts/mount-smoke/host.json` is the single host/pnpm pin (a unit test keeps its `dsh` field
equal to the newest `COMPATIBILITY.md` row), so a host bump can move those entry points and may require
probe adjustments in the same change.

## #56 definition of done

All epic DoD items now have an executable gate:

- Pure domain share: **37.9%** (5,993 / 15,820 source lines), enforced by
  `npm run domain:check` (threshold 35%).
- `domain/**` imports no fs, child_process, adapters, app, tools, or lib infrastructure;
  `domain-pure` is a blocking architecture rule.
- Inside the source roots, only `adapters/vcs-git.js` imports `node:child_process`; only
  `adapters/store-fs.js` imports `node:fs`; both are blocking rules whose files are the only
  `child-process-surface`/`fs-surface` entries in `scripts/architecture-waivers.json`.
- `lib`, `app`, and `domain` files stay <= 800 lines; every `tools/**` file stays
  40-200 lines (one handler module per tool; `tools/index.js` is 40-line wiring).
- No `withLock` scope starts a process; the two-phase tests instrument every git call.
- `tools/**` has no status/type/enum literal; vocabulary is owned by
  `domain/vocabulary.js`; the `tools-vocabulary` rule is blocking.
- `validateState` has a four-line body over `domain/state/schema.js` and
  `domain/state/semantics.js`.
- `state.json` and `modes.json` share `lib/persistence.js` atomic write, token-owned
  lock, dead-PID quarantine, and bounded-wait primitives.
- The in-memory lifecycle runs the real app use cases (init → plan → provision → spawn → complete →
  review → gate → merge → teardown) on an in-memory store and scripted vcs supplied through the
  composition root, with no disk, no git and no `defaultDeps` (#69).
- The ten fitness rules are errors, each with a seeded failing fixture; the `waiver-contract` rule
  makes an unjustified exemption blocking as well.



