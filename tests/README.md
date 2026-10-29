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

- `cleanup.test.mjs` — the shared teardown helper: bounded retry/backoff for `EPERM`/`EBUSY`/`EACCES`, the quarantine rename after the first transient failure, the `os.tmpdir()` isolation guard, and a seeded real Windows `FileShare.None` handle that must be released before the tree can be removed (declared with `skip:` off Windows, so Linux reports it as `# SKIP`).
- `unit.test.mjs` — pure helpers: scope overlap, scope validation, printable-Unicode titles (NFC, 120-character bound), glob matching.
- `unicode-titles.test.mjs` — a non-ASCII title round-trips `tower_plan` → state → `tower_status` → `MISSIONS.md` → briefing, the board table stays aligned, and invisible/over-long titles are rejected.
- `platform.test.mjs` — the platform branches, asserted on every OS: win32 path case folding (`isInside`), the `pwsh`/`bash` discovery shell (`shellSpec`), the transient rename/unlink retry loops via injected syscalls, and worktree path identity (`compareKey`). The one real-Windows case (renaming over an open destination) is declared with `skip:` so Linux reports it as `# SKIP` rather than dropping it.
- `errors.test.mjs` — the stable `[tower:<code>]` classifier for every documented failure family, and the #74 recovery contract: every catalog `nextAction` renders exactly once, codes without one stay byte-identical, retryable codes mark the suffix, and a message that already contains its action is not suffixed twice.
- `events.test.mjs` — #75 domain events: transitions return `{ state, events }`, the app persists then emits `tower.mission.planned/completed/reviewed/merged/abandoned` with `{ missionId, revision, at }` (+`commit` for merged), planning emits before the tool returns, failed tools emit nothing, and `tower/<tool>` remains as a tested deprecated alias.
- `config.repo.test.mjs` — repository config layer: path, precedence, legacy keys, and invalid input codes.
- `findings.test.mjs` — the finding lifecycle through the domain class.
- `protocol.e2e.test.mjs` — drives the `Tower` class through a real temporary Git repository: init → plan → worktree → tasks → unread-inbox block → complete → finding → review → preflight → merge → teardown, plus automatic dependency for overlapping scopes and rejection of unknown dependencies.
- `plugin.test.mjs` — loads the real `apply()` from the repository-root `index.js` against a minimal mock Cordis context: every `/tower` input form, attachment forwarding, a complete `UserMessage` reaching `agent.steer`, guard denials, the dynamic prompt section, goal pausing, `tower_control` gating and reason validation, and mode persistence. It points `$DSH_HOME` at a temp directory and never writes the real store.
- `state-machine.test.mjs` — the documented mission transition table (allowed and denied), completion/merge entry points, and a seeded 200-step fuzz that must keep the state valid and the revision monotonic.
- `roles.test.mjs` — actor-role matrix with fake `subagents`: workers cannot change status/scope/blockers/pause metadata, workers can update tasks/notes/blockers, reviewers read findings but cannot mutate them, and tower-only tools reject roster workers without side effects.
- `interrupt.test.mjs` — `tower_interrupt` targets the child session id, records the roster as interrupted, is idempotent for idle agents, and `tower_send interrupt:true` interrupts before delivering.
- `workspace-lock.test.mjs` — the advisory `<git-common-dir>/dsh-tower/tower.lock` (acquire/self reacquire/touch/release/stale takeover/corrupt lock) and the mode-level rule that a second Tower session is refused with `[tower:workspace-busy]` until the first runs `/tower off`.
- `concurrency.test.mjs` — `spawn.maxLiveWorkers`, `tower_send` per-minute rate limiting, stale roster entries (`spawn.staleMs`), and parallel writers serializing on the state lock with a monotonic revision.
- `faults.test.mjs` — corrupt/unsupported state JSON (`state-corrupt`), a held writer lock (`state-locked`), and a vanished worktree reported as `branch-missing` instead of throwing.
- `status.test.mjs` — `tower_status` pagination, one-mission detail, `includeGate` digests, `format:"markdown"` and the `MISSIONS.md` board written by mutations.
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
- `ui-bundle.test.mjs` — plain-JS UI chunk format/syntax, the 400-line split budget, toolview/dock/overlay registrations, locale parity, theme tokens and defensive rendering.

All temporary repositories and state are created under the OS temp directory and cleaned up automatically. Teardown goes through `tests/helpers/cleanup.mjs`: it retries transient `EPERM`/`EBUSY`/`EACCES` failures with bounded backoff, moves the tree to a fresh sibling name after the first one, and refuses any target that is not a strict child of `os.tmpdir()`. Do not delete a test-owned tree directly — Windows can still hold a handle after the test that created it has finished, and a bare recursive delete turns a green suite red at random. The retry path is proven by `tests/cleanup.test.mjs`, including a real Windows handle.

### Windows fallback

Parallel file execution is the default and stays the default: `npm test` runs one process per file, exactly as CI does. If a Windows machine still fails because another program (antivirus, the search indexer) is holding a temp tree for longer than the bounded retry, `node --test --test-concurrency=1 tests/*.test.mjs` serialises the files to confirm that hypothesis. It is a diagnostic fallback, not the fix: a green run that only passes with `--test-concurrency=1` still has a teardown problem.

### Coverage and watch mode

```powershell
npm run test:coverage   # same suite plus Node's experimental coverage report
npm run test:watch      # re-run the offline suite while editing
```

Coverage is a diagnostic, not a gate; the meaningful signal is that the offline suite is green and the new behaviour has a dedicated case.

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
$env:DSH_HOST_VERSION='0.2.1-rc.2'

npm run test:live                       # boot smoke against DSH_TEST_URL (default)
npm run test:live -- --check            # environment + resolution only, no browser, < 10 s
npm run test:live -- --script command   # the /tower command acceptance
npm run test:live -- --list             # the selectable scripts
```

`DSH_HOME` must exist and resolve under `os.tmpdir()`. The guard refuses the operator's real `DSH_HOME` and any profile under `$DSH_HOME/profiles`; the error names `npm run test:live`. The first line of live output names the resolved home and host version, for example `live: DSH_HOME=/tmp/dsh-live-abc host=0.2.1-rc.2`.

Browsers come from Playwright by default; set `DSH_TEST_CHROME` to force a specific executable. The individual scripts still run with `node tests/live/<name>.cjs` once the same environment is exported.

The browser run is **nightly-only** in CI: `.github/workflows/test.yml` schedules it against a pinned host matrix (`live (0.2.1-rc.2)`) and keeps only `npm run test:live -- --check` on push (no browser). The `nightly` script is the CI orchestrator that provisions the throwaway profile, boots the server, and runs `boot-smoke`.

`boot-smoke` waits up to 60 s for the composer or the new-session entry; set `DSH_LIVE_BOOT_TIMEOUT_MS` to override that (milliseconds, clamped to 1000–600000; an unset or invalid value falls back to the 60 s default). It always writes `tests/live/boot-smoke.png` and `tests/live/boot-smoke.log`; a failure logs the page signals, a redacted `body.innerText` snippet (URLs and `token=` values become `<redacted>`), and the full non-benign page/console errors. The nightly job uploads both files with `if: always()` as the `live-boot-diagnostics` artifact (7-day retention), so a red nightly is diagnosable from the run page even though it cannot be reproduced on push.

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

`model.cjs` asks the model to: `tower_control enter` → read `tower_mode` → call `create_goal` (must be denied by the guard) → `tower_control exit`.

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

> The desktop Web UI answers plain browsers with 401 (it requires the boot token), so automation cannot type `/tower` for you. Items 1–4 must be typed by a human in the desktop composer. Items 5–8 can be verified by calling `tower_control` / `tower_mode` directly, by a human or by the model.

1. `/tower` → mode on; `tower_mode` reports `mode:"on"`.
2. `/tower on 继续` → mode on, and “继续” becomes the next user message.
3. `/tower off 继续` → mode off, and “继续” becomes the next user message.
4. `/tower 继续` → mode on with the instruction forwarded.
5. While the mode is on: `create_goal`, `todo_write`, `spawn_teammate`, and `update_goal(resume)` are refused by the guard.
6. With an active goal: after `/tower on`, the goal becomes paused (`tower_mode.pausedGoal` is set).
7. After `/tower off`, `todo_write` works again and the tower guard no longer blocks `update_goal`.
8. After a restart, `tower_mode` is still on for the same session id (`$DSH_HOME/tower-mode/modes.json`).
9. With `allowAgentControl: true`, `tower_control` exists; with the default `false` it does not.
10. Full chain: `tower_init → plan → spawn(worker) → inbox → complete → spawn(reviewer) → review → preflight → merge → teardown`, exercising all 25 blocker/failure codes (see the repository `README.md`).
