# Surface budget

The plugin measures its user-facing surface in three numbers: **config leaf keys**,
**config sections**, and **registered tools**. The committed baseline is
[`scripts/surface-baseline.json`](../../scripts/surface-baseline.json); the brake
is `npm run surface:check`; the decision record is
[ADR 0004](../adr/0004-surface-budget.md).

Decision date: 2026-10-23

Every key and tool is classified here so "why is this here" has an answer that a
check can read. `core` is a behavioural or safety contract, `tuning` is a safe
default a user may want to change, and `niche` was added for one workflow and
must carry a removal note for the next minor. A live key or tool missing from
these tables fails `npm run surface:check`.

## Config keys

| Key | Class | Note |
|---|---|---|
| `section` | core | Legacy alias for `mode.promptSection`; changes the Tower-mode prompt contract. |
| `allowAgentControl` | core | Legacy alias for `mode.allowAgentControl`; decides whether the model may toggle the mode. |
| `init.autoGitInit` | tuning | Repository bootstrap convenience; safe default is off. |
| `init.snapshotDirty` | tuning | Baseline snapshot convenience; tracks dirty state explicitly. |
| `init.autoExclude` | tuning | Keeps generated artifacts out of user dirt without touching `.gitignore`. |
| `mode.promptSection` | core | Replaces the whole Tower-mode prompt text. |
| `mode.sectionAppend` | tuning | Appends team conventions to the prompt. |
| `mode.allowAgentControl` | core | The human-owned-mode toggle described by ADR 0003. |
| `mode.autoPauseGoal` | core | Entering the mode pauses an active goal; exit never resumes it. |
| `mode.requireResumeAuthorization` | core | Guards resuming a user-paused mission. |
| `mode.requireHumanAckOnFirstEntry` | core | First entry can require an explicit human ack. |
| `mode.workspaceLock` | core | One Tower session per repository is a safety contract. |
| `mode.workspaceLockScope` | tuning | Chooses whether read-only tools skip the workspace lock. |
| `mode.planModePolicy` | core | Entering Tower mode either clears plan mode or refuses. |
| `mode.workspaceStaleMs` | tuning | Stale window for the advisory workspace lock. |
| `mode.heartbeatMs` | tuning | Heartbeat interval while the mode is on. |
| `mode.denyTools` | core | The denied-tool list is part of the mode guard. |
| `mode.storePath` | niche | Custom mode-store location added for one deployment workflow. Removal note: derive the path from `$DSH_HOME` in the next minor; no in-tree caller sets this key. |
| `mode.maxEntries` | tuning | Bounds the persisted mode store. |
| `mode.lockTimeoutMs` | tuning | Bounded wait for the cross-process mode lock. |
| `review.requireReview` | core | Turns the review gate into a merge blocker. |
| `review.maxRoundsPerReviewer` | core | Caps review rounds; changes the review lifecycle. |
| `merge.timeoutMs` | tuning | Default merge timeout; a per-call value wins. |
| `merge.maxBufferBytes` | tuning | Captured merge output buffer. |
| `git.timeoutMs` | tuning | Default Git command timeout outside merge. |
| `worktrees.root` | tuning | Default worktree placement. |
| `spawn.workerPreset` | core | Chooses the tool surface a worker receives. |
| `spawn.reviewerPreset` | core | Chooses the read-only reviewer surface. |
| `spawn.maxDepth` | tuning | Subagent depth requested at spawn. |
| `spawn.provider` | tuning | Provider route for spawned agents. |
| `spawn.workerModel` | tuning | Optional model route for workers. |
| `spawn.reviewerModel` | tuning | Optional independent model route for reviewers. |
| `spawn.maxLiveWorkers` | core | Resource-safety cap on live workers. |
| `spawn.staleMs` | tuning | Roster staleness window before merge is blocked. |
| `spawn.maxWaitMs` | tuning | Upper bound for a blocking spawn wait. |
| `spawn.requireLease` | niche | Advisory-lease gate added for one multi-agent workflow. Removal note: fold into `tower_resource` policy in the next minor unless a second workflow uses it. |
| `send.maxPerMinute` | tuning | Message rate limit; zero disables it. |
| `send.interruptDefault` | tuning | Default for the interrupt-before-deliver flag. |
| `tests.enabled` | core | Whether declared discovery may run at all. |
| `tests.admission` | core | Chooses when repository code is executed. |
| `tests.timeoutMs` | tuning | Per-command discovery timeout. |
| `tests.maxBytes` | tuning | Captured discovery output cap. |
| `tests.autoChecks` | tuning | Attaches a tests check to completion. |
| `tests.allowPackageDiscovery` | core | Allows repository code to execute; a security contract. |
| `gates.requireChecks` | core | Requires completion evidence before merge. |
| `gates.requireTests` | core | Requires a test receipt before merge. |
| `gates.allowReviewExemption` | core | Allows a review exemption and its reason. |
| `gates.maxReportBytes` | tuning | Report size cap; the refusal itself is not configurable. |
| `docs.board` | tuning | Writes the human-readable board. |
| `docs.boardLocation` | tuning | Chooses the board location. |
| `archive.enabled` | core | Controls whether terminal missions leave the hot state. |
| `archive.afterDays` | tuning | Archive age threshold. |
| `archive.maxMissions` | tuning | Hot terminal-mission cap. |
| `tools.exposeOperational` | core | Master switch for the operational tool surface. |
| `tools.exposeBatch` | core | Registers the evidence-batch tool. |
| `tools.exposeImport` | core | Registers the legacy import tools. |
| `tools.exposeLeases` | core | Registers advisory leases. |
| `tools.exposeTests` | core | Registers test discovery; required when the test gate is on. |
| `tools.exposeRecovery` | core | Registers the stale-lock escape hatch. |
| `tools.exposeDoctor` | core | Registers the read-only health contract. |
| `leases.ttlMs` | tuning | Default advisory lease lifetime. |
| `dev.hotReload` | tuning | Registers the dev reload tool when HMR exists. |
| `dev.reloadDelayMs` | tuning | Delay so a tool result is delivered before reload. |
| `dev.reloadRequiredIds` | niche | Loader ids added for one linked-profile development setup. Removal note: derive the required ids from the bundle manifest in the next minor. |

## Tools

Tools are `core` when the product does not work without them and `optional` when
an operational switch (`tools.expose*`) or the dev mode can legitimately remove
them from the surface.

| Tool | Class | Note |
|---|---|---|
| `tower_adopt` | core | Reconciles a restored roster with the durable catalog. |
| `tower_batch` | optional | Evidence-batch workflow; `tools.exposeBatch`. |
| `tower_complete` | core | The only completion path for a worker. |
| `tower_diff` | core | The read-only review view. |
| `tower_doctor` | optional | Read-only health contract; `tools.exposeDoctor`. |
| `tower_finding` | core | Out-of-scope issue recording. |
| `tower_findings` | core | Finding lifecycle. |
| `tower_import_legacy` | optional | Legacy migration; `tools.exposeImport`. |
| `tower_inbox` | core | Message delivery and acknowledgement. |
| `tower_init` | core | Creates the repository state. |
| `tower_interrupt` | core | Stops a runaway worker. |
| `tower_legacy_map` | optional | Legacy audit mapping; `tools.exposeImport`. |
| `tower_merge` | core | The only merge path. |
| `tower_mission` | core | Mission progress and blockers. |
| `tower_plan` | core | Mission planning. |
| `tower_preflight` | core | The read-only merge gate. |
| `tower_rebase` | core | Keeps a mission branch current. |
| `tower_recover` | optional | Stale-lock recovery; `tools.exposeRecovery`. |
| `tower_reload` | optional | Dev-only reload; registered while the HMR/dev mode is on. |
| `tower_resource` | optional | Advisory leases; `tools.exposeLeases`. |
| `tower_review` | core | Independent review verdicts. |
| `tower_roster` | core | Roster and live activity. |
| `tower_send` | core | Durable messages to agents. |
| `tower_spawn` | core | Starts workers and reviewers. |
| `tower_status` | core | The dashboard. |
| `tower_teardown` | core | Worktree cleanup and archiving. |
| `tower_test` | optional | Explicit discovery; `tools.exposeTests`. |

## Non-goals

This is a measurement and a brake, not a cleanup epic. The numbers report the
surface; they do not decide which key is bad.

Enforced by: `scripts/surface-baseline.mjs` and `domain/surface.js`; tests in
`tests/surface.test.mjs`; gate: `npm run surface:check`.
