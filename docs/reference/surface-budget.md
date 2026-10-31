# Surface budget

The plugin measures its user-facing surface in four numbers: **config leaf keys**,
**config sections**, **registered tools**, and **visible component rows**. The
committed baseline is [`scripts/surface-baseline.json`](../../scripts/surface-baseline.json);
the brakes are `npm run surface:check` for the first three and
`npm run docs:check:components` for the component count; the decision records are
[ADR 0004](../adr/0004-surface-budget.md) and
[ADR 0005](../adr/0005-component-surface.md).

Decision date: 2026-10-23

Every key and tool is classified here so "why is this here" has an answer that a
check can read. `core` is a behavioural or safety contract, `tuning` is a safe
default a user may want to change, and `niche` was added for one workflow and
must carry a removal note for the next minor. A live key or tool missing from
these tables fails `npm run surface:check`.

A second axis asks who may turn a key off. It is generated from
[`scripts/component-surface.json`](../../scripts/component-surface.json) into
[component-surface.md](component-surface.md): every key is `core`,
`optional-component`, `optional-config` or `forbidden-to-disable`. A boolean (or a
recorded non-boolean behaviour knob) cannot stay `optional-config` without a dated
tuning-only exemption. Both the component count and the config-key count are
baselined two-way: an increase or a contraction needs a dated decision
(`npm run docs:check:components`, [ADR 0005](../adr/0005-component-surface.md)).
Every decision on those two surfaces must carry a real `date` (`YYYY-MM-DD`); a
from/to record without one fails the brake even when it reaches the committed
count.
The same source of truth records
the `gateableTools` allowlist; it is empty since #122, so a future
`tools.expose*` route to any tool is refused before it can remove a review,
merge or host tool.

The 2.3.0 baseline counted 27 tools because it recorded only the `define()` path.
`tower_mode` and `tower_control` are registered directly by `index.js`, so the
shipped surface was always 29. The 27 → 29 step is an explicit
*measurement correction* with a reason and date in
[`scripts/surface-baseline.json`](../../scripts/surface-baseline.json) (see
[ADR 0004](../adr/0004-surface-budget.md)), not surface growth; a later count
change still needs an ADR or a provably matching deletion.

The tool count is the **build** surface, not one profile's mounted subset (#121):
the recorder includes every tool this build can register, so a component row that
ships off (`tower-hmr`, whose `tower_reload` keeps the count at 29) does not
shrink the budget. `tower_doctor` reports the same 29 and names the mounted
subset through its `components` check; the mount smoke asserts the shipped
profile's 28 loaded tools and pins 29 for the all-rows-on surface.

#121 also shrank the config surface: the seven capability `tools.expose*` keys
and `dev.hotReload` became component rows, so config keys went 64 → 56 and
sections 15 → 14. Sections keep the ADR 0004 cheap-shrink rule. #136 shrank the
config keys once more, 56 → 55: `tests.enabled` was a second switch over the
`tower-tests` component row, so the row is now the only switch and the key is
gone (a config that still writes it fails with `config-unknown-key`). #133 and
#135 shrank it again, 55 → 53: `docs.board` and `archive.enabled` were the same
kind of second switch over the new `tower-board` and `tower-archive` rows, so
each row is now the only switch and both keys are gone (a config that still sets
either fails with `config-unknown-key`, and the upgrade note names the replacing
row).

Since #138 that 64 → 53 history is one dated decision in
[`scripts/surface-baseline.json`](../../scripts/surface-baseline.json), and the
config-key count is two-way: a later increase **or** decrease needs its own
decision naming an ADR, unlike sections and tools. The same wave makes the gate
import `OPERATIONAL_TOOLS` instead of scraping it, discover every shipped
`cordis.patch.yml` in both directions, review the non-boolean behaviour knobs
(`spawn.requireLease`, `tests.admission`), and refuse a row config outside its
component's `allowedOverrides`.

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
| `tests.admission` | core | Chooses when repository code is executed. |
| `tests.timeoutMs` | tuning | Per-command discovery timeout. |
| `tests.maxBytes` | tuning | Captured discovery output cap. |
| `tests.autoChecks` | tuning | Attaches a tests check to completion. |
| `tests.allowPackageDiscovery` | core | Allows repository code to execute; a security contract. |
| `gates.requireChecks` | core | Requires completion evidence before merge. |
| `gates.requireTests` | core | Requires a test receipt before merge. |
| `gates.allowReviewExemption` | core | Allows a review exemption and its reason. |
| `gates.maxReportBytes` | tuning | Report size cap; the refusal itself is not configurable. |
| `docs.boardLocation` | tuning | Chooses where the board is written; whether it is written is the tower-board row. |
| `archive.afterDays` | tuning | Archive age threshold; archival itself is the tower-archive row. |
| `archive.maxMissions` | tuning | Hot terminal-mission cap. |
| `leases.ttlMs` | tuning | Default advisory lease lifetime. |
| `dev.reloadDelayMs` | tuning | Delay so a tool result is delivered before reload. |
| `dev.reloadRequiredIds` | niche | Loader ids added for one linked-profile development setup. Removal note: derive the required ids from the bundle manifest in the next minor. |

## Tools

Tools are `core` when the product does not work without them and `optional` when
a component row (`tower-batch`, `tower-import`, `tower-leases`, `tower-tests`,
`tower-hmr`), `mode.allowAgentControl`, or the dev mode can legitimately remove
them from the surface. `tower_doctor` and `tower_recover` are core: #122 made
them mandatory for every configuration.

| Tool | Class | Note |
|---|---|---|
| `tower_adopt` | core | Reconciles a restored roster with the durable catalog. |
| `tower_batch` | optional | Evidence-batch workflow; component `tower-batch`. |
| `tower_complete` | core | The only completion path for a worker. |
| `tower_control` | optional | Model-initiated mode change; `mode.allowAgentControl:false` removes it (ADR 0003). |
| `tower_diff` | core | The read-only review view. |
| `tower_doctor` | core | Read-only health contract; registered for every configuration (#122). |
| `tower_finding` | core | Out-of-scope issue recording. |
| `tower_findings` | core | Finding lifecycle. |
| `tower_import_legacy` | optional | Legacy migration; component `tower-import`. |
| `tower_inbox` | core | Message delivery and acknowledgement. |
| `tower_init` | core | Creates the repository state. |
| `tower_interrupt` | core | Stops a runaway worker. |
| `tower_legacy_map` | optional | Legacy audit mapping; component `tower-import`. |
| `tower_merge` | core | The only merge path. |
| `tower_mission` | core | Mission progress and blockers. |
| `tower_mode` | core | Reports the session stance, workspace lock, HMR and plugin version; always registered. |
| `tower_plan` | core | Mission planning. |
| `tower_preflight` | core | The read-only merge gate. |
| `tower_rebase` | core | Keeps a mission branch current. |
| `tower_recover` | core | Stale-lock recovery; registered for every configuration (#122). |
| `tower_reload` | optional | Dev-only reload; component `tower-hmr` (shipped off). |
| `tower_resource` | optional | Advisory leases; component `tower-leases`. |
| `tower_review` | core | Independent review verdicts. |
| `tower_roster` | core | Roster and live activity. |
| `tower_send` | core | Durable messages to agents. |
| `tower_spawn` | core | Starts workers and reviewers. |
| `tower_status` | core | The dashboard. |
| `tower_teardown` | core | Worktree cleanup and archiving. |
| `tower_test` | optional | Explicit discovery; component `tower-tests`. |

## Non-goals

This is a measurement and a brake, not a cleanup epic. The numbers report the
surface; they do not decide which key is bad.

Enforced by: `scripts/surface-baseline.mjs` and `domain/surface.js`; tests in
`tests/surface.test.mjs`; gate: `npm run surface:check`.
