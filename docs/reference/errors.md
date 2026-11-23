# Tool error codes

Tool failures are thrown errors, not `{ok:false}` results (gate outcomes are the exception: see
[blockers.md](blockers.md)). Every thrown error carries a stable code as a message prefix. This
release defines 45 tool error codes.

Every `TowerToolError` carries `retryable` (boolean), `nextAction` (string or `null`) and `details`
(structured context or `null`) for programmatic callers. The model-visible surface is the message:
when the catalog supplies a recovery step, exactly one trailing ` — next: …` segment is rendered;
when the code is also retryable, that same segment ends with ` (retryable)`. Codes without a
`nextAction` keep the historical `[tower:<code>] <message>` form byte-for-byte, and a message that
already contains its action is not suffixed twice. The table below is generated from
`domain/errors.js`, the same catalog the runtime uses.

```
[tower:mission-not-found] unknown mission "M9" — next: list missions with tower_inspect (view: status)
```

Callers can match the prefix instead of the prose. Codes are reserved for the conditions below; a
plain `Error` without a structured code is reported as `tool-internal`.

<!-- generated:error-table:start -->
| Code | Meaning | Retryable | Next action | Typical trigger |
|---|---|---|---|---|
| `invalid-argument` | A tool argument is missing, malformed, or not allowed. | no | — | `missionId`/`id` omitted; unknown status; empty report; bad scope glob; `timeoutMs < 1000`; `status: "all"` on an update. |
| `repo-invalid` | The target repository could not be resolved, or the resolved path is not inside a Git repository. | no | bind a Tower workspace, call from inside a Git repository, or pass an absolute `repoRoot` | a repository-scoped tool called with no workspace binding, outside a Git repository, and without an explicit `repoRoot` |
| `not-initialized` | Tower is not initialized for this repository; run tower_init. | no | run tower_init for this repository | a read tool before `tower_init` |
| `mission-not-found` | No mission with that id exists. | no | list missions with tower_inspect (view: status) | a stale or mistyped `M9` |
| `finding-not-found` | No finding with that id exists. | no | list findings with tower_finding | `tower_finding({op:"list", id:"F99"})` |
| `invalid-transition` | The requested state transition is not allowed. | no | — | a blocked→merged attempt; a finding transition not in the graph; a reviewer mutating findings; completing a mission with open tasks, blockers, no commits, or unread inbox messages. |
| `stale-base` | The repository state changed while the operation was being prepared; retry. | yes | retry the tool; if it keeps failing, run tower_inspect with view: preflight and view: status | two-phase mutation revalidation |
| `base-mismatch` | The checked-out branch differs from the recorded state.base, so planning and spawning would split the repository. | no | check out the recorded base branch; if this checkout is the intended base, run tower_init({base:"<branch>", reanchor:true}) when no mission is in flight | `tower_plan` or `tower_spawn` while HEAD is on another branch (or detached) instead of `state.base` |
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
| `preset-missing` | The agent preset this Tower profile needs is not registered. | no | switch the required preset back on in the plugin page, then restart DSH | the required preset is not registered after a configuration change or an upgrade, or DSH was not restarted after installing it |
| `reviewer-prerequisite` | The reviewer spawn prerequisite is not met. | no | complete the mission first, then spawn the reviewer | reviewer spawned before the mission is `completed`, or before a worktree exists |
| `review-disabled` | Review before merging is turned off in this project's plugin configuration, so no reviewer, verdict, or review blocker exists. | no | turn review before merging back on in the plugin page, or start an agent without requiring review | a reviewer is started, or a review is recorded, while review before merging is turned off |
| `not-authorized` | The calling agent role may not perform this action. | no | call the tool as the tower, or as the worker/reviewer it is assigned to | a worker calling a tower-only tool or changing mission status/scope; a reviewer mutating findings |
| `workspace-busy` | Another Tower session owns this repository workspace lock. | yes | run /tower off in the other session or wait for its lock to become stale | `mode.workspaceLock:true` and a second session calls a repo-scoped tool |
| `mode-store-corrupt` | The persisted Tower mode store is unreadable or corrupt, so the owner's mode cannot be determined. | no | repair or move aside the mode store file, then re-enter Tower mode in the owning session and retry | a takeover or mode read while `modes.json` is truncated, invalid JSON, or not a `{version,modes}` document |
| `mode-persist-failed` | A Tower mode change could not be saved to the mode store; for `/tower off` the change is rolled back so the session keeps the mode the disk records. | yes | fix the mode store path/permissions or remove the stale mode-store lock, then retry the mode change | `/tower on\|off`, `tower_mode` writes, or workspace-lock persistence cannot write the mode store (corrupt bytes, unwritable path, or a held mode-store lock) |
| `owner-live` | The current Tower owner is still active, so ownership cannot be transferred. | yes | run /tower off in the owning session, wait for its workspace lock to go stale, then retry the takeover | takeover while the previous owner still has Tower mode on and a live workspace lock |
| `owner-busy` | Another live Tower participant or a foreign workspace lock blocks ownership transfer. | yes | stop live workers, release the foreign workspace lock, then retry the takeover | takeover while live roster agents exist or another session holds the workspace lock |
| `approval-unavailable` | The human approval channel is unavailable for an ownership transfer or an artifact acceptance. | no | use the human /tower takeover <reason> command (or accept in a session with the user-questions service available); an artifact acceptance is never auto-recorded | `tower_mode({active:"takeover"})` or `tower_mission({accept:true})` in a profile without the userQuestions service |
| `acceptance-human-only` | An artifact mission merges on a human acceptance of the committed tip; an agent cannot accept. | no | only the tower may ask the human through the approval channel; the recorded acceptance always says by:"human" | a worker calls tower_mission accept for an artifact mission |
| `worker-limit` | The repository reached spawn.maxLiveWorkers live workers. | no | wait for a live worker to finish or raise spawn.maxLiveWorkers | spawning a fifth worker with the default limit |
| `rate-limited` | The tower_send per-minute rate limit was reached. | yes | wait for the next per-minute window or raise send.maxPerMinute | `send.maxPerMinute` exceeded |
| `agent-not-resumable` | A wake:true target cannot be resumed, so its persisted message cannot start a turn. | no | choose a running agent or a resumable direct child (tower_inspect view:"roster"); the message stays in the target's inbox until that agent runs again | `tower_send({wake:true})` to a stopped agent with no continuation state |
| `takeover-refused` | The mission already has a live worker that was not stopped first. | no | run tower_interrupt for the live worker, then retry the takeover | `tower_spawn({op:"takeover"})` before `tower_interrupt` |
| `reload-unavailable` | The DSH HMR service is not available in this profile. | no | restart DSH instead of reloading | `tower_reload` / `/tower reload` on a profile without HMR |
| `reload-failed` | The HMR reload failed; check the DSH log and restart if needed. | no | check the DSH log and restart DSH | `reconcileProfile` threw |
| `tests-failed` | Declared test discovery failed or did not meet its admission requirements. | no | fix the failing tests, then retry tower_complete | nonzero command, malformed output, minCount/required shortfall |
| `tests-timeout` | Test discovery exceeded its time or output budget. | no | raise tests.timeoutMs or tests.maxBytes (or speed up the suite), then retry | `tests.timeoutMs`, or stdout over `tests.maxBytes` |
| `lease-busy` | Another holder owns the requested advisory lease. | no | release the lease or wait for it to expire, then retry | `tower_resource acquire` while `heavy-ci` is held |
| `lease-token` | The lease release token does not match the current holder. | no | use the token returned when the lease was acquired | releasing with another session's token |
| `batch-invalid` | The batch request or its close evidence is invalid. | no | fix the batch request or the receipt hashes, then retry | unknown member, duplicate id, unsafe receipt path, missing receipt hash |
| `legacy-invalid` | The legacy snapshot or mapping is invalid. | no | check the legacy snapshot path, schema and mapping, then retry | unknown schema, source inside the Tower state dir, mapping rewrite |
| `state-io-failed` | A Tower state, activity, lock, commit-mutex or mode document could not be read or written because the host filesystem refused the operation; the previous document is left in place. | no | free space on the volume named in the message (or close the open file handles), confirm the directory is writable, remove any lock record named in the message, then retry the same tool call | ENOSPC/EMFILE/ENFILE/EIO while writing state.json, the activity log, a lock record, the state commit mutex, the merge record or the mode store |
| `tool-internal` | An unexpected failure; read the message and the activity log. | no | — | a bug; read the message and the activity log |
<!-- generated:error-table:end -->

A git-mutex timeout is a `state-locked` error that names the holder. Its `details` is
`{ holderPid, holderPhase, heldMs, waitedMs }`, and the message renders the same facts as
`held by pid 1234 (merge) for 92 s; waited 60 s`. `holderPhase` is the operation that holds the lock
(`merge`, `rebase`, `init`, `teardown`, `provision`); `tower_inspect` with `view: "status"` and `tower_inspect` with `view: "doctor"` expose the same
holder as `gitLock: { held, pid, phase, heldMs }` while it is held.

A `state-io-failed` error carries `details: { code, path, phase }`: the raw errno, the exact file
whose write was refused, and the durable-write seam that failed. `phase` is one of

| Phase | The write that was refused |
|---|---|
| `state-write` | replacing `state.json` itself |
| `state-read` | reading `state.json` (an unreadable document is the mirror case) |
| `state-backup` | writing the pre-migration `state.json.v<N>.bak` |
| `activity-append` | appending a line to the activity log |
| `lock-create` | creating the state writer lock (`state.lock`) |
| `lock-release` | moving the state writer lock aside after a successful mutation |
| `state-commit-lock` | creating the short-lived state commit mutex (`state.commit.lock`), or moving it aside afterwards |
| `<phase>-lock` | creating the git mutation lock for the named operation (`merge-lock`, `rebase-lock`, `init-lock`, `teardown-lock`, `provision-lock`) |
| `<phase>-release` | moving the git mutation lock aside after that operation finished |
| `config-write` | writing the mode store |

When the failure happens *after* git already created a merge commit, the message says so: the
commit exists in Git, Tower could not record it, and the merge therefore did not land in the mission
state. When only the activity line fails after the state record landed, the message says the merge
landed and only its activity line is missing. A failure to release the commit mutex after a
successful state write adds `details.released: false` and warns that the next writer reports
`state-commit-busy` until the named lock path is removed.

## Why thrown?

Returned `{ok:false}` shapes are reserved for expected policy outcomes that the tower decides on
(`tower_merge`/`tower_rebase` gate blockers and `tower_inspect` with `view: "preflight"`). Anything that prevents the tool
from producing a decision is thrown so the model does not mistake it for a normal negative result.
