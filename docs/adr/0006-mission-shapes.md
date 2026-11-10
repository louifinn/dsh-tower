# ADR 0006: Mission shapes

- Status: accepted
- Date: 2026-11-10
- Ref: #148, #149

## Context

`kind` was a column on one mission record, but it carried three contracts: a build
owns a branch and a worktree, is reviewed at its tip, and merges; a survey only
reads one commit. The state document could describe both shapes at once, so the
generic layers kept asking `kind === 'survey'` and the answer leaked into
completion (`commit >= 1`), the merge gate (`read-only-survey`), archive and
reanchor terminality, planning's open-work count, and provisioning. A survey
that completed could not be archived, blocked reanchor forever, counted as open
work, and paid for a full checkout while consuming the live-worker budget.

## Decision

`domain/shapes/` is the one registry. Each shape module owns its statuses,
transitions, terminality, merge/rebase permission, provisioning, plan fields,
completion invariants, dependency satisfaction, briefing and summary projection.
`domain/shapes/index.js` is the only way a generic layer resolves a shape:
`shapeFor(mission.kind)`, `isTerminal(kind, status)`, `canTransition(kind, from,
to)`, and `assertActionSupported(mission, action)` for merge/rebase/preflight/diff.
The global `TERMINAL_STATUSES`/`TRANSITIONS` vocabulary and the one-argument
`isTerminal`/`canTransition` entry points are deleted.

Schema version 4 is a TypeBox union: a build mission keeps its worktree/branch and
merge fields; a survey carries `readCommit` and `readDirty` and may not carry
`worktree`, `branch`, `baseCommit`, `mergedCommit` or `mergedAt`. `merged` is not
a survey status. Migration v3→v4 is pure, one-way and idempotent: it stamps every
mission with a shape, reads a legacy survey's commit from
`worktree.baseCommit ?? baseCommit`, drops its branch fields, and maps a legacy
`merged` survey to `completed`.

Read-only is structural, not a gate: `tower_plan({kind:'survey'})` refuses while
the `tower-survey` component row is off; a survey spawn uses the shared checkout
and the `tower-survey` preset allow-list; `tower_complete` checks that HEAD still
equals `readCommit`, that the tracked-status set matches the set captured at plan
time, and that zero commits were made.

`scripts/shape-audit.mjs` enforces the decision: no kind or role literal
comparison outside `domain/shapes/` and `domain/roles.js`, no global status
vocabulary, no one-argument entry points. Waivers are justified data in
`scripts/architecture-waivers.json` under `shapeWaivers`; an unjustified or stale
waiver fails. `docs/reference/shapes.md` is generated from the registry.

## Surface budget

The shape redesign grows the config surface by exactly one key, recorded in
`scripts/surface-baseline.json`:

- `spawn.surveyModel` (tuning): an optional independent model route, mirroring
  `spawn.workerModel`/`spawn.reviewerModel`.

An earlier cut of this work also added `spawn.surveyPreset` (core) and
`survey.sandbox` (tuning) in a new `survey` section. Review contracted the
surface back before release (config 57 → 55, sections 15 → 14): a shape owns its
preset (`SHAPES.survey.spawn.defaultPreset`), so a `spawn.surveyPreset` key could
only disagree with the registry; and `survey.sandbox` advertised a detached
read-only checkout that W1 does not implement. Neither is a tuning knob a user
should see; the completion invariants (HEAD, tracked-status fingerprint, zero
commits) are the read-only guarantee, not a placement option.

The `tower-survey` row is a visible optional component (components 11 → 12): off
means surveys cannot be planned (an actionable code) and no survey agent can be
dispatched; build missions are unaffected. It is a declarative preset row: the
host resolves its availability through the async `agentPresets` probe, not the
process-local code registry.

## Rejected alternatives

- Keep `kind` on one record and guard each leak with another `kind === 'survey'`
  check. Rejected: that is exactly the census in #149; the state document would
  still be able to describe both shapes and every new layer would re-learn the
  rule.
- Add a `shape: 'build'|'survey'` flag selecting an old and a new code path during
  a transition period. Rejected: a dual-shape path lets a document carry an
  impossible combination (a survey with a worktree, a merged survey) and makes the
  migration untestable.
- Keep `commit >= 1` and make a survey commit an empty commit. Rejected: a survey
  is a read, so the empty commit records nothing and hides that HEAD moved.
- Enforce read-only at merge time (`read-only-survey` in the gate). Rejected: the
  write already happened by then; read-only must be structural (preset allow-list)
  and checked as a completion invariant.
- Give a survey its own branch so the existing lifecycle "just works". Rejected:
  it reintroduces provisioning cost, branch ownership, stale-base and merge
  vocabulary for a kind that never merges.

## Consequences

- `kind` is now a closed vocabulary with one registry; adding a kind means adding
  a shape module and regenerating `docs/reference/shapes.md`, not editing generic
  layers.
- Older v3 documents migrate on load; a legacy survey's `worktree` is removed by
  a bounded-retry teardown and its completion with commits is accepted as history.
- A completed survey is terminal, archivable, no longer open work, and no longer
  blocks reanchor or the live-worker budget.
- Surveys can be planned only while the `tower-survey` row is on, and they cannot
  be merged, rebased, preflighted or diffed: each refuses with `invalid-transition`
  and an actionable next step.
- The shape audit is part of `npm run check`; a new kind or role comparison in a
  generic layer fails CI unless a justified waiver is recorded.

## Addendum: W2 detached sandbox and dependency semantics (#148)

W1 implemented the shared-checkout survey only. W2 adds the placement it left
out, without changing the default or the shared path:

- `survey.sandbox` (`none`|`detached`, default `none`) is tuning, recorded in
  `scripts/surface-baseline.json` (config keys 55 → 56, sections 14 → 15). The
  shape resolves the placement (`resolveProvisioning`) and the preset
  (`resolvePreset`); no generic layer reads the key or compares a kind.
  `spawn.surveyPreset` stays removed because the preset follows the registry and
  the resolved placement.
- `detached` provisions `git worktree add --detach <worktreeRoot>/<id>-sandbox
  <readCommit>` with no branch and records `mission.sandbox`. It never records
  `baseCommit`, never participates in stale-base, review or merge, and the
  completion invariant is sandbox HEAD === `readCommit` plus zero commits.
  Expected write/shell side effects in the disposable checkout are ignored;
  the shared placement keeps the tracked-status fingerprint invariant.
- The sandbox preset (`tower-survey-sandbox`) allows read/write/edit/pwsh plus
  the mission tools and still denies spawn/merge/rebase/review/diff. Both survey
  presets are internal children of the one visible `tower-survey` group row, so
  the component count does not move (12) and turning the capability off removes
  both.
- Cleanup is advisory: completion, abandon and `tower_teardown` remove the
  sandbox with a bounded retry. A failure keeps `mission.sandbox`, records
  `sandboxCleanupError` and names the `git worktree remove --force <path>`
  remedy in the activity log; the transition itself is not rolled back. Archival
  defers a mission whose sandbox is still present instead of moving the only
  record of the path out of hot state.
- `gates.requireFreshSurvey` (default `false`) controls dependency freshness. A
  build depending on a survey whose `readCommit` is not ancestor-or-equal of the
  build base gets a `survey-stale` warning in plan/preflight with
  `{code,missionId,depId,readCommit,baseCommit,message}`; only when the gate is
  `true` does the same code block the merge. The ancestor check is the existing
  `isAncestor` (`git merge-base --is-ancestor`, which is true for equal commits).
- A build briefing carries each survey dependency's recorded `result`
  (`paths`/`symbols`/`plan`/`notes`) with bounded formatting, so the dependent
  worker sees the evidence rather than only the terminal status. `result`
  remains survey-only at completion.
- Placement is decided at provisioning time, not at completion time: a recorded
  `mission.sandbox` wins over current `survey.sandbox` config for provisioning,
  preset and completion invariants. Flipping the key after a sandbox was created
  therefore cannot skip the sandbox HEAD/zero-commit checks or strand the
  disposable checkout, and a survey that never got a sandbox keeps the shared
  invariants.
- The archive index keeps a survey's `readCommit` and bounded `result`, so an
  archived survey dependency still carries its evidence into a build briefing
  and `gates.requireFreshSurvey` cannot fail open after archiving (#73).

## Addendum: W3 review, batch, leases and paused-vs-blocked (#149)

W3 audited four state dimensions that are not mission kinds. None became a
shape: each has one owning module, and each verdict names a fitness rule that
`npm run shape:audit` enforces (generated into `docs/reference/shapes.md`).

- **Review — commit-stamped evidence (`app/review.js`, `app/reviewCheckout.js`,
  `domain/missions/review.js`).** A verdict is evidence about a commit, not about
  a mutable worktree. `tower_spawn` provisions a disposable detached checkout of
  the mission branch tip for the reviewer and records `reviewCommit` /
  `reviewCheckout` on the roster row. `tower_review` stamps `reviewedCommit` with
  that recorded commit, refuses if the checkout HEAD moved, and the merge gate
  compares the stamp to the current branch tip with the existing `tip-moved`
  blocker. `tower_diff` shows a reviewer the same recorded commit. The old
  after-the-fact "reviewer modified the branch" check (`assertReviewerSpawnTip`)
  is deleted: a stale worker write can no longer affect what a review decided.
  The checkout is removed when the verdict is recorded and retried by
  `tower_teardown`. A tower break-glass verdict stamps the current branch tip
  because there is no checkout. Fitness rule: `review-tip-read`.
- **Batch — correctly generic second lifecycle (`domain/batch.js`,
  `domain/collab/batch.js`, `app/batch.js`).** A batch is finite evidence over
  missions, not a mission kind, so it stays generic — but its second state
  machine is now owned by one module: `BATCH_STATUS`, `BATCH_TRANSITIONS`
  (`open → closed | abandoned`), `canTransitionBatch`, `isBatchTerminal` and
  `normalizeBatchStatus` (legacy `created`/`active`/`pending` read as `open`).
  `createBatch`/`closeBatch`/`abandonBatch` share one guarded transition and
  state semantics validates the stored status, so an unknown or invented batch
  status fails as state corruption. Receipt verification is unchanged. Fitness
  rule: `batch-status-literal`.
- **Leases — advisory coordination, never authority (`adapters/leases.js`,
  `app/spawn-prechecks.js`).** Lease acquisition is not OS-enforced exclusivity,
  and the docs say so. There is exactly one enforcement point: the fail-closed
  spawn admission when `spawn.requireLease` names a lease, which refuses a
  missing lease and a lease held by another actor with an actionable remedy. The
  prior contract deadlocked: an expired lease held by a crashed process could
  never be released because a token mismatch was refused even with `force`. Now
  `force: true` releases an **expired** lease (explicit crash recovery) while a
  live lease still refuses a foreign token, and `acquire` never takes over
  automatically. Fitness rule: `lease-ledger`.
- **Paused vs blocked — two distinct stopped semantics
  (`domain/missions/lifecycle.js`, `domain/state/semantics.js`).** `blocked` is
  derived machine state: it means "open blockers exist". `paused` is a deliberate
  stop with a `pauseCause` (`user`|`failure`|`resource`|`dependency`). They never
  coexist: a recorded blocker clears a pause and moves the mission to `blocked`;
  `clear_blockers` clears them and resumes the mission (to `active`, or to
  `completed` in the same patch); pausing or completing is refused while blockers
  are open; `status: "blocked"` is refused and machine writers go through
  `markBlocked(mission, text)` (merge/rebase conflicts use it). The state
  invariant `status === "blocked" ⇔ open blockers exist` (for non-terminal
  missions) is checked on every load/validation, and migration v4→v5 normalizes
  recorded states: a blocked mission without a blocker gets an explicit legacy
  blocker, blockers under another non-terminal status become `blocked`, and a
  superseded `pauseCause` is removed. It is not a per-kind rule: both shapes
  declare `blocked`/`paused` in their own transition tables. Fitness rule:
  `blocked-status-write`.
- Because the stopped-status invariant is new, the persisted schema version is
  now **5** (`SCHEMA_VERSION = 5` in `domain/mission.js`); the v4→v5 migration is
  pure and idempotent like its predecessors.
- The audit grew four rules (`review-tip-read`, `batch-status-literal`,
  `lease-ledger`, `blocked-status-write`) with mutation tests proving each rule
  fails on a seeded violation. `scripts/shape-audit.mjs` exports `RULES`, and
  `scripts/generate-shapes-reference.mjs` refuses to generate if a verdict names
  a rule the audit does not run.

## Addendum: W4 evidence, legacy, scope and role-vs-kind (#149)

W4 audited the four remaining dimensions. Each had no single owner; each got a
written verdict, one owning module, and a fitness rule that `npm run shape:audit`
enforces (generated into `docs/reference/shapes.md`). No dimension became a
per-kind conditional and no second shape table was added.

- **Test receipts / evidence — redesigned to one reader (`domain/evidence.js`).**
  The same question ("did tests run?") previously had four answers:
  `mission.completionReport.checks`, a synthetic `tests` check that
  `tower_complete` copied from discovery via `tests.autoChecks`,
  `mission.testRuns`, and a separate `gates.requireTests` filter that re-read
  receipts. `domain/evidence.js` now owns the normalized record
  `{names, name, source, ok, command, exitCode, evidence, treeTip, entry}` with
  sources `completionReport` | `testRuns` | `input`, aliases `tests`/`tower_test`
  carried in `names`, and one ordering (completion checks first, then newest
  receipts, then caller checks scoped to the mission) applied by `findEvidence` —
  precedence and ordering are reader decisions, not fields on the record.
  `evidenceEntries`, `findEvidence`, `passingDiscovery`,
  `hasCheckEvidence` and `hasTestReceipts` are the only readers; the shapes
  declare the contract (`build.evidence = {completionChecks: true, testReceipts:
  "tip-bound"}`, `survey.evidence = {completionChecks: true, testReceipts:
  false}`) because only a shape with a branch has a tip to bind a receipt to.
  `gates.requireTests` uses `passingDiscovery`; completion blockers use
  `hasCheckEvidence`; `tower_batch` validation/summary use `findEvidence`.
  `tower_complete` no longer copies a `tests` check into the report and
  `tower_test` returns the receipt only, so the config key `tests.autoChecks`
  disappears (config surface 57 → 56, recorded in `scripts/surface-baseline.json`
  and `docs/reference/surface-budget.md`). Fitness rule:
  `evidence-single-read`, owned by `domain/evidence.js`; mutation tests seed a
  completion-check read, a `mission.testRuns` read and prove the owner module is
  exempt.
- **Legacy import — redesigned to a strict adapter contract
  (`adapters/legacy.js`).** Import was approximate in four ways: the format was
  inferred from the first mission id (mixed namespaces were only caught
  incidentally), an absent `kind` was silently stamped `build`, a Tower Codex
  `retired` status leaked into the mission summary as if it were a DSH status,
  and batch exclusion read several hand-written snapshot shapes
  (`missions`/`snapshot.missions`/`payload.missions`/`pausedIds`). The adapter now
  exports `LEGACY_FORMATS`: one declared entry per accepted format (id pattern,
  id hint, input statuses, `statusRemap`, `baseBranchField`,
  `requiresBaseBranch`). Detection requires exactly one id namespace (a declared
  `payload.format` is authoritative and validated against the ids); a Codex
  `retired` status is remapped to `abandoned` and reported in `remapped`; an
  absent kind is reported in `unresolved` instead of silently invented; mission
  fields the summary does not carry are reported in `dropped` with the reason
  that the exact bytes remain in the stored snapshot. The persisted snapshot
  record gains `unresolved`, `droppedFields` and `remapped`, so the honesty
  survives a restart. `domain/batch.js` reads only the canonical
  `pausedMissionIds`. The import remains read-only, byte-exact,
  hash-addressed and idempotent: it never writes `state.json`, never activates,
  adopts or resumes a mission, and a paused mission stays paused. Fitness rule:
  `legacy-vocabulary`, owned by `adapters/legacy.js`; mutation tests prove a
  second `tower-codex`/`pausedIds` reader fails outside the adapter.
- **Scope ownership — redesigned to `shape.reach` (`domain/scope.js` +
  shapes).** The shape flag `ownsScope` lived beside three enforcers (the
  integration gate, the planner's auto-dependencies, and lifecycle scope
  widening), each of which read `mission.scope` itself. The shape now declares
  `reach = { ownsPaths, fence: "scope" | "read-only" }`: a build owns paths and
  fences changed files against its scope; a survey reaches nothing and is fenced
  read-only. `domain/scope.js` exports one `scopeFenceBlocker({ mission, reach,
  changedFiles, caseInsensitive })`; `domain/integration/gate.js` derives the
  reach from `shapeFor(mission.kind)` and re-exports the existing
  `outOfScopeBlocker` shape; `domain/missions/plan.js`,
  `domain/planning.js` and `domain/missions/lifecycle.js` derive
  `reach.ownsPaths`. `ownsScope` is deleted. Fitness rule: `scope-reach`, owned
  by `domain/scope.js`; mutation tests seed an `ownsScope` reader and a direct
  `fileInScope` call.
- **Role vs kind — redesigned to an orthogonal role contract
  (`domain/roles.js`).** Spawn resolved a reviewer by combining
  `isReviewerRole(role)` with `shape.fields.readCommit`/`shape.canMerge`, and
  presets, prechecks, placement, briefings and the roster each re-derived role
  facts independently. `domain/roles.js` now owns `ROLE_CONTRACT`, one entry per
  actor role with `preset`, `model`, `placement`, `briefing`, `tracksMission`,
  `countsTowardBudget`, `spawnDiscovery` and `requires` (review, canMerge,
  worktree, status set). `resolveRoleSpawn` returns the preset/model route,
  `roleMissionBlockers` returns ordered prerequisites, and
  `roleCountsTowardBudget`, `roleTracksMission`, `rolePlacement`,
  `roleBriefingKind` and `rolePresetConfig` replace the scattered checks. The
  shape supplies only facts (`canMerge`, `fields.worktree`, `spawn.model`);
  `tools/spawn.js`, `app/spawn-prechecks.js`, `app/spawn-support.js`,
  `domain/roster.js` and `host/presets.js` call the role API and never combine a
  role predicate with a shape decision. Fitness rule: `role-shape-conflation`,
  owned by `domain/roles.js`; mutation tests seed a role∧shape conditional and
  prove the owner module is exempt.
- The audit now runs 12 rules. The generated reference's `Dimension inventory
  (#149)` lists every audited dimension with its verdict, owner module and
  fitness rule; `scripts/generate-shapes-reference.mjs` still refuses to emit a
  rule id the audit does not run.
