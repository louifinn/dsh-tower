# Tools reference

All tools take `repoRoot` (an absolute path inside the target Git repository) and return JSON.
The build exposes up to 22 tools: 19 repository tools below, `tower_interrupt`, `tower_mode`,
`tower_control` when `mode.allowAgentControl` is enabled (the bundled patch enables it), and
`tower_reload` while `dev.hotReload` is on (default true; it fails with `reload-unavailable` when the
profile has no HMR service).

`tower_mission` uses `id` (alias `missionId`); every other mission-scoped tool uses `missionId`
(alias `id`). Other input aliases: `task_done`/`taskDone`, `task_drop`/`taskDrop`,
`task_drop_reason`/`taskDropReason`, `clear_blockers`/`clearBlockers`,
`include_read`/`includeRead`, `dry_run`/`dryRun`, `timeoutMs`/`timeout_ms`,
`waitMs`/`wait_ms`, `mission_id`/`missionId` on findings, `agent_id`/`agentId` on interrupt,
`include_gate`/`includeGate` on status, `retire_missing`/`retireMissing` on adopt. Outputs use
canonical camelCase names.

## Roles

Roster roles are resolved from `exec.agent` + the roster. Mission-scoped tools (`tower_interrupt`,
`tower_init`, `tower_plan`, `tower_spawn`, `tower_merge`, `tower_rebase`, `tower_teardown`,
`tower_adopt`, `tower_reload`) are **tower only**. A worker may call `tower_mission` only for
`task_done`/`task_drop`/`blocker`/`note`; status changes, scope widening, `clear_blockers` and
`completed` are tower-only (completion must go through `tower_complete`). A roster reviewer may read
findings but not mutate them. Violations throw `[tower:not-authorized]` or
`[tower:invalid-transition]`.

## Tools

| Tool | Parameters | Purpose / notes |
|---|---|---|
| `tower_init` | `base?`, `autoGitInit?`, `snapshotDirty?`, `reanchor?` | Create `<git-common-dir>/dsh-tower/state.json`. `autoGitInit` runs `git init` + empty initial commit; `snapshotDirty` records a dangling snapshot commit of uncommitted tracked changes used as the mission baseline; `reanchor` changes base only when no non-terminal mission exists. Returns `dirty`, `snapshotCommit`, `reanchored`. |
| `tower_plan` | `missions[]` (`title`, `scope[]`, `tasks[]?`, `deps[]?`, `kind?`, `context?`) | Create missions `M1..`; overlapping build scopes auto-add a dependency; rejects unknown deps and cycles. |
| `tower_mission` | `id` (alias `missionId`), `status?`, `task_done?`, `task_drop?`+`task_drop_reason?`, `blocker?`, `clear_blockers?`, `note?`, `scope?`, `pause_cause?`, `authorization?` | Update one mission. Worker-safe fields are task/blocker/note; `merged` cannot be set here. Paused missions record `pause_cause` (user/failure/resource/dependency); resuming a user-paused mission honors `mode.requireResumeAuthorization`. |
| `tower_status` | `missionId?`, `offset?`, `limit?`, `includeGate?`, `format?` | Dashboard by default. `missionId` returns full detail (tasks/notes/reviews/findings/completionReport). `offset`/`limit` page missions (default 20, max 100), `includeGate` adds gate digests, `format:"markdown"` returns the board. |
| `tower_spawn` | `missionId` (alias `id`), `role` (`worker`/`reviewer`), `name?`, `instructions?`, `worktreeRoot?`, `wait?`, `waitMs?`, `takeover?`, `includeDirtyBase?` | Provision/reuse the worktree and start a subagent. Worker uses `tower-worker`; reviewer requires a `completed` mission and uses the read-only `tower-reviewer`. `takeover:true` replaces a live worker entry that is no longer running (increments ownerGeneration). Only one live worker per mission; `spawn.maxLiveWorkers` caps the repository. |
| `tower_roster` | — | Roster with live activity (`running`/`inactive`/`missing`/`unknown`) and `stale` flags from the subagent catalog. Read-only. |
| `tower_adopt` | `retireMissing?` | Reconcile roster entries with the durable subagent catalog. Provably gone agents are retired (default) or marked `missing` (`retireMissing:false`) so they can be inspected/taken over. |
| `tower_diff` | `missionId` (alias `id`), `maxBytes?` | Read-only merge-base diff: files, commits, capped patch. Safe for reviewers. |
| `tower_send` | `to`, `subject`, `body`, `scope?`, `interrupt?`, `consentRef?` | Durable message to a roster name, `tower`, or `all`; delivers live to a running agent. `interrupt:true` interrupts the running turn first (Kimi-style), then delivers; `consentRef` is recorded for audit. Rate-limited by `send.maxPerMinute`. |
| `tower_inbox` | `limit?`, `include_read?` | Read/ack messages addressed to the caller; unread messages block `tower_complete`. |
| `tower_complete` | `missionId` (alias `id`), `report`, `checks?` | Worker reports completion (mission becomes `completed`, awaiting review). Requires current owner, no open tasks/blockers, ≥1 commit, no unread inbox. `checks` records `{name, command?, exitCode?, evidence?}` evidence; `gates.requireChecks` can demand it. |
| `tower_interrupt` | `to?` (roster name), `agentId?`, `reason?` | Interrupt one running roster agent via `subagents.interrupt`, record `state:"interrupted"`. Idempotent (not running → `interrupted:false`). |
| `tower_finding` | `type`, `title`, `summary`, `details`, `suggested_fix`, `severity?`, `missionId?`, `location?` | Record an out-of-scope issue; reviewers use this instead of editing. Finds start as `open`. |
| `tower_findings` | `id?`, `status?`, `note?`, filters (`type?`, `severity?`, `missionId?`, `open?`, `limit?`) | Lifecycle tool: list/read/transition. Statuses `open → triaged → fixed`/`wontfix`, reopen allowed. Only the tower or a worker may mutate; a reviewer can list/read. |
| `tower_review` | `missionId` (alias `id`), `status` (`clean`/`p1-Nitems`/`p2-Nitems`), `merge` (`merge`/`fix-then-merge`/`hold`), `findings`, `decision`, `checks?`, `breakGlassReason?` | Reviewer verdict bound to the current tip. Reviewer must be the assigned reviewer (or tower break-glass). |
| `tower_preflight` | `missionId` (alias `id`) | Read-only gate: returns `{ok, blockers[], branchTip, baseTip, changedFiles, review}`. |
| `tower_merge` | `missionId` (alias `id`), `timeoutMs?` (alias `timeout_ms`) | Merge after a green gate. Records already-landed merges (`reconciled`), recovers a failed call whose commit exists (`recoveredFromFailure`), and separates `merge-hook-failed` from `merge-conflict`. |
| `tower_rebase` | `missionId` (alias `id`) | Rebase the branch onto the base in its worktree. Refuses while the worker runs or the worktree is dirty. Already-contained branches return `alreadyMerged` untouched. |
| `tower_teardown` | `force?`, `exclude?`, `dry_run?` (alias `dryRun`) | Remove eligible merged/abandoned worktrees and branches; running agents are always kept. |
| `tower_mode` | — | Report mode, last change, paused goal, denied tools, store path, plugin version, HMR availability, workspace-lock holder. |
| `tower_control` | `action` (`enter`/`exit`), `reason` | Model-initiated mode change; only when `mode.allowAgentControl` is true; reason is mandatory. |
| `tower_reload` | `repoRoot?` | Dev-only: ask DSH HMR to reconcile the profile and reload the Host plugin from disk. Registered while `dev.hotReload` is on; scheduled after the result (default 50 ms); fails with `reload-unavailable` without HMR. When `repoRoot` is supplied the caller must be the tower. |

## Workspace lock

With `mode.workspaceLock:true`, the first repo-scoped Tower tool call from a Tower-mode session
acquires `<git-common-dir>/dsh-tower/tower.lock`; another session gets `[tower:workspace-busy]`
until the holder runs `/tower off` or the lock exceeds `mode.workspaceStaleMs`. Default off.

## Failure results

Gate tools return `{ok:false, blockers:[{code, detail}]}`; the code list is in
[blockers.md](blockers.md). Thrown tool errors carry a stable `[tower:<code>]` prefix
([errors.md](errors.md)). Successful mutations emit process-local events ([events.md](events.md)),
and, with `docs.board:true`, refresh `<git-common-dir>/dsh-tower/MISSIONS.md`.
