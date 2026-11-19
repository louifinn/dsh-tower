# Install, upgrade and migration

## Requirements

- DSH `0.2.2-rc.5` (rc.1/rc.2 keep working through the legacy spawn contract); see
  [COMPATIBILITY.md](../../COMPATIBILITY.md) for the builds actually verified per release
- Node.js 24.9+
- Git (local worktrees; no network access is required)

## Install

```bash
dsh plugin --profile web add dsh-tower
```

Or inside DSH: `plugin_manager({ action: "install_bundle", target: "dsh-tower" })`. From a checkout:

```bash
dsh plugin --profile web add github:louifinn/dsh-tower
```

The Host plugin loads at DSH startup: **restart DSH after install or update**.

## Upgrade

1. Read [CHANGELOG.md](../../CHANGELOG.md) for behavior changes.
2. Update the dependency (`dsh plugin --profile web add dsh-tower@latest` or your pinned version).
3. Restart DSH; check `tower_mode` reports `allowAgentControl` as expected.
4. Existing mission state stays compatible: the state schema did not change in 1.2/1.3.

## Migration notes

- **2.9.5 → 2.9.6 — patch release, no migration required**: the state schema stays v5, the config
  surface is unchanged (58 keys in 16 sections), and there is no migration step. Nothing an operator
  configured needs to move:
  - **The host floor moves to DSH `0.2.2-rc.5`.** Update DSH to `0.2.2-rc.5` or newer before you
    update Tower; rc.1/rc.2 still work through the legacy spawn contract, but the published floor and
    the tested build are rc.5. `npm run support:check` keeps the package engines, mount pin, live CI
    matrix and the newest compatibility row in agreement.
  - **Teardown is harder to surprise.** Removing a mission worktree now retries `EPERM`/`EBUSY`/
    `EACCES` up to three times and reports the attempts instead of failing on the first transient
    error. `tower_teardown` with `dry_run` also previews which due missions would be archived, and an
    `exclude` id that matches no mission is reported as a `keep` decision instead of being ignored.
  - **Waiting-to-teardown state is visible.** The doctor view reports how many terminal mission
    worktrees are still waiting for teardown; it does not delete anything automatically and adds no
    config key.
  - **The orphan sweep is opt-in.** `tower_teardown({orphans:true})` removes clean checkouts under
    the worktree root that no mission, sandbox or review row references; dirty checkouts are kept,
    the main checkout and every recorded path are protected, and a dry run only previews. Normal
    teardown never touches them. `create_worktree` stays available in Tower mode, and unrecorded
    external checkouts now show up in the doctor view instead of disappearing.
  - **New doctor advisories and a deny page.** `worktrees-orphans` and `foreign-capabilities` list
    what Tower sees but does not own, with the recorded stance and remedy; the new "denied
    capabilities and replacements" page records what each denied or warned capability costs and what
    replaces it. No setting changed.
  - **Native UI chrome.** Tool cards regain the native file link, image preview, inspect entry and
    expand/collapse (with a scroll region instead of a six-row cut); the Tower overlay uses the
    native toast position and tokens, and the composer chip shares the native `StatsPills` base.
    The client bundle is loaded at DSH startup, so **refresh or restart DSH** after updating to load
    the new one.
  - **No new config key, no new state field.** The state schema stays v5 and the config stays at 58
    keys in 16 sections. Update the plugin and **restart DSH**.

- **2.9.4 → 2.9.5 — patch release, no migration required**: the config surface is unchanged (58 keys in
  16 sections), the state schema stays v5, and the DSH floor stays `0.2.2-rc.3`. Nothing an operator
  configured needs to move:
  - **A torn workspace lock can be repaired from the tool path.** A killed session can leave a
    half-written `<git-common-dir>/dsh-tower/tower.lock`. That unreadable record used to refuse every
    Tower tool — including `tower_recover` — with `[tower:workspace-busy]`, so the session could not
    recover itself. Parseable records keep their exact previous behaviour; `tower_recover` now runs
    despite the workspace gate, its `status` action reports the `workspaceLock` record (path, bytes,
    mtime, holder, and torn/unreadable state), and the new `action: "clear-workspace-lock"` needs
    `confirm: "CLEAR_WORKSPACE_LOCK"` and renames the record to `tower.lock.recovered-<timestamp>` — it
    never deletes it.
  - **A torn record must be 30 seconds old.** The next acquisition auto-reclaims an empty,
    whitespace-only or unparseable record only once its mtime is older than the 30 s torn grace window,
    then retries the exclusive create once. Anything written more recently still refuses.
  - **The refusal names the file.** The `workspace-busy` message now includes the lock path, its byte
    count and its mtime, so a stale record is distinguishable from another live session.
  - **No new config key and no migration.** The schema stays v5, the config keys stay at 58, and the
    confirmation literal is domain vocabulary rather than a setting. Update the plugin and **restart
    DSH**.

- **2.9.3 → 2.9.4 — patch release, no migration required**: the config surface is unchanged (58 keys in
  16 sections) and the state schema stays v5. Nothing an operator configured needs to move:
  - **Pure client-UI change.** No tool schema, output or wire format moved, no config key or state field
    was added, and the same nine `dsh-tower-ui` chunks ship. The Tower tool cards now use the host's own
    process row when collapsed and its generic io-card surface when expanded; the Tower-mode blocked
    tool rows are the same native row, with a localized tool name and "Unavailable in Tower mode", and the
    explanation (Reason / Next step) lives in the expanded body instead of a hand-drawn card. The raw
    host denial sentence is no longer visible copy.
  - **Restart or refresh DSH.** The Host plugin is unchanged, but the Web client keeps the bundle it
    loaded: restart DSH (or refresh the page) to pick up the new client chunks.
  - No state or config migration is required. Update the plugin and **restart DSH**.

- **2.9.2 → 2.9.3 — patch release, no migration required**: the config surface is unchanged (58 keys in
  16 sections) and the state schema stays v5. Nothing an operator configured needs to move:
  - **No UI, tool or wire-format change.** The client size budget now ratchets client *logic* separately
    from the bilingual translation catalogue, and the catalogue has its own data guards (en/zh key-set
    parity, a 133-key floor and 260-key ceiling, 240-character values, no executable code). The same nine
    chunks ship, the loader is untouched, and every tool schema and output is unchanged; this is an
    internal budget decision recorded in ADR 0011.
  - **Windows test runs are load-insensitive.** The exclusive lock-record create retries only the
    transient `EPERM`/`EBUSY`/`EACCES` sharing errors within a 1.5 s budget (`EEXIST` is still never
    retried), and the heartbeat/merge tests now wait on observable state instead of a fixed wall clock.
    A slow host no longer turns untouched test files red.
  - **Developers have an optional bounded runner.** `npm run test:shards` runs exactly
    `tests/*.test.mjs` in sequential batches of 25 (`npm run test:shards -- --size 10` for a busier
    host). It is a local convenience for constrained machines, not a new requirement: CI keeps running
    `npm run check`, which runs `npm test`.
  - No state or config migration is required. Update the plugin and **restart DSH**.

- **2.9.1 → 2.9.2 — patch release, no migration required**: the config surface is unchanged (58 keys in
  16 sections) and the state schema stays v5. What an operator will observe:
  - **Plan scopes cover their subtree.** A bare directory entry, or one with a trailing separator, now
    expands to its subtree in `tower_plan` (and in a `tower_mission` scope widening): `docs/guide/` is
    stored as `docs/guide/**`, and `.` becomes the whole tree (`**`). Globs, files and unknown paths keep
    their literal spelling, and a scope already stored on a mission is never rewritten.
  - **Worker staleness is judged on sustained evidence.** `spawn.staleMs` now defaults to 30000 and the
    bundled patch sets the same 30 s window. The watchdog marks an absence only after two consecutive
    misses spanning twice the window, and an empty or unreadable parent catalog proves nothing. A worker
    whose own `tower_complete` reaches the host is revived inside the completion transaction and recorded
    as `completed (self-report)`; every other terminal state is still refused.
  - **`tower_init({op: "adopt"})` does not retire on an empty catalog.** Only a non-empty
    `listDescendants` answer is evidence of absence; rows under an empty or failing parent are reported
    in the new `unjudged` list with the `parentStatus` reason, and their observation counters are left
    untouched. `retire_missing` keeps its meaning for an authoritative catalog.
  - **`tower_recover` also recovers the state-commit mutex.** `status` and `clear-stale-lock` inspect
    `state.commit.lock` as well as the state lock, return `commitBackup`, refuse a record that changed
    after it was read, and with `force` clear the commit mutex before moving the state lock. An unreadable
    record is reported as `{unreadable: true, path, error}` and renamed to a backup, never deleted.
  - **Host version sources have an explicit trust order.** Non-empty `DSH_VERSION`, `DSH_HOST_VERSION`
    and `npm_config_dsh_version` come first; then the first readable `package.json` under
    `DSH_INSTALL_DIR`/its parent and the corresponding `app.asar.unpacked` copies; then a mounted
    service; last, a profile-installed dependency as a labelled non-authoritative hint. A parent package
    can no longer stand in for the package `DSH_INSTALL_DIR` names, and a profile hit is always a warning,
    never a pass.
  - **The published type surface is checked for real.** `types:check` now runs
    `types:check:declarations` against `types/index.d.ts` with `skipLibCheck: false`. `TowerConfig` now
    resolves to the actual config type instead of `any`, so a consumer may see stricter, correct types.
  - No state or config migration is required. Update the plugin and **restart DSH**.

- **2.9.0 → 2.9.1 — patch release, no migration required**: the config surface is unchanged (58 keys in
  16 sections) and the state schema stays v5. The only state-shape change is the optional
  `reservationId` on the roster row a spawn reserves; a 2.9.0 reader ignores it, so rolling back is
  safe. What a caller of the tools can observe:
  - `tower_spawn` output: `worktree` is still required but may now be `null`. A survey spawn creates
    no branch worktree, so it reports `null` instead of failing output validation after the worker has
    already started. Branch worktrees keep `{path, branch, baseCommit}`.
  - `tower_teardown` / `tower_inspect` with `view: "doctor"`: a terminal mission whose checkout was
    deleted outside Tower is no longer an unrecoverable row. `tower_teardown` records
    `worktreeRemovedAt` and returns `repaired: true` with the reason `worktree directory was already
    gone; the removal was recorded`; the doctor downgrades that case in the `worktrees` check to an
    advisory warn (a missing worktree of a live mission still fails, a dirty worktree still warns) and
    counts the removals it has recorded.
  - Host version: the desktop build is now recognized from the `package.json` under `DSH_INSTALL_DIR`
    (or its parent), so 0.2.2-rc.3 reports as verified without hand-setting a version environment
    variable. When no source answers, the detail lists every source that was probed.
  - Windows line endings: Git write commands run with `core.autocrlf=false`, so a user-level
    `core.autocrlf=true` can no longer make Tower's own checkout look like an out-of-scope change; read
    commands such as `status`/`diff` keep the ambient setting.
  - Failed spawns: a stalled `reserved` roster row (`agentId: null`) is reaped after a 60 s grace
    window in two phases, and each reservation carries its own `reservationId`, so a stale sweep never
    retires a row another spawn is using. If a one-shot review checkout cannot be removed, the row is
    kept: the spawn precheck fails with its checkout path and a remedy, and `tower_init({op:"adopt"})`
    reports it in the `unreaped` list.
  - No configuration key changed. Update the plugin and restart DSH; nothing else to migrate.

<!-- tower-retired-names:begin 2.9.0-migration -->
- **2.8.0 → 2.9.0 (#163, #176, #160, #164, #162, #159, #161) — consolidated tool surface**: the
  build surface drops from 29 tools to 21 (16 tools in the default profile). The five read-only
  tools (`tower_status`, `tower_roster`, `tower_diff`, `tower_preflight`, `tower_doctor`) are now
  the `status`, `roster`, `diff`, `preflight` and `doctor` views of `tower_inspect`;
  `tower_control`, `tower_adopt`, `tower_findings`, `tower_import_legacy` and `tower_legacy_map`
  fold into `tower_mode`, `tower_init({op:"adopt"})`, `tower_finding`,
  `tower_import({op:"snapshot"})` and `tower_import({op:"map"})`. Old names written in
  `mode.denyTools` are still accepted and rewritten to their replacements, while direct calls
  return an actionable unknown-tool error. The tower session now exposes tools by role and phase
  (mode off: `tower_mode` only; idle: plus `tower_init`; active: the 14 default admission tools),
  the worker/reviewer/survey presets get their own allow-lists, and `tower_complete`/`tower_review`
  are hidden from the tower session. `/tasks` adds a read-only roster panel. Tower and a live Ralph
  loop are mutually exclusive per repository: `/ralph` is shadowed while Tower mode is active,
  Ralph round agents are refused, and `mode.ralphPolicy` (`stop`, the default, or `refuse`) decides
  whether entry stops and records the loop or rejects with the reason. The third mission shape
  `artifact` replaces review with human acceptance recorded through the DSH approval channel. The
  state schema stays v5, the config surface grows from 57 to 58 keys in 16 sections, and the error
  catalogue grows to 42 codes (35 blocker codes).
<!-- tower-retired-names:end 2.9.0-migration -->

- **2.8.0 → 2.9.0 — DSH 0.2.2-rc.3 host contract**: rc.3 removed `subagents.list()` and changed
  `startActivation` to take flat fields, so 2.8.0 failed to spawn on the upgraded host
  (`subagents.list is not a function`; the old nested request also left `spec.parent` undefined).
  2.9.0 detects the contract at runtime in `app/host-contract.js`: rc.1/rc.2 keep the nested
  request, rc.3 receives the flat spec with the live parent agent, prompt array and the caller's
  signal. Provider resolution tries `spawn.provider`, then `getProvider("spawn")`, then the legacy
  list, and otherwise fails with an actionable message naming `spawn.provider`. No state or config
  migration is required; update the plugin and **restart DSH**. rc.3 is the verified build.
- **2.8.0 — bounded activity log**: two optional tuning keys were added under `activity`:
  `activity.maxBytes` (default 4 MiB, `0` disables rotation) and `activity.retention` (default 5
  segments, range 1–100). The defaults preserve the previous unbounded behavior only up to the byte
  limit; once the live log would exceed it, Tower rotates to `activity.jsonl.1`, shifts older segments
  and deletes those beyond the retention window before appending. Existing logs are not rewritten on
  upgrade, and no state migration is required. The config surface grows from 55 to 57 keys and from
  15 to 16 sections.
- **2.7.1 → 2.8.0 (#M71) — supported runtime floor is Node.js 24.9+ and DSH 0.2.2-rc.1**: DSH
  0.2.2-rc.1 declares `engines.node >=24.9.0`, so Tower publishes the same floor in its package
  engines and the package-lock root. `scripts/support.json` is the single manifest: the mount-smoke
  host pin, the live CI matrix and the newest COMPATIBILITY row must agree with it, and `npm run
  support:check` (part of `npm run check`) fails on any disagreement. There is no state or config
  migration; upgrade Node to 24.9+ before installing 2.8.0, and restart DSH after the upgrade.
- **2.7.0 → 2.8.0 (#M66) — `review.requireReview` is removed**: the one-release boolean alias
  introduced in 2.6.0 no longer exists. `review.mode` (`off`, `optional` or `required`) is the only
  review policy key; a profile or repository config that still writes `review.requireReview` is
  rejected as `config-unknown-key` with a dated note that names `review.mode` and the mapping
  (`true` → `required`, `false` → `optional`) as the remedy. The three modes resolve exactly as
  before, so there is no state or review-policy migration; the config key count drops 56 → 55.
  Saving from the plugin page writes only `review.mode`, and the doctor now reports a profile that
  never pinned `review.mode` instead of normalizing an alias.
- **2.6.0 → 2.7.0 (#148/#149) — mission shapes, survey tasks, and state schema v5**: a completed
  survey is a read of a commit, not a write of a branch. `tower_plan({kind:"survey"})` records
  `readCommit` and `readDirty`, creates no branch or worktree, and completes only while HEAD and the
  tracked-file status still match that read. The optional `survey.sandbox: "detached"` mode gives a
  writable inspection a disposable worktree pinned to the same commit. `tower-survey` is an optional
  component row; survey presets are read-only by default, and surveys do not count against
  `spawn.maxLiveWorkers`.
  - **State migration is automatic and one-way.** The first write after upgrading migrates
    `state.json` from v3 to v5 in one step, writes `state.json.v3.bak` first, advances `revision`
    once, and logs `state.migrated` with steps v3→v4 and v4→v5. Legacy survey rows gain
    `readCommit`/`readDirty` (anchored at `state.base` when the old row never started), and build
    rows are stamped `kind:"build"`. Read-only loads migrate in memory without rewriting the file.
    A newer document is still refused with `state-version-unsupported` and never downgraded.
  - **Config key count 57 → 56.** `tests.autoChecks` is gone; test evidence is now the
    `mission.testRuns` receipt read by `domain/evidence.js`. A config that still writes the key is
    rejected as `config-unknown-key` with this note; there is no replacement switch.
  - **`blocked` is derived.** Write `status:"blocked"` through `tower_mission` is refused; use
    `blocker` to report and `clear_blockers` to resolve. Batch statuses are canonical
    `open → closed|abandoned`; an expired foreign lease requires explicit `force` to recover.
  - **Survey actions are explicit.** `tower_merge`, `tower_rebase`, `tower_inspect` with `view: "preflight"`, and
    `tower_inspect` with `view: "diff"` refuse surveys with `invalid-transition`; a completed survey is terminal for
    planning, archive, dependency satisfaction, and reanchor. `tower_complete` accepts an optional
    structured `result` (`paths`, `symbols`, `notes`, `plan`) for surveys only.
  - Reviewers are now spawned into a detached checkout bound to the recorded commit; a verdict is
    tied to that commit, and teardown cleans the checkout. Existing build workflows are unchanged.
  - No npm dist-tag or review-policy change is required. Restart DSH after upgrading.
- **2.5.0 → 2.6.0 (#M39/#M40) — review modes replace the boolean**: the review policy is one
  tri-state control on the Plugins page in the `dsh-tower` configuration section, and the config key
  is `review.mode`: `off`, `optional` (the default) or `required`.
  - `off` is supported and documented: `tower_review` is not registered, reviewer spawn is refused,
    and the merge gate ignores review.
  - `optional` keeps `tower_review` but never blocks a merge.
  - `required` keeps the merge gate: a completed mission needs a clean review bound to the branch tip
    (the existing per-mission exemption still applies).
  `review.requireReview` is a deprecated one-release alias: `true` resolves to `required`, `false`
  to `optional`, and leaving it unset means `optional`. A `true` next to an explicit non-`required`
  mode is rejected with `config-invalid`; `false` never overrides an explicit mode. Saving from the
  plugin page always writes `review.mode` and normalizes the alias to `false`. The policy is not a
  component row and there are no mutually exclusive review rows: `preset-tower-reviewer` remains an
  optional capability the policy may leave unused. The row may be off while `review.mode` is `off`
  or `optional`; when `review.mode` is `required` and the reviewer row is off, planning and mode
  entry refuse the combination with an explanatory `preset-missing` error.
  A profile that starts with the policy `off` never registered `tower_review`; switching to
  `optional` or `required` changes the merge gate immediately, but the tool appears only after a DSH
  restart (or a profile reload), and the plugin page states that after such a save.
  Upgrade: replace `review.requireReview: true|false` with `review.mode: required|optional`. The
  alias was accepted for one release only and is removed in 2.8.0 (see the 2.7.0 → 2.8.0 note); a
  config that keeps it is rejected rather than silently resolved. No state migration.

- **2.4.2 → 2.5.0 (#131/#133/#135/#136/#142)**: three component-shaped config
  keys are gone — `tests.enabled`, `docs.board`, and `archive.enabled`. The
  `tower-tests`, `tower-board`, and `tower-archive` component rows are the only
  switches. A profile or repository config that still writes any of these keys is
  rejected as `config-unknown-key` with an upgrade note and the host stops
  mounting, so delete the key and enable or disable the row in the plugin page
  instead. `docs.boardLocation` and `archive.afterDays`/`archive.maxMissions`
  remain tuning keys. With `tower-tests` off there is no `tower_test` tool and no
  receipt, which also means `gates.requireTests` cannot be satisfied: planning and
  mode entry refuse that combination, and the merge gate's `tests-missing` blocker
  names the disabled row and the fix. `tower_test` no longer reports "not
  configured" for a component cause; it reports `disabled by component
  tower-tests` with the remedy.
  Two more runtime rules became explicit: a config that sets `spawn.requireLease`
  while the `tower-leases` row is off is refused up front with `config-invalid`
  naming the row and both remedies (previously every spawn failed at `lease-busy`
  advising an unregistered `tower_resource`), and `/tower` re-validates the runtime
  preconditions only when it enters the mode, so `/tower off` and a forwarded
  `/tower <text>` keep working while an unrelated row is disabled. No state
  migration; see [component rows and messages](quickstart.md#component-rows-runtime-preconditions-and-message-language).

- **state schema v1 → v2 (unreleased)**: `state.json` migrates automatically. The first **write** after
  upgrading keeps a `state.json.v1.bak` backup, advances `revision` once, and appends
  `state.migrated {from,to}` to `activity.jsonl`; read-only tools keep reading a v1 file without
  rewriting it. `tower_inspect` with `view: "doctor"` reports the on-disk version and the pending migration. A file written by
  a newer plugin is refused with `[tower:state-version-unsupported]` and is never rewritten or
  downgraded; a migration that throws reports `[tower:state-migration-failed]` and leaves the original
  file byte-identical.

- **state schema v2 → v3 (unreleased, #90)**: scope matching follows the checkout's filesystem. The
  migration backfills `caseInsensitive: null` ("not detected"); a migration never reads the filesystem,
  so the first `tower_init` after upgrading probes the checkout once and records `true`/`false`. Until
  then the safe `case-sensitive` comparison applies, and `tower_inspect` with `view: "doctor"` reports the unknown mode as a
  `warn` (`case-mode`). On a case-insensitive checkout, `src/Api/**` and `src/api/**` then count as
  overlapping and case-only mismatches are no longer refused by the out-of-scope gate. Stored scope
  strings are never rewritten: the board keeps showing what the operator typed.

- **2.3.0 → 2.4.0 (unreleased)**: the single `tower-bundle` group row is gone. `cordis.patch.yml`
  now ships the mandatory `tower` host anchor (the Host plugin and the worker preset are its internal
  sections) plus individually switchable top-level rows: `tower-skills`, `tower-batch`, `tower-import`,
  `tower-leases`, `tower-tests`, `tower-hmr` (shipped off) and `preset-tower-reviewer` (conditional on
  the review policy, today `review.mode`). The `tools` config group and `dev.hotReload` were removed: a
  profile that still carries them is now rejected as an unknown key (`config-unknown-key`) and the host stops
  mounting until they are deleted, so no silent no-op switch remains. Move each capability to its row
  in the plugin page instead; `tower-hmr` ships off, so `tower_reload` and `/tower reload` are reported
  as "disabled by component tower-hmr" until you enable it for a linked dev profile. `tower_inspect` with `view: "doctor"` and
  `tower_recover` are registered for every configuration and need no key. The reviewer row may be off
  while the policy is `off` or `optional`; with `review.mode:required`, planning and mode entry refuse
  the combination with an explanatory error. No state migration is needed.

- **2.0.4 → 2.1.0-beta.1**: no config migration; the state file migrates automatically (v1/v2 → v3) as
  described above. This is a **pre-release** published on the
  `next` dist-tag, so `latest` still resolves to 2.0.4 — install it with
  `dsh plugin --profile web add dsh-tower@next` (or the exact version). The runtime behavior is
  unchanged; the release carries the delivery gate (mount smoke in CI, `npm run release:check`, the
  evidence conventions and the tracker policy) rather than tool changes. These docs merge before the
  human publish step: `next` only resolves to 2.1.0-beta.1 after the [release checklist](release.md)
  runs `npm publish --tag next`, and `latest` stays on 2.0.4 until a stable release.
- **2.0.3 → 2.0.4**: no state/config migration. This is a security-hardening and integrity release
  (authorization, merge SHA binding, dirty-worktree completion, stale-lock recovery, limited test/git
  process environment, `tower_recover`, UI 0.2.2). Review the review policy (`review.mode`; the
  deprecated `review.requireReview` alias was removed in 2.8.0), `tests.admission` and worker tool
  permissions against your
  threat model after upgrading.
- **2.0.1 → 2.0.3**: no state migration. Independent review became **optional by default** in 2.0.3
  (today's `review.mode:optional`); set `review.mode:required` to keep the old review-gated merges.
  2.0.1 added
  `tower_batch` `abandon`, accepted merged members in batch close, made doctor skip torn-down worktrees,
  and fixed terminal-mission spawn/preflight edge cases. The optional `ui-bundle` 0.2.1 adds the
  persistent Tower-mode chip and mode-aware denied-tool rows.
- **1.x → 2.0 (released)**: no state migration is needed (`schemaVersion` stays 1; new fields are
  optional). Behavior changes to review: `mode.denyTools` now also denies `workflow`, `ralph`, `subagent`,
  `subagent_fork`, `wait_agent` and `team_task_list` while Tower mode is active (override with an explicit
  list); `spawn.maxLiveWorkers` defaults to 4; `mode.workspaceLock` is off in the code default and on in
  the bundled patch. Workers can no longer complete/abandon/scope a mission directly — use
  `tower_complete`. New tools: `tower_interrupt`, and `tower_reload` when HMR is available. Restart DSH
  once after upgrading; see [hot reload](hot-reload.md).
- **1.3 → 1.4**: no state migration is needed. New: repository-level config
  (`<git-common-dir>/dsh-tower/config.json`), stable `[tower:<code>]` tool errors, the findings
  ledger (now `tower_finding`), and `id`/`missionId` + snake/camel input aliases. Existing calls
  keep working; restart DSH to load the new tool surface (the findings ledger and the newer output
  schemas).
- **1.2 → 1.3**: reviewers moved from the shared `tower-worker` preset to the new read-only
  `tower-reviewer` preset. Reinstall/restart so both preset rows exist. `tower_spawn role=reviewer`
  now requires the mission to be `completed`.
- **1.1 → 1.2**: merge failures gained `merge-hook-failed`, `cleanup` and reconciliation behavior; no
  state migration is needed.
- **1.0 → 1.1**: package name changed from `@local/dsh-tower` to `dsh-tower`. Remove the old bundle
  (`remove_bundle` with `@local/dsh-tower`) and install `dsh-tower`.

## Uninstall

```text
plugin_manager({ action: "remove_bundle", target: "dsh-tower" })
```

Restart DSH. Mission state under `<git-common-dir>/dsh-tower/` and worktrees under
`<checkout parent>/.dsh-tower-worktrees/` are left in place; remove them manually only after no mission
is active.
