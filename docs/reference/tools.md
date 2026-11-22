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

The default profile registers **18 tools**: `tower_init` (`op:"init"`/`"adopt"`), `tower_plan`,
`tower_spawn`, `tower_mission`, `tower_interrupt`, `tower_merge`, `tower_rebase`,
`tower_teardown`, `tower_send`, `tower_inbox`, `tower_finding`, `tower_inspect`
(five read-only views), `tower_complete`, `tower_review`, `tower_verify`, `tower_mode`,
`tower_recover` and `tower_wait`.
The build still exposes up to 23 tools when every optional row is on: the 18 default tools plus `tower_batch`
(`tower-batch`), `tower_import` (`tower-import`), `tower_resource` (`tower-leases`),
`tower_test` (`tower-tests`) and `tower_reload` (`tower-hmr`).

What each profile **advertises** is narrower than what ships. The tower session does not mount
`tower_complete`, `tower_review` or `tower_verify` — they are owned by the worker/survey and
reviewer role sessions (#163 Phase 5, #202). Calling one from a tower session anyway fails with an
actionable `not-authorized` hint naming the role entry (`tower_spawn({role:"worker"})` or
`tower_spawn({role:"reviewer"})`) instead of an unknown-tool error. The measured profile surfaces are
tower 15 tools / 18,871 B of input schema, worker 6 / 11,661 B, and reviewer 6 / 7,260 B;
`docs/reference/surface-budget.md` records the baseline and every change.

## Default-off subsystems

The five component rows below ship `disabled: true` in the bundled `cordis.patch.yml`. Closing a
row removes exactly its tools; `tower_inspect`'s `doctor` view lists each row with its tool and the enable step, and
reports it as "disabled by component <id>". To enable one, set its
`disabled` flag to `false` in `cordis.patch.yml` (or omit the flag) and restart DSH.

| Component row | Tool(s) | Enable |
|---|---|---|
| `tower-batch` | `tower_batch` | remove `disabled: true` from the `tower-batch` row and restart DSH |
| `tower-import` | `tower_import` | remove `disabled: true` from the `tower-import` row and restart DSH |
| `tower-leases` | `tower_resource` | remove `disabled: true` from the `tower-leases` row and restart DSH |
| `tower-tests` | `tower_test` | remove `disabled: true` from the `tower-tests` row and restart DSH |
| `tower-hmr` | `tower_reload` | remove `disabled: true` from the `tower-hmr` row and restart DSH |

The tools still exist and stay in the all-on 23; they are off, not deleted.

## Reviewer verification whitelist (#202)

A reviewer preset has no shell, so before #202 a review could only restate the worker's prose.
`tower_verify` gives the reviewer three read-only things to run in the mission worktree — never a
command string, never a shell, and never an arbitrary argument list:

| `kind` | What runs | Arguments |
|---|---|---|
| `tests` | `node --test <files>` | `files`: 1–30 repository-relative `tests/*.test.mjs` paths; absolute paths, `..` segments, and shell text are rejected before anything executes |
| `tsc` | the worktree's own `typescript` with `--noEmit` | none |
| `shards` | `node --test` on one batch of the default 25-file `tests/*.test.mjs` plan | `batch`: 1-based batch number (default 1); it never runs the whole suite |

```
tower_verify({missionId:"M7", checks:[
  {kind:"tests", files:["tests/verify.test.mjs"]},
  {kind:"tsc"},
], timeoutMs:120000})
```

Every check runs sequentially in the mission worktree and is recorded in `mission.testRuns` with its
own `runId`. The result row is `{check, kind, command, status, exitCode, durationMs, summary,
truncated, runId}`; `status` is `passed`, `failed`, `timeout`, `error` or `unavailable`. `timeoutMs`
defaults to 120000, must be 5000–600000, and a timeout kills the whole process tree before it records
`status: "timeout"`: on Windows it runs `taskkill /T` against the spawned orchestrator while its pid
is still openable (a bounded 2 s attempt) and only falls back to a direct kill if that cannot run,
because `node --test` starts one child per test file and killing the parent first would strand them.
A missing worktree `node_modules` makes `tsc` record `unavailable` with the
remedy: install dependencies, or spawn with `spawn.nodeModules: "link"` (M166). The tool is
read-only: it changes no mission status and writes nothing except the run receipts.

The evidence is citable, not free text. `tower_complete` checks accept `{name, runId}` and
`normalizeChecks` refuses a `runId` that is not in the mission's `testRuns`; a reviewer can cite the
same id in its `tower_review` checks (for example `checks: ["run-3"]`), because a review check is a
string list. Only the reviewer role may call `tower_verify`; a worker session uses `tower_test` for
its own discovery, and the tool is not on the tower profile.

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

## Base consistency check

`tower_plan` and `tower_spawn` refuse to run when the checkout is not the recorded base. Before any
state write or agent start, they compare the live HEAD with `state.base`; a different branch (or a
detached HEAD) throws `[tower:base-mismatch]`, naming both sides and the two remedies: check out the
recorded base, or, when that checkout is the intended base and no mission is in flight, run
`tower_init({base:"<branch>", reanchor:true})`. A refused call writes no state, so a plan on the
wrong branch can no longer succeed only to strand its missions at merge time (#215). `tower_inspect`
`status` shows `base` and `head` side by side and adds `baseWarning` when they differ; `headDetached`
marks a detached checkout. `tower_init({reanchor:true})` still refuses while a non-terminal mission
exists and now lists the blocking mission ids.

## One stance per repository

Tower mode and a Ralph loop (`@deepseek-ai/dsh-tool-ralph`, the community `dsh-ralph`, or any other
implementation of the same stance) are mutually exclusive per repository: the loop's `/ralph` command
is shadowed while Tower mode is active (commands are not tools, so the command-owner table covers
them), its tool names are denied by #161's owner-derived `mode.denyTools` default, entering Tower mode
with a live loop either stops and records it or refuses the entry (`mode.ralphPolicy`, default
`stop`), and round agents are refused while the repository is under Tower mode — which is why a
renamed entry point cannot restart a loop under a live tower. `tower_inspect({ view: "doctor" })`
reports a live loop as an environment fact.
A Ralph loop *inside* a Tower worker is not a conflict: the worker owns one mission in its isolated
worktree and reports through `tower_complete`. See
[ADR 0010](../adr/0010-tower-ralph-mutual-exclusion.md).

## Roles

Roster roles are resolved from `exec.agent` + the roster. Mission-scoped tools (`tower_interrupt`,
`tower_init`, `tower_plan`, `tower_spawn`, `tower_merge`, `tower_rebase`, `tower_teardown`) are
**tower only**, as are `tower_init({op:"adopt"})` and the `tower_mode` write actions. `tower_reload`
is tower-only and is the one tool registered as repository-optional in `host/tool-profiles.js`: it
may run without a repository to reload a broken profile, and supplying a `repoRoot` does not change
that row (still gated by the `tower-hmr` component row). `tower_batch` create/close/abandon,
`tower_resource` acquire/release, `tower_import` and review-exemption planning are tower-only; the
`tower_import` read-only `status` action is open to roster roles. A worker may call `tower_mission`
only for `task_done`/`task_drop`/`blocker`/`note`; status changes, scope edits and widening, `deferred`, `clear_blockers` and
`completed` are tower-only (completion must go through `tower_complete`). A roster reviewer may read
findings but not mutate them. Violations throw `[tower:not-authorized]` or
`[tower:invalid-transition]`.

## Tools

| Tool | Parameters | Purpose / notes |
|---|---|---|
| `tower_init` | `op?` (`init` default / `adopt`), `repoRoot`, `base?`, `auto_git_init?`, `snapshot_dirty?`, `reanchor?`, `retire_missing?` | `op:"init"` creates `<git-common-dir>/dsh-tower/state.json`. The only tool that advertises `repoRoot` (bootstrap); it wins over the session directory so an explicit target can be initialized. `auto_git_init` runs `git init` + empty initial commit; `snapshot_dirty` records a dangling snapshot commit of uncommitted tracked changes used as the mission baseline; `reanchor` changes base only when no non-terminal mission exists (the refusal lists the blocking mission ids). `op:"adopt"` reconciles the roster with the durable catalog: provably gone agents are retired (default) or marked `missing` (`retire_missing:false`). `op:"adopt"` also returns `missions[]`, a read-only worktree residue report for every non-terminal mission with a recorded worktree: `{id, status, branch, tip, lastCommit:{sha, at}, worktreePath, dirty:{files, paths, sample}, lastActivityAt, class, suggestedAction}`; `class` is `dirty`, `clean`, `unmerged`, `missing`, `external` or `unknown`, and `suggestedAction` names the next step (`none` for a clean checkout). It never changes `retire_missing` semantics. Tower-only for both ops. |
| `tower_plan` | `missions[]` (`title` — printable Unicode, NFC-normalized, ≤120 characters, `scope[]`, `tasks[]?`, `deps[]?`, `kind?` — `build`/`survey`/`artifact`, `artifacts[]?` ≤20, `context?`, `references[]?` ≤20, `reviewPolicy?`, `reviewExemptionReason?`, `allowMissingScope?`, `key?`), `dry_run?` | Create missions `M1..`; overlapping build scopes auto-add a dependency; rejects unknown deps and cycles. `dry_run:true` runs every validation without writing state, creating a mission or bumping the revision: it returns `{dry_run, ok, revision, missions:[{index, key?, wouldBeId, title, kind, scope, deps, overlaps}], problems}` where `wouldBeId` is the id the mission would receive, `deps` are resolved to ids, `overlaps` names the planned or open missions whose scopes overlap, and `problems` is the complete list (`kind` `scope`/`mission`/`key`/`deps`/`cycle`/`component`) instead of the first failure. A real plan that fails reports that same complete set in `details.problems`. A per-mission `key` is a plan-local handle for `deps` in the same call (trimmed, ≤64 characters, not `M<n>`-shaped, unique, never persisted); a dependency may name an existing mission id, a key, or a would-be id, and cycles are still rejected before anything is created. It first checks the checkout: when HEAD is not `state.base`, planning refuses with `[tower:base-mismatch]` (naming both sides and the remedies) and writes no state. Mission ids stay ASCII (`M1`, `M2`); invisible characters and over-long titles are rejected with `invalid-argument`. `kind:"artifact"` declares concrete deliverable paths in `artifacts[]` (no globs, each inside the scope); they must be committed at the tip before completion and the merge then waits for a human acceptance of that tip. `reviewPolicy:"none"` requires a non-empty reason; when the review gate is on, preflight also requires `gates.allowReviewExemption`. `scope` is a list of file globs relative to the repository root; a directory-shaped entry (`docs/guide/`, or a bare `docs/guide` that exists at plan time) is stored as the explicit subtree glob `docs/guide/**` — see [Mission scopes](#mission-scopes). Every entry is checked against `git ls-files` at plan time: an entry that names a tracked directory but matches nothing in it is rejected with `invalid-argument`, naming the nearest existing prefix and up to five tracked candidates. Pass `allowMissingScope:true` on that mission to accept paths the mission will create; the acceptance is recorded as one `scope.unverified` activity entry and the stored scope is unchanged. Planning a `**` mission while other build work is planned or active also returns a non-blocking `broad-scope` warning (see [Planned edits, deferral and pauses](#planned-edits-deferral-and-pauses)) naming the missions it would fence. |
| `tower_mission` | `id` (alias `missionId`) or `missions[]` (each `{id, ...same fields}`) / `ids[]` shorthand, `atomic?`, `status?`, `task_done?`, `task_drop?`+`task_drop_reason?`, `task_add?`, `blocker?`, `clear_blockers?`, `note?`, `scope?`, `allowMissingScope?`, `deferred?`, `pause_cause?`, `authorization?`, `accept?`, `accept_note?` | Update one mission (`id`) or many (`missions`, or `ids` for lifecycle-only fields). Worker-safe fields are task/blocker/note; `merged` cannot be set here. `task_add` appends 1–20 non-empty strings (≤200 characters each) at the task-list tail as `open` tasks without reordering existing indexes; it is allowed on planned, active, paused, and blocked missions, and refused with `invalid-transition` (no state change) on completed, merged, or abandoned ones. Appended `open` tasks therefore keep `tower_complete` closed until they are done or dropped. `blocked` is derived from an open blocker (record `blocker`, never `status:"blocked"`); `clear_blockers` resumes it to `active`. A paused mission records `pause_cause` (user/failure/resource/dependency); a planned mission can be paused only with an explicit cause, and `status:"planned"` returns a paused mission to planning (the cause is cleared, no authorization) while resuming to `active` honors `mode.requireResumeAuthorization`. `scope` edits a planned mission's fence (which stays planned) and widens an active or completed one (which starts), following the same tracked-file presence rule and directory expansion as planning. `allowMissingScope:true` with `scope` accepts entries that match no tracked file yet (paths the mission will create) for a plan, a planned edit, or a widening; the acceptance is recorded as one `scope.unverified` activity entry and the flag is not stored on the mission. `deferred` steps a planned or active mission that owns paths (build or artifact) out of the widen overlap ordering: while true, another mission's edit or widening may overlap it, and `false` rejoins. The flag affects ordering decisions only while the mission is planned or active. `accept:true` records the human acceptance of an artifact mission's committed tip: the tool asks the human through the DSH approval channel, stamps the current branch tip, and refuses with `approval-unavailable` when the channel is missing — no argument can make an acceptance agent-made (a worker call is refused with `acceptance-human-only`). The bulk form is one closed object: `missions` carries the same per-item fields as the single form except `accept`/`accept_note` (acceptance stays single-mission), `ids` only applies lifecycle fields, and `atomic` (bulk only, default `true`) makes the batch all-or-nothing — one revision, one activity per mission plus one `mission.bulk` record, and an invalid or unknown id rolls the whole batch back before any write; `atomic:false` applies items in order and reports `{id, ok, mission?, error?, code?}` per item with the successful missions. The single-mission output is unchanged. |
| `tower_inspect` | `view` (`status`/`roster`/`diff`/`preflight`/`doctor`), `missionId?`, `maxBytes?`, `offset?`, `limit?`, `includeGate?`, `includeArchived?`, `format?`, `checks?`, `compact?`, `fields?`, `sinceRevision?` (alias `since_revision`), `agent?` (one agent's row + activity), `tail?` (with `agent`: newest N activity summaries on `status`/`roster`; with `roster` and no `agent`: newest N rows; default 5, max 50), `stat?` | One read-only tool for five views of the same state (#163 Phase 3). `status`: dashboard by default; `missionId` returns full detail; `offset`/`limit` page active missions (default 20, max 100); `includeGate` adds gate digests; `includeArchived` appends archived summaries; `format:"markdown"` returns the board, always rendered in full (`sinceRevision` filters only the JSON output); `fields:["id","status"]` projects each mission to exactly those keys; `sinceRevision` keeps only rows stamped at a later state revision: `missions` is the filtered mission list; `roster` is the filtered roster row **count** — roster rows themselves come from the `roster` view (`agent`/`tail`), which ignores `sinceRevision`; only the spawn, interrupt and roster writers stamp rows, while `tower_plan`, `tower_mission`, `tower_complete`, `tower_test` (test-run receipts), merge, review and the worktree writers leave no stamp and are omitted for a positive value (0 means no filter and returns every row); `status` with `missionId` returns the full detail and ignores `sinceRevision`; archived summaries carry no stamp, so `includeArchived` adds none for a positive value; test-run receipts (`testRuns`) appear only in `missionId` detail, never in list rows; non-terminal missions with a worktree also carry `worktreeDirty` and `uncommittedPathCount` (one bounded `git status` read per mission, `null` when it cannot be read); a newer/corrupt `state.json` degrades to a read-only on-disk diagnostic instead of failing. `roster`: roster with live activity (`running`/`inactive`/`missing`/`unknown`), `stale` flags, `lastObservedAt` (the last authoritative catalog sighting), and the dead-agent diagnostics `failureReason` (why the last activation failed; any non-failure outcome clears it) and `previousOutcome` (the outcome a replacement retired); `agent` selects one row by name or agent id and `tail` keeps the newest N rows; with `agent`, `roster` returns only that row's `{agent, activity: [{at, event, text}]}` and never the whole table (`tail` defaults to 5, max 50), and `status` with `agent` returns that row plus its bound mission and bounded activity instead of a dashboard page (`agent` and `missionId` are exclusive). `status` without `agent` is the dashboard and has no tail: on `status`, `tail` requires `agent` and is otherwise refused with `invalid-argument` (on `roster` it also keeps the newest N rows when `agent` is absent), so it is never silently ignored. With `compact:true` those two agent views keep only the identity `{name, role, missionId, state}` (status also keeps the bound mission as `{id, status, kind}`) and leave the bounded activity tail as its own field. `diff` (requires `missionId`): merge-base diff, files, commits, capped patch (`maxBytes`); `stat:true` replaces `patch`/`truncated` with per-file `{path, added, deleted}` counts (binary files are `null`) and never returns patch bytes; safe for reviewers. `preflight` (requires `missionId`): `{ok, blockers[], warnings[], order[], cycle, branchTip, baseTip, changedFiles, review}`; warnings are advisory and never enter `blockers[]` or flip `ok` — for example `checks-unverified` when a completion check claims a `command`/`exitCode` that no recorded test run corroborates; each blocker carries an ordered `resolution` list and the result carries a top-level `order` — dependency merges ancestor-first, then `rebase`, then the remaining steps — plus `cycle`, which is `null`, or a `dependency-cycle` conclusion naming the involved mission ids with a `break-dependency-cycle` step. A dependency that cannot be merged (a survey) is planned as `complete-mission`, not a merge. This is diagnosis only: preflight never merges or rebases. Review blockers only appear with `review.mode:required`, and artifact missions report `acceptance-missing`/`acceptance-stale` instead (the gate still accepts a recorded human verdict as the whole-tip approval); it rethrows state errors because no gate can be computed from unreadable state. `doctor`: concept-budget surface, git, state schema, config, presets/subagents/HMR, locks, workspace lock, roster, worktree realpath/ownership, test config, leases, the terminal-mission archive and the Ralph stance (`environmentContract.ralphLoop` plus a `ralph-stance` check); returns `{ok, checks[], surface, stateLock, gitLock, stateSchema, archive, environmentContract}` and never writes; `checks:true` returns only `{ok, checks}` with the full check rows, and `compact:true` returns only `{ok, checks}` with passing rows reduced to `{id, status}` and non-passing rows also keeping `detail` (compact wins when both are set). `roster`/`diff` require a known actor, `diff` also requires mission participation; `status`/`preflight`/`doctor` stay public so a broken repository can be diagnosed. |
| `tower_spawn` | `missionId` (alias `id`), `op?` (`spawn` default / `takeover`), `role` (`worker`/`reviewer`), `name?`, `instructions?`, `worktreeRoot?`, `wait?`, `includeDirtyBase?` | Provision/reuse the worktree and start a subagent. Worker uses `tower-worker`; reviewer requires a `completed` mission and uses the read-only `tower-reviewer`; with `review.mode:off` the reviewer role is refused with `[tower:review-disabled]`. `op:"takeover"` replaces a live worker entry that is no longer running (increments ownerGeneration); the old `takeover:true` field is rejected with the replacement path. `wait:true` waits for the result, bounded by `spawn.maxWaitMs` (default 90000); the old `waitMs` field is rejected with that config path. Only one live worker per mission; `spawn.maxLiveWorkers` caps the repository. The report names the placement in `worktree`: `{path, branch, baseCommit}` for a branch worktree and `null` for a survey that reads the shared checkout or a detached sandbox. Spawn runs the same base check before provisioning, so a mismatched checkout starts no agent. With `spawn.nodeModules:"link"` the spawn creates `<worktree>/node_modules` as a junction to the baseline checkout's installed `node_modules` and records `{target, path, createdAt}` as `mission.worktree.nodeModulesLink` and on the roster row; the target must already exist (otherwise the spawn is refused with `invalid-argument` and a remedy) and the report carries the same `nodeModulesLink`. |
| `tower_send` | `to`, `subject`, `body`, `scope?`, `interrupt?`, `wake?`, `consentRef?` | Durable message to a roster name, `tower`, or `all`. A running roster agent is steered into its current turn; a stopped one keeps the message for its next turn. `interrupt:true` (tower only) interrupts the running turn first, then delivers. `wake:true` starts a turn for a stopped agent and throws `agent-not-resumable` when that agent cannot be resumed. Activity that cannot be observed (the catalog errors or returns no rows) is never treated as stopped: `wake:true` then reports `woke:false` and says that no wake is claimed, and an explicit `interrupt:true` is still attempted and reported instead of silently skipped. `consentRef` is recorded for audit. Rate-limited by `send.maxPerMinute`. |
| `tower_inbox` | `limit?`, `include_read?` | Read/ack messages addressed to the caller; unread messages block `tower_complete`. |
| `tower_complete` | `missionId` (alias `id`), `report`, `checks?` | Worker reports completion (mission becomes `completed`, ready for preflight and optional review). Requires current owner, no open tasks/blockers, ≥1 commit, no unread inbox; an artifact mission additionally needs every declared deliverable present in the committed tip. `report` is capped at `gates.maxReportBytes` (default 32768 UTF-8 bytes): a larger report is rejected with `invalid-argument` and a `nextAction` to file the full text in the mission worktree, never truncated; the stored report records `reportBytes`. `checks` records `{name, runId?, command?, exitCode?, evidence?}` evidence: `runId` names a receipt in the mission's `testRuns` (from `tower_test`), and an unknown or foreign id is rejected with `invalid-argument` before any state write; a command/exit-code claim that no recorded run corroborates is reported by preflight as the advisory `checks-unverified` warning, never a blocker. `gates.requireChecks` can demand checks. When configured, test discovery runs automatically and adds a `tests` check; failure throws `[tower:tests-failed]`. |
| `tower_interrupt` | `to?` (roster name), `agentId?`, `reason?` | Interrupt one running roster agent via `subagents.interrupt`, record `state:"interrupted"`. Idempotent (not running → `interrupted:false`). |
| `tower_finding` | `op?` (`report` / `list` default / `update`), `id?`, `status?`, `note?`, filters (`type?`, `severity?`, `missionId?`, `open?`, `limit?`), `title?`, `summary?`, `details?`, `suggested_fix?`, `location?` | One finding lifecycle (#163 Phase 4). `report` needs `type` (bug/improve/vuln/idea), `title`, `summary`, `details`, `suggested_fix`; finds start as `open`. `list` reads/list by `id` or filters. `update` needs `id` plus `status`/`note`; statuses `open → triaged → fixed`/`wontfix`, reopen allowed. Only the tower or a worker may mutate; a reviewer can list/read. |
| `tower_review` | `missionId` (alias `id`), `status` (`clean`/`p1-Nitems`/`p2-Nitems`), `merge` (`merge`/`fix-then-merge`/`hold`), `findings`, `decision`, `checks?`, `breakGlassReason?` | Reviewer verdict bound to the current tip. Reviewer must be the assigned reviewer (or tower break-glass). Not registered when `review.mode:off`; a repository-level `off` refuses the submission with `[tower:review-disabled]`. A later route may record a verdict for the same reviewed tip while the mission is active: it appends to that round (`appended:true`) without changing the status; a verdict for a moved tip is rejected with an explanation. Inside one round the newest recorded verdict (highest `seq`) is the one the merge gate, landed-merge detection, status and briefing evaluate: a later clean verdict supersedes an earlier non-clean verdict of the same round. |
| `tower_merge` | `missionId` (alias `id`), `timeoutMs?` (alias `timeout_ms`) | Merge after a green gate. Records already-landed merges (`reconciled`), recovers a failed call whose commit exists (`recoveredFromFailure`), and separates `merge-hook-failed` from `merge-conflict`. |
| `tower_rebase` | `missionId` (alias `id`) | Rebase the branch onto the base in its worktree. Refuses while the worker runs or the worktree is dirty. Already-contained branches return `alreadyMerged` untouched. |
| `tower_teardown` | `force?`, `exclude?`, `orphans?`, `dry_run?` (alias `dryRun`) | Remove eligible merged/abandoned worktrees and branches; running agents are always kept. Each removal retries a transient lock (EPERM/EBUSY/EACCES) up to three times and its decision carries `attempts`; a permanent failure keeps the mission record and reports the final error. The final pass applies the `archive` policy while the `tower-archive` component row is mounted: terminal missions whose worktree is gone are moved to `<git-common-dir>/dsh-tower/archive/` once `archive.afterDays`/`archive.maxMissions` says so, and `archived` lists their ids. `dry_run` writes nothing and returns `archivePreview` (`{missions: [{missionId, reason}], year}`) computed from the same policy inputs on the state after the worktree removals and detached-sandbox cleanups the run plans, so a real run with the same inputs and successful cleanups archives exactly those ids. `orphans: true` opts into a sweep of git worktrees under the configured root that no mission, sandbox or review record references (#185): every git registration gets one decision, only clean checkouts are removed (a dirty one is kept, a registration whose directory is gone is pruned), and the main checkout, every state-referenced path and every path outside the root are always kept. The report is `orphanWorktrees: {root, decisions, removed, pruned}`, and a dry run previews it without removing or pruning anything. A call without `orphans` never looks at these checkouts. A recorded `node_modules` junction (`spawn.nodeModules:"link"`) is unlinked before the git removal and its target is never touched; an unrecorded link or junction at the worktree top level keeps the checkout with a `keep` decision and a `links` reason (teardown never follows or deletes a link it did not create). After a removal, leftover top-level entries are settled without recursion: the recorded link is unlinked, unrecorded links and files are kept, and only proved-empty directories are removed; the decision lists each outcome as `residuals`, and a removed recorded link as `nodeModulesLink`. `exclude` ids that match no mission or roster row are listed in `unmatchedExclude` with a `keep` decision whose reason is `exclude did not match any mission`. Nothing is deleted; `archive.afterDays:0` archives a just-torn-down mission immediately. |
| `tower_mode` | `active?` (`true`/`false`/`"takeover"`), `reason?`, `authorization?` | Without `active`: report mode, last change, paused goal, any Agent Team left on entry (`releasedTeam`: role, members, suspended), denied tools, store path, plugin version, HMR availability, workspace-lock holder, and the Ralph stance (`ralph: {policy, runs, rounds, liveRounds, detail}`) the entry policy acts on. With `active`: `true` enters, `false` leaves, `"takeover"` transfers repository ownership from an inactive owner after explicit user approval. Writes require a non-empty `reason` and `mode.allowAgentControl:true`; `takeover` also requires `authorization`, the audit reference recorded on the activity entry. Entering with a live Ralph loop either releases it (default `stop`, reported as `ralphReleased`) or fails with `[tower:invalid-transition]` under `mode.ralphPolicy:"refuse"`. |
| `/tower takeover <reason>` | — | Human-only ownership transfer, available even with `mode.allowAgentControl:false`. |
| `/tasks`, `/tower tasks` | — | Read-only live-roster panel for humans: one line per live roster agent (mission, role, name, short branch, state, silence since its last recorded event, that event), most silent first, capped at 20 rows, with `N live, M stale` counts and the `tower_interrupt` remedy in the footer. Costs no model turn and performs no writes (no `state.json`, activity log, or modes-store touches). Staleness is the same `spawn.staleMs` rule `tower_inspect`'s `roster` view and the merge gate use. The plugin claims `/tasks` only when the host profile defines no other `tasks` command; `/tower tasks` is the always-available alias, and which one this profile got is stated in the command description (#160). |
| `tower_reload` | — | Dev-only: ask DSH HMR to reconcile the profile and reload the Host plugin from disk. Registered while the `tower-hmr` component row is on (the row ships off); scheduled after the result (default 50 ms); fails with `reload-unavailable` without HMR. Registered in `host/tool-profiles.js` as the one repository-optional tool, so it works without a repository to fix a broken profile; the tool identity, not a supplied `repoRoot`, decides that path. |
| `tower_recover` | `action` (`status`/`clear-stale-lock`/`clear-workspace-lock`), `confirm?`, `force?` | Recovery diagnostics plus an explicit stale-lock repair for the state writer lock, the short-lived state-commit mutex (`state.commit.lock`) and the repository workspace lock (`<git-common-dir>/dsh-tower/tower.lock`). Use `status` when a mutation reports `state-locked`/`state-commit-busy`, or when `tower_inspect`'s doctor reports a leftover `commit-lock`; it reports `stateLock` and `commitLock` with the owner's `{pid, startedAt, ageMs, heartbeatAgeMs, stale}`, or `{unreadable:true, path, error}` when the file exists but does not parse (a torn write — an unreadable record is a wedge, not "no lock"). `clear-stale-lock` requires `confirm:"CLEAR_STALE_LOCK"` and only moves a record whose PID is provably dead to a unique numeric `.recovered-<timestamp><tick>` backup (never colliding even when two recoveries land in one millisecond; named in the output: `backup` for the state lock, `commitBackup` for the commit mutex). `force:true` additionally clears a live-but-silent PID (a recycled PID or a stopped process) and an unreadable record; without `force` an unreadable record is refused with `state-commit-lock-unreadable`/`state-lock-unreadable` and an executable `nextAction`. A moved record is always renamed, never unlinked. `status` also reports `workspaceLock` for the repository workspace lock: `{path, bytes, mtime, held, self, stale, corrupt, unreadable, torn, aged, reclaimable, pid, sessionId}`. A torn record (empty, whitespace only, or not a lock object) is auto-reclaimed by the next acquisition only once its mtime is older than the 30s torn grace window; a fresh torn file and every parseable record keep their existing behavior. `clear-workspace-lock` requires `confirm:"CLEAR_WORKSPACE_LOCK"` and moves that record to `tower.lock.recovered-<ts>` under the same rules: without `force` only a torn record past the grace window or a record whose PID is provably dead is moved; a live holder, an unprovable PID, a fresh torn file and an unreadable file are refused with the path, byte size, mtime and an executable `nextAction`. `tower_recover` runs before the workspace-lock gate (so it stays callable while every other repository tool reports `workspace-busy`, whose message now names the lock path, size and mtime), but recovery remains ownership-bound. Recovery never resets state or worktrees, and clearing the commit mutex does not replace the writer fence: every commit still verifies the state-lock token and the exact `state.json` bytes and classifies the landed revision, so a writer that lost the race fails closed. |
| `tower_wait` | `missionId?` (alias `id`) or `agent?` (exactly one), `until?` (`settled` default / `completed` / `inactive` / `any-change`), `timeoutMs?` (1000–600000, default 30000) | One bounded blocking wait over exactly one mission or roster agent (#201). Polls `state.json` once per round, never holds the state lock across the wait, never writes state or activity, and yields between rounds. Returns exactly one conclusion: `{status:"reached", waitedMs, target, detail}` when the condition holds; `{status:"timeout", waitedMs, target, last}` with the last bounded observation when it does not (no full tables); or `{status:"unknown", waitedMs, target, reason}` when the target is absent or the catalog becomes unreadable — an absent target is never a timeout. Tower-only; see [Waiting on one target](#waiting-on-one-target). |
| `tower_test` | `missionId` (alias `id`) | Run the worktree's `package.json` `tower.testDiscovery` and record a receipt; `ok:false` on failure. Use `tower_complete` for automatic admission checks. |
| `tower_batch` | `action` (`create`/`status`/`close`/`abandon`), `missionIds?`, `exclusions?`, `requiredChecks?`, `receiptPaths?`, `batchId?`, `checks?`, `treeTip?`, `receiptHashes?`, `reason?` | Finite evidence batch. Create freezes members/checks/receipts; close verifies every required check and receipt hash; merged members are eligible; abandon retires a stale open batch without deleting missions. Membership is immutable. |
| `tower_resource` | `action` (`acquire`/`release`/`status`), `name?`, `holder?`, `token?`, `ttlMs?`, `force?` | Advisory per-repository lease in `<common>/dsh-tower/leases.json`. No OS CPU/memory hard cap. A live lease is released only by its holder token; an **expired** lease is recovered by an explicit `force: true` release (never taken over automatically). |
| `tower_import` | `op?` (`snapshot` inferred from `sourcePath` / `map` default), `sourcePath?`, `action?` (`map`/`status`), `sourceHash?`, `oldId?`, `newMissionId?` | One legacy-resource tool (#163 Phase 4). `snapshot`: read-only import of a Tower Codex `schemaVersion:1` or DSH legacy state; the full payload goes under `<common>/dsh-tower/legacy/<sha256>.json` and state stores a summary only. `map`: audit-only legacy-id mapping; mappings are append-only. `action:"status"` lists mappings. Never activates/adopts/resumes paused missions. Tower-only except the read-only `status` action. |

### Reading less than the whole view

The read views accept opt-in projections, so a caller can bound a large response
without changing any default shape. Each line is one arm of one tool:

```json
{"tool":"tower_inspect","arguments":{"view":"doctor","compact":true}}
{"tool":"tower_inspect","arguments":{"view":"doctor","checks":true}}
{"tool":"tower_inspect","arguments":{"view":"status","fields":["id","status","owner"]}}
{"tool":"tower_inspect","arguments":{"view":"status","sinceRevision":41}}
{"tool":"tower_inspect","arguments":{"view":"roster","agent":"worker-m1","tail":5}}
{"tool":"tower_inspect","arguments":{"view":"diff","missionId":"M7","stat":true}}
```

`sinceRevision` uses the per-row `revision` stamps. Only the spawn, interrupt and
roster writers stamp rows (spawn reserve/outcome, interrupt, and roster
observation/retirement/watchdog changes); `tower_plan`, `tower_mission`,
`tower_complete`, `tower_test` test-run receipts, merge, review and the worktree
writers (`tower_spawn` provisioning, `tower_rebase`, `tower_teardown`) bump
`state.revision` without stamping rows, so a positive value omits those changes.
Test receipts live in `testRuns` and appear only in `missionId` detail, never in
list rows; each receipt carries a durable `id` (`run-N`) that a completion check
can cite as `runId`. In the JSON dashboard, `missions` is the filtered mission list and
`roster` is the filtered roster row **count**; roster rows themselves come from
the `roster` view (`agent`/`tail`), which ignores `sinceRevision`.
`status` with `missionId` returns the full detail and ignores `sinceRevision`;
archived summaries carry no stamp, so `includeArchived` adds none for a positive
value. Pass `0` to read every row (no filter). The filter applies to the JSON
output only: `format:"markdown"` always renders the full board. `compact` keeps
every non-passing check with its `detail`, so a smaller doctor report never
hides a failure.

`tail` bounds one target at a time. With `agent` it caps that agent's activity
summaries on the `status` and `roster` views; on `roster` without `agent` it keeps
the newest N rows. `status` without `agent` renders the dashboard, which has no
bounded tail, so that combination is refused with `invalid-argument` naming
`agent` instead of being silently ignored.

## Waiting on one target

`tower_wait` is the second half of the bounded read story (#201). Instead of
polling `tower_inspect` in a loop, a caller names one mission or one roster agent
and gets exactly one conclusion back:

```json
{"tool":"tower_wait","arguments":{"missionId":"M7","until":"settled","timeoutMs":120000}}
{"tool":"tower_wait","arguments":{"agent":"worker-m7","until":"any-change"}}
```

| Result | When | Payload |
|---|---|---|
| `reached` | The condition held at a poll: the mission reached `completed`/`merged` (`completed`), its status is `completed`/`merged`/`blocked`/`paused`/`abandoned` (`settled`) or every row of it is settled with no rows counting as inactive (`inactive`); the agent row state is settled (or the row is gone); or the observed projection changed (`any-change` — the mission summary, the agent summary, or a roster row of the target's mission; not task lists, notes, blockers or test runs). | `status`, `waitedMs`, `target`, `detail` (the `until` value and the mission/agent summary). |
| `timeout` | The condition did not hold before the timeout elapsed. | `status`, `waitedMs`, `target`, `last` — the last bounded observation (revision, the target row, and at most five roster rows; never full mission/roster tables). |
| `unknown` | The target does not exist, or the catalog became unreadable/removed mid-wait. | `status`, `waitedMs`, `target`, `reason`. Do not retry the same target blindly; re-read the roster or mission list. |

`until:"settled"` is the default. For an agent target it means that roster row's
state is one of `inactive`, `retired`, `failed`, `interrupted` or `missing` —
independent of the bound mission, and a row that disappears mid-wait counts as
`missing` for `settled`, `inactive` and `any-change`; `stale`, `reserved` and `active` are not settled, because staleness
is an observation-health fact and not a lifecycle fact (#210/#211). For a
mission target, settled means the mission status is `completed`, `merged`,
`blocked`, `paused` or `abandoned`. `until:"inactive"` means every roster row of
that mission is settled, so a mission with no rows is inactive at once.
`until:"completed"` means the bound mission is `completed` or `merged`,
including when the target is an agent.

`until:"any-change"` compares one bounded projection of the target on each poll:
the mission summary (`id`, `status`, `kind`, `owner`, `title`), the agent summary
(`name`, `agentId`, `role`, `missionId`, `state`) and, for a mission target, every
roster row of that mission. Task lists, notes, blockers and test-run receipts are
not part of it, so a change that only touches those does not wake the wait; read
`status` with `missionId` for them.

Guarantees:

- **Bounded.** `timeoutMs` is an integer between 1000 and 600000 (default
  30000). A wait never blocks forever; out-of-range and ambiguous targets
  (`missionId` and `agent` together) are refused with `invalid-argument` naming
  the boundary.
- **Read-only.** A wait re-reads `state.json` once per round, takes no state
  lock, writes no state or activity, and yields to the event loop between
  rounds (`min(500 ms, remaining)`), so it cannot starve a concurrent writer.
- **Tower-only.** The tool is exposed in the tower profile and `host:active`;
  the worker, reviewer and survey presets do not mount it. A worker reports
  progress through `tower_complete`, and a role preset must stay non-blocking.

## Mission scopes

A `scope` entry is a **file glob** relative to the repository root, matched by
`fileInScope` as a pure glob: `*` matches within one path segment, `**` matches any
depth (including none), `?` matches one non-separator character, and every other
character is literal. A scope entry therefore names files, never a directory: the
literal entry `docs/guide` matches only the file with exactly that name, not the files
below it.

`tower_plan` keeps that matcher unchanged and instead normalises directory-shaped
entries when it stores a new plan; the `scope` of a `tower_mission` planned edit or
widening gets the same treatment:

| Entry written | Stored scope | Why |
|---|---|---|
| `docs/guide/` | `docs/guide/**` | A trailing separator states "directory", even before it exists. |
| `docs/guide` | `docs/guide/**` | The planning checkout has a directory at that path (probed once at plan time). |
| `docs/guide` (no such directory) | `docs/guide` | It may name an existing file or a file a mission will create; it stays literal. |
| `docs/guide/**` | `docs/guide/**` | Already an explicit subtree glob; unchanged. |
| `docs/*.md` | `docs/*.md` | A glob entry is a file pattern; unchanged. |
| `.` | `**` | The repository root is the whole tree. |

The stored scope is always the explicit glob, never the directory spelling, so the
gate, the briefing and `tower_inspect` all show the exact fence. Only **new input** is
normalised: a scope already stored on a mission is never rewritten, so a mission
planned before this rule keeps its literal entry (and keeps rejecting files below the
directory) until the tower widens the scope explicitly. When the directory probe fails,
the entry stays literal instead of failing the plan.

Recommended spellings for a directory subtree are `docs/guide/**` and `docs/guide/`.
Avoid the bare `docs/guide`: it is expanded only while that directory exists at plan
time, so the same text can mean a file or a whole subtree depending on the repository.

### A scope entry must name something

Expansion above describes how an entry is stored; presence decides whether it may be
planned at all. Planning checks the raw entries against `git ls-files` before
normalising them, so a typo is caught before a mission exists instead of after a
spawn, when the only way out is abandoning and replanning the mission (#200).

A raw entry passes when it is `**`, `.`, a directory-shaped entry (a trailing
separator, or a bare path that is a directory in the planning checkout), or when it
matches at least one tracked path. It also passes when its static prefix — the text
before the first `*`, `?` or `[`, up to the last separator — is outside every tracked
tree: planning cannot know whether a mission will create that tree, so `src/**` on a
README-only repository is a future tree, not a typo. Root-level literals (no
directory prefix) are unverifiable for the same reason and stay legal, so an unknown
dependency keeps its own error and the gate fences the path as before.

Everything else is a known territory without a match: an entry whose prefix is
tracked (or exists in the checkout) but which matches no tracked file is rejected
with `invalid-argument`. That includes a glob that matches only ignored files in a
checked-out directory. The message names the first failing entry, the nearest
existing prefix and up to five tracked candidates in that directory; `details.problems`
carries `{entry, reason, closestPrefix, candidates}` for each one, and
`details.operation` says whether a plan (including a planned mission's scope edit) or a widening was rejected:

```text
[tower:invalid-argument] no tracked file matches "tests/teardown*.test.mjs"; nearest
existing prefix "tests"; tracked files there: tests/cleanup.test.mjs — next: use a
tracked path such as "tests/cleanup.test.mjs", or pass allowMissingScope: true to
accept a path a mission will create
```

Case is folded for presence only: a case-only mismatch is the fence's comparison
decision (#90), not a missing path, and nothing is rewritten. When the entry really is
a path a mission will create, pass `allowMissingScope:true` with that mission in
`tower_plan`, or with the `scope` of a `tower_mission` edit or widening. The call
accepts the entries without proof and records one `scope.unverified` activity entry
naming them. The flag is an input decision, not part of the stored mission, and the
stored scope is unchanged. `tower_mission` validates the new entries with the same
rule: a planned mission edits its fence and keeps the planned-edit ordering, while an
active or completed mission widens it and starts it; `allowMissingScope:true` is
available in both cases. The two operations differ only in the rejected entry's
`details.operation` (`"plan"` or `"widen"`): either rejection spells out the presence
rule above and its next action names `allowMissingScope:true`, so a caller who knows the
mission will create the path can opt in explicitly.

A mission whose scope is `**` owns every future path, so any later planned edit or
widening by another in-flight mission overlaps it. `tower_plan` therefore returns a
non-blocking `broad-scope` warning when a new whole-repository mission is planned while
other owning work is planned or active: the warning names the missions such a fence would
block and suggests planning the release-preparation mission last, deferring it, or
pausing it before another mission widens. The plan itself still succeeds.

### Planned edits, deferral and pauses

A planned mission has not started, so `tower_mission` treats its `scope` as a planning
edit: the fence is replaced, `scopeGeneration` increments, and the mission stays
`planned`. Presence and directory rules are the same as planning, and
`allowMissingScope:true` is available for paths the mission will create.

A planned or active mission that owns paths (build or artifact) can set `deferred:true` to
step out of the widen ordering: while deferred, its scope no longer blocks another
mission's planned edit or widening, so release-preparation work can be planned last
without rewriting the fence.
`deferred:false` rejoins the ordering, and once the mission is terminal the flag no
longer affects any decision.

A mission paused from `planned` must carry an explicit `pause_cause`.
`status:"planned"` returns a paused mission to planning, clears the cause, and needs no
authorization; only `status:"active"` follows `mode.requireResumeAuthorization`. Paused
missions are skipped by the widen overlap check, so pausing is another way to release
an ordering block.

When `git ls-files` fails or returns nothing, presence cannot be proved and planning
proceeds without the check; the gate still fences the stored scope as before.

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
