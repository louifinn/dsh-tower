# Doctor

`tower_doctor({repoRoot})` is read-only. It never takes the state lock, writes state, or changes Git.
It returns:

```json
{
  "ok": true,
  "checks": [
    { "id": "git", "status": "pass", "detail": "git version 2.55.0" },
    { "id": "state", "status": "pass", "detail": ".../state.json revision 7" },
    { "id": "state-schema", "status": "pass", "detail": "schemaVersion 3 is current" },
    { "id": "case-mode", "status": "pass", "detail": "caseInsensitive: true; scope matching uses case-insensitive comparison" }
  ],
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
  "stateSchema": {
    "currentVersion": 3,
    "supportedVersion": 3,
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
heartbeating is reported as `stale: true` and is reclaimable by the next mutation (or by
`tower_recover clear-stale-lock force:true`), while a fresh heartbeat is reported as held and is never
stolen. This is what makes a recycled PID diagnosable without reading `state.lock` by hand.

`archive` reports the terminal-mission archive: active `missions`, `archivedMissions` and `stateBytes`,
the archive directory's `archiveBytes`/`years`/`files`, every `unreadable` diagnostic, and the configured
`policy` (`enabled`, `afterDays`, `maxMissions`). A missing archive directory is a healthy empty archive
(`archive` check `pass`); a truncated index or year file is a `warn` with the diagnostic, and archiving is
paused until it is repaired rather than overwriting it. Nothing is lost while the archive is unreadable:
the eligible missions stay in `state.json`.

Checks cover: git availability, repository identity, state schema/load, repo config presence,
worker/reviewer preset names, subagents and HMR services, workspace lock holder/staleness, live roster,
worktree existence/ownership/dirtiness, test-discovery policy, completion-report sizes, archive health, legacy`nsnapshots, batches and leases. Missions intentionally cleaned up by `tower_teardown` are skipped (the check`nnotes the removed count) instead of being reported as missing.

`caseInsensitive` is the mode `tower_init` detected once on the checkout's filesystem; `null` means
"not detected yet" and the `case-mode` check is a `warn`. `comparisonMode` is the comparison scope
matching actually uses: `case-insensitive` folds both sides, `case-sensitive` stays byte-exact. Doctor
never probes — a probe creates a temporary file, and a read-only call must not write. Run
`tower_init` on a writable checkout to record the mode; until then the safe `case-sensitive` default
applies.

Checks cover: git availability, repository identity, state schema/load, the detected case mode, repo
config presence, worker/reviewer preset names, subagents and HMR services, state lock age/heartbeat,
workspace lock holder/staleness, live roster, worktree existence/ownership/dirtiness, test-discovery policy, legacy
snapshots, batches and leases. Missions intentionally cleaned up by `tower_teardown` are skipped (the
check notes the removed count) instead of being reported as missing.
`warn` is advisory; `fail` means the repository needs attention before spawning/merging.

The `reports` check names the largest completion report in the repository (`<bytes> B on <mission>`,
against the `gates.maxReportBytes` cap); the same numbers are returned as
`reports: { count, largest: { missionId, bytes } | null, capBytes }`. Reports written before the cap
only produce a `warn`; doctor never rewrites them.

The environment contract is informational; it is not an identity or authorization proof. `tower_init`
still requires the tower role, and `tower_spawn` still checks the live subagent catalog.
