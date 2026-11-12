# Tools reference

Repository-scoped tools no longer take a `repoRoot` argument except `tower_init`, which keeps the
field because it bootstraps the repository. Every other tool resolves the repository in one place,
in this order: the repository bound to the calling session by the workspace lock, then the session's
working directory, then an explicit `repoRoot` field (still accepted for headless/embedded callers).
A session working directory inside a linked worktree resolves to the main checkout, so a worker
never writes Tower state or the board into its mission worktree.
`tower_mode` and `tower_reload` need no repository; `tower_reload` is the repository-optional
escape hatch (it may run without one to reload a broken profile).
## Tool sets

The default profile registers **16 tools**: `tower_init` (`op:"init"`/`"adopt"`), `tower_plan`,
`tower_spawn`, `tower_mission`, `tower_interrupt`, `tower_merge`, `tower_rebase`,
`tower_teardown`, `tower_send`, `tower_inbox`, `tower_finding`, `tower_inspect`
(five read-only views), `tower_complete`, `tower_review`, `tower_mode` and `tower_recover`.
The build still exposes up to 21 tools when every optional row is on: the 16 default tools plus `tower_batch`
(`tower-batch`), `tower_import` (`tower-import`), `tower_resource` (`tower-leases`),
`tower_test` (`tower-tests`) and `tower_reload` (`tower-hmr`).

What each profile **advertises** is narrower than what ships. The tower session does not mount
`tower_complete` or `tower_review` — they are owned by the worker/survey and reviewer role
sessions (#163 Phase 5). Calling one from a tower session anyway fails with an actionable
`not-authorized` hint naming the role entry (`tower_spawn({role:"worker"})`) instead of an
unknown-tool error. The measured profile surfaces are tower 14 tools / 10,582 B of input schema,
worker 6 / 6,175 B, and reviewer 5 / 4,371 B; `docs/reference/surface-budget.md` records the
baseline and every change.

## Default-off subsystems

The five component rows below ship `disabled: true` in the bundled `cordis.patch.yml`. Closing a
row removes exactly its tools; `tower_doctor` lists each row with its tool and the enable step, and
`tower_inspect`'s `doctor` view reports it as "disabled by component <id>". To enable one, set its
`disabled` flag to `false` in `cordis.patch.yml` (or omit the flag) and restart DSH.

| Component row | Tool(s) | Enable |
|---|---|---|
| `tower-batch` | `tower_batch` | remove `disabled: true` from the `tower-batch` row and restart DSH |
| `tower-import` | `tower_import` | remove `disabled: true` from the `tower-import` row and restart DSH |
| `tower-leases` | `tower_resource` | remove `disabled: true` from the `tower-leases` row and restart DSH |
| `tower-tests` | `tower_test` | remove `disabled: true` from the `tower-tests` row and restart DSH |
| `tower-hmr` | `tower_reload` | remove `disabled: true` from the `tower-hmr` row and restart DSH |

The tools still exist and stay in the all-on 21; they are off, not deleted.

`tower_mission` uses `id` (alias `missionId`); every other mission-scoped tool uses `missionId`
(alias `id`). Other input aliases: `task_done`/`taskDone`, `task_drop`/`taskDrop`,
`task_drop_reason`/`taskDropReason`, `clear_blockers`/`clearBlockers`,
`include_read`/`includeRead`, `dry_run`/`dryRun`, `timeoutMs`/`timeout_ms`,
`mission_id`/`missionId` on `tower_finding`, `agent_id`/`agentId` on
interrupt, `include_gate`/`includeGate`, `include_archived`/`includeArchived` on the `inspect`
status view, and `retire_missing`/`retireMissing` on `tower_init({op:"adopt"})`. Aliases are
accepted by the server but are no longer advertised in the tool schemas (#163 Phase 2), so they
cost no bytes on every request.
Outputs use canonical camelCase names.

## Roles

Roster roles are resolved from `exec.agent` + the roster. Mission-scoped tools (`tower_interrupt`,
`tower_init`, `tower_plan`, `tower_spawn`, `tower_merge`, `tower_rebase`, `tower_teardown`) are
**tower only**, as are `tower_init({op:"adopt"})` and the `tower_mode` write actions. `tower_reload`
is tower-only and is the one tool registered as repository-optional in `host/tool-profiles.js`: it
may run without a repository to reload a broken profile, and supplying a `repoRoot` does not change
that row (still gated by the `tower-hmr` component row). `tower_batch` create/close/abandon,
`tower_resource` acquire/release, `tower_import` and review-exemption planning are tower-only; the
`tower_import` read-only `status` action is open to roster roles. A worker may call `tower_mission`
only for `task_done`/`task_drop`/`blocker`/`note`; status changes, scope widening, `clear_blockers` and
`completed` are tower-only (completion must go through `tower_complete`). A roster reviewer may read
findings but not mutate them. Violations throw `[tower:not-authorized]` or
`[tower:invalid-transition]`.

## Tools

| Tool | Parameters | Purpose / notes |
|---|---|---|
| `tower_init` | `op?` (`init` default / `adopt`), `repoRoot`, `base?`, `auto_git_init?`, `snapshot_dirty?`, `reanchor?`, `retire_missing?` | `op:"init"` creates `<git-common-dir>/dsh-tower/state.json`. The only tool that advertises `repoRoot` (bootstrap); it wins over the session directory so an explicit target can be initialized. `auto_git_init` runs `git init` + empty initial commit; `snapshot_dirty` records a dangling snapshot commit of uncommitted tracked changes used as the mission baseline; `reanchor` changes base only when no non-terminal mission exists. `op:"adopt"` reconciles the roster with the durable catalog: provably gone agents are retired (default) or marked `missing` (`retire_missing:false`). Tower-only for both ops. |
| `tower_plan` | `missions[]` (`title` — printable Unicode, NFC-normalized, ≤120 characters, `scope[]`, `tasks[]?`, `deps[]?`, `kind?`, `context?`, `references[]?` ≤20, `reviewPolicy?`, `reviewExemptionReason?`) | Create missions `M1..`; overlapping build scopes auto-add a dependency; rejects unknown deps and cycles. Mission ids stay ASCII (`M1`, `M2`); invisible characters and over-long titles are rejected with `invalid-argument`. `reviewPolicy:"none"` requires a non-empty reason; when the review gate is on, preflight also requires `gates.allowReviewExemption`. |
| `tower_mission` | `id` (alias `missionId`), `status?`, `task_done?`, `task_drop?`+`task_drop_reason?`, `blocker?`, `clear_blockers?`, `note?`, `scope?`, `pause_cause?`, `authorization?` | Update one mission. Worker-safe fields are task/blocker/note; `merged` cannot be set here. `blocked` is derived from an open blocker (record `blocker`, never `status:"blocked"`); `clear_blockers` resumes it to `active`. Paused missions record `pause_cause` (user/failure/resource/dependency); resuming a user-paused mission honors `mode.requireResumeAuthorization`. |
| `tower_inspect` | `view` (`status`/`roster`/`diff`/`preflight`/`doctor`), `missionId?`, `maxBytes?`, `offset?`, `limit?`, `includeGate?`, `includeArchived?`, `format?` | One read-only tool for five views of the same state (#163 Phase 3). `status`: dashboard by default; `missionId` returns full detail; `offset`/`limit` page active missions (default 20, max 100); `includeGate` adds gate digests; `includeArchived` appends archived summaries; `format:"markdown"` returns the board; a newer/corrupt `state.json` degrades to a read-only on-disk diagnostic instead of failing. `roster`: roster with live activity (`running`/`inactive`/`missing`/`unknown`) and `stale` flags. `diff` (requires `missionId`): merge-base diff, files, commits, capped patch (`maxBytes`); safe for reviewers. `preflight` (requires `missionId`): `{ok, blockers[], branchTip, baseTip, changedFiles, review}`; review blockers only with `review.mode:required`; it rethrows state errors because no gate can be computed from unreadable state. `doctor`: concept-budget surface, git, state schema, config, presets/subagents/HMR, locks, workspace lock, roster, worktree realpath/ownership, test config, leases and the terminal-mission archive; returns `{ok, checks[], surface, stateLock, gitLock, stateSchema, archive, environmentContract}` and never writes. `roster`/`diff` require a known actor, `diff` also requires mission participation; `status`/`preflight`/`doctor` stay public so a broken repository can be diagnosed. |
| `tower_spawn` | `missionId` (alias `id`), `op?` (`spawn` default / `takeover`), `role` (`worker`/`reviewer`), `name?`, `instructions?`, `worktreeRoot?`, `wait?`, `includeDirtyBase?` | Provision/reuse the worktree and start a subagent. Worker uses `tower-worker`; reviewer requires a `completed` mission and uses the read-only `tower-reviewer`; with `review.mode:off` the reviewer role is refused with `[tower:review-disabled]`. `op:"takeover"` replaces a live worker entry that is no longer running (increments ownerGeneration); the old `takeover:true` field is rejected with the replacement path. `wait:true` waits for the result, bounded by `spawn.maxWaitMs` (default 90000); the old `waitMs` field is rejected with that config path. Only one live worker per mission; `spawn.maxLiveWorkers` caps the repository. |
| `tower_send` | `to`, `subject`, `body`, `scope?`, `interrupt?`, `consentRef?` | Durable message to a roster name, `tower`, or `all`; delivers live to a running agent. `interrupt:true` interrupts the running turn first (Kimi-style), then delivers; `consentRef` is recorded for audit. Rate-limited by `send.maxPerMinute`. |
| `tower_inbox` | `limit?`, `include_read?` | Read/ack messages addressed to the caller; unread messages block `tower_complete`. |
| `tower_complete` | `missionId` (alias `id`), `report`, `checks?` | Worker reports completion (mission becomes `completed`, ready for preflight and optional review). Requires current owner, no open tasks/blockers, ≥1 commit, no unread inbox. `report` is capped at `gates.maxReportBytes` (default 32768 UTF-8 bytes): a larger report is rejected with `invalid-argument` and a `nextAction` to file the full text in the mission worktree, never truncated; the stored report records `reportBytes`. `checks` records `{name, command?, exitCode?, evidence?}` evidence; `gates.requireChecks` can demand it. When configured, test discovery runs automatically and adds a `tests` check; failure throws `[tower:tests-failed]`. |
| `tower_interrupt` | `to?` (roster name), `agentId?`, `reason?` | Interrupt one running roster agent via `subagents.interrupt`, record `state:"interrupted"`. Idempotent (not running → `interrupted:false`). |
| `tower_finding` | `op?` (`report` / `list` default / `update`), `id?`, `status?`, `note?`, filters (`type?`, `severity?`, `missionId?`, `open?`, `limit?`), `title?`, `summary?`, `details?`, `suggested_fix?`, `location?` | One finding lifecycle (#163 Phase 4). `report` needs `type` (bug/improve/vuln/idea), `title`, `summary`, `details`, `suggested_fix`; finds start as `open`. `list` reads/list by `id` or filters. `update` needs `id` plus `status`/`note`; statuses `open → triaged → fixed`/`wontfix`, reopen allowed. Only the tower or a worker may mutate; a reviewer can list/read. |
| `tower_review` | `missionId` (alias `id`), `status` (`clean`/`p1-Nitems`/`p2-Nitems`), `merge` (`merge`/`fix-then-merge`/`hold`), `findings`, `decision`, `checks?`, `breakGlassReason?` | Reviewer verdict bound to the current tip. Reviewer must be the assigned reviewer (or tower break-glass). Not registered when `review.mode:off`; a repository-level `off` refuses the submission with `[tower:review-disabled]`. A later route may record a verdict for the same reviewed tip while the mission is active: it appends to that round (`appended:true`) without changing the status; a verdict for a moved tip is rejected with an explanation. Inside one round the newest recorded verdict (highest `seq`) is the one the merge gate, landed-merge detection, status and briefing evaluate: a later clean verdict supersedes an earlier non-clean verdict of the same round. |
| `tower_merge` | `missionId` (alias `id`), `timeoutMs?` (alias `timeout_ms`) | Merge after a green gate. Records already-landed merges (`reconciled`), recovers a failed call whose commit exists (`recoveredFromFailure`), and separates `merge-hook-failed` from `merge-conflict`. |
| `tower_rebase` | `missionId` (alias `id`) | Rebase the branch onto the base in its worktree. Refuses while the worker runs or the worktree is dirty. Already-contained branches return `alreadyMerged` untouched. |
| `tower_teardown` | `force?`, `exclude?`, `dry_run?` (alias `dryRun`) | Remove eligible merged/abandoned worktrees and branches; running agents are always kept. The final pass applies the `archive` policy while the `tower-archive` component row is mounted: terminal missions whose worktree is gone are moved to `<git-common-dir>/dsh-tower/archive/` once `archive.afterDays`/`archive.maxMissions` says so, and `archived` lists their ids. Nothing is deleted; `archive.afterDays:0` archives a just-torn-down mission immediately. |
| `tower_mode` | `active?` (`true`/`false`/`"takeover"`), `reason?`, `authorization?` | Without `active`: report mode, last change, paused goal, any Agent Team left on entry (`releasedTeam`: role, members, suspended), denied tools, store path, plugin version, HMR availability, workspace-lock holder. With `active`: `true` enters, `false` leaves, `"takeover"` transfers repository ownership from an inactive owner after explicit user approval. Writes require a non-empty `reason` and `mode.allowAgentControl:true`; `takeover` also requires `authorization`, the audit reference recorded on the activity entry. |
| `/tower takeover <reason>` | — | Human-only ownership transfer, available even with `mode.allowAgentControl:false`. |
| `/tasks`, `/tower tasks` | — | Read-only live-roster panel for humans: one line per live roster agent (mission, role, name, short branch, state, silence since its last recorded event, that event), most silent first, capped at 20 rows, with `N live, M stale` counts and the `tower_interrupt` remedy in the footer. Costs no model turn and performs no writes (no `state.json`, activity log, or modes-store touches). Staleness is the same `spawn.staleMs` rule `tower_inspect`'s `roster` view and the merge gate use. The plugin claims `/tasks` only when the host profile defines no other `tasks` command; `/tower tasks` is the always-available alias, and which one this profile got is stated in the command description (#160). |
| `tower_reload` | — | Dev-only: ask DSH HMR to reconcile the profile and reload the Host plugin from disk. Registered while the `tower-hmr` component row is on (the row ships off); scheduled after the result (default 50 ms); fails with `reload-unavailable` without HMR. Registered in `host/tool-profiles.js` as the one repository-optional tool, so it works without a repository to fix a broken profile; the tool identity, not a supplied `repoRoot`, decides that path. |
| `tower_recover` | `action` (`status`/`clear-stale-lock`), `confirm?`, `force?` | Recovery diagnostics plus an explicit stale state-lock repair. `clear-stale-lock` requires `confirm:"CLEAR_STALE_LOCK"` and only moves a lock whose PID is provably dead to a `.recovered-<ts>` backup. `force:true` additionally clears a live-but-silent PID (a recycled PID): the output names `{pid, startedAt, ageMs, heartbeatAgeMs}` and the record is still renamed, never unlinked. It never resets state/worktrees. |
| `tower_test` | `missionId` (alias `id`) | Run the worktree's `package.json` `tower.testDiscovery` and record a receipt; `ok:false` on failure. Use `tower_complete` for automatic admission checks. |
| `tower_batch` | `action` (`create`/`status`/`close`/`abandon`), `missionIds?`, `exclusions?`, `requiredChecks?`, `receiptPaths?`, `batchId?`, `checks?`, `treeTip?`, `receiptHashes?`, `reason?` | Finite evidence batch. Create freezes members/checks/receipts; close verifies every required check and receipt hash; merged members are eligible; abandon retires a stale open batch without deleting missions. Membership is immutable. |
| `tower_resource` | `action` (`acquire`/`release`/`status`), `name?`, `holder?`, `token?`, `ttlMs?`, `force?` | Advisory per-repository lease in `<common>/dsh-tower/leases.json`. No OS CPU/memory hard cap. A live lease is released only by its holder token; an **expired** lease is recovered by an explicit `force: true` release (never taken over automatically). |
| `tower_import` | `op?` (`snapshot` inferred from `sourcePath` / `map` default), `sourcePath?`, `action?` (`map`/`status`), `sourceHash?`, `oldId?`, `newMissionId?` | One legacy-resource tool (#163 Phase 4). `snapshot`: read-only import of a Tower Codex `schemaVersion:1` or DSH legacy state; the full payload goes under `<common>/dsh-tower/legacy/<sha256>.json` and state stores a summary only. `map`: audit-only legacy-id mapping; mappings are append-only. `action:"status"` lists mappings. Never activates/adopts/resumes paused missions. Tower-only except the read-only `status` action. |

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
and, with the `tower-board` component row mounted, refresh `<git-common-dir>/dsh-tower/MISSIONS.md`. The board location stays `docs.boardLocation`; the old `docs.board` switch is a component row now (#133).
