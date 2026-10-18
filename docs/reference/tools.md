# Tools reference

All tools take `repoRoot` (an absolute path inside the target Git repository) and return JSON.
The build exposes up to 28 tools: 19 core repository tools below (including `tower_interrupt`),
`tower_mode`, `tower_control` (registered by default; set `mode.allowAgentControl:false` to disable),
`tower_reload` while `dev.hotReload` is on, and the 2.1 verification/ops tools `tower_doctor`,
`tower_test`, `tower_batch`, `tower_resource`, `tower_import_legacy`, `tower_legacy_map`.

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
`tower_adopt`, `tower_reload`) are **tower only**. `tower_batch` create/close/abandon, `tower_resource`
acquire/release, `tower_import_legacy`, `tower_legacy_map` map and review-exemption planning are
tower-only; their read-only status actions are open to roster roles. A worker may call `tower_mission`
only for `task_done`/`task_drop`/`blocker`/`note`; status changes, scope widening, `clear_blockers` and
`completed` are tower-only (completion must go through `tower_complete`). A roster reviewer may read
findings but not mutate them. Violations throw `[tower:not-authorized]` or
`[tower:invalid-transition]`.

## Tools

| Tool | Parameters | Purpose / notes |
|---|---|---|
| `tower_init` | `base?`, `autoGitInit?`, `snapshotDirty?`, `reanchor?` | Create `<git-common-dir>/dsh-tower/state.json`. `autoGitInit` runs `git init` + empty initial commit; `snapshotDirty` records a dangling snapshot commit of uncommitted tracked changes used as the mission baseline; `reanchor` changes base only when no non-terminal mission exists. Returns `dirty`, `snapshotCommit`, `reanchored`. |
| `tower_plan` | `missions[]` (`title`, `scope[]`, `tasks[]?`, `deps[]?`, `kind?`, `context?`, `references[]?` ≤20, `reviewPolicy?`, `reviewExemptionReason?`) | Create missions `M1..`; overlapping build scopes auto-add a dependency; rejects unknown deps and cycles. `reviewPolicy:"none"` requires a non-empty reason; when the review gate is on, preflight also requires `gates.allowReviewExemption`. |
| `tower_mission` | `id` (alias `missionId`), `status?`, `task_done?`, `task_drop?`+`task_drop_reason?`, `blocker?`, `clear_blockers?`, `note?`, `scope?`, `pause_cause?`, `authorization?` | Update one mission. Worker-safe fields are task/blocker/note; `merged` cannot be set here. Paused missions record `pause_cause` (user/failure/resource/dependency); resuming a user-paused mission honors `mode.requireResumeAuthorization`. |
| `tower_status` | `missionId?`, `offset?`, `limit?`, `includeGate?`, `format?` | Dashboard by default. `missionId` returns full detail (tasks/notes/reviews/findings/completionReport). `offset`/`limit` page missions (default 20, max 100), `includeGate` adds gate digests, `format:"markdown"` returns the board. |
| `tower_spawn` | `missionId` (alias `id`), `role` (`worker`/`reviewer`), `name?`, `instructions?`, `worktreeRoot?`, `wait?`, `waitMs?`, `takeover?`, `includeDirtyBase?` | Provision/reuse the worktree and start a subagent. Worker uses `tower-worker`; reviewer requires a `completed` mission and uses the read-only `tower-reviewer`. `takeover:true` replaces a live worker entry that is no longer running (increments ownerGeneration). Only one live worker per mission; `spawn.maxLiveWorkers` caps the repository. |
| `tower_roster` | — | Roster with live activity (`running`/`inactive`/`missing`/`unknown`) and `stale` flags from the subagent catalog. Read-only. |
| `tower_adopt` | `retireMissing?` | Reconcile roster entries with the durable subagent catalog. Provably gone agents are retired (default) or marked `missing` (`retireMissing:false`) so they can be inspected/taken over. |
| `tower_diff` | `missionId` (alias `id`), `maxBytes?` | Read-only merge-base diff: files, commits, capped patch. Safe for reviewers. |
| `tower_send` | `to`, `subject`, `body`, `scope?`, `interrupt?`, `consentRef?` | Durable message to a roster name, `tower`, or `all`; delivers live to a running agent. `interrupt:true` interrupts the running turn first (Kimi-style), then delivers; `consentRef` is recorded for audit. Rate-limited by `send.maxPerMinute`. |
| `tower_inbox` | `limit?`, `include_read?` | Read/ack messages addressed to the caller; unread messages block `tower_complete`. |
| `tower_complete` | `missionId` (alias `id`), `report`, `checks?` | Worker reports completion (mission becomes `completed`, ready for preflight and optional review). Requires current owner, no open tasks/blockers, ≥1 commit, no unread inbox. `checks` records `{name, command?, exitCode?, evidence?}` evidence; `gates.requireChecks` can demand it. When configured, test discovery runs automatically and adds a `tests` check; failure throws `[tower:tests-failed]`. |
| `tower_interrupt` | `to?` (roster name), `agentId?`, `reason?` | Interrupt one running roster agent via `subagents.interrupt`, record `state:"interrupted"`. Idempotent (not running → `interrupted:false`). |
| `tower_finding` | `type`, `title`, `summary`, `details`, `suggested_fix`, `severity?`, `missionId?`, `location?` | Record an out-of-scope issue; reviewers use this instead of editing. Finds start as `open`. |
| `tower_findings` | `id?`, `status?`, `note?`, filters (`type?`, `severity?`, `missionId?`, `open?`, `limit?`) | Lifecycle tool: list/read/transition. Statuses `open → triaged → fixed`/`wontfix`, reopen allowed. Only the tower or a worker may mutate; a reviewer can list/read. |
| `tower_review` | `missionId` (alias `id`), `status` (`clean`/`p1-Nitems`/`p2-Nitems`), `merge` (`merge`/`fix-then-merge`/`hold`), `findings`, `decision`, `checks?`, `breakGlassReason?` | Reviewer verdict bound to the current tip. Reviewer must be the assigned reviewer (or tower break-glass). |
| `tower_preflight` | `missionId` (alias `id`) | Read-only gate: returns `{ok, blockers[], branchTip, baseTip, changedFiles, review}`. |
| `tower_merge` | `missionId` (alias `id`), `timeoutMs?` (alias `timeout_ms`) | Merge after a green gate. Records already-landed merges (`reconciled`), recovers a failed call whose commit exists (`recoveredFromFailure`), and separates `merge-hook-failed` from `merge-conflict`. |
| `tower_rebase` | `missionId` (alias `id`) | Rebase the branch onto the base in its worktree. Refuses while the worker runs or the worktree is dirty. Already-contained branches return `alreadyMerged` untouched. |
| `tower_teardown` | `force?`, `exclude?`, `dry_run?` (alias `dryRun`) | Remove eligible merged/abandoned worktrees and branches; running agents are always kept. |
| `tower_mode` | — | Report mode, last change, paused goal, denied tools, store path, plugin version, HMR availability, workspace-lock holder. |
| `tower_control` | `action` (`enter`/`exit`), `reason` | Model-initiated mode change; registered by default; disable with `mode.allowAgentControl:false`; reason is mandatory. |
| `tower_reload` | `repoRoot?` | Dev-only: ask DSH HMR to reconcile the profile and reload the Host plugin from disk. Registered while `dev.hotReload` is on; scheduled after the result (default 50 ms); fails with `reload-unavailable` without HMR. When `repoRoot` is supplied the caller must be the tower. |
| `tower_doctor` | — (takes `repoRoot`) | Read-only health contract: git, state schema, config, presets/subagents/HMR, workspace lock, roster, worktree realpath/ownership, test config, leases. Returns `{ok, checks[{id,status,detail}], environmentContract}`. Never writes. |
| `tower_test` | `missionId` (alias `id`) | Run the worktree's `package.json` `tower.testDiscovery` and record a receipt; `ok:false` on failure. Use `tower_complete` for automatic admission checks. |
| `tower_batch` | `action` (`create`/`status`/`close`/`abandon`), `missionIds?`, `exclusions?`, `requiredChecks?`, `receiptPaths?`, `batchId?`, `checks?`, `treeTip?`, `receiptHashes?`, `reason?` | Finite evidence batch. Create freezes members/checks/receipts; close verifies every required check and receipt hash; merged members are eligible; abandon retires a stale open batch without deleting missions. Membership is immutable. |
| `tower_resource` | `action` (`acquire`/`release`/`status`), `name?`, `holder?`, `token?`, `ttlMs?`, `force?` | Advisory per-repository lease in `<common>/dsh-tower/leases.json`. No OS CPU/memory hard cap; expired leases require explicit `force` and the correct token. |
| `tower_import_legacy` | `sourcePath` | Read-only import of a Tower Codex `schemaVersion:1` or DSH legacy state. Full payload goes under `<common>/dsh-tower/legacy/<sha256>.json`; state stores a summary only. Never activates/adopts/resumes paused missions. |
| `tower_legacy_map` | `action` (`map`/`status`), `sourceHash?`, `oldId?`, `newMissionId?` | Audit-only legacy-id mapping; mappings are append-only and never adopt a mission. |

## Workspace lock

With `mode.workspaceLock:true` (the bundled patch enables it), the first repo-scoped Tower tool call
from a Tower-mode session acquires `<git-common-dir>/dsh-tower/tower.lock`; another session gets
`[tower:workspace-busy]` until the holder runs `/tower off` or the lock exceeds
`mode.workspaceStaleMs`. `mode.workspaceLockScope:"mutations"` skips the lock for read-only tools.
Code default is off; the shipped patch is on for Kimi-compatible single-active-tower behavior.

## Failure results

Gate tools return `{ok:false, blockers:[{code, detail}]}`; the code list is in
[blockers.md](blockers.md). Thrown tool errors carry a stable `[tower:<code>]` prefix
([errors.md](errors.md)). Successful mutations emit process-local events ([events.md](events.md)),
and, with `docs.board:true`, refresh `<git-common-dir>/dsh-tower/MISSIONS.md`.
