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
unknown-tool error. The measured profile surfaces are tower 14 tools / 16,017 B of input schema,
worker 6 / 8,646 B, and reviewer 5 / 6,000 B; `docs/reference/surface-budget.md` records the
baseline and every change.

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
| `tower_init` | `op?` (`init` default / `adopt`), `repoRoot`, `base?`, `auto_git_init?`, `snapshot_dirty?`, `reanchor?`, `retire_missing?` | `op:"init"` creates `<git-common-dir>/dsh-tower/state.json`. The only tool that advertises `repoRoot` (bootstrap); it wins over the session directory so an explicit target can be initialized. `auto_git_init` runs `git init` + empty initial commit; `snapshot_dirty` records a dangling snapshot commit of uncommitted tracked changes used as the mission baseline; `reanchor` changes base only when no non-terminal mission exists. `op:"adopt"` reconciles the roster with the durable catalog: provably gone agents are retired (default) or marked `missing` (`retire_missing:false`). Tower-only for both ops. |
| `tower_plan` | `missions[]` (`title` — printable Unicode, NFC-normalized, ≤120 characters, `scope[]`, `tasks[]?`, `deps[]?`, `kind?` — `build`/`survey`/`artifact`, `artifacts[]?` ≤20, `context?`, `references[]?` ≤20, `reviewPolicy?`, `reviewExemptionReason?`, `allowMissingScope?`) | Create missions `M1..`; overlapping build scopes auto-add a dependency; rejects unknown deps and cycles. Mission ids stay ASCII (`M1`, `M2`); invisible characters and over-long titles are rejected with `invalid-argument`. `kind:"artifact"` declares concrete deliverable paths in `artifacts[]` (no globs, each inside the scope); they must be committed at the tip before completion and the merge then waits for a human acceptance of that tip. `reviewPolicy:"none"` requires a non-empty reason; when the review gate is on, preflight also requires `gates.allowReviewExemption`. `scope` is a list of file globs relative to the repository root; a directory-shaped entry (`docs/guide/`, or a bare `docs/guide` that exists at plan time) is stored as the explicit subtree glob `docs/guide/**` — see [Mission scopes](#mission-scopes). Every entry is checked against `git ls-files` at plan time: an entry that names a tracked directory but matches nothing in it is rejected with `invalid-argument`, naming the nearest existing prefix and up to five tracked candidates. Pass `allowMissingScope:true` on that mission to accept paths the mission will create; the acceptance is recorded as one `scope.unverified` activity entry and the stored scope is unchanged. Planning a `**` mission while other build work is planned or active also returns a non-blocking `broad-scope` warning (see [Planned edits, deferral and pauses](#planned-edits-deferral-and-pauses)) naming the missions it would fence. |
| `tower_mission` | `id` (alias `missionId`), `status?`, `task_done?`, `task_drop?`+`task_drop_reason?`, `blocker?`, `clear_blockers?`, `note?`, `scope?`, `allowMissingScope?`, `deferred?`, `pause_cause?`, `authorization?`, `accept?`, `accept_note?` | Update one mission. Worker-safe fields are task/blocker/note; `merged` cannot be set here. `blocked` is derived from an open blocker (record `blocker`, never `status:"blocked"`); `clear_blockers` resumes it to `active`. A paused mission records `pause_cause` (user/failure/resource/dependency); a planned mission can be paused only with an explicit cause, and `status:"planned"` returns a paused mission to planning (the cause is cleared, no authorization) while resuming to `active` honors `mode.requireResumeAuthorization`. `scope` edits a planned mission's fence (which stays planned) and widens an active or completed one (which starts), following the same tracked-file presence rule and directory expansion as planning. `allowMissingScope:true` with `scope` accepts entries that match no tracked file yet (paths the mission will create) for a plan, a planned edit, or a widening; the acceptance is recorded as one `scope.unverified` activity entry and the flag is not stored on the mission. `deferred` steps a planned or active mission that owns paths (build or artifact) out of the widen overlap ordering: while true, another mission's edit or widening may overlap it, and `false` rejoins. The flag affects ordering decisions only while the mission is planned or active. `accept:true` records the human acceptance of an artifact mission's committed tip: the tool asks the human through the DSH approval channel, stamps the current branch tip, and refuses with `approval-unavailable` when the channel is missing — no argument can make an acceptance agent-made (a worker call is refused with `acceptance-human-only`). |
| `tower_inspect` | `view` (`status`/`roster`/`diff`/`preflight`/`doctor`), `missionId?`, `maxBytes?`, `offset?`, `limit?`, `includeGate?`, `includeArchived?`, `format?` | One read-only tool for five views of the same state (#163 Phase 3). `status`: dashboard by default; `missionId` returns full detail; `offset`/`limit` page active missions (default 20, max 100); `includeGate` adds gate digests; `includeArchived` appends archived summaries; `format:"markdown"` returns the board; a newer/corrupt `state.json` degrades to a read-only on-disk diagnostic instead of failing. `roster`: roster with live activity (`running`/`inactive`/`missing`/`unknown`) and `stale` flags. `diff` (requires `missionId`): merge-base diff, files, commits, capped patch (`maxBytes`); safe for reviewers. `preflight` (requires `missionId`): `{ok, blockers[], branchTip, baseTip, changedFiles, review}`; review blockers only with `review.mode:required`, and artifact missions report `acceptance-missing`/`acceptance-stale` instead (the gate still accepts a recorded human verdict as the whole-tip approval); it rethrows state errors because no gate can be computed from unreadable state. `doctor`: concept-budget surface, git, state schema, config, presets/subagents/HMR, locks, workspace lock, roster, worktree realpath/ownership, test config, leases, the terminal-mission archive and the Ralph stance (`environmentContract.ralphLoop` plus a `ralph-stance` check); returns `{ok, checks[], surface, stateLock, gitLock, stateSchema, archive, environmentContract}` and never writes. `roster`/`diff` require a known actor, `diff` also requires mission participation; `status`/`preflight`/`doctor` stay public so a broken repository can be diagnosed. |
| `tower_spawn` | `missionId` (alias `id`), `op?` (`spawn` default / `takeover`), `role` (`worker`/`reviewer`), `name?`, `instructions?`, `worktreeRoot?`, `wait?`, `includeDirtyBase?` | Provision/reuse the worktree and start a subagent. Worker uses `tower-worker`; reviewer requires a `completed` mission and uses the read-only `tower-reviewer`; with `review.mode:off` the reviewer role is refused with `[tower:review-disabled]`. `op:"takeover"` replaces a live worker entry that is no longer running (increments ownerGeneration); the old `takeover:true` field is rejected with the replacement path. `wait:true` waits for the result, bounded by `spawn.maxWaitMs` (default 90000); the old `waitMs` field is rejected with that config path. Only one live worker per mission; `spawn.maxLiveWorkers` caps the repository. The report names the placement in `worktree`: `{path, branch, baseCommit}` for a branch worktree and `null` for a survey that reads the shared checkout or a detached sandbox. |
| `tower_send` | `to`, `subject`, `body`, `scope?`, `interrupt?`, `wake?`, `consentRef?` | Durable message to a roster name, `tower`, or `all`. A running roster agent is steered into its current turn; a stopped one keeps the message for its next turn. `interrupt:true` (tower only) interrupts the running turn first, then delivers. `wake:true` starts a turn for a stopped agent and throws `agent-not-resumable` when that agent cannot be resumed. Activity that cannot be observed (the catalog errors or returns no rows) is never treated as stopped: `wake:true` then reports `woke:false` and says that no wake is claimed, and an explicit `interrupt:true` is still attempted and reported instead of silently skipped. `consentRef` is recorded for audit. Rate-limited by `send.maxPerMinute`. |
| `tower_inbox` | `limit?`, `include_read?` | Read/ack messages addressed to the caller; unread messages block `tower_complete`. |
| `tower_complete` | `missionId` (alias `id`), `report`, `checks?` | Worker reports completion (mission becomes `completed`, ready for preflight and optional review). Requires current owner, no open tasks/blockers, ≥1 commit, no unread inbox; an artifact mission additionally needs every declared deliverable present in the committed tip. `report` is capped at `gates.maxReportBytes` (default 32768 UTF-8 bytes): a larger report is rejected with `invalid-argument` and a `nextAction` to file the full text in the mission worktree, never truncated; the stored report records `reportBytes`. `checks` records `{name, command?, exitCode?, evidence?}` evidence; `gates.requireChecks` can demand it. When configured, test discovery runs automatically and adds a `tests` check; failure throws `[tower:tests-failed]`. |
| `tower_interrupt` | `to?` (roster name), `agentId?`, `reason?` | Interrupt one running roster agent via `subagents.interrupt`, record `state:"interrupted"`. Idempotent (not running → `interrupted:false`). |
| `tower_finding` | `op?` (`report` / `list` default / `update`), `id?`, `status?`, `note?`, filters (`type?`, `severity?`, `missionId?`, `open?`, `limit?`), `title?`, `summary?`, `details?`, `suggested_fix?`, `location?` | One finding lifecycle (#163 Phase 4). `report` needs `type` (bug/improve/vuln/idea), `title`, `summary`, `details`, `suggested_fix`; finds start as `open`. `list` reads/list by `id` or filters. `update` needs `id` plus `status`/`note`; statuses `open → triaged → fixed`/`wontfix`, reopen allowed. Only the tower or a worker may mutate; a reviewer can list/read. |
| `tower_review` | `missionId` (alias `id`), `status` (`clean`/`p1-Nitems`/`p2-Nitems`), `merge` (`merge`/`fix-then-merge`/`hold`), `findings`, `decision`, `checks?`, `breakGlassReason?` | Reviewer verdict bound to the current tip. Reviewer must be the assigned reviewer (or tower break-glass). Not registered when `review.mode:off`; a repository-level `off` refuses the submission with `[tower:review-disabled]`. A later route may record a verdict for the same reviewed tip while the mission is active: it appends to that round (`appended:true`) without changing the status; a verdict for a moved tip is rejected with an explanation. Inside one round the newest recorded verdict (highest `seq`) is the one the merge gate, landed-merge detection, status and briefing evaluate: a later clean verdict supersedes an earlier non-clean verdict of the same round. |
| `tower_merge` | `missionId` (alias `id`), `timeoutMs?` (alias `timeout_ms`) | Merge after a green gate. Records already-landed merges (`reconciled`), recovers a failed call whose commit exists (`recoveredFromFailure`), and separates `merge-hook-failed` from `merge-conflict`. |
| `tower_rebase` | `missionId` (alias `id`) | Rebase the branch onto the base in its worktree. Refuses while the worker runs or the worktree is dirty. Already-contained branches return `alreadyMerged` untouched. |
| `tower_teardown` | `force?`, `exclude?`, `orphans?`, `dry_run?` (alias `dryRun`) | Remove eligible merged/abandoned worktrees and branches; running agents are always kept. Each removal retries a transient lock (EPERM/EBUSY/EACCES) up to three times and its decision carries `attempts`; a permanent failure keeps the mission record and reports the final error. The final pass applies the `archive` policy while the `tower-archive` component row is mounted: terminal missions whose worktree is gone are moved to `<git-common-dir>/dsh-tower/archive/` once `archive.afterDays`/`archive.maxMissions` says so, and `archived` lists their ids. `dry_run` writes nothing and returns `archivePreview` (`{missions: [{missionId, reason}], year}`) computed from the same policy inputs on the state after the worktree removals and detached-sandbox cleanups the run plans, so a real run with the same inputs and successful cleanups archives exactly those ids. `orphans: true` opts into a sweep of git worktrees under the configured root that no mission, sandbox or review record references (#185): every git registration gets one decision, only clean checkouts are removed (a dirty one is kept, a registration whose directory is gone is pruned), and the main checkout, every state-referenced path and every path outside the root are always kept. The report is `orphanWorktrees: {root, decisions, removed, pruned}`, and a dry run previews it without removing or pruning anything. A call without `orphans` never looks at these checkouts. `exclude` ids that match no mission or roster row are listed in `unmatchedExclude` with a `keep` decision whose reason is `exclude did not match any mission`. Nothing is deleted; `archive.afterDays:0` archives a just-torn-down mission immediately. |
| `tower_mode` | `active?` (`true`/`false`/`"takeover"`), `reason?`, `authorization?` | Without `active`: report mode, last change, paused goal, any Agent Team left on entry (`releasedTeam`: role, members, suspended), denied tools, store path, plugin version, HMR availability, workspace-lock holder, and the Ralph stance (`ralph: {policy, runs, rounds, liveRounds, detail}`) the entry policy acts on. With `active`: `true` enters, `false` leaves, `"takeover"` transfers repository ownership from an inactive owner after explicit user approval. Writes require a non-empty `reason` and `mode.allowAgentControl:true`; `takeover` also requires `authorization`, the audit reference recorded on the activity entry. Entering with a live Ralph loop either releases it (default `stop`, reported as `ralphReleased`) or fails with `[tower:invalid-transition]` under `mode.ralphPolicy:"refuse"`. |
| `/tower takeover <reason>` | — | Human-only ownership transfer, available even with `mode.allowAgentControl:false`. |
| `/tasks`, `/tower tasks` | — | Read-only live-roster panel for humans: one line per live roster agent (mission, role, name, short branch, state, silence since its last recorded event, that event), most silent first, capped at 20 rows, with `N live, M stale` counts and the `tower_interrupt` remedy in the footer. Costs no model turn and performs no writes (no `state.json`, activity log, or modes-store touches). Staleness is the same `spawn.staleMs` rule `tower_inspect`'s `roster` view and the merge gate use. The plugin claims `/tasks` only when the host profile defines no other `tasks` command; `/tower tasks` is the always-available alias, and which one this profile got is stated in the command description (#160). |
| `tower_reload` | — | Dev-only: ask DSH HMR to reconcile the profile and reload the Host plugin from disk. Registered while the `tower-hmr` component row is on (the row ships off); scheduled after the result (default 50 ms); fails with `reload-unavailable` without HMR. Registered in `host/tool-profiles.js` as the one repository-optional tool, so it works without a repository to fix a broken profile; the tool identity, not a supplied `repoRoot`, decides that path. |
| `tower_recover` | `action` (`status`/`clear-stale-lock`/`clear-workspace-lock`), `confirm?`, `force?` | Recovery diagnostics plus an explicit stale-lock repair for the state writer lock, the short-lived state-commit mutex (`state.commit.lock`) and the repository workspace lock (`<git-common-dir>/dsh-tower/tower.lock`). Use `status` when a mutation reports `state-locked`/`state-commit-busy`, or when `tower_inspect`'s doctor reports a leftover `commit-lock`; it reports `stateLock` and `commitLock` with the owner's `{pid, startedAt, ageMs, heartbeatAgeMs, stale}`, or `{unreadable:true, path, error}` when the file exists but does not parse (a torn write — an unreadable record is a wedge, not "no lock"). `clear-stale-lock` requires `confirm:"CLEAR_STALE_LOCK"` and only moves a record whose PID is provably dead to a unique numeric `.recovered-<timestamp><tick>` backup (never colliding even when two recoveries land in one millisecond; named in the output: `backup` for the state lock, `commitBackup` for the commit mutex). `force:true` additionally clears a live-but-silent PID (a recycled PID or a stopped process) and an unreadable record; without `force` an unreadable record is refused with `state-commit-lock-unreadable`/`state-lock-unreadable` and an executable `nextAction`. A moved record is always renamed, never unlinked. `status` also reports `workspaceLock` for the repository workspace lock: `{path, bytes, mtime, held, self, stale, corrupt, unreadable, torn, aged, reclaimable, pid, sessionId}`. A torn record (empty, whitespace only, or not a lock object) is auto-reclaimed by the next acquisition only once its mtime is older than the 30s torn grace window; a fresh torn file and every parseable record keep their existing behavior. `clear-workspace-lock` requires `confirm:"CLEAR_WORKSPACE_LOCK"` and moves that record to `tower.lock.recovered-<ts>` under the same rules: without `force` only a torn record past the grace window or a record whose PID is provably dead is moved; a live holder, an unprovable PID, a fresh torn file and an unreadable file are refused with the path, byte size, mtime and an executable `nextAction`. `tower_recover` runs before the workspace-lock gate (so it stays callable while every other repository tool reports `workspace-busy`, whose message now names the lock path, size and mtime), but recovery remains ownership-bound. Recovery never resets state or worktrees, and clearing the commit mutex does not replace the writer fence: every commit still verifies the state-lock token and the exact `state.json` bytes and classifies the landed revision, so a writer that lost the race fails closed. |
| `tower_test` | `missionId` (alias `id`) | Run the worktree's `package.json` `tower.testDiscovery` and record a receipt; `ok:false` on failure. Use `tower_complete` for automatic admission checks. |
| `tower_batch` | `action` (`create`/`status`/`close`/`abandon`), `missionIds?`, `exclusions?`, `requiredChecks?`, `receiptPaths?`, `batchId?`, `checks?`, `treeTip?`, `receiptHashes?`, `reason?` | Finite evidence batch. Create freezes members/checks/receipts; close verifies every required check and receipt hash; merged members are eligible; abandon retires a stale open batch without deleting missions. Membership is immutable. |
| `tower_resource` | `action` (`acquire`/`release`/`status`), `name?`, `holder?`, `token?`, `ttlMs?`, `force?` | Advisory per-repository lease in `<common>/dsh-tower/leases.json`. No OS CPU/memory hard cap. A live lease is released only by its holder token; an **expired** lease is recovered by an explicit `force: true` release (never taken over automatically). |
| `tower_import` | `op?` (`snapshot` inferred from `sourcePath` / `map` default), `sourcePath?`, `action?` (`map`/`status`), `sourceHash?`, `oldId?`, `newMissionId?` | One legacy-resource tool (#163 Phase 4). `snapshot`: read-only import of a Tower Codex `schemaVersion:1` or DSH legacy state; the full payload goes under `<common>/dsh-tower/legacy/<sha256>.json` and state stores a summary only. `map`: audit-only legacy-id mapping; mappings are append-only. `action:"status"` lists mappings. Never activates/adopts/resumes paused missions. Tower-only except the read-only `status` action. |

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
