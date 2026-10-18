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
