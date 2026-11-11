# ADR 0007: Bounded activity-log rotation

- Status: accepted
- Date: 2026-11-12
- Ref: #M76 (W5-B, technical-debt plan)

## Context

`<git-common-dir>/dsh-tower/activity.jsonl` is append-only. Every mutation and
the one-time state migration append a line (`app/*.js` via `Tower.appendActivity`,
and `adapters/stateFile.js` for `state.migrated`), because the log is the only
audit trail that survives outside `state.json`. Nothing bounded it: a long-lived
repository accumulates activity forever, and both the write path and every
`tower_status` read paid for the whole file.

The log cannot be truncated in place. A truncation would discard audit lines
while readers were still consuming them, and a partial write would leave the live
file torn. Rotation therefore has to move complete files, and the read paths have
to know the segments are part of the same chronological log.

## Decision

The store adapter owns rotation; the app layer only passes the repository's
resolved `activity` policy as data. Two tuning keys are added:

- `activity.maxBytes` (default 4 MiB, `0` disables rotation)
- `activity.retention` (default 5 rotated segments)

`appendJsonl(file, value, options)` compares the live file size plus the encoded
line with `maxBytes`. When the line would cross the cap, the adapter:

1. removes the oldest segment (`activity.jsonl.<retention>`),
2. shifts `.retention-1` … `.1` up by one with the same retrying rename kernel
   used for atomic JSON writes (`renameWithRetry`, with `unlinkOnFailure:false`
   so a failed move never deletes a durable file),
3. renames the live file to `.1`,
4. appends the new line to a fresh live file.

`.1` is the newest rotated segment and `.retention` the oldest. A rotation
failure never fails the append and never loses the line: the adapter falls back
to appending to the live file, and a later append retries rotation. An
unbounded log is preferable to a missing audit record. Appends to one file are
serialised inside the process so two writers cannot interleave the rename chain;
cross-process rotation remains advisory because activity appends normally run
while the repo state lock is held.

`readActivityTail(file, limit)` reads the live file first, then `.1`, `.2`, …
only as far as needed, reverses the collected groups and slices the tail. A
missing segment, a corrupt line, or a truncated final line is tolerated and
never hides the rest of the history. `tower_status` reports the policy
(`activityLog.maxBytes`/`retention`), and `tower_doctor` reports the policy plus
the live and rotated bytes and the segment count.

## Consequences

- The activity log is bounded at roughly `maxBytes × (retention + 1)` bytes.
- Existing repositories keep working: no migration, no schema change, and the
  live file remains `activity.jsonl`.
- The activity-tail reads that use `readActivityTail` — `tower_status` (dashboard and
  mission detail) — follow rotated segments instead of silently losing history; a
  reader that names only the live file still gets the live tail. `tower_complete`
  and `tower_roster` never read the activity log, so rotation does not affect them.
- Rotation is best effort. If the filesystem refuses every rename (for example a
  directory squatting on `activity.jsonl.1`), the log keeps growing until the
  obstruction is removed; the fallback is deliberately line-safe.
- A second process writing the same repository can race the rename chain. That is
  the same advisory-coordination boundary as the state lock, not a new hard
  guarantee.

## Rejected alternatives

- **Truncate the live file in place** — loses already-written audit lines and
  exposes readers to a partially rewritten file; a rename chain keeps complete
  files.
- **External logrotate** — imposes a host daemon and a configuration file outside
  Tower's config/schema; the adapter is the only layer already allowed to touch
  the filesystem.
- **Persist rotation counters in `state.json`** — a state-schema change and a
  second source of truth for a file-size decision that the adapter can make from
  `stat`.
- **A component row or a new tool** — rotation has no off state worth exposing as
  a capability and no user action; component rows are capability switches, not
  file-size tuning.

## Surface budget

Two tuning config keys and one section, recorded in
[`scripts/surface-baseline.json`](../../scripts/surface-baseline.json): config
keys 55 → 57 and sections 15 → 16. The visible component count stays 12; no tool
is added.
