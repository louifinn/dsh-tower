# Install, upgrade and migration

## Requirements

- DSH `0.2.1-rc.2`; see [COMPATIBILITY.md](../../COMPATIBILITY.md) for the builds actually verified per release
- Node.js 22+
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

- **2.4.0 → 2.5.0 (unreleased, #136/#131/#142)**: the `tests.enabled` switch is
  gone — the `tower-tests` component row is the only switch. A profile or repository
  config that still writes `tests.enabled` is rejected as `config-unknown-key` and
  the host stops mounting, so delete the key and enable or disable the row in the
  plugin page instead. With the row off there is no `tower_test` tool and no receipt,
  which also means `gates.requireTests` cannot be satisfied: planning and mode entry
  refuse that combination, and the merge gate's `tests-missing` blocker names the
  disabled row and the fix. `tower_test` no longer reports "not configured" for a
  component cause; it reports `disabled by component tower-tests` with the remedy.
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
  rewriting it. `tower_doctor` reports the on-disk version and the pending migration. A file written by
  a newer plugin is refused with `[tower:state-version-unsupported]` and is never rewritten or
  downgraded; a migration that throws reports `[tower:state-migration-failed]` and leaves the original
  file byte-identical.

- **state schema v2 → v3 (unreleased, #90)**: scope matching follows the checkout's filesystem. The
  migration backfills `caseInsensitive: null` ("not detected"); a migration never reads the filesystem,
  so the first `tower_init` after upgrading probes the checkout once and records `true`/`false`. Until
  then the safe `case-sensitive` comparison applies, and `tower_doctor` reports the unknown mode as a
  `warn` (`case-mode`). On a case-insensitive checkout, `src/Api/**` and `src/api/**` then count as
  overlapping and case-only mismatches are no longer refused by the out-of-scope gate. Stored scope
  strings are never rewritten: the board keeps showing what the operator typed.

- **2.3.0 → 2.4.0 (unreleased)**: the single `tower-bundle` group row is gone. `cordis.patch.yml`
  now ships the mandatory `tower` host anchor (the Host plugin and the worker preset are its internal
  sections) plus individually switchable top-level rows: `tower-skills`, `tower-batch`, `tower-import`,
  `tower-leases`, `tower-tests`, `tower-hmr` (shipped off) and `preset-tower-reviewer` (conditional on
  `review.requireReview`). The `tools` config group and `dev.hotReload` were removed: a profile that
  still carries them is now rejected as an unknown key (`config-unknown-key`) and the host stops
  mounting until they are deleted, so no silent no-op switch remains. Move each capability to its row
  in the plugin page instead; `tower-hmr` ships off, so `tower_reload` and `/tower reload` are reported
  as "disabled by component tower-hmr" until you enable it for a linked dev profile. `tower_doctor` and
  `tower_recover` are registered for every configuration and need no key. The reviewer row may be off
  only while `review.requireReview` is false; with the gate on, planning and mode entry refuse the
  combination with an explanatory error. No state migration is needed.

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
  process environment, `tower_recover`, UI 0.2.2). Review `review.requireReview`, `tests.admission` and
  worker tool permissions against your threat model after upgrading.
- **2.0.1 → 2.0.3**: no state migration. Independent review became **optional by default** in 2.0.3
  (`review.requireReview:false`); set it to `true` to keep the old review-gated merges. 2.0.1 added
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
  (`<git-common-dir>/dsh-tower/config.json`), stable `[tower:<code>]` tool errors, `tower_findings`,
  and `id`/`missionId` + snake/camel input aliases. Existing calls keep working; restart DSH to load
  the new tool surface (`tower_findings` and the newer output schemas).
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
