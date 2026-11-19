# Tower tests

The test suite has three layers: pure functions, protocol end-to-end, and a real DSH Web runtime. The first two need no DSH process; the third runs in a **throwaway profile** on another port and never touches the profile you are using.

All commands below run from the **repository root** (the directory containing `package.json`). `$DSH_HOME` is the DSH data directory (default `~/.dsh`; on Windows usually `C:\Users\<you>\.dsh`).

## 1. Offline suite (run before every change)

```powershell
npm test
# equivalent to: node --test "tests/*.test.mjs"
```

> Node's `--test` no longer accepts a directory argument; pass a glob instead. A bare directory fails with `Cannot find module`.

The offline suites are grouped by concern; each file runs as its own process with real temporary Git repositories and cleans them up:

- `cleanup.test.mjs` — the shared teardown helper: bounded retry/backoff for `EPERM`/`EBUSY`/`EACCES`, the quarantine rename after the first transient failure, the `os.tmpdir()` isolation guard, and a seeded real Windows `FileShare.None` handle that must be released before the tree can be removed (declared with `skip:` off Windows, so Linux reports it as `# SKIP`). It also covers `tower_teardown`'s mission-worktree removal with the same bounded retry (the decision reports `attempts`; a permanent failure keeps the mission record and the final error), its `exclude` reporting (matched ids stay protected, unmatched ids appear in `unmatchedExclude` with a `keep` decision whose reason is `exclude did not match any mission`), and its explicit `orphans: true` sweep (#185): git worktrees under the root that no mission, sandbox or review row references get one decision each, only clean checkouts are removed (a dirty one is kept, a registration whose directory is gone is pruned), and the main checkout, every state-referenced path and every path outside the root are always kept. A normal teardown never looks at them, and a `dry_run` previews the decisions without removing or pruning anything.
- `unit.test.mjs` — pure helpers: scope overlap, scope validation, printable-Unicode titles (NFC, 120-character bound), glob matching.
- `unicode-titles.test.mjs` — a non-ASCII title round-trips `tower_plan` → state → `tower_inspect` with `view: "status"` → `MISSIONS.md` → briefing, the board table stays aligned, and invisible/over-long titles are rejected.
- `platform.test.mjs` — the platform branches, asserted on every OS: win32 path case folding (`isInside`), the `pwsh`/`bash` discovery shell (`shellSpec`), the transient rename/unlink retry loops via injected syscalls, and worktree path identity (`compareKey`). The one real-Windows case (renaming over an open destination) is declared with `skip:` so Linux reports it as `# SKIP` rather than dropping it.
- `errors.test.mjs` — the stable `[tower:<code>]` classifier for every documented failure family, and the #74 recovery contract: every catalog `nextAction` renders exactly once, codes without one stay byte-identical, retryable codes mark the suffix, and a message that already contains its action is not suffixed twice.
- `events.test.mjs` — #75 domain events: transitions return `{ state, events }`, the app persists then emits `tower.mission.planned/completed/reviewed/merged/abandoned` with `{ missionId, revision, at }` (+`commit` for merged), planning emits before the tool returns, failed tools emit nothing, and `tower/<tool>` remains as a tested deprecated alias.
- `config.repo.test.mjs` — repository config layer: path, precedence, legacy keys, and invalid input codes.
- `findings.test.mjs` — the finding lifecycle through the domain class.
- `protocol.e2e.test.mjs` — drives the `Tower` class through a real temporary Git repository: init → plan → worktree → tasks → unread-inbox block → complete → finding → review → preflight → merge → teardown, plus automatic dependency for overlapping scopes and rejection of unknown dependencies.
- `plugin.test.mjs` — loads the real `apply()` from the repository-root `index.js` against a minimal mock Cordis context: every `/tower` input form, attachment forwarding, a complete `UserMessage` reaching `agent.steer`, guard denials, the dynamic prompt section, goal pausing, `tower_mode` write gating and reason validation, and mode persistence. It points `$DSH_HOME` at a temp directory and never writes the real store.
- `state-machine.test.mjs` — the documented mission transition table (allowed and denied) and the completion/merge entry points. The former seeded 200-step fuzz moved to `tests/property/state-machine.prop.mjs`, where fast-check shrinks a failing sequence instead of printing an unshrinkable loop.
- `no-random.test.mjs` — the #130 PRNG guard: walks `tests/**/*.mjs` / `*.cjs` and fails if test inputs use `Math.random`, an inlined PRNG (mulberry32, xorshift, sfc32, splitmix, seedrandom, LCG, `Math.imul`) or `node:crypto` randomness. The exemption list is explicit (live runtime plumbing, the cleanup helper's quarantine names, and the long-tier seed in the property harness) and a meta-test proves the scanner is not vacuous.
- `release-gate.test.mjs` — the `release:check` claim over real temporary Git repositories (branch, tag and prepublish modes: annotated/lightweight/unreachable tags, dirty trees, support drift, changelog and version-bump rules) plus the in-scope docs pages that restate the release contract. #M79 adds the tag-push checkout simulation: an annotated origin tag reads as `tag`; the checkout's `+<commit>:refs/tags/<tag>` fetch turns it into `commit` and the CLI fails with `[tag-lightweight]`; the workflow's own restore fetch puts the annotated object back, `git cat-file -t` reports `tag`, and the CLI passes.
- `workflow-contract.test.mjs` — the CI contract (#M72/W5-D): `scripts/check-workflow.mjs` must find the canonical `npm run check` on the three supported legs, the four required contexts (those three legs plus the `mount` job), no legacy `test` job, least-privilege permissions, per-ref cancellation, SHA-pinned actions, npm caching, bounded artifact retention and the schedule-only nightly failure reporter. Every rule has a tamper case that edits the real workflow text and expects the named problem, so the gate cannot go vacuous. #M79 adds the tag-push rule: the canonical job must force-fetch the pushed tag ref (`git fetch --force origin "+refs/tags/${GITHUB_REF_NAME}:refs/tags/${GITHUB_REF_NAME}"`) before `npm run release:check`, gated by `matrix.release` and `github.ref_type == 'tag'`; tamper cases drop the step, move it after the release check, ungate it, fetch the commit SHA instead of the ref, or drop `--force`.
- `activity-rotation.test.mjs` — #M76 bounded activity log: the pure policy/segment/plan helpers, append-driven rotation with retention, chronological tail reads across segments (including corrupt/truncated lines), the fallback that keeps appending to the live file when a rename cannot land, and `inspectActivityLog` accounting for doctor/status.
- `roles.test.mjs` — actor-role matrix with fake `subagents`: workers cannot change status/scope/blockers/pause metadata, workers can update tasks/notes/blockers, reviewers read findings but cannot mutate them, and tower-only tools reject roster workers without side effects.
- `interrupt.test.mjs` — `tower_interrupt` targets the child session id, records the roster as interrupted, is idempotent for idle agents, and `tower_send interrupt:true` interrupts before delivering.
- `workspace-lock.test.mjs` — the advisory `<git-common-dir>/dsh-tower/tower.lock` (acquire/self reacquire/touch/release/stale takeover/corrupt lock) and the mode-level rule that a second Tower session is refused with `[tower:workspace-busy]` until the first runs `/tower off`.
- `concurrency.test.mjs` — `spawn.maxLiveWorkers`, `tower_send` per-minute rate limiting, stale roster entries (`spawn.staleMs`), and parallel writers serializing on the state lock with a monotonic revision. Also pins the #148 budget shape: a live survey row does not consume a build slot, a survey spawn is allowed while build slots are full, and a second build is refused with `worker-limit`.
- `roster-watchdog.test.mjs` — F73 roster truth: an empty descendant catalog is never authoritative; a live row needs consecutive missing observations spanning twice `spawn.staleMs` before it can go stale; a stale-marked row that calls `tower_complete` itself is revived and recorded, because a stopped worker cannot call tools; `staleMs: 0` disables the watchdog without writing state or activity. The race cases are pinned with an injectable seam (`rosterView` parked between the snapshot and the sweep; `checkCompletion` preempted by a sweep): a row revived mid-tick stays active, a completion that races a parked tick closes its row with no `worker-stale` blocker, and a sweep that wins the lock before the commit is re-prepared instead of refused.
- `survey-lifecycle.test.mjs` — the survey shape against a real temporary Git repository: planning records `readCommit`/`readDirty` and no worktree/branch/baseCommit, a moved shared checkout refuses planning, provisioning is the shared checkout, completion enforces HEAD and the tracked-status fingerprint with zero commits, merge/rebase/preflight/diff are refused, a completed survey is terminal for archive/reanchor/open work, and the `tower-survey` row off refuses planning with an actionable code.
- `shape-registry.test.mjs` / `shape-migration.test.mjs` — the shape kernel (per-kind statuses, `isTerminal`/`canTransition` agreement, `dependencySatisfied`, action refusals, `migrateLegacy` fixed point) and the v3 → v4 per-kind schema migration (a branch-shaped survey becomes a read-only record, a build is unchanged, one-way and idempotent).
- `faults.test.mjs` — corrupt/unsupported state JSON (`state-corrupt`), a held writer lock (`state-locked`), and a vanished worktree reported as `branch-missing` instead of throwing.
- `status.test.mjs` — the `tower_inspect` `status` view: pagination, one-mission detail, `includeGate` digests, `format:"markdown"` and the `MISSIONS.md` board written by mutations.
- `tasks-view.test.mjs` / `tasks-command.test.mjs` — #160 read-only `/tasks` roster panel: the pure projection (silence sort, second/hour/day labels, terminal-state hiding, the 20-row cap, the `(no tool yet)` fallback) and the command end-to-end (host `tasks`-name collision fallback, the `/tower tasks` alias, zero writes to `state.json`/the activity log/the mode store both with Tower mode off and on, the `tower_init` remedy for an uninitialized repo, and stale parity with the `tower_inspect` `roster` view).
- `report-cap.test.mjs` — `tower_complete.report` is capped in UTF-8 bytes (`gates.maxReportBytes`, 32 KiB default): a 40 KB report is rejected with the worktree `nextAction` and no state write, 30 KB of CJK is accepted, `reportBytes` is persisted, the paged summary omits the body, doctor names the largest report, and pre-cap completions load unchanged.
- `briefing.test.mjs` — worker/reviewer briefing history injection (previous review rounds, findings, completion report and checks) and truncation bounds, including a real `missionContext` fixture.
- `tool-names.test.mjs` — #75 folded: every `tower_*` name referenced in `app/briefing.js` and `skills/*.md` exists in the real registered tool surface, and a seeded rename fixture fails with file and line.
- `init.test.mjs` — `tower_init` policies: `autoGitInit` in a plain directory, `snapshotDirty` mission baselines, `reanchor` preconditions, and dirty-tree reporting.
- `tools.test.mjs` / `tool-schemas.test.mjs` / `spawn.mock.test.mjs` — tool surface, aliases, stable error prefixes, full output-schema walk, and mock-spawn role/preset/briefing behavior.
- `hmr.test.mjs` / `reload.test.mjs` — the HMR bridge (availability, scheduling, error codes, CLI block editing) and the `/tower reload` + `tower_reload` wiring.
- `regressions.test.mjs` — fixes found in the 2.0 review round: spawn limit must reject before any activation, repo-config `send.interruptDefault`/`init.snapshotDirty`, and classifier coverage for actionable refusals.
- `discovery.test.mjs` / `batch.test.mjs` — test-discovery config/TAP/json parsing, budgets, receipts, and pure batch create/close validation.
- `leases.test.mjs` / `legacy.test.mjs` / `worktree-ownership.test.mjs` — advisory leases, Tower Codex/DSH legacy import + audit mapping, and realpath/worktree ownership checks.
- `integration-2.1.test.mjs` — end-to-end 2.1: references/review exemption, discovery admission/auto checks, failing admission without a child, batch close, leases/requireLease, legacy import/map, doctor, stale watchdog gate, board location, delivery ack, `gates.requireTests`.
- `plan-mode.test.mjs` — Tower entry clears/refuses plan mode and the pre-step keeps them mutually exclusive.
- `ralph-stance.test.mjs` — #162 Tower/Ralph mutual exclusion: tool denial stays #161's owner-derived `mode.denyTools` default, the command-owner table shadows `/ralph` with an actionable refusal while Tower mode is active (and the pre-step listener re-mounts it after a restart), entry with a live stub loop stops and records the release (`mode.ralphPolicy:"refuse"` rejects), Ralph round agents are refused while their repository is under Tower mode (so a renamed entry point cannot restart a loop), `tower_inspect({ view: "doctor" })` reports the loop as an environment fact, and `tower_mode` exposes the policy and live counts.
- `ui-bundle.test.mjs` — plain-JS UI chunk format/syntax, the 400-line split budget, toolview/dock/overlay registrations, locale parity and glossary terms, localized enum labels, `/tower` command-semantics no-ops, dock storage validation/failure containment, accessibility labels/roles/live regions, theme tokens and defensive rendering.
- `locale-copy.test.mjs` — the copy gate over the root locale, generated row locales, ui-bundle meta and the `ui-bundle/client.locales.js` client dictionary (en/zh parity, emptiness, glossary, untranslated English); banned config/tool/command/module syntax is applied to page copy and intentionally not to client tooltips that quote `/tower` and `tower_mode`.
- `plugin-config-client.test.mjs` — the review-policy settings control: registration, three native radio options, save/refuse/restart states, and its labelled-group/described-option/live-status accessibility contract.
- `test-shards.test.mjs` — the bounded local runner (`scripts/test-shards.mjs`): its planned file set equals the live `tests/*.test.mjs` set exactly (no duplicates, no silent skips), batch sizes respect the limit and reconstruct the input order, a failing batch still runs the remaining batches and yields exit code 1, and the CLI forwards `node --test` arguments after `--`.

> CI keeps running `npm run check` (and therefore `npm test`). On a constrained Windows machine, or when several
> agents share the host, run the same suite through the bounded runner instead:
>
> ```powershell
> npm run test:shards                # tests/*.test.mjs in sequential batches of 25
> npm run test:shards -- --size 10   # smaller batches on a busier host
> ```
>
> It binds the same file set, puts at most `--size` files in flight, runs every batch even after a failure, and
> exits 1 if any batch failed. `tests/test-shards.test.mjs` pins the file-set equality, so the fallback cannot
> silently skip a file. This changes only how a loaded local machine runs the suite; CI behaviour is untouched.

All temporary repositories and state are created under the OS temp directory and cleaned up automatically. Teardown goes through `tests/helpers/cleanup.mjs`: it retries transient `EPERM`/`EBUSY`/`EACCES` failures with bounded backoff, moves the tree to a fresh sibling name after the first one, and refuses any target that is not a strict child of `os.tmpdir()`. Do not delete a test-owned tree directly — Windows can still hold a handle after the test that created it has finished, and a bare recursive delete turns a green suite red at random. The retry path is proven by `tests/cleanup.test.mjs`, including a real Windows handle.

### Windows fallback

Parallel file execution is the default and stays the default: `npm test` runs one process per file, exactly as CI does. The supported constrained-machine fallback is [`npm run test:shards`](#1-offline-suite-run-before-every-change) — the same file set in sequential batches of 25, with every batch reported and a failing batch never skipping the rest. If a single file still fails, `node --test tests/<file>.test.mjs` isolates it; `node --test --test-concurrency=1 tests/*.test.mjs` serialises the whole suite to confirm a resource hypothesis. Those are diagnostics, not the fix: a green run that only passes when serialised still has a real teardown or resource problem, so report it instead of weakening the test.

Load-sensitive tests wait on observable state, not fixed sleeps: the lock-heartbeat case derives its freshness expectations from the doctor's own reported `heartbeatAgeMs`/`staleAfterMs` (so a slow inspection cannot age a fresh record past a fixed window), the parallel-writer case raises `mode.lockTimeoutMs` — the budget `Tower.withStateLock` passes to the state lock — so a loaded runner does not time out while the exact revision delta is still asserted, and the git-mutex case waits for the merge to reach `git merge --no-ff` or the operation to settle, with a 60 s guard only against a wedged process, instead of betting on 5 s of wall clock. Residual constraint: on Windows the filesystem can still hold a handle after a child process exits, so a full parallel `npm test` can accumulate rename/unlink pressure even when each file passes; that is what `npm run test:shards` bounds. The exclusive lock-record create also retries the transient `EPERM`/`EBUSY`/`EACCES` sharing violations inside a 1.5 s budget (proven by `tests/lock-kernel.test.mjs`), so an antivirus or indexer hold on `git.lock` is waited out rather than surfacing as a false red. No assertion is weakened to make either run green.

### Coverage and watch mode

```powershell
npm run test:coverage   # same suite plus Node's experimental coverage report
npm run test:watch      # re-run the offline suite while editing
```

Coverage is a diagnostic, not a gate; the meaningful signal is that the offline suite is green and the new behaviour has a dedicated case.

### Property-based tests (fast-check, #130)

The offline suite above is example-based; `tests/property/*.prop.mjs` adds generated inputs on top of it, using [fast-check](https://fast-check.dev/) v4 with `node:test` as the only runner. The generators live in `tests/property/arbitraries/` (mission, status, review, finding, config, state, path/scope, commit sha, merge-gate evidence) and produce **schema-shaped values only** — they never read the filesystem, a git repository, a subprocess or the network. The shared harness is `tests/property/helpers/harness.mjs`.

Twelve files carry **121 property cases** (the PR tier therefore generates 121 × 3 seeds × 100 runs = **36,300 inputs** per run; the long tier 121 × 2000 = 242,000):

- `smoke.prop.mjs` — the first smoke set: state shape/semantics, config resolution, relative scope entries, absolute/`..` scope rejection, commit-sha shape.
- `transition-graph.prop.mjs` — the transition table, terminal statuses and edge reachability checked against an independently written model, plus terminal absorption (every status/blocker patch rejected byte-identically, note-only updates accepted).
- `state-machine.prop.mjs` — the flagship model-based property: an `fc.commands` walk over ten mission operations compared with `tests/property/model/state-machine-model.mjs`; rejected commands are no-ops, accepted commands bump the revision by exactly one and stay atomic, and the merge gate matches the model.
- `state-semantics-roundtrip.prop.mjs` — `validateState` accepts schema-valid states and rejects 21 semantic corruptions, JSON round-trips are fixed points, and state migration/migration refusal behave as documented.
- `no-illegal-path.prop.mjs` — illegal mission sequences stay rejected and leave state unchanged; frozen completion/merge blocker matrices; the tower override is pinned.
- `scope-algebra.prop.mjs` — property 7: `fileInScope` agrees with an independently written naive matcher for `*`/`**`/`?`, `scopesOverlap` is symmetric and a sound over-approximation (a shared concrete file always implies overlap, inline-prefix globs included; overlap may over-approximate but never under-approximates a provably shared path), and case-insensitive mode folds both sides.
- `scope-normalization.prop.mjs` — property 8: `normalizeScope` is idempotent, absolute/`..`/hostile inputs are rejected with `invalid-argument`, `validateTitle` accepts Unicode after NFC, counts code points (not UTF-16 units), and rejects bidi/zero-width/control/over-long titles before and after normalization.
- `gate-monotonicity.prop.mjs` — property 9: worsening completion or merge evidence (extra blocker, open task, missing checks, unknown/stale/busy worker, missing test receipt at a moved tip, worse review status/verdict) never removes an existing blocker or unblocks the gate; unrelated fields leave the blocker set unchanged. The documented exception — `running → inactive` clears `worker-busy` because the roster state *is* the evidence — is frozen explicitly.
- `config-resolution.prop.mjs` — property 10: `resolveTowerConfig` is total over valid configs, is strictly one-pass idempotent (`resolve(resolve(raw))` deep-equals `resolve(raw)` for every generated config, including `{}`), all 16 `gates.requireTests` × `tests` group cells resolve (the old `true` + `enabled:false` contradiction retired with the `tests.enabled` switch, #136), and a config that still writes `tests.enabled` is rejected as `config-unknown-key`.
- `error-catalogue.prop.mjs` — property 11: every `ERROR_CODES` entry is complete and reachable through `classifyError`, `renderErrorMessage` appends the ` — next:` segment exactly once (never twice), and a static scan proves every literal production constructor code is catalogued.
- `boundaries.prop.mjs` — W5 boundary properties: the `host/tool-registry.js` facade re-exports each split-module binding from exactly one home, tool registration is a sorted idempotent set independent of order, component enablement follows its reference count in frozen row order, and the pure rotation plan keeps an ordered suffix within the configured segment budget without a filesystem read.

Two tiers exist so the suite is affordable on every change and still thorough nightly:

- **PR tier** — `npm run test:property`. 100 runs per seed × three fixed seeds (`PR_SEEDS` in the harness). Deterministic: the same seeds always generate the same inputs, so a red build is reproducible. This runs inside `npm run check`; each canonical CI leg runs that command once, so the PR tier runs on all three supported runtime legs.
- **Long tier** — `npm run test:property:long`. 2000 runs on one seed drawn from `node:crypto`, plus an `fc.statistics` distribution report for each property that supplies a `classify` function, so a shrinking corpus or a lopsided generator shows up in the log. It runs only in the nightly/manual `property-long` CI job (`schedule` / `workflow_dispatch`, never on push or pull_request) and locally with `npm run test:property:long` (the script selects the tier through `tests/property/tiers/long.env` and `node --env-file`, which works on Windows and POSIX).

A failing property is replayable. Re-run the same seed and the recorded fast-check path:

```powershell
# POSIX
FC_SEED=131 FC_PATH=0:4:0:2:0:2:0:0 node --test tests/property/scope-algebra.prop.mjs
# PowerShell
$env:FC_SEED='131'; $env:FC_PATH='0:4:0:2:0:2:0:0'; node --test tests/property/scope-algebra.prop.mjs
```

`FC_SEED` alone switches every property in every file to that seed (comma-separate several); `FC_PATH` without `FC_SEED` is an error, because a path is only meaningful for its seed. **`FC_PATH` is per file, not per property:** the harness applies it to every `*.prop.mjs` Node happens to run, so a foreign path can make an unrelated property fail before it replays. Replay the failing file only (as above), or restrict the run with `node --test --test-name-pattern "<property name>" tests/property/*.prop.mjs` so only the recorded property executes. The harness does not edit files or the counterexample; it just feeds the same generator.

When a property fails the harness also writes a JSON artifact to `tests/property/.artifacts/` (gitignored) with the test name, tier, seed, path, run count, counterexample, error and the exact replay environment. The nightly `property-long` job uploads that directory on failure. Writing artifacts is the harness's only filesystem side effect; keep properties themselves pure.

The same PR also added `tests/no-random.test.mjs`, which fails if a future test reintroduces a hand-rolled PRNG instead of using fast-check. It scans every `tests/**/*.mjs` / `*.cjs` file for `Math.random`, mulberry32, xorshift, sfc32, splitmix, seedrandom, LCG/linear-congruential code, `Math.imul` mixing, and `randomUUID`/`randomBytes`/`randomInt`/`randomFill` used as a test input. The documented exemptions are `tests/live/**` (runtime plumbing), `tests/helpers/cleanup.mjs` (quarantine directory names) and `tests/property/helpers/harness.mjs` (the long tier's `node:crypto` seed, which fast-check replay covers); an inline `prng-guard: allow <reason>` annotation is available for a future justified exception. Seed selection belongs to fast-check plus `FC_SEED`/`FC_PATH`, not to a local PRNG.

### CI: the canonical gate, the four required contexts and the workflow contract (#M72/W5-D)

CI does not keep its own hand-maintained list of gates. The `canonical` job runs `npm run check`
**exactly once** on each supported leg — `test (24.9)`, `test (25)` and `test (24.9, windows)` — and the
Ubuntu Node 24.9 leg adds the tag-only release check, the coverage table and
`npm run test:live -- --check`. `npm run check` includes `npm run workflow:check`
(`scripts/check-workflow.mjs`), so the workflow contract is checked locally and in every canonical leg;
the tamper cases live in `tests/workflow-contract.test.mjs`.

The tag-push release leg preserves the annotated tag object (#M79): `actions/checkout` runs with
`fetch-tags: false` and fetches a tag push's *commit* into `refs/tags/<tag>`, so the workflow
force-fetches the tag ref itself before `npm run release:check`. The check is not weakened — a genuine
lightweight tag still resolves to `commit` and is refused. `tests/release-gate.test.mjs` reproduces the
overwrite against a real clone: the origin tag is annotated (`tag`), the simulated checkout fetch turns
the local ref into `commit` and the release check fails with `[tag-lightweight]`, then the workflow's
own restore command (asserted present in the workflow text) puts the annotated object back and the
check passes.

The branch-protection cutover is complete. `main` requires exactly four contexts under `strict`
protection: `mount`, `test (24.9)`, `test (25)` and `test (24.9, windows)`. The legacy `test` job is
deleted and the contract gate rejects a reintroduced one.
[docs/operations/ci.md](../docs/operations/ci.md) documents the two-step cutover and
the SHA pins (every action — including the mount-fixtures cache and the live diagnostics upload — is
pinned to a 40-hex commit with a `# vX.Y.Z` comment; `tests/mount-smoke.test.mjs` and
`tests/live-harness.test.mjs` require those pinned forms). Run the gates locally with:

```powershell
npm run workflow:check
node --test tests/workflow-contract.test.mjs
```

### 2.9.5 release evidence (2026-11-19)

The bounded suite is **126 `tests/*.test.mjs` files**, run as six sequential `node --test <files...>`
batches through the bounded runner (`npm run test:shards`, 25 files per batch) on Windows 11 with Node
`v25.8.1` (never an unbounded `npm test`). Declarations are counted, so the one skip is included in the
total:

| Run | Command | Declarations | Result |
|---|---|---|---|
| Bounded offline suite, all 126 files | `npm run test:shards` (six sequential batches of at most 25 files) | **1280** | 1279 pass, 1 skip, 0 fail |
| Property PR tier (12 files) | `npm run test:property` | **121** | 121 pass, 0 fail (121 × 3 seeds × 100 runs = 36,300 generated inputs) |
| Mount smoke | `npm run smoke:mount` | — | 16/16 default tools, 3 skills, 4 presets (4 distinct labels), `/tower` present, 1 top-level bundle row on pinned `@deepseek-ai/dsh@0.2.2-rc.3` (91.1 s) |

The single skip is still the POSIX-only `TMPDIR` guard in
[`tests/live-harness.test.mjs`](live-harness.test.mjs) (declared with `skip:` on win32). No file is
excluded from the batches: `concurrency.test.mjs`, `lock-heartbeat.test.mjs`,
`git-mutex-budget.test.mjs`, `lock-kernel.test.mjs` and `roster-watchdog.test.mjs` run inside them and
passed. The F87 cases in [`workspace-lock.test.mjs`](workspace-lock.test.mjs) (recovery through the real
`tower_recover` tool path, the 30 s torn grace, and the unreadable/live-holder refusals) and the two F85
cases in [`ui-bundle.test.mjs`](ui-bundle.test.mjs) (the live UI key table derives from the bundle's
`TOOL_NAMES`, plus the negative proof) run inside the batch and passed. These are the current totals;
the W5 table below is the historical record of `feat/2.8.0-structure` at `bad249c` and is kept as
written.

### 2.9.4 release evidence (2026-11-19)

The bounded suite is **126 `tests/*.test.mjs` files**, run as six sequential `node --test <files...>`
batches through the bounded runner (`npm run test:shards`, 25 files per batch) on Windows 11 with Node
`v25.8.1` (never an unbounded `npm test`). Declarations are counted, so the one skip is included in the
total:

| Run | Command | Declarations | Result |
|---|---|---|---|
| Bounded offline suite, all 126 files | `npm run test:shards` (six sequential batches of at most 25 files) | **1271** | 1270 pass, 1 skip, 0 fail |
| Property PR tier (12 files) | `npm run test:property` | **121** | 121 pass, 0 fail (121 × 3 seeds × 100 runs = 36,300 generated inputs) |
| Mount smoke | `npm run smoke:mount` | — | 16/16 default tools, 3 skills, 4 presets (4 distinct labels), `/tower` present, 1 top-level bundle row on pinned `@deepseek-ai/dsh@0.2.2-rc.3` (78.7 s) |

The single skip is still the POSIX-only `TMPDIR` guard in
[`tests/live-harness.test.mjs`](live-harness.test.mjs) (declared with `skip:` on win32). No file is
excluded from the batches: `concurrency.test.mjs`, `lock-heartbeat.test.mjs`,
`git-mutex-budget.test.mjs`, `lock-kernel.test.mjs` and `roster-watchdog.test.mjs` run inside them and
passed. These were the 2.9.4 totals; the current totals are in
[2.9.5 release evidence](#295-release-evidence-2026-11-19) above, and the W5 table below is the
historical record of `feat/2.8.0-structure` at `bad249c` and is kept as written.

### 2.9.3 release evidence (2026-11-18)

The bounded suite is **126 `tests/*.test.mjs` files**, run as six sequential `node --test <files...>`
batches through the bounded runner (`npm run test:shards`, 25 files per batch) on Windows 11 with Node
`v25.8.1` (never an unbounded `npm test`). Declarations are counted, so the one skip is included in the
total:

| Run | Command | Declarations | Result |
|---|---|---|---|
| Bounded offline suite, all 126 files | `npm run test:shards` (six sequential batches of at most 25 files) | **1267** | 1266 pass, 1 skip, 0 fail |
| Property PR tier (12 files) | `npm run test:property` | **121** | 121 pass, 0 fail (121 × 3 seeds × 100 runs = 36,300 generated inputs) |
| Mount smoke | `npm run smoke:mount` | — | 16/16 default tools, 3 skills, 4 presets (4 distinct labels), `/tower` present, 1 top-level bundle row on pinned `@deepseek-ai/dsh@0.2.2-rc.3` (65.5 s) |

The single skip is still the POSIX-only `TMPDIR` guard in
[`tests/live-harness.test.mjs`](live-harness.test.mjs) (declared with `skip:` on win32). No file is
excluded from the batches: `concurrency.test.mjs`, `lock-heartbeat.test.mjs`,
`git-mutex-budget.test.mjs`, `lock-kernel.test.mjs` and `roster-watchdog.test.mjs` run inside them and
passed. These were the 2.9.3 totals; the W5 table below is the historical record of
`feat/2.8.0-structure` at `bad249c` and is kept as written.

### 2.9.2 release evidence (2026-11-18)

The bounded suite is **125 `tests/*.test.mjs` files**, run as five sequential `node --test <files...>`
batches on Windows 11 with Node `v25.8.1` (never an unbounded `npm test`). Declarations are counted, so
the one skip is included in the total:

| Run | Command | Declarations | Result |
|---|---|---|---|
| Bounded offline suite, all 125 files | five sequential batches, `node --test --test-reporter=tap <files>` | **1252** | 1251 pass, 1 skip, 0 fail |
| Property PR tier (12 files) | `npm run test:property` | **121** | 121 pass, 0 fail (121 × 3 seeds × 100 runs = 36,300 generated inputs) |
| Mount smoke | `npm run smoke:mount` | — | 16/16 default tools, 3 skills, 4 presets (4 distinct labels), `/tower` present, 1 top-level bundle row on pinned `@deepseek-ai/dsh@0.2.2-rc.3` (79.1 s) |

The single skip is still the POSIX-only `TMPDIR` guard in
[`tests/live-harness.test.mjs`](live-harness.test.mjs) (declared with `skip:` on win32). No file is
excluded from the batches: `concurrency.test.mjs`, `lock-heartbeat.test.mjs`,
`git-mutex-budget.test.mjs` and `roster-watchdog.test.mjs` run inside them and passed. These were the
2.9.2 totals; the W5 table below is the historical record of `feat/2.8.0-structure` at `bad249c` and is
kept as written.

### 2.9.1 release evidence (2026-11-17)

The bounded suite is **124 `tests/*.test.mjs` files**, run as five sequential `node --test <files...>`
batches on Windows 11 with Node `v25.8.1` (never an unbounded `npm test`). Declarations are counted, so
the one skip is included in the total:

| Run | Command | Declarations | Result |
|---|---|---|---|
| Bounded offline suite, all 124 files | five sequential batches, `node --test --test-reporter=tap <files>` | **1168** | 1167 pass, 1 skip, 0 fail |
| Survey-spawn contract | `node --test tests/tool-schemas.test.mjs tests/spawn.mock.test.mjs tests/roster-reserved.test.mjs` | 25 | 25 pass (`tower_spawn` reports `worktree: null` for a survey and still satisfies the real spawn schema) |
| Property PR tier (12 files) | `npm run test:property` | **119** | 119 pass, 0 fail (119 × 3 seeds × 100 runs = 35,700 generated inputs) |
| Mount smoke | `npm run smoke:mount` | — | 16/16 default tools, 3 skills, 4 presets (4 distinct labels), `/tower` present, 1 top-level bundle row on pinned `@deepseek-ai/dsh@0.2.2-rc.3` (63.9 s) |

The single skip is still the POSIX-only `TMPDIR` guard in
[`tests/live-harness.test.mjs`](live-harness.test.mjs) (declared with `skip:` on win32). No file is
excluded from the batches: `concurrency.test.mjs`, `lock-heartbeat.test.mjs` and
`git-mutex-budget.test.mjs` run inside them and passed. These were the 2.9.1 totals; the W5 table
below is the historical record of `feat/2.8.0-structure` at `bad249c` and is kept as written.

### W5 integration evidence (#M77, v2.8.0 debt close-out)

This is the final W5 integration record for the branch that carries the M75 structure split and the M76
bounded-activity/advisory-budget/Windows-flake work. It was taken from a clean worktree of
`feat/2.8.0-structure` at `bad249c` (M75 + M76 merged) on Windows 11 with Node `v25.8.1`, npm `11.21.2`
and 24 logical CPUs. Every number below is a Node `--test` declaration count, so skipped declarations
are included. It is history: the current totals are in
[2.9.5 release evidence](#295-release-evidence-2026-11-19) above.

| Run | Command | Declarations | Result |
|---|---|---|---|
| Bounded offline suite, 110 of the 113 files (excludes `git-mutex-budget.test.mjs`, `lock-heartbeat.test.mjs`, `concurrency.test.mjs`) | eight sequential chunks of 12–14 files, `node --test --test-reporter=tap <files>` | **1019** | 1018 pass, 1 skip, 0 fail |
| `git-mutex-budget.test.mjs` isolated | `node --test tests/git-mutex-budget.test.mjs` | 3 | 3 pass |
| `lock-heartbeat.test.mjs` isolated | `node --test tests/lock-heartbeat.test.mjs` | 8 | 8 pass |
| `concurrency.test.mjs` isolated | `node --test tests/concurrency.test.mjs` | 11 | 11 pass |
| **Offline suite, all 113 files** | bounded chunks + the three isolated runs | **1041** | **1040 pass, 1 skip, 0 fail** |
| Property PR tier (11 files) | `npm run test:property` | **117** | 117 pass, 0 fail (117 × 3 seeds × 100 runs = 35,100 generated inputs) |
| Mount smoke | `npm run smoke:mount` | — | 28/28 tower tools, 3 skills, 4 presets (4 distinct labels), `/tower` present, 1 top-level bundle row on pinned `@deepseek-ai/dsh@0.2.2-rc.1` |

The single skip is the POSIX-only `TMPDIR` guard case in
[`tests/live-harness.test.mjs`](live-harness.test.mjs) (declared with `skip:` on win32); it is counted,
not dropped. The bounded suite is chunked deliberately: the three excluded files are the documented
Windows isolation cases (the known parallel-run hang and the two load-sensitive lock/parallel-writer
suites), and serialising groups of files keeps a full parallel pass from accumulating rename/unlink
pressure across all 113 files at once. The three isolated runs are executed one at a time.

Every static gate in `npm run check` (the whole chain except its two test commands) plus the CI-only
release check exited 0 in that same checkout:

| Group | Commands | Exit |
|---|---|---|
| Generated references | `docs:check:generated`, `:tools`, `:config`, `:events`, `:blockers`, `:types`, `:components`, `:locale`, `:shapes` | 0 |
| Docs, components, blockers, shapes | `docs:check`, `docs:check:philosophy`, `docs:check:components`, `blockers:check`, `shape:audit` | 0 |
| Surface, pack, workflow, support | `surface:check` (57 keys / 16 sections / 29 tools, 12 visible), `pack:check` (337 files), `workflow:check` (3 canonical legs, 4 legacy contexts, 15 SHA pins), `support:check` (Node >=24.9, DSH 0.2.2-rc.1) | 0 |
| Architecture, types, domain | `architecture:check` (2 waivers), `types:coverage` (181/181), `types:strict:check` (10 pinned), `types:check` (main, strict, declarations), `domain:check` (42.3% pure) | 0 |
| Release claim | `release:check` | 0 (one expected `version-not-bumped` warning; this branch does not bump the version) |

The W5 `workflow:check` row records that run's numbers (3 canonical legs, 4 legacy contexts, 15 SHA
pins). W5-D then deleted the frozen legacy job, so the final contract is 4 required contexts (`mount`
plus the three canonical legs) and 13 SHA pins.

Environment caveats and residual known failures: the only non-pass declaration is the Windows
`# SKIP` above; the bounded, isolated and property runs have no failing or cancelled declarations.
`git-mutex-budget.test.mjs` (3/3) and `lock-heartbeat.test.mjs` (8/8) are green when run alone but are
not part of the bounded parallel chunk run, per the residual Windows constraint documented in
[Windows fallback](#windows-fallback). `release:check` intentionally warns because the version stays
`2.7.1` on this debt branch. The `COMPATIBILITY.md` `0.2.2-rc.1` row predates W5 and still records the
pre-W5 counts (976 offline tests / 111 property cases); it is outside this evidence update and must be
refreshed when the release is cut. The evidence run left the worktree clean: nothing was pushed,
merged or released.

## 2. Real Web runtime (isolated profile)

Purpose: verify command registration, real `agent.steer`, `ctx.goals`, the guard, and tool output. It uses **another profile and another port**, so your active profile is untouched.

### Install the live harness (reproducible, once)

```powershell
npm ci --prefix tests/live                 # Playwright version pinned in tests/live/package-lock.json
npx --prefix tests/live playwright install chromium
```

The live scripts resolve `playwright` from `tests/live/node_modules` first, then from `NODE_PATH`. A global install still works as a fallback (`npm root -g` prints the directory; put it on `NODE_PATH`), but the local install is the supported path: the root `npm ci` deliberately downloads neither Playwright nor a browser.

### Create the throwaway profile

```powershell
# 1) Create a throwaway profile from the shipped web template
#    (do not use `desktop`: it can only be started by the Electron app)
dsh --profile towertest --from-default-profile web --dump-config
# 2) Add this repository to that profile (the repo root is the bundle root;
#    it is registered into dsh.profile.bundles automatically)
dsh plugin --profile towertest add <repo-root>
# 3) Start the isolated server (note the tokenized URL it prints)
dsh --profile towertest --port 59001 --no-open
```

### Run the live suite

`npm run test:live` validates the environment and the Playwright resolution before anything runs. A missing install prints the two commands above and exits 2; it never prints a `MODULE_NOT_FOUND` stack.

```powershell
# A disposable DSH_HOME, always under the OS temp directory (never ~/.dsh):
$env:DSH_LIVE='1'
$env:DSH_HOME=(New-Item -ItemType Directory "$env:TEMP\dsh-live-$(Get-Random)").FullName
# The tokenized URL printed by the isolated server in step 3:
$env:DSH_TEST_URL='http://127.0.0.1:59001/?token=<token printed at boot>'
# Optional: the host build under test, named on the first output line:
$env:DSH_HOST_VERSION='0.2.2-rc.3'
# Optional: the writable documents directory used to seed the first-use
# Workspace (absolute). Defaults to <DSH_HOME>/documents.
$env:DSH_LIVE_DOCUMENTS_DIR="$env:DSH_HOME\documents"

npm run test:live                       # boot smoke against DSH_TEST_URL (default)
npm run test:live -- --check            # environment + resolution only, no browser, < 10 s
npm run test:live -- --script command   # the /tower command acceptance
npm run test:live -- --list             # the selectable scripts
```

`DSH_HOME` must exist and resolve under `os.tmpdir()`. The guard refuses the operator's real `DSH_HOME` and any profile under `$DSH_HOME/profiles`; the error names `npm run test:live`. The first line of live output names the resolved home and host version, for example `live: DSH_HOME=/tmp/dsh-live-abc host=0.2.2-rc.3`.

Browsers come from Playwright by default; set `DSH_TEST_CHROME` to force a specific executable. The individual scripts still run with `node tests/live/<name>.cjs` once the same environment is exported.

The browser run is **nightly-only** in CI: `.github/workflows/test.yml` schedules it against a pinned host matrix (`live (0.2.2-rc.3)`) and keeps only `npm run test:live -- --check` on push (no browser). The `nightly` script is the CI orchestrator that provisions the throwaway profile, boots the server, and runs `boot-smoke`.

`nightly` also seeds a default Workspace for a first-use CI runner (#47). An Ubuntu runner has no xdg Documents directory, so `@deepseek-ai/dsh-api-workspace-controller` cannot resolve its first-use workspace: the Web shell parks on the Preview Notice / "Choose workspace" state and the composer never renders (a Windows machine resolves Documents, which is why this was CI-only). The orchestrator creates a writable documents directory — `DSH_LIVE_DOCUMENTS_DIR` when set (must be absolute), otherwise `<DSH_HOME>/documents` — and writes a loader overlay at `<DSH_HOME>/workspace-override.patch.yml`:

```yaml
- id: workspace-controller
  config:
    documentsDirectory: '<absolute path>'
```

It passes that file to the host server as `--patch <overlay>`, a launcher flag that must precede the inner app flags (`--port`, `--no-open`). The profile's own layers stay untouched, and the run logs the documents directory and overlay path (paths only, no secrets). To boot the same way by hand, create the directory and the overlay, then add `--patch <overlay>` to the step-3 command. This is how CI gets a usable default Workspace instead of the notice.

`boot-smoke` requires the composer as its success target: a shell that rendered only the sidebar is a broken boot, not a pass. After navigation it waits up to 15 s for the first render to show either the composer or a visible Preview Notice button with the exact label `Continue` / `继续`; if the notice is present it is clicked and the log records `dismissed:preview-notice` (a present-but-unclickable notice is recorded too). Readiness is then a bounded poll for the composer alone; set `DSH_LIVE_BOOT_TIMEOUT_MS` to override the 60 s timeout (milliseconds, clamped to 1000–600000; an unset or invalid value falls back to the 60 s default). The page signals log both sidebar markers (`New Session` and `新会话` as `newSessionEnglish` / `newSessionChinese`, with `newSession` true for either) plus whether a Preview Notice or a Choose-workspace state is still visible. It always writes `tests/live/boot-smoke.png` and `tests/live/boot-smoke.log`; a failure logs the page signals, a redacted `body.innerText` snippet (URLs and `token=` values become `<redacted>`), and the full non-benign page/console errors. The nightly job uploads both files with `if: always()` as the `live-boot-diagnostics` artifact (7-day retention), so a red nightly is diagnosable from the run page even though it cannot be reproduced on push.

### Command semantics (no model required)

```powershell
$env:DSH_TEST_URL='http://127.0.0.1:59001/?token=<token printed at boot>'
npm run test:live -- --script command
```

The script opens a new session and submits `/tower on 继续`, `/tower`, `/tower off 继续`, and `/tower 继续` in order, saving screenshots and a log under `tests/live/`.

### Model-driven tools and guard (requires a usable account)

The `towertest` profile name is not `desktop`, so the account route is unavailable by default. Mount the account platform with the overlay:

```powershell
dsh --profile towertest --patch <repo-root>\tests\live\account.patch.yml --port 59002 --no-open
$env:DSH_TEST_URL='http://127.0.0.1:59002/?token=<token printed in the previous step>'
npm run test:live -- --script model
```

`model.cjs` asks the model to: `tower_mode` with `active: true` and a reason → read `tower_mode` → call `create_goal` (must be denied by the guard) → `tower_mode` with `active: false` and a reason.

### Hot reload and UI bundle (dev runtime)

`npm run dev:hmr` enables the DSH HMR service for this repository in the selected profile (idempotent; supports `--dry-run` and `--remove`; needs one restart). See `docs/guide/hot-reload.md` for the profile patch details.

- `npm run test:live -- --script hmr` — opt-in live acceptance for `/tower reload` and the `tower_reload` tool. It drives only `DSH_TEST_URL`; a missing `DSH_TEST_URL` prints SKIP and exits 0, and a missing Playwright install prints the two setup commands and exits 2. Set `DSH_TEST_HMR_ROOT` to a scratch copy under `%TEMP%` when you want the script to touch a watched file.
- `npm run test:live -- --script ui-slots` — read-only check for the optional `ui-bundle/`: it binds a session with a bare `/tower`, then verifies the state-aware dock chip, tool cards and `window.__TOWER_UI_DIAG__` registrations. `DSH_TEST_EXPECT_HINT=1` makes a missing dock entry a failure; `DSH_TEST_EXPECT_MODE=1` also requires the `Tower · on` chip.

Neither live script touches the desktop profile or the live `$DSH_HOME` session state.

### Cleanup

```powershell
# After stopping the servers:
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\towertest"
Remove-Item -Recurse -Force $env:DSH_HOME   # the disposable temp home from this run
# Delete only the sessions created by this test run; never delete by timestamp,
# and remove the test entries left in $DSH_HOME/tower-mode/modes.json.
```

`*.log`, `*.png`, and `backup/` under `tests/live/` are local acceptance artifacts. They are excluded by `.gitignore` and never enter the repository.

### Diagnostic and repair scripts (`tests/live/`)

These are read-only diagnostics (except `repair-session.cjs`) against the DSH home whose sessions you inspect, usually the operator's real `$DSH_HOME`. They are opt-in (`DSH_LIVE=1`) but deliberately do **not** go through the live-suite isolation guard: the live suite must run only against a temp home, while a diagnostic has to read the real one. They resolve `$DSH_HOME` from the environment and derive the session directory from the **current working directory** by default; set `DSH_SESSION_ROOT` to override.

- `scan-session.cjs <text>` — search all session logs for a text fragment (decodes concatenated zstd frames).
- `dump-session.cjs <session-suffix> <from> <to>` — print events by sequence number; useful for locating a malformed message.
- `validate-messages.cjs <session-suffix>` — verify every user/assistant/system/tool message and inbox splice has an `id` and `role` (`problems=0` means clean).
- `repair-session.cjs <session-suffix>` — repair the 1.0.0 `missing field role` corruption: it only accepts exactly two role-less user messages, backs up the original under `tests/live/backup/`, replaces it atomically, and writes a validation copy under a fresh session id.
- `steer-role.cjs` — isolated Web regression for 1.0.1: `/tower 这是一条测试消息` must produce a normal model reply.

## 3. Manual acceptance checklist for a desktop install

After installing/restarting desktop (Host plugins load at process start, so a code change requires a DSH restart):

> The desktop Web UI answers plain browsers with 401 (it requires the boot token), so automation cannot type `/tower` for you. Items 1–4 must be typed by a human in the desktop composer. Items 5–8 can be verified by calling `tower_mode` directly (`active: true|false` with a non-empty `reason` for a write; omit `active` to read), by a human or by the model.

1. `/tower` → mode on; `tower_mode` reports `mode:"on"`.
2. `/tower on 继续` → mode on, and “继续” becomes the next user message.
3. `/tower off 继续` → mode off, and “继续” becomes the next user message.
4. `/tower 继续` → mode on with the instruction forwarded.
5. While the mode is on: `create_goal`, `todo_write`, `spawn_teammate`, and `update_goal(resume)` are refused by the guard.
6. With an active goal: after `/tower on`, the goal becomes paused (`tower_mode.pausedGoal` is set).
7. After `/tower off`, `todo_write` works again and the tower guard no longer blocks `update_goal`.
8. After a restart, `tower_mode` is still on for the same session id (`$DSH_HOME/tower-mode/modes.json`).
9. With `allowAgentControl: true`, a `tower_mode` write (`active: true|false` plus a reason) changes the mode; with the default `false` the write is refused with `not-authorized` while the read still works.
10. Full chain: `tower_init → plan → spawn(worker) → inbox → complete → spawn(reviewer) → review → preflight → merge → teardown`, exercising the blocker/failure codes listed in [docs/reference/blockers.md](../docs/reference/blockers.md) (the repository `README.md` states the live surface).
