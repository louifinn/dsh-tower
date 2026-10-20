# Tool error codes

Tool failures are thrown errors, not `{ok:false}` results (gate outcomes are the exception: see
[blockers.md](blockers.md)). Every thrown error carries a stable code as a message prefix. This
release defines 31 tool error codes.

Every `TowerToolError` also carries `retryable` (boolean), `nextAction` (string or `null`) and `details`
(structured context or `null`) for programmatic callers; the message prefix remains the stable contract
for text-only clients.

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
| `worktree-dirty` | The mission worktree has uncommitted changes and cannot complete. | staged, modified, or untracked files left behind before `tower_complete` |
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
| `not-authorized` | The calling agent role may not perform this action. | a worker calling a tower-only tool or changing mission status/scope; a reviewer mutating findings |
| `workspace-busy` | Another Tower session owns this repository's workspace lock. | `mode.workspaceLock:true` and a second session calls a repo-scoped tool |
| `worker-limit` | The repository reached `spawn.maxLiveWorkers` live workers. | spawning a fifth worker with the default limit |
| `rate-limited` | The `tower_send` per-minute rate limit was reached. | `send.maxPerMinute` exceeded; retry later |
| `takeover-refused` | The mission still has a running worker. | `tower_spawn({takeover:true})` before `tower_interrupt` |
| `reload-unavailable` | The DSH HMR service is not available in this profile. | `tower_reload` / `/tower reload` on a profile without HMR |
| `reload-failed` | The HMR reload failed. | `reconcileProfile` threw; check the DSH log and restart |
| `tests-failed` | Declared test discovery failed or did not meet admission requirements. | nonzero command, malformed output, minCount/required shortfall |
| `tests-timeout` | Test discovery exceeded its time or output budget. | `tests.timeoutMs`, or stdout over `tests.maxBytes` |
| `lease-busy` | Another holder owns the requested advisory lease. | `tower_resource acquire` while `heavy-ci` is held |
| `lease-token` | The lease release token does not match the holder. | releasing with another session's token |
| `batch-invalid` | A batch request or its close evidence is invalid. | unknown member, duplicate id, unsafe receipt path, missing receipt hash |
| `legacy-invalid` | The legacy snapshot or mapping is invalid. | unknown schema, source inside the Tower state dir, mapping rewrite |
| `tool-internal` | An unexpected failure. | a bug; read the message and the activity log |

## Why thrown?

Returned `{ok:false}` shapes are reserved for expected policy outcomes that the tower decides on
(`tower_merge`/`tower_rebase` gate blockers and `tower_preflight`). Anything that prevents the tool
from producing a decision is thrown so the model does not mistake it for a normal negative result.
