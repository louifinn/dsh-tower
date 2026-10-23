# Architecture and state machine

## Components

Since #121 the bundle ships a mandatory host anchor plus individually switchable
optional rows: `cordis.patch.yml` declares top-level `tower` (a `cordis:group`
that mounts the Host plugin and the mandatory worker preset), then
`tower-skills`, `tower-batch`, `tower-import`, `tower-leases`, `tower-tests`,
`tower-hmr` (shipped off) and `preset-tower-reviewer`. Turning one optional row
off removes exactly that capability; the host, the diagnostics and the recovery
escape keep working.

[Principle 11](../../PRINCIPLES.md) and
[ADR 0005](../adr/0005-component-surface.md) say a component may exist only for
a capability whose off state leaves the rest intact, and that the host, health,
recovery, review and merge-gate capabilities are never switches. Which keys are
allowed to be switches is a table lookup in
[component-surface.md](../reference/component-surface.md), generated from
`scripts/component-surface.json`; the component count is baselined and checked by
`npm run docs:check:components`. That gate also refuses a `tools.expose*` route
to a tool that is not on the recorded allowlist (empty since #122) and any
`cordis.patch.yml` row that defaults a forbidden key off.

### Row display metadata (#121)

The Plugins page renders an optional row as `row.meta.title ?? row.moduleName`
plus `row.meta.description`. The Host fills `row.meta` by resolving
`<specifier>/locale/en.json` and then every sibling `<lang>.json` in that
directory, reading `meta.title` / `meta.description`; title falls back to the full
module specifier and description to empty when no resource resolves. That is why
the mandatory `tower` card explains itself (the package root ships
`locale/*.json`) while a bare subpath row would show only `dsh-tower/batch`.

Each optional capability therefore ships its own resolvable subpath resource:
`dsh-tower/skills/locale/{en,zh}.json` and the same for `batch`, `import`,
`leases`, `tests` and `hmr`. `package.json` `exports` maps every
`./<capability>/locale/*.json` to `./locale/<capability>/*.json`, and
`files: ["locale/"]` ships the nested tree, so the lookup matches the installed
package. The root `./locale/*.json` export stays so the Tower group keeps its own
`meta`.

The capability files are generated, never hand-written. `npm run
docs:generate:locale` renders them from the `components` block of
`locale/en.json` and `locale/zh.json` (the same source `docs:check:components`
audits): `meta.title` is the component `title`, and `meta.description` joins the
component `summary` (what the capability enables) with its `disables` text (what
turning it off removes) behind a per-language "When off / 关闭后" label. The
row is therefore decidable from the page alone. `npm run
docs:check:generated:locale` fails on drift and is part of `npm run check`.

To label a new capability row:

1. Classify it in `scripts/component-surface.json`, ship it in
   `cordis.patch.yml`, and add `title` / `summary` / `disables` to the
   `components` block of both `locale/en.json` and `locale/zh.json`.
2. Add `{ specifier, component }` to `CAPABILITY_LOCALES` in
   `scripts/generate-capability-locale.mjs`, the matching
   `./<specifier>/locale/*.json` export in `package.json`, and the row to the
   coverage map in `tests/capability-locales.test.mjs`.
3. Run `npm run docs:generate:locale`, then regenerate
   `scripts/pack-manifest.txt` with `npm run pack:check -- --write`.

The reviewer preset row is the one visible component that is not a package
specifier: its label comes from the `cordis.patch.yml` preset `config.name` /
`description`. The generated capability files never touch the root locale `meta`.

```
Host plugin (index.js)
 ├─ /tower command + Tower mode (guard, prompt section, tower_mode/tower_control)
 ├─ host/tool-registry.js -> registration aggregator, actor guards, shared helpers
 │                    (+ 21 define()-registered host tools)
 │                    (+ tower_mode/tower_control registered by the Host entry, 29 total
 │                       once every optional capability row is on)
 │                    (tower_doctor/tower_recover are host tools, never switches)
 ├─ host/capability-*.js -> optional capability entry points (batch/import/leases/tests/hmr)
 ├─ tools/index.js  -> thin public wiring (re-exports the registry + briefings)
 └─ app/tower.js   -> orchestration surface; delegates to use-case modules
       ├─ app/init.js, provision.js, merge.js, rebase.js, teardown.js
       ├─ app/review.js, findings.js, batch.js, messages.js, roster.js
       ├─ app/plan.js, mission.js, checkCompletion.js, spawn.js, recording.js
       ├─ app/spawn-prechecks.js, spawn-support.js, briefing.js
       └─ app/archive.js, gate.js, read.js, board.js, missionContext.js, enrichedMissions.js
 host (composition root + process/session glue; the only layer that may hold ambient state):
       host/tool-registry.js   registration aggregator + shared guards/helpers
       host/config.js          profile/repo config layers over the pure schema
       host/doctor.js          read-only environment contract and health checks
       host/capability-registry.js  mounted-component report for status/doctor
       host/hmr.js             optional DSH HMR bridge (tower_reload / /tower reload)
       host/modeStore.js       per-agent Tower mode persistence
       host/modeState.js       owned in-memory mode state
       host/presets.js         cross-field preset validation before work starts
       host/compatibility.js   COMPATIBILITY.md provenance
       host/tower.js           default-deps Tower binding for tests/embedders
 ports (explicit runtime contracts, no implementation):
       ports/contract.js      definePort/assertPort runtime contract primitives
       ports/{store,vcs,clock,ids,config,state,ownership,caseSensitivity,archive}.js
       ports/index.js         PORTS table + assertPorts(deps) injection check
 adapters (the only I/O; they implement the ports):
       adapters/store-fs.js   the only module importing node:fs; createStorePort()
       adapters/vcs-git.js    the only module importing node:child_process; createVcsPort()
       adapters/git.js        bounded git commands + timeout classification
       adapters/store.js      repo-scoped lock + atomic JSON + activity.jsonl
       adapters/persistence.js  shared atomic write / lock / heartbeat primitives
       adapters/archive.js    terminal-mission archive files
       adapters/leases.js     repo-scoped advisory lease ledger
       adapters/workspaceLock.js  optional one-Tower-session-per-repository lock
       adapters/worktreeOwnership.js  worktree identity verification
       adapters/stateFile.js  state-file load/migrate/persist
       adapters/caseSensitivity.js  filesystem case-folding probe
       adapters/legacy.js     read-only legacy snapshot validation + storage
       adapters/tests.js      test discovery execution + TAP/JSON parsing
       adapters/default.js    createDefaultDeps(): the one default port implementation set
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
| `config` | ConfigPort: `runtimeConfig/resolveRepoConfig` | `host/config.js` |
| `state` | StatePort: `loadStateFile` | `adapters/stateFile.js` |
| `archive` | ArchivePort: `readIndex/readEntry/writeEntries` | `adapters/archive.js` |
| `ownership` | OwnershipPort: `assertOwnership/canonicalPath` | `adapters/worktreeOwnership.js` |
| `caseSensitivity` | CaseSensitivityPort: `detect` | `adapters/caseSensitivity.js` |

`index.js` is the composition root: it calls `createDefaultDeps()` once and passes the object to
`registerTowerTools`. The registry adopts and validates that object (`assertPorts`) instead of building
its own adapter set, hands every tool an `openTower(repoRoot)` factory bound to those ports, and
`Tower.open(repoRoot, deps)` / `new Tower(repo, config, deps)` validates the object again before use.
`app/tower.js` itself imports no adapter and no `host/` module. The one piece of lock policy the app and
the store share (the git-mutex budget, #93) is pure and lives in `domain/lockBudget.js`;
`adapters/store.js` re-exports it for the infrastructure callers.

`store.rename` and `store.renameWithRetry` are both declared because they are not interchangeable: the
retrying helper has temp-file semantics and removes its source when the rename finally fails, which is
right for a disposable temp file but would destroy the lock bytes `tower_recover` must keep auditable.
The audit rename therefore uses the plain `rename`. The contract test scans `app/**` **and** `tools/**`
for every `deps.<port>.<method>` call and fails if the named port does not declare it, so a tool that
reaches a new port method cannot slip past `assertPorts`.

`lib/` no longer exists (#70): every module was `git mv`-ed into the layer that owns it. The I/O
implementations now sit in `adapters/` (`store`, `persistence`, `git`, `archive`, `stateFile`,
`leases`, `workspaceLock`, `worktreeOwnership`, `caseSensitivity`, `legacy`, `tests`), the
composition root and process/session glue in `host/`, and spawn policy in `app/`. `host/**` is the
only source root, besides `adapters/**` itself, allowed to import an adapter; `app/**` and `domain/**`
may not import `lib/**` (rule `no-lib-from-core`) and may not hold ambient module state
(`host-scope`). Tools receive effectful helpers from the registry instead of importing an adapter.

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
  The rule is enforced over the source roots — `host/`, `app/`, `domain/`, `tools/`,
  `adapters/`, `ports/` — and does not cover `scripts/**`, which holds maintenance
  entry points (release check, mount smoke, docs generators) that may spawn git or npm.
  The optional Web client (`ui-bundle/`) is its own tier with its own rules.
- `tools/**` must stay thin and free of status/type literals (`tools-thin`, `tools-vocabulary`);
  `tools/index.js` is the thin public wiring module (it imports `host/tool-registry.js`, not a
  `node:` module), while registration/shared machinery lives in `host/tool-registry.js`.
  Tools receive effectful helpers (repository resolution, leases, recovery, legacy import) from
  the registry instead of importing an adapter.
- Aggregate files have size ceilings; top-level mutable state is limited to `host/**`
  (`aggregate-size`, `host-scope`). The per-tool ceiling is 200 lines; `tools/index.js`
  currently sits inside the 40-200 range, so the tools allow-list is empty rather than silently
  exempting the wiring module.
- `app/**` may import only app siblings, `domain/**`, `ports/**` and `node:path` (`app-ports-only`);
  an app module that reaches an adapter, a `host/` module or `lib/` fails the gate.
- `app/**` and `domain/**` may not import the retired `lib/` layer (`no-lib-from-core`); with the
  layer gone this keeps it from creeping back.
- `host/**` is the only source root that may hold ambient module state (`host-scope`);
  `app/**` and `domain/**` must stay stateless at module scope. Only `host/**` and `adapters/**`
  may import an adapter (`composition-root`); `app/`, `tools/`, `domain/` and `ports/` never may.
- Every `ports/**` module must export a runtime contract (`const`/`function`/`class`) and must not
  import an implementation (`port-shape`); a typedef plus `export {}` is no longer accepted.
- `ui-bundle/**` is a browser tier, not host code (#71): no `node:*` import
  (`client-no-node` — DOM globals are fine; host capabilities must come through the
  plugin's registration surface), every client file stays at or below 800 lines
  (`client-size`), and module-level mutable state is banned exactly as it is for
  `app/**` (`client-ambient`); the split surfaces keep their state inside the
  `create*` closure the entry composes. `ui-bundle/` is also excluded from
  `aggregate-size`, which it would otherwise duplicate.

### Exemptions are justified data

The gate's only exemptions live in `scripts/architecture-waivers.json`; `scripts/architecture.mjs`
keeps no allow-lists of its own. Since #70 the file has exactly two entries, both I/O adapter
boundaries (`adapters/vcs-git.js` for `node:child_process` and `adapters/store-fs.js` for
`node:fs`). Each entry names the `rule` and `path` and must carry a non-empty `reason` plus an
`owner` or `ref`. An entry missing any of those is itself a blocking `waiver-contract` violation
that names the rule and the path, so a bare path cannot turn the gate green. The waiver file is a
two-key path in `CONTRIBUTING.md`; there is no `reviewBy`/expiry field in this release, so the
reason and the owner are the reviewed decision.

`host-scope` replaces the old `ambient-state` waivers (#70). It scans `app/**` and `domain/**` and
records every module-level `let`; `host/**` owns the process/session state and needs no waiver. The
scan is statement-aware rather than line-based: it walks the module's token stream and records every
binding of every top-level `let` declaration. A second declarator (`let a = 1, b = 2`), a second
statement on one line (`let a = 1; let b = 2`), and any new top-level `let` in `app/` or `domain/`
are each their own violation. Strings, comments, template literals and regex literals are skipped,
and `let` inside a function, block, class or `for (…)` header is not module-level state.

`domain-pure`, `host-scope`, `no-lib-from-core`, and anything under `domain/**` are load-bearing: no
waiver may target them, even a justified one. A `waiver-contract` violation rejects that entry and
the underlying rule still fails.

A green run prints `architecture: ok (waivers: N)`; N is the number of entries that actually
suppressed a violation, so a stale waiver is visible in the output and in the tests. The fixture
suite seeds an unjustified waiver (it fails), a justified one (it passes), a `host-scope` fixture
that puts ambient state in `host/` (allowed) and in `app/`/`domain/` (rejected), a `no-lib-from-core`
import from `app/` (rejected), a same-line second binding (rejected), and a new violation inside
each rule. A separate fixture seeds one violation per rule, so a rule that cannot fail is itself a
test failure.

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

- Pure domain share: **39.5%** (7,475 / 18,936 host source lines), enforced by
  `npm run domain:check` (threshold 35%). `npm run domain:metrics` also prints a
  separate `ui-bundle` line, so Web-client growth is visible in CI output while the
  share itself still measures the Host architecture.
- `domain/**` imports no fs, child_process, adapters, app, tools, or host infrastructure;
  `domain-pure` is a blocking architecture rule.
- Inside the source roots, only `adapters/vcs-git.js` imports `node:child_process`; only
  `adapters/store-fs.js` imports `node:fs`; both are blocking rules whose files are the only
  `child-process-surface`/`fs-surface` entries in `scripts/architecture-waivers.json`.
- `host`, `app`, and `domain` files stay <= 800 lines; the same ceiling applies to
  `ui-bundle/**` (`client-size`); every `tools/**` file stays
  40-200 lines (one handler module per tool; `tools/index.js` is 40-line wiring).
- No `withLock` scope starts a process; the two-phase tests instrument every git call.
- `tools/**` has no status/type/enum literal; vocabulary is owned by
  `domain/vocabulary.js`; the `tools-vocabulary` rule is blocking.
- `validateState` has a four-line body over `domain/state/schema.js` and
  `domain/state/semantics.js`.
- `state.json` and `modes.json` share `adapters/persistence.js` atomic write, token-owned
  lock, dead-PID quarantine, and bounded-wait primitives.
- The in-memory lifecycle runs the real app use cases (init → plan → provision → spawn → complete →
  review → gate → merge → teardown) on an in-memory store and scripted vcs supplied through the
  composition root, with no disk, no git and no `defaultDeps` (#69).
- The eleven host fitness rules are errors, each with a seeded failing fixture; the
  three `client-*` rules form the Web-client tier with one fixture each, and the
  `waiver-contract` rule makes an unjustified exemption blocking as well.

## Non-goals

This layer map is not a dependency-injection container, a service locator, or a
place to register classes by reflection. Ports stay runtime contracts and the
composition root stays the only place that assembles implementations.

Enforced by: `scripts/architecture.mjs` and `ports/index.js`; tests in
`tests/architecture.test.mjs`; gate: `npm run architecture:check`.



