# Install, upgrade and migration

## Requirements

- DSH `0.2.1-rc.2` or newer
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
