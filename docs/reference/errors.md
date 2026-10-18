# Tool error codes

Tool failures are thrown errors, not `{ok:false}` results (gate outcomes are the exception: see
[blockers.md](blockers.md)). Every thrown error carries a stable code as a message prefix:

```
[tower:mission-not-found] unknown mission "M9"
```

Callers can match the prefix instead of the prose. Codes are reserved for the conditions below; a
message without a more specific match is reported as `tool-internal`.

| Code | Meaning | Typical trigger |
|---|---|---|
| `invalid-argument` | A tool argument is missing, malformed, or not allowed. | `missionId`/`id` omitted; unknown status; empty report; bad scope glob; `timeoutMs < 1000`; `status: "all"` on an update. |
| `repo-invalid` | `repoRoot` is missing, relative, or not inside a Git repository. | passing a path in a directory that is not a repo |
| `not-initialized` | Tower is not initialized for this repository. | a read tool before `tower_init` |
| `mission-not-found` | No mission with that id exists. | a stale or mistyped `M9` |
| `finding-not-found` | No finding with that id exists. | `tower_findings({id:"F99"})` |
| `invalid-transition` | The requested state transition is not allowed. | a blocked→merged attempt; a finding transition not in the graph; a reviewer mutating findings; completing a mission with open tasks, blockers, no commits, or unread inbox messages. |
| `state-locked` | Another Tower writer holds the state lock. | concurrent mutation after the lock timeout |
| `state-corrupt` | The Tower state file is unreadable or invalid. | hand-edited `state.json` |
| `config-invalid` | Tower configuration is invalid. | malformed repo `config.json`, a value that violates the schema |
| `config-unknown-key` | Tower configuration has an unknown top-level key. | a typo such as `allowAgentToggle` |
| `git-failed` | A git command failed for a reason other than the delegated cases. | a rejected merge command, invalid ref |
| `git-timeout` | A git command timed out or exceeded its output buffer. | slow pre-merge hook, huge diff |
| `spawn-unavailable` | The subagents service is unavailable. | a Host without `subagents` |
| `provider-missing` | No subagent provider is registered. | an empty provider list |
| `preset-missing` | The configured agent preset is not registered. | missing `tower-worker`/`tower-reviewer` preset rows, DSH not restarted |
| `reviewer-prerequisite` | The reviewer spawn prerequisite is not met. | reviewer spawned before the mission is `completed`, or before a worktree exists |
| `tool-internal` | An unexpected failure. | a bug; read the message and the activity log |

## Why thrown?

Returned `{ok:false}` shapes are reserved for expected policy outcomes that the tower decides on
(`tower_merge`/`tower_rebase` gate blockers and `tower_preflight`). Anything that prevents the tool
from producing a decision is thrown so the model does not mistake it for a normal negative result.
