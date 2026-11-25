# Surface budget

The plugin measures its user-facing surface in four numbers: **config leaf keys**,
**config sections**, **registered tools**, and **visible component rows**. The
committed baseline is [`scripts/surface-baseline.json`](../../scripts/surface-baseline.json);
the brakes are `npm run surface:check` for the first three and
`npm run docs:check:components` for the component count; the decision records are
[ADR 0004](../adr/0004-surface-budget.md),
[ADR 0005](../adr/0005-component-surface.md) and
[ADR 0007](../adr/0007-bounded-activity-log-rotation.md). Two per-profile axes
sit on top of the counts: the #163 name/input-byte profiles and the #164
role × phase byte ladder ([ADR 0009](../adr/0009-role-phase-exposure.md)),
both gated by `npm run surface:check`.

Decision date: 2026-11-12

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

<!-- tower-surface-history 2026-10-23: the 2.3.0 baseline correction, when only the define() path was counted -->

The 2.3.0 baseline counted 27 tools because it recorded only the `define()` path.
`tower_mode` is registered directly by `index.js` — one of the two direct
registrations that were uncounted at 2.3.0, the other being `tower_control`,
which #163 Phase 4 folded into `tower_mode` — so the 2.3.0 shipped surface was
always 29. The 27 → 29 step is an explicit
*measurement correction* with a reason and date in
[`scripts/surface-baseline.json`](../../scripts/surface-baseline.json) (see
[ADR 0004](../adr/0004-surface-budget.md)), not surface growth; a later count
change still needs an ADR or a provably matching deletion.

The tool count is the **build** surface, not one profile's mounted subset (#121):
the recorder includes every tool this build can register, so a component row that
ships off (`tower-hmr`, whose `tower_reload` keeps the count at 23) does not
shrink the budget. `tower_inspect`'s `doctor` view reports the same 23 and names
the mounted subset through its `components` check; the mount smoke asserts the
shipped profile's 18 loaded tools and pins 23 for the all-rows-on surface.

## Per-profile surfaces (#163)

The build count is not the whole bill. The tower profile, the worker preset and
the reviewer preset each mount a different subset, and each pays that subset's
advertised input-schema bytes on every request — the `repoRoot` field repeated
on every tool is the biggest item. `scripts/surface-baseline.json` therefore
also carries a `profiles` block: `tools` (mounted tool count) and `inputBytes`
(UTF-8 bytes of the advertised `parameters` JSON) for `tower`, `worker` and
`reviewer`. `npm run surface:check` prints all three lines.

These numbers are **two-way**: both a consolidation (shrink) and a regression
(growth) change the committed value, and any change needs a dated decision
record (`date: "YYYY-MM-DD"`) in the same file. Unlike `configKeys` and
`components`, a profile decision needs no ADR or deletion evidence — the dated
phase commit that records the consolidation is the evidence. The worker and
reviewer counts come from the same allow-lists their presets install: the
lists live in `domain/exposure.js` (`PRESET_ALLOWS`) and are re-exported by
`host/tool-profiles.js` for the role predicates, so `worker.js` /
`reviewer.js`, the authorization kernel and this gate all read one table.

<!-- tower-surface-history 2026-11-12: #163 Phase 1+2 removed the repeated repoRoot field and the 21 server-side-only alias fields -->

#163 Phase 1+2 shrank the advertised schemas without changing the tool count:
removing the repeated `repoRoot` field and the 21 alias fields took the tower
profile from 17,008 to 13,287 input bytes, the worker from 8,159 to 6,465, and
the reviewer from 5,871 to 4,661. Every such contraction is a dated decision in
[`scripts/surface-baseline.json`](../../scripts/surface-baseline.json); a later
growth past the committed value fails `npm run surface:check` the same way.

<!-- tower-surface-history 2026-11-12: #163 Phase 3 folded the five read-only views into `tower_inspect` -->

#163 Phase 3 folded the five read-only views (`status`, `roster`, `diff`,
`preflight`, `doctor`) into one `tower_inspect` tool: the build surface went
29 → 25, the tower profile 23 → 19 tools (12,895 input bytes), the worker
8 → 7 tools (6,348 bytes) and the reviewer 7 → 6 tools (4,544 bytes). The
worker and reviewer allow-lists name `tower_inspect` exactly once (it serves
their status and diff views), which is why their count drops by one rather
than five. The removed tools are recorded as a dated decision on the `tools`
surface and a dated decision per profile metric.

<!-- tower-surface-history 2026-11-12: #163 Phase 4 folded the four same-resource tool pairs -->

#163 Phase 4 folded four same-resource pairs: `init`+`adopt`,
`finding`+`findings`, `mode`+`control`, and `import_legacy`+`legacy_map`. The
build surface went 25 → 21, the tower profile 19 → 16 tools (12,921 input
bytes), the worker 7 → 6 tools (6,175 bytes) and the reviewer 6 → 5 tools
(4,371 bytes). The tower profile's bytes rise by 26 rather than falling:
`tower_mode` now advertises the read plus the write fields and the takeover
audit reference, which is larger than the old read-only schema it absorbed.
The tool count still falls by three there; that is a dated decision, not an
exemption from the two-way rule.

<!-- tower-surface-history 2026-11-12: #163 Phase 5 moved the role-owned tools out of the tower profile -->

#163 Phase 5 kept the build surface at 21 but narrowed what the tower profile
mounts: `tower_complete` and `tower_review` are registered with a role
predicate and belong to the worker/survey and reviewer presets, so the tower
profile advertised 16 → 14 tools and 12,921 → 10,582 input bytes (both dated
decisions). The five subsystem rows (`tower-batch`, `tower-import`,
`tower-leases`, `tower-tests`, `tower-hmr`) ship `disabled: true`, so the
shipped profile mounted all of the 21 except those five rows at that point.
Closing a row is not a surface reduction: the tools stay in the build and
`tower_inspect`'s `doctor` view reports each one as off with its enable step. The
default tool list and the all-on list are documented in
[tools.md](tools.md#tool-sets).

<!-- tower-surface-history 2026-11-21: #201 added `tower_wait`, the one bounded blocking reach -->

#201 adds `tower_wait`, the one bounded blocking reach (#201, recorded in
[ADR 0012](../adr/0012-bounded-wait-tool.md)): the build surface moves 21 → 22
and the default profile gains that tool with it, but the mounted count is not a
tracked surface axis — no baseline ladder records it, so this page does not
restate it as a checked figure. The five default-off rows do not move, and the
tower profile advertises 15 tools / 15,379 B. The tool is
tower-only, so the worker (6 tools) and reviewer
(5 tools) tool counts do not move; their input schemas grew by the 211 bytes
#207 added to `tower_inspect`'s `agent`/`tail` descriptions. R185 then made the
`compact` key set explicit in the same schema, adding 116 bytes to every profile
that mounts `tower_inspect`: tower 15,379 B (was 15,263), worker 8,631 (was
8,515), reviewer 5,725 (was 5,609), `host:active` 20,229 (was 20,113), and the
four presets 10,609 / 7,342 / 9,424 / 9,424. The wait is pure
polling: it never holds the state lock, never writes state or activity, and
returns `reached`, `timeout` or `unknown` within a 1000–600000 ms bound
(default 30000). Per-agent progress (#207) rides the existing `tower_inspect`
`status`/`roster` views; no second read tool appears.

<!-- tower-surface-history 2026-11-22: M165 (#215/#216) added the bulk `tower_mission` form -->

M165 (#215/#216) added the bulk `tower_mission` form (a closed `missions[]`
array, the `ids` lifecycle shorthand and `atomic`): every profile that mounts
`tower_mission` grows by 2,887 input-schema bytes — tower 15 tools / 18,266 B,
worker 6 / 11,661 — and by 2,865 advertised bytes, so at that commit
`host:active` read 23,094 B, `preset:worker` 13,617 and
`preset:survey`/`preset:survey-sandbox` 12,432 each. Mode-off, idle and
`preset:reviewer` do not mount `tower_mission` and are unchanged; no tool count
moves. The two figures it moved (`tower` and `host:active`) are re-measured
again by #217/#218 and then by #219 below, which is why the ladder further down
reads 25,191 B.

<!-- tower-surface-history 2026-11-22: #217/#218 added the plan preview and worktree links; #219 re-measured both rungs afterwards -->

#217/#218 added `tower_plan`'s `dry_run` and plan-local `key` fields and
`spawn.nodeModules`: the two profiles that mount `tower_plan` and `tower_spawn`
grow by 605 advertised bytes each, so `tower` becomes 15 tools / 18,871 B input
schema and `host:active` 15 tools / 23,699 B, while `preset:worker` (13,617),
`preset:reviewer` (7,342) and the two survey presets (12,432 each) do not mount
either tool and stay put. The config surface grows by exactly one tuning key,
`spawn.nodeModules` (`none` default / `link`), 58 → 59 keys in the same 16
sections; no tool, section or component moves.

<!-- tower-surface-history 2026-11-22: #202 gave the reviewer `tower_verify`; the tower rung it quotes moved again with #217/#218 and #219 -->

#202 adds `tower_verify`, the reviewer's one verifiable read surface: a closed
whitelist of `{kind:"tests", files:["tests/*.test.mjs"]}`, `{kind:"tsc"}` and
`{kind:"shards", batch:N}` run in the mission worktree (never a shell, never a
caller-supplied command) with a recorded run per check. The build surface moves
22 → 23 and the reviewer allow-list gains the tool, so the reviewer profile
becomes 6 tools / 7,260 input bytes (was 5 / 5,725; `VerifyInput` is 1,535
bytes) and `preset:reviewer` 9,202 B (was 7,342). The tool is role-owned
(`tower_verify` is in `ROLE_TOOLS`), so the tower profile stays 15 tools /
18,871 B, the host ladder and every other preset are unchanged, and the shipped
profile now mounts 18 — a live measurement, not a ladder rung, because the
default-mounted count is not a tracked surface axis.

<!-- tower-surface-history 2026-11-22: #219's measured delta and the rungs it replaced; the ladder below states those same profiles live -->

#219 adds the single-form `widen` object to `tower_mission`
(`mode:"refuse"|"defer-conflicts"`, `restoreDeferrals`, `keepStatus`): it is
one nested object plus the repeated copy inside `properties.missions.items`, so
`MissionInput` grows by 1,492 bytes wherever `tower_mission` is mounted — the
`tower` profile becomes 15 tools / 20,363 B input schema (was 18,871) and the
`worker` preset 6 / 13,153 (was 11,661) — and every profile that mounts the
tool pays the same 1,492 advertised bytes: `host:active` reads 15 tools /
25,191 B (was 23,699), `preset:worker` 15,109 (was 13,617), and
`preset:survey`/`preset:survey-sandbox` 13,924 each (was 12,432). Mode-off,
idle and `preset:reviewer` do not mount `tower_mission` and are unchanged; no
tool count moves. The growth buys the one call that replaces the manual
bulk-defer choreography: without it every widen had to defer each planned
overlapping neighbour by hand, widen, then restore them one at a time, and a
completed receiver had to be pushed back to active before its reviewer could
spawn.

## Role × phase exposure (#164)

`tower_mode` is the only tool a host session advertises with Tower mode off.
The role × phase gate (`domain/exposure.js`, `host/exposure.js`) registers
every tool with a step-time `when` condition and subtracts the orchestration
schemas until the session enters a rung; the admitted set is frozen for the
step, so a hidden tool resolves exactly like a missing one. The ladder is:

- `off` — Tower mode off: `tower_mode` only, **846 B / 1 tool**.
- `idle` — mode on, no state for the repository: adds `tower_init`,
  **2,185 B / 2 tools**.
- `active` — mode on, state exists: the default host-admitted set, **25,731 B /
  15 tools** (the 18 default registered tools minus the #163 role-owned
  `tower_complete`/`tower_review` and the #202 `tower_verify`, which a non-role
  session never sees).

The host ladder therefore measures the surface a session actually admits, not
the all-on build surface: with every optional capability row on the build is
**35,167 B / 23 tools**, and that figure is a build-surface statement, never a
session baseline.

Entering Tower mode and creating state are the only two transitions, so a
mode-off session stops paying for 14 of the 15 host-admitted schemas and a
mode-on session pays a prefix that stays stable for its lifetime (the
arithmetic is in [ADR 0009](../adr/0009-role-phase-exposure.md)).

Spawned role presets are not gated by the ladder: their `restrict` allow-list
is the contract, and a role is admitted by both conditions when it also owns a
role-gated tool. Measured over the tower tools each preset advertises:
`preset:worker` **15,649 B / 6 tools**, `preset:reviewer` **9,543 B / 6**,
`preset:survey` and `preset:survey-sandbox` **14,464 B / 5** each (the
non-Tower names in their allow-lists are not part of this budget). The source
of truth for all four lists is `domain/exposure.js` (`PRESET_ALLOWS`), which
`host/tool-profiles.js` re-exports for the role predicates and the preset
modules import directly — one table, not a copy per consumer.

#221 adds the review note channel without adding a tool: `tower_review` gains
an optional `notes` array (at most 10 short strings, and a note never carries a
verdict or gates a merge) and `tower_mission` an optional `fold_notes` boolean
(tower only, single form). `ReviewInput` grows by 341 advertised bytes and
`MissionInput` by 540, so every profile that mounts them is re-measured in the
ladder above: `tower` 15 tools / 20,903 B, `worker` 6 / 13,693 B, `reviewer` 6 /
7,601 B, `host:active` 25,731 B, `preset:worker` 15,649 B, `preset:reviewer`
9,543 B, `preset:survey` and `preset:survey-sandbox` 14,464 B each, and the
all-on build surface 35,167 B. No tool count, config key, section or component
moves, and the reviewer preset is the one rung that pays for the review schema
without mounting `tower_mission`, so it takes the 341-byte increment alone.

`scripts/surface-baseline.json` carries these as a top-level `profileBytes`
block, measured as the UTF-8 bytes of the advertised `name`, `description` and
`parameters` fields in fixed key order, over the surface each profile actually
sees: the host ladder over the default host-admitted session surface (the 18
default registered tools minus the #163/#202 role tools), the presets over
their allow-lists intersected with the mounted surface, all from the same
shipped-surface load `surface:check` already uses, and printed as the
`surface: profile bytes:` line. The all-on build surface is not a profile and
is not measured here. Any drift needs a dated decision in the same block;
growth additionally needs one that names an existing ADR under `docs/adr/`
(`profile-bytes-growth`). `tests/exposure.test.mjs` also enforces that every
registered tool has a phase row ("no implicit all"), that every legal mission
transition's driving tool is exposed to the profile that owns it, and that the
host ladder stays on the default host-admitted surface (15 tools / 25,731 B)
rather than the 23-tool build surface (review R103).

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
(`spawn.requireLease`, `tests.admission`, and now `review.mode`), and refuse a row
config outside its component's `allowedOverrides`.

#M39 grew the config surface by exactly one, 53 → 54: `review.mode`
(`off`/`optional`/`required`) is the review policy, and the deprecated
`review.requireReview` boolean stayed accepted for one release as a normalized
alias. It is not a fifth component row: `preset-tower-reviewer` remains a
capability row and `review.mode:off` simply leaves it unused (no `tower_review`,
no reviewer spawn, no review blockers). The dated decision records both the new
key and why the old boolean was not removed in the same release.

#M42 reclassifies the deprecated alias from `forbidden-to-disable` to `core` in
the component surface: it is policy configuration and a compatibility alias, not
a capability a row may switch. The policy is one tri-state control on the
plugin-page form, not a row and not one row per mode; the review gate in
`required` mode, its tip-bound evidence and the exemption path remain
non-disableable. The component and config-key counts do not move (11 visible
components, 54 keys).

#148/#149 grow the surface by exactly one key and one visible component,
recorded in [ADR 0006](../adr/0006-mission-shapes.md): config keys 54 → 55,
sections stay 14, components 11 → 12. A first cut of the shape work added three
keys and a `survey` section, then contracted 57 → 55 before release in a second
dated decision: a survey's preset is shape-owned
(`SHAPES.survey.spawn.defaultPreset`), so a `spawn.surveyPreset` key could only
disagree with the registry, and `survey.sandbox` advertised a placement W1 does
not implement. What remains is `spawn.surveyModel`, the optional model route for
survey workers (the survey row owns the capability, not the key name). The
`tower-survey` row is the switch: off means surveys cannot be planned and no
survey agent is dispatched; build missions are unaffected. No existing key
changed class.

#148 W2 implements the detached survey sandbox, so it restores exactly the
placement key that W1 correctly withheld: `survey.sandbox` (`none`|`detached`,
default `none`) returns as tuning, and `gates.requireFreshSurvey` (default
`false`) joins it as merge-gate strictness; config keys 55 → 57 and sections
14 → 15. It
is not a capability: the `tower-survey` row stays the single switch and the
sandbox preset is an internal child of it, so the visible component count does
not move (12). `spawn.surveyPreset` stays removed: the shape resolves the preset
from `survey.sandbox`, so the key could still only disagree with the registry.

#149 W4 contracts the config surface by one: config keys 57 → 56. `tests.autoChecks`
only chose whether a discovery projection was copied into the completion report,
and that copy was the second evidence shape the W4 audit removed. The receipt in
`mission.testRuns` is the one evidence record now, so the switch had no meaning
left; it is deleted rather than kept as a dead tuning key. Sections and the
visible component count do not move.

#M66 retires the alias itself: config keys 56 → 55. `review.requireReview` was
accepted for one release (#M39) and is now removed, so a config that still
writes it fails with `config-unknown-key` and a dated upgrade note naming
`review.mode` and the `true → required` / `false → optional` mapping. The
surviving key keeps the same three modes; the review gate, the reviewer preset
row and the exemption path are unchanged. The component surface drops the alias
row with it (55 classified config keys), while the visible component count
stays 12.

#M76 (W5-B) bounds the append-only activity log and grows the surface by exactly
two tuning keys and one section, recorded in
[ADR 0007](../adr/0007-bounded-activity-log-rotation.md): config keys 55 → 57,
sections 15 → 16, while the visible component count stays 12. The two keys,
`activity.maxBytes` (default 4 MiB, `0` disables) and `activity.retention`
(default 5 segments), are adapter policy: rotation is always on by default, the
live file is renamed to a numbered segment rather than truncated, and the
activity-tail reads behind `tower_inspect`'s `status` view (dashboard and mission detail)
follow the segments; `tower_complete` and `tower_inspect`'s `roster` view do not read the
activity log, while `tower_inspect`'s `doctor` view inspects every segment read-only for its
size accounting. No
capability row or tool appears or disappears, so neither the component nor the
tool count moves.

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
| `mode.ralphPolicy` | core | Entering Tower mode with a live Ralph loop stops it (recording the release) or refuses the entry. |
| `mode.workspaceStaleMs` | tuning | Stale window for the advisory workspace lock. |
| `mode.heartbeatMs` | tuning | Heartbeat interval while the mode is on. |
| `mode.denyTools` | core | The denied-tool list is part of the mode guard. |
| `mode.storePath` | niche | Custom mode-store location added for one deployment workflow. Removal note: derive the path from `$DSH_HOME` in the next minor; no in-tree caller sets this key. |
| `mode.maxEntries` | tuning | Bounds the persisted mode store. |
| `mode.lockTimeoutMs` | tuning | Bounded wait for the cross-process state and mode locks. |
| `review.mode` | core | The review policy itself (`off`/`optional`/`required`); the only review policy key since 2.8.0. |
| `review.maxRoundsPerReviewer` | core | Caps review rounds; changes the review lifecycle. |
| `merge.timeoutMs` | tuning | Default merge timeout; a per-call value wins. |
| `merge.maxBufferBytes` | tuning | Captured merge output buffer. |
| `git.timeoutMs` | tuning | Default Git command timeout outside merge. |
| `worktrees.root` | tuning | Default worktree placement. |
| `spawn.workerPreset` | core | Chooses the tool surface a worker receives. |
| `spawn.surveyModel` | tuning | Optional model route for survey agents. |
| `survey.sandbox` | tuning | Placement only: shared read-only checkout (default) or a disposable detached sandbox. The tower-survey row is still the switch. |
| `spawn.reviewerPreset` | core | Chooses the read-only reviewer surface. |
| `spawn.maxDepth` | tuning | Subagent depth requested at spawn. |
| `spawn.provider` | tuning | Provider route for spawned agents. |
| `spawn.workerModel` | tuning | Optional model route for workers. |
| `spawn.reviewerModel` | tuning | Optional independent model route for reviewers. |
| `spawn.maxLiveWorkers` | core | Resource-safety cap on live workers. |
| `spawn.staleMs` | tuning | Roster staleness window before merge is blocked. |
| `spawn.maxWaitMs` | tuning | Upper bound for a blocking spawn wait. |
| `spawn.requireLease` | niche | Advisory-lease gate added for one multi-agent workflow. Removal note: fold into `tower_resource` policy in the next minor unless a second workflow uses it. |
| `spawn.nodeModules` | tuning | Dependency visibility for a spawned worktree: `none` (default) leaves it without `node_modules`; `link` creates `<worktree>/node_modules` as a junction to the baseline checkout's installed dependencies and records it so teardown only ever unlinks that link. Placement tuning, not a capability row; a missing target refuses the spawn. |
| `send.maxPerMinute` | tuning | Process-local advisory message rate limit; zero disables it. |
| `send.interruptDefault` | tuning | Default for the interrupt-before-deliver flag. |
| `tests.admission` | core | Chooses when repository code is executed. |
| `tests.timeoutMs` | tuning | Per-command discovery timeout. |
| `tests.maxBytes` | tuning | Captured discovery output cap. |
| `tests.allowPackageDiscovery` | core | Allows repository code to execute; a security contract. |
| `gates.requireChecks` | core | Requires completion evidence before merge. |
| `gates.requireTests` | core | Requires a test receipt before merge. |
| `gates.allowReviewExemption` | core | Allows a review exemption and its reason. |
| `gates.requireFreshSurvey` | core | Promotes the survey-stale dependency warning to a merge blocker; `false` keeps it advisory. |
| `gates.maxReportBytes` | tuning | Report size cap; the refusal itself is not configurable. |
| `docs.boardLocation` | tuning | Chooses where the board is written; whether it is written is the tower-board row. |
| `archive.afterDays` | tuning | Archive age threshold; archival itself is the tower-archive row. |
| `archive.maxMissions` | tuning | Hot terminal-mission cap. |
| `activity.maxBytes` | tuning | Rotates `activity.jsonl` at this size; `0` disables rotation. Enforced by the store adapter, not a capability switch. |
| `activity.retention` | tuning | Number of rotated activity segments kept; the newest history survives. |
| `leases.ttlMs` | tuning | Default advisory lease lifetime. |
| `dev.reloadDelayMs` | tuning | Delay so a tool result is delivered before reload. |
| `dev.reloadRequiredIds` | niche | Loader ids added for one linked-profile development setup. Removal note: derive the required ids from the bundle manifest in the next minor. |

## Tools

Tools are `core` when the product does not work without them and `optional` when
a component row (`tower-batch`, `tower-import`, `tower-leases`, `tower-tests`,
`tower-hmr`), `mode.allowAgentControl`, or the dev mode can legitimately remove
them from the surface. `tower_inspect`'s `doctor` view and `tower_recover` are core: #122 made
them mandatory for every configuration.

| Tool | Class | Note |
|---|---|---|
| `tower_batch` | optional | Evidence-batch workflow; component `tower-batch`. |
| `tower_complete` | core | The only completion path for a worker. |
| `tower_inspect` | core | The five read-only views (status, roster, diff, preflight, doctor) behind one tool (#163). |
| `tower_finding` | core | Finding lifecycle: report, list/read and update (#163 Phase 4). |
| `tower_import` | optional | Legacy migration and audit mapping; component `tower-import` (#163 Phase 4). |
| `tower_inbox` | core | Message delivery and acknowledgement. |
| `tower_init` | core | Creates the repository state or adopts the roster (`op`) (#163 Phase 4). |
| `tower_interrupt` | core | Stops a runaway worker. |
| `tower_merge` | core | The only merge path. |
| `tower_mission` | core | Mission progress and blockers. |
| `tower_mode` | core | Reads the session stance; writes enter/leave/takeover with `active`; `mode.allowAgentControl:false` refuses writes (ADR 0003). |
| `tower_plan` | core | Mission planning. |
| `tower_rebase` | core | Keeps a mission branch current. |
| `tower_recover` | core | Stale-lock recovery; registered for every configuration (#122). |
| `tower_reload` | optional | Dev-only reload; component `tower-hmr` (shipped off). |
| `tower_resource` | optional | Advisory leases; component `tower-leases`. |
| `tower_review` | core | Independent review verdicts. |
| `tower_send` | core | Durable messages to agents. |
| `tower_spawn` | core | Starts workers and reviewers; the takeover case is `op:"takeover"` and the wait bound is `spawn.maxWaitMs` (#163 Phase 5). |
| `tower_teardown` | core | Worktree cleanup and archiving. |
| `tower_test` | optional | Explicit discovery; component `tower-tests`. |
| `tower_verify` | core | Reviewer-only read execution: the fixed whitelist (node --test on tests/*.test.mjs, tsc --noEmit, one shard batch) in the mission worktree, with each result recorded in `testRuns` (#202). Role-owned, so never on the tower ladder. |
| `tower_wait` | core | One bounded blocking wait over a mission or roster agent: reached/timeout/unknown, 1000–600000 ms (default 30000), tower-only (#201). |

## Non-goals

This is a measurement and a brake, not a cleanup epic. The numbers report the
surface; they do not decide which key is bad.

Enforced by: `scripts/surface-baseline.mjs` and `domain/surface.js`; tests in
`tests/surface.test.mjs`; gate: `npm run surface:check`.

The prose in this page is checked too: `npm run docs:check` (through
`scripts/check-docs.mjs`) rescans every current-facing markdown page — the
`docs/**` tree except `docs/adr/`, the markdown `package.json` ships (the
READMEs, CONTRIBUTING, COMPATIBILITY, GLOSSARY, PRINCIPLES, SECURITY, the
`skills/*.md` briefings, `ui-bundle/README.md`) and `tests/README.md` — for the
tool totals and input-schema byte counts those pages write, and fails on a figure
it cannot account for against
[`scripts/surface-baseline.json`](../../scripts/surface-baseline.json) plus the
live default-profile and all-rows-on counts.

The scanned spelling is exact, because a prose gate is only honest about the forms
it actually reads. A byte count is read as the number, an optional thousands
separator, then `B`, `input bytes` or `bytes` (`35,167 B`, `20,903 input bytes`,
`7,601 bytes`). A tool total is read as `N tools`, `N mounted tools`, `N 个工具`
or `N-tool`, and as the verb-first `mounts N` / `mounted N` / `mounting N`,
`registers N` / `registered N` / `registering N` and `advertises N` /
`advertised N` / `advertising N`; those verbs are read as a
tool count in every inflection they take, because in these pages they never mean
anything else — a page that means something else by them fails and is reworded,
which is the safe direction. Numbers that only look like a figure are not figures
and stay unscanned: `45 tool error codes`, `45 个工具错误码`, `21 个工具形别名`,
`28/28`, and a bare Chinese `N 个` with no 工具 after it (`21 个之中`).

Two forms are deliberately outside the gate. `docs/adr/**` records what a
decision measured at the time and is never re-measured, so the ADRs' own
tool-count and byte figures — including their verb-first spelling — are not
scanned. And a figure wrapped across a line break is invisible, because the lexer
reads one line at a time: write a claim's figure on one line. A historical
measurement stays readable only behind a dated
`<!-- tower-surface-history YYYY-MM-DD: reason -->` marker whose figures are
recorded in the baseline; a fenced sample of tool output needs
`<!-- tower-surface-sample: reason -->`.

One count is measured live but never charted: **how many tools the default
profile mounts**. `scripts/surface-baseline.json` ladders per-profile and build
totals, not that number. A live mounted count is therefore checked against the
live measurement, while a historical one can only be accepted because the same
number appears somewhere on a recorded ladder — a coincidence, not a check of
the mounted count. The page therefore writes no historical mounted count as a
figure. Where the count matters, the derivation is written instead (`mounted all
of the 21 except those five rows`), and the one live figure (`mounts 18`) is
checked like any other.
