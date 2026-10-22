# Doctor

`tower_doctor({repoRoot})` is read-only. It never takes the state lock, writes state, or changes Git.
It returns:

```json
{
  "ok": true,
  "checks": [
    { "id": "git", "status": "pass", "detail": "git version 2.55.0" },
    { "id": "state", "status": "pass", "detail": ".../state.json revision 7" },
    { "id": "state-schema", "status": "pass", "detail": "schemaVersion 2 is current" }
  ],
  "stateSchema": {
    "currentVersion": 2,
    "supportedVersion": 2,
    "migrations": [],
    "status": "current"
  },
  "environmentContract": {
    "platform": "win32",
    "gitVersion": "git version 2.55.0",
    "repoRoot": "D:/repo",
    "commonDir": "D:/repo/.git",
    "stateDir": "D:/repo/.git/dsh-tower"
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

Checks cover: git availability, repository identity, state schema/load, repo config presence,
worker/reviewer preset names, subagents and HMR services, workspace lock holder/staleness, live roster,
worktree existence/ownership/dirtiness, test-discovery policy, completion-report sizes, legacy
snapshots, batches and leases.
Missions intentionally cleaned up by `tower_teardown` are skipped (the check notes the removed count)
instead of being reported as missing.
`warn` is advisory; `fail` means the repository needs attention before spawning/merging.

The `reports` check names the largest completion report in the repository (`<bytes> B on <mission>`,
against the `gates.maxReportBytes` cap); the same numbers are returned as
`reports: { count, largest: { missionId, bytes } | null, capBytes }`. Reports written before the cap
only produce a `warn`; doctor never rewrites them.

The environment contract is informational; it is not an identity or authorization proof. `tower_init`
still requires the tower role, and `tower_spawn` still checks the live subagent catalog.
