# 0004 — The concept surface is frozen by a committed baseline

- Date: 2026-10-23
- Status: Accepted
- Deciders: maintainer
- Supersedes: none

## Context

Four days after the first publish the plugin carried 60+ config keys and 28 tools.
The fitness suite measures file shape (line ceilings, pure-domain share) but not
how many concepts a user has to hold. Line counts can stay green while the real
surface grows, and every config key is four promises: a reference row, a validator
branch, a default that must keep working, and an answer to "why did this change my
behaviour". The same is true of every tool.

## Decision

Count three surfaces — config leaf keys, config sections and registered tools — in
one pure module (`domain/surface.js`). Commit the counts in
`scripts/surface-baseline.json` with a date. `npm run surface:check` fails when a
live count differs from the baseline; a decision that raises a count must name an
existing ADR under `docs/adr/` or deletions that are provably absent from the live
surface. `tower_doctor` prints the counts, the generated config/tools references
print the same counts plus the baseline date, and every key/tool is classified
`core`, `tuning` or `niche` in `docs/reference/surface-budget.md`, with a removal
note for each niche key.

## Consequences

- Growth is visible in a diff instead of arriving one reasonable-looking key at a
  time.
- A reduction is cheap for `sections` and `tools`: the baseline can be ratcheted
  down with no ADR. Since #138 the config-key count is two-way like the component
  count (see [ADR 0005](0005-component-surface.md)).
- The classification table is auditable, not decorative: the check fails when a
  live key or tool is missing from it.
- The numbers are three lines in `tower_doctor` output, not a new dashboard.
- This does not remove any key in this release; it is a brake, not a clean-up.

## Measurement correction (2026-10-23)

The first baseline counted 27 tools because it recorded only the `define()`
registration path. `tower_mode` and `tower_control` are registered directly by
`index.js`, so the shipped surface was always 29 (#118). The baseline now carries
an explicit correction decision (27 → 29) with a reason, a date and a reference
to this ADR, and the recorder in `host/tool-registry.js` covers both registration
paths. This is a measurement correction, not surface growth: a later count change
still needs its own ADR or a provably matching deletion.

## Amended by ADR 0005 (2026-10-23)

The decision above counts three surfaces. [ADR 0005](0005-component-surface.md)
extends the budget with a fourth — the number of user-visible component rows in
`cordis.patch.yml` — and records it as its own `components` baseline entry with a
two-way decision rule (a contraction needs a decision just like growth). The
three original counts are still measured by `npm run surface:check`; the
component count is validated by `npm run docs:check:components`. ADR 0005's wave
3 (#138) also makes `configKeys` two-way, so the cheap-shrink consequence above
now applies only to `sections` and `tools`. The historical decision above is
unchanged: "three surfaces" describes the 2.3.0 rule.

## Rejected alternatives

- **A line-count or file-size rule** — the project already has those and the
  surface grew while they stayed green; they measure the wrong thing.
- **A hard cap with no escape hatch** — a real capability would be blocked, and the
  first exception would be added as an unexplained waiver.
- **A per-key count in each generated reference** — two references can disagree;
  one shared baseline plus one check keeps the counts equal.
- **Only an ADR requirement** — a pure deletion would need paperwork even though it
  shrinks the surface; the matching-deletion path keeps `sections`/`tools`
  reductions cheap. The config-key surface is the exception since #138: a removed
  switch is itself a capability decision, so it needs a dated record (ADR 0005).
- **A GitHub issue label instead of a repo file** — the brake must run offline in
  `npm test` and in CI without a token.
