# Doctor

`tower_inspect({ view: "doctor" })` is read-only. It never takes the state lock, writes state, or changes Git.
It returns:

```json
{
  "ok": true,
  "checks": [
    { "id": "git", "status": "pass", "detail": "git version 2.55.0" },
    { "id": "surface", "status": "pass", "detail": "config keys: 57 · sections: 16 · tools: 21 (baseline 2026-11-12)" },
    { "id": "state", "status": "pass", "detail": ".../state.json revision 7" },
    { "id": "state-schema", "status": "pass", "detail": "schemaVersion 5 is current" },
    { "id": "activity-log", "status": "pass", "detail": "activity.jsonl 1024 B live + 2 rotated segment(s) 8192 B (cap 4194304 B, retention 5)" },
    { "id": "case-mode", "status": "pass", "detail": "caseInsensitive: true; scope matching uses case-insensitive comparison" }
  ],
  "surface": {
    "configKeys": 57,
    "sections": 16,
    "tools": 21,
    "baselineDate": "2026-11-12",
    "line": "config keys: 57 · sections: 16 · tools: 21"
  },
  "stateLock": {
    "held": true,
    "pid": 4242,
    "startedAt": 1761280000000,
    "at": 1761280120000,
    "alive": true,
    "ageMs": 121000,
    "heartbeatAgeMs": 1000,
    "staleAfterMs": 3000,
    "stale": false
  },
  "gitLock": {
    "held": true,
    "pid": 4242,
    "phase": "merge",
    "heldMs": 92000
  },
  "ownership": {
    "owner": "session-abc",
    "caller": null,
    "sameOwner": false,
    "ownerMode": "off",
    "modeStoreStatus": "ok",
    "modeStoreFile": "D:/home/tower-mode/modes.json",
    "modeStoreError": null,
    "ownerLock": false,
    "foreignLock": false,
    "liveRoster": [],
    "unreadMessages": 0,
    "orphanLock": false,
    "blockers": [],
    "takeoverAvailable": true
  },
  "stateSchema": {
    "currentVersion": 5,
    "supportedVersion": 5,
    "migrations": [],
    "status": "current"
  },
  "archive": {
    "missions": 3,
    "archivedMissions": 12,
    "stateBytes": 48211,
    "archiveBytes": 190244,
    "years": [2026],
    "files": 2,
    "unreadable": [],
    "policy": { "enabled": true, "afterDays": 30, "maxMissions": 100 }
  },
  "environmentContract": {
    "platform": "win32",
    "gitVersion": "git version 2.55.0",
    "repoRoot": "D:/repo",
    "commonDir": "D:/repo/.git",
    "stateDir": "D:/repo/.git/dsh-tower",
    "caseInsensitive": true,
    "comparisonMode": "case-insensitive"
  }
}
```

### When config resolution fails

Doctor is the one diagnostic that stays reachable when the configuration cannot be resolved: an unknown
key, an invalid value, or an unreadable/corrupt repository config. Every other tool opens the Tower
first, so config resolution runs before the handler and the call fails closed. For `tower_inspect` with `view: "doctor"` only,
`config-invalid`/`config-unknown-key` from that open path is not rethrown: the call continues with an
anonymous actor, the handler opens the repository without the layer that failed, and it returns a
degraded report instead:

```json
{
  "ok": false,
  "configError": "[tower:config-unknown-key] Tower config has unknown key(s) ...",
  "checks": [
    {
      "id": "config",
      "status": "fail",
      "detail": "[tower:config-unknown-key] Tower config has unknown key(s) ...",
      "action": "repair the config named in the detail (profile config or <git-common-dir>/dsh-tower/config.json), then re-run tower_doctor"
    },
    { "id": "state", "status": "pass", "detail": ".../state.json revision 7" }
  ]
}
```

`configError` carries the resolution error verbatim, and the `config` check is replaced (never
duplicated) with a `fail` whose `detail` is the same error and whose `action` names the repair. The rest
of the report is still computed without the failed layer: the profile config when it still resolves,
otherwise the code defaults. The call is read-only: it never writes, never
migrates, and does not normalise `<git-common-dir>/dsh-tower/config.json`. The doctor row also skips the
lazy workspace-lock hook, which would resolve the config it just reported and could acquire a lock; a
read-only diagnostic must not write.

The exception is opt-in per authorization-matrix row (`configDiagnostic: true`, set only on the public
`tower_inspect` with `view: "doctor"` row). `tower_inspect` with `view: "status"`, `tower_plan`, every writer and every other read-only tool still fail
closed with `[tower:config-invalid]`/`[tower:config-unknown-key]`, so a broken config is never reported
as a healthy repository.

`surface` (and the `surface` check) reports the concept budget in the same format
as the generated references: `config keys: N · sections: N · tools: N`, plus the
committed baseline date from `scripts/surface-baseline.json`. The counts are live:
the config schema and every tool the build ships — `define()`-registered tools,
the `tower_mode` tool the Host entry registers directly (#118),
and the capability tools whose optional component row may be off (#121) —
independent of the operational switches. The `tools` count is therefore the full
build surface (21 in 2.8.0, 16 default), even though the shipped profile mounts 16 because the
five subsystem rows ship off; the `components` check names the mounted subset and every
disabled row.

`subsystems` lists the five default-off rows (`tower-batch`, `tower-import`,
`tower-leases`, `tower-tests`, `tower-hmr`) as `{id, enabled, tool, enable}`; each
row's tool stays in the 21 all-on surface. The `components` check detail names each
row as off, not deleted, with its enable step. A `deprecated-tool-names` check scans
`mode.denyTools` for names that #163 merged or removed (`tower_control`, `tower_adopt`,
`tower_findings`, `tower_import_legacy`, `tower_legacy_map`, `tower_status`,
`tower_roster`, `tower_diff`, `tower_preflight`, `tower_doctor`) and reports
`<old> -> <replacement>` instead of silently ignoring them. `npm run surface:check` is what fails when a count grew without an
ADR, a matching deletion or a recorded measurement correction. See
[surface-budget.md](surface-budget.md) for the classification table.

`stateSchema` describes the file **on disk**, not the in-memory document: `currentVersion` is the
`schemaVersion` doctor read, `supportedVersion` is the build's `SCHEMA_VERSION`, and `migrations` is
the ordered v→v path a write would apply (`[]` when current). `status` is one of `current`,
`migratable`, `newer`, `unmigratable`, `invalid`. Doctor never migrates, so a `migratable` file stays
byte-identical and the `state-schema` check is a `warn` (the next locked write applies the migration
and keeps a `state.json.v<N>.bak` backup). A file written by a newer plugin reports `newer` and a
`fail`: this build refuses to downgrade it. A state-load failure is reported as a failed check rather
than thrown so doctor remains useful on a broken repository.

`stateLock` (and the `state-lock` check) reports the held lock's age (`ageMs`, from the record's
`since`) and heartbeat freshness (`heartbeatAgeMs`, from its last `at`) against the stale window
(`staleAfterMs = 3 × 1000 ms`). A live PID is not proof of a live writer: a holder that stopped
heartbeating is reported as `stale: true`, but a live-but-silent holder is **never reclaimed
automatically**. Only a lock whose PID is provably dead is reclaimed, atomically, by the next
mutation. Recovering a live-but-silent lock requires the operator to confirm the process is gone and
run `tower_recover clear-stale-lock force:true` with `confirm:"CLEAR_STALE_LOCK"`; that moves the
lock record to a backup instead of deleting it. This makes a recycled PID diagnosable without
reading `state.lock` by hand.

`ownership` (and the `tower-owner`/`workspace-lock` checks) is the same read-only ownership snapshot
`tower_inspect` with `view: "status"` returns, or `null` when the state or ownership facts could not be read. It contains
`owner`, `caller`, `sameOwner`, `ownerMode`, `modeStoreStatus`, `modeStoreFile`, `modeStoreError`,
`ownerLock`, `foreignLock`, `liveRoster`, `unreadMessages`, `orphanLock`, `blockers` and
`takeoverAvailable`. `modeStoreStatus` is `missing`, `ok`, or `corrupt`. When it is `corrupt`,
`ownerMode` is `unknown` (never `off`), the first `blockers` entry is `mode-store-corrupt` with the
repair action, and `takeoverAvailable` is `false`: a takeover fails closed instead of transcribing
an unreadable mode store as an inactive owner. The `ownership` field is how doctor and status stay
consistent with each other.

`gitLock` (and the `git-lock` check) reports the repo-scoped git mutex: `{held, pid, phase, heldMs}`
while a merge/rebase/init/teardown/provision holds it, and `{held: false}` when free. A merge may hold
it for the configured merge timeout (15 minutes by default), so a held lock is a `warn` rather than a
failure; the holder's phase and age make a stalled tower diagnosable. `tower_inspect` with `view: "status"` returns the same
`gitLock` object.

`board` names the `MISSIONS.md` location (`docs.boardLocation`) and whether the `tower-board` component
row is mounted. With the row off the check is a `warn` that says the board is not written (an existing
board goes stale) and names the row; every state tool and gate still works.

`archive` reports the terminal-mission archive: active `missions`, `archivedMissions` and `stateBytes`,
the archive directory's `archiveBytes`/`years`/`files`, every `unreadable` diagnostic, and the tuning
`policy` (`afterDays`, `maxMissions`). `policy.enabled` reflects the `tower-archive` component row, not a
config key: with the row off the policy line says archival is disabled by the component, terminal
missions stay hot and `state.json` keeps growing. A missing archive directory is a healthy empty archive
(`archive` check `pass`); a truncated index or year file is a `warn` with the diagnostic, and archiving is
paused until it is repaired rather than overwriting it. Nothing is lost while the archive is unreadable:
the eligible missions stay in `state.json`.

`caseInsensitive` is the mode `tower_init` detected once on the checkout's filesystem; `null` means
"not detected yet" and the `case-mode` check is a `warn`. `comparisonMode` is the comparison scope
matching actually uses: `case-insensitive` folds both sides, `case-sensitive` stays byte-exact. Doctor
never probes — a probe creates a temporary file, and a read-only call must not write. Run
`tower_init` on a writable checkout to record the mode; until then the safe `case-sensitive` default
applies.

Checks cover: git availability, repository identity, state schema/load, bounded activity-log rotation,
the detected case mode, repo config presence, worker/reviewer preset names, subagents and HMR services,
state lock age/heartbeat, workspace lock holder/staleness, live roster, worktree
existence/ownership/dirtiness, test-discovery policy, completion-report sizes, archive health, legacy
snapshots, batches and leases. Missions intentionally cleaned up by `tower_teardown` are skipped (the
check notes the removed count) instead of being reported as missing.
`warn` is advisory; `fail` means the repository needs attention before spawning/merging.

The `reports` check names the largest completion report in the repository (`<bytes> B on <mission>`,
against the `gates.maxReportBytes` cap); the same numbers are returned as
`reports: { count, largest: { missionId, bytes } | null, capBytes }`. Reports written before the cap
only produce a `warn`; doctor never rewrites them.

The environment contract is informational; it is not an identity or authorization proof. `tower_init`
still requires the tower role, and `tower_spawn` still checks the live subagent catalog.
