# Testing, discovery and evidence

Tower 2.1 can execute a repository's declared test discovery and turn its result into durable
completion evidence. Discovery is **opt-in by configuration**: a worktree with no
`package.json.tower.testDiscovery` block behaves exactly as before.

## Configuration

`package.json` (Tower Codex-compatible):

```json
{
  "tower": {
    "testDiscovery": {
      "version": 1,
      "commands": [
        {
          "id": "unit",
          "command": "node --test dist/tests/*.test.js",
          "format": "node-tap",
          "minCount": 1,
          "required": ["smoke"]
        }
      ]
    }
  }
}
```

| Field | Meaning |
|---|---|
| `id` | Unique, `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; also used in diagnostic file names. |
| `command` | Shell command executed with the worktree as cwd (Windows `pwsh`, POSIX `bash`). |
| `format` | `node-tap` (TAP `ok N - name` / `not ok`) or `json-array` (JSON array of `{name, ok?}`). |
| `minCount` | Minimum discovered tests for this command (default 1). |
| `required` | Test names that must appear and pass. |

`tests.*` in the Tower config controls admission, timeout, output cap and whether package discovery
is allowed. `tests.admission` is `spawn` (before a worker starts; fail-closed, no child), `complete`
(at `tower_complete`; default), or `off` (explicit `tower_test` only).

## Receipts and gates

Each run stores a receipt under `<git-common-dir>/dsh-tower/test-runs/<mission>-<stamp>/` with
stdout/stderr files, SHA-256 hashes, exit codes, counts, required names, the worktree tip, and an
overall `ok`. `state.missions[].testRuns` keeps the most recent 50 receipts. The tool returns
`ok:false` with diagnostics on failure; `tower_complete` throws `[tower:tests-failed]` when automatic
discovery fails.

- `tower_test({repoRoot,missionId})` runs discovery on demand and records a receipt.
- `tower_complete` adds a `tests` check when `tests.autoChecks` is on.
- `gates.requireChecks` requires any completion check; `gates.requireTests` requires a passing receipt
  for the current mission branch tip (`tests-missing`). Review is independent of this gate: with
  `review.requireReview:false` the tests gate still checks the branch tip.

## Trust boundary

Discovery commands are repository-controlled code. `tests.allowPackageDiscovery:false` disables the
package block; a CI or policy profile should set it when cloning untrusted repositories. The command
runs with the same OS permissions as DSH, in the mission worktree, with no network access added by
Tower. Output is capped at `tests.maxBytes` (16 MiB default) and each command at `tests.timeoutMs`
(60 s default); over-budget runs fail closed.
