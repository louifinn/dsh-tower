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

The shape redesign grows the config surface by exactly three keys and one
section, all recorded in `scripts/surface-baseline.json`:

- `spawn.surveyPreset` (core): the read-only preset a survey spawn receives; the
  survey row owns the capability, the preset name is the routing knob.
- `spawn.surveyModel` (tuning): an optional independent model route, mirroring
  `spawn.workerModel`/`spawn.reviewerModel`.
- `survey.sandbox` (tuning): `none` (default) reads the shared checkout;
  `detached` creates a disposable detached worktree at `readCommit`. It never
  participates in `state.base`, never becomes a branch, and is never merged.
- the `survey` section exists only to hold `survey.sandbox`.

The `tower-survey` row is a visible optional component (components 11 → 12): off
means surveys cannot be planned (an actionable code) and no survey agent can be
dispatched; build missions are unaffected.

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