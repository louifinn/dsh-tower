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
  "stateSchema": {
    "currentVersion": 3,
    "supportedVersion": 3,
    "migrations": [],
    "status": "current"
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

`caseInsensitive` is the mode `tower_init` detected once on the checkout's filesystem; `null` means
"not detected yet" and the `case-mode` check is a `warn`. `comparisonMode` is the comparison scope
matching actually uses: `case-insensitive` folds both sides, `case-sensitive` stays byte-exact. Doctor
never probes — a probe creates a temporary file, and a read-only call must not write. Run
`tower_init` on a writable checkout to record the mode; until then the safe `case-sensitive` default
applies.

Checks cover: git availability, repository identity, state schema/load, the detected case mode, repo
config presence, worker/reviewer preset names, subagents and HMR services, workspace lock
holder/staleness, live roster, worktree existence/ownership/dirtiness, test-discovery policy, legacy
snapshots, batches and leases. Missions intentionally cleaned up by `tower_teardown` are skipped (the
check notes the removed count) instead of being reported as missing.
`warn` is advisory; `fail` means the repository needs attention before spawning/merging.

The environment contract is informational; it is not an identity or authorization proof. `tower_init`
still requires the tower role, and `tower_spawn` still checks the live subagent catalog.
