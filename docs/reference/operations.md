# Batches, leases and legacy import

## Evidence batches

`tower_batch` groups finite mission completion evidence.

- `create` freezes `missionIds`, `exclusions`, `requiredChecks` (default `["check"]`) and exact
  relative `receiptPaths`. Members must be known missions and only paused legacy missions may be
  excluded; membership is immutable after create.
- `status` summarizes members and pending/failed checks.
- `close` verifies every required check for completed members (from `completionReport.checks`,
  `testRuns`, or close-time `checks`), checks `treeTip` when provided, and requires every frozen
  receipt path to be supplied in `receiptHashes`/`receipts` (or bound to a passing check with
  `receiptHash`). Missing evidence returns `{ok:false, blockers}`; nothing is deleted.

A failed close is not a partial close: the batch stays `open` and can be retried after evidence is
fixed.

## Advisory leases

`tower_resource` manages per-repository leases in `<git-common-dir>/dsh-tower/leases.json`:

```text
tower_resource({action:"acquire", name:"heavy-ci", ttlMs:900000})
tower_resource({action:"status"})
tower_resource({action:"release", name:"heavy-ci", token:"<token from acquire>"})
```

- acquire is tower-only; the caller gets a token, pid, holder, created/expiry timestamps;
- the same token renews; another holder gets `[tower:lease-busy]`;
- release requires the token; an **expired** lease still requires the token and explicit `force:true`
  (no silent takeover);
- `spawn.requireLease` makes a worker spawn fail unless that lease is held.

Leases coordinate local jobs and CI windows. They are **not** an OS CPU/memory hard cap: DSH has no
public Job Object quota API, so Tower cannot enforce per-process resource limits; use the live-worker
cap and your OS/CI scheduler for those.

## Legacy import and mapping

`tower_import_legacy({repoRoot,sourcePath})` accepts a Tower Codex `schemaVersion:1` state file or a
DSH legacy state. It:

- requires an absolute source path outside `<git-common-dir>/dsh-tower`;
- validates the schema (16 MiB cap), stores the raw payload byte-for-byte under
  `<git-common-dir>/dsh-tower/legacy/<sha256>.json`, and records only a summary in
  `state.legacySnapshots`;
- never activates, adopts, or resumes paused missions.

`tower_legacy_map` records an audit-only `sourceHash + oldId → newMissionId?` mapping. Mappings are
append-only; rewriting an existing mapping to another mission is rejected. Mapping does not change
mission state.
