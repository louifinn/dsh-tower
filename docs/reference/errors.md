# Tool error codes

Tool failures are thrown errors, not `{ok:false}` results (gate outcomes are the exception: see
[blockers.md](blockers.md)). Every thrown error carries a stable code as a message prefix. This
release defines 35 tool error codes.

Every `TowerToolError` carries `retryable` (boolean), `nextAction` (string or `null`) and `details`
(structured context or `null`) for programmatic callers. The model-visible surface is the message:
when the catalog supplies a recovery step, exactly one trailing ` — next: …` segment is rendered;
when the code is also retryable, that same segment ends with ` (retryable)`. Codes without a
`nextAction` keep the historical `[tower:<code>] <message>` form byte-for-byte, and a message that
already contains its action is not suffixed twice. The table below is generated from
`domain/errors.js`, the same catalog the runtime uses.

```
[tower:mission-not-found] unknown mission "M9" — next: list missions with tower_status
```

Callers can match the prefix instead of the prose. Codes are reserved for the conditions below; a
plain `Error` without a structured code is reported as `tool-internal`.

<!-- generated:error-table:start -->
| Code | Meaning | Retryable | Next action | Typical trigger |
|---|---|---|---|---|
| `invalid-argument` | A tool argument is missing, malformed, or not allowed. | no | — | `missionId`/`id` omitted; unknown status; empty report; bad scope glob; `timeoutMs < 1000`; `status: "all"` on an update. |
| `repo-invalid` | repoRoot is missing, relative, or not inside a Git repository. | no | pass an absolute path to a directory inside a Git repository | passing a path in a directory that is not a repo |
| `not-initialized` | Tower is not initialized for this repository; run tower_init. | no | run tower_init for this repository | a read tool before `tower_init` |
| `mission-not-found` | No mission with that id exists. | no | list missions with tower_status | a stale or mistyped `M9` |
| `finding-not-found` | No finding with that id exists. | no | list findings with tower_findings | `tower_findings({id:"F99"})` |
| `invalid-transition` | The requested state transition is not allowed. | no | — | a blocked→merged attempt; a finding transition not in the graph; a reviewer mutating findings; completing a mission with open tasks, blockers, no commits, or unread inbox messages. |
| `stale-base` | The repository state changed while the operation was being prepared; retry. | yes | retry the tool; if it keeps failing, run tower_preflight and inspect tower_status | two-phase mutation revalidation |
| `state-locked` | Another Tower writer holds the state lock. | yes | wait for the other Tower writer to finish, then retry | concurrent mutation after the lock timeout |
| `state-corrupt` | The Tower state file is unreadable or invalid. | no | restore state.json from a backup, or re-initialize after filing the corruption | hand-edited `state.json`; invalid JSON; no usable `schemaVersion` |
| `state-version-unsupported` | The Tower state file uses a schema version this build cannot read or downgrade. | no | upgrade dsh-tower to a release that supports this state schemaVersion | opening a repository written by a newer plugin; an unknown older version; this build refuses to downgrade |
| `state-migration-failed` | A Tower state migration failed; the original state file was not modified. | no | restore the pre-migration backup state.json.v<N>.bak and report the migration bug | a bug in a migration step; see the pre-migration `state.json.v<N>.bak` |
| `config-invalid` | Tower configuration is invalid. | no | fix the repository config file, then retry | malformed repo `config.json`, a value that violates the schema |
| `config-unknown-key` | Tower configuration has an unknown top-level key. | no | remove the unknown key from the repository config file, then retry | a typo such as `allowAgentToggle` |
| `git-failed` | A git command failed. | no | — | a rejected merge command, invalid ref |
| `git-timeout` | A git command timed out or exceeded its output buffer. | yes | retry; if it persists, raise git.timeoutMs or merge.timeoutMs | slow pre-merge hook, huge diff |
| `worktree-dirty` | The mission worktree has uncommitted changes and cannot complete. | no | commit or remove the worktree changes, then retry tower_complete | staged, modified, or untracked files left behind before `tower_complete` |
| `spawn-unavailable` | The subagents service is unavailable. | no | enable the DSH subagents service, then retry | a Host without `subagents` |
| `provider-missing` | No subagent provider is registered. | no | register a subagent provider in the DSH profile, then retry | an empty provider list |
| `provider-cooldown` | The provider is throttled; spawn is in a short cooldown. | yes | wait for the cooldown to expire, then retry | repeated retryable provider failures; wait for `blockedUntil` |
| `preset-missing` | The configured agent preset is not registered. | no | install the tower-worker and tower-reviewer agent presets and restart DSH | missing `tower-worker`/`tower-reviewer` preset rows, DSH not restarted |
| `reviewer-prerequisite` | The reviewer spawn prerequisite is not met. | no | complete the mission first, then spawn the reviewer | reviewer spawned before the mission is `completed`, or before a worktree exists |
| `not-authorized` | The calling agent role may not perform this action. | no | call the tool as the tower, or as the worker/reviewer it is assigned to | a worker calling a tower-only tool or changing mission status/scope; a reviewer mutating findings |
| `workspace-busy` | Another Tower session owns this repository workspace lock. | yes | run /tower off in the other session or wait for its lock to become stale | `mode.workspaceLock:true` and a second session calls a repo-scoped tool |
| `worker-limit` | The repository reached spawn.maxLiveWorkers live workers. | no | wait for a live worker to finish or raise spawn.maxLiveWorkers | spawning a fifth worker with the default limit |
| `rate-limited` | The tower_send per-minute rate limit was reached. | yes | wait for the next per-minute window or raise send.maxPerMinute | `send.maxPerMinute` exceeded |
| `takeover-refused` | The mission already has a live worker that was not stopped first. | no | run tower_interrupt for the live worker, then retry the takeover | `tower_spawn({takeover:true})` before `tower_interrupt` |
| `reload-unavailable` | The DSH HMR service is not available in this profile. | no | restart DSH instead of reloading | `tower_reload` / `/tower reload` on a profile without HMR |
| `reload-failed` | The HMR reload failed; check the DSH log and restart if needed. | no | check the DSH log and restart DSH | `reconcileProfile` threw |
| `tests-failed` | Declared test discovery failed or did not meet its admission requirements. | no | fix the failing tests, then retry tower_complete | nonzero command, malformed output, minCount/required shortfall |
| `tests-timeout` | Test discovery exceeded its time or output budget. | no | raise tests.timeoutMs or tests.maxBytes (or speed up the suite), then retry | `tests.timeoutMs`, or stdout over `tests.maxBytes` |
| `lease-busy` | Another holder owns the requested advisory lease. | no | release the lease or wait for it to expire, then retry | `tower_resource acquire` while `heavy-ci` is held |
| `lease-token` | The lease release token does not match the current holder. | no | use the token returned when the lease was acquired | releasing with another session's token |
| `batch-invalid` | The batch request or its close evidence is invalid. | no | fix the batch request or the receipt hashes, then retry | unknown member, duplicate id, unsafe receipt path, missing receipt hash |
| `legacy-invalid` | The legacy snapshot or mapping is invalid. | no | check the legacy snapshot path, schema and mapping, then retry | unknown schema, source inside the Tower state dir, mapping rewrite |
| `tool-internal` | An unexpected failure; read the message and the activity log. | no | — | a bug; read the message and the activity log |
<!-- generated:error-table:end -->

A git-mutex timeout is a `state-locked` error that names the holder. Its `details` is
`{ holderPid, holderPhase, heldMs, waitedMs }`, and the message renders the same facts as
`held by pid 1234 (merge) for 92 s; waited 60 s`. `holderPhase` is the operation that holds the lock
(`merge`, `rebase`, `init`, `teardown`, `provision`); `tower_status` and `tower_doctor` expose the same
holder as `gitLock: { held, pid, phase, heldMs }` while it is held.

## Why thrown?

Returned `{ok:false}` shapes are reserved for expected policy outcomes that the tower decides on
(`tower_merge`/`tower_rebase` gate blockers and `tower_preflight`). Anything that prevents the tool
from producing a decision is thrown so the model does not mistake it for a normal negative result.
