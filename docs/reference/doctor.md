# Doctor

`tower_doctor({repoRoot})` is read-only. It never takes the state lock, writes state, or changes Git.
It returns:

```json
{
  "ok": true,
  "checks": [
    { "id": "git", "status": "pass", "detail": "git version 2.55.0" },
    { "id": "state", "status": "pass", "detail": ".../state.json revision 7" }
  ],
  "environmentContract": {
    "platform": "win32",
    "gitVersion": "git version 2.55.0",
    "repoRoot": "D:/repo",
    "commonDir": "D:/repo/.git",
    "stateDir": "D:/repo/.git/dsh-tower"
  }
}
```

Checks cover: git availability, repository identity, state schema/load, repo config presence,
worker/reviewer preset names, subagents and HMR services, workspace lock holder/staleness, live roster,
worktree existence/ownership/dirtiness, test-discovery policy, legacy snapshots, batches and leases.
`warn` is advisory; `fail` means the repository needs attention before spawning/merging. A state-load
failure is reported as a failed check rather than thrown so doctor remains useful on a broken
repository.

The environment contract is informational; it is not an identity or authorization proof. `tower_init`
still requires the tower role, and `tower_spawn` still checks the live subagent catalog.
