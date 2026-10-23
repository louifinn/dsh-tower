# 0005 — The component surface: mandatory host, switchable optional rows

- Date: 2026-10-23
- Status: Accepted
- Deciders: maintainer
- Supersedes: none

## Context

The plugin had no durable statement of what may and may not be a switch. The
policy that #65 was resolved against lived only in the issue body, so when the
issue closed the policy evaporated: the 2.0.4 surface (four top-level rows:
`tower`, `tower-skills`, `preset-tower-worker`, `preset-tower-reviewer`) became
one all-or-nothing `tower-bundle` group row plus seven `tools.expose*` config
keys. The user-controllable component count went 4 → 1 while nothing recorded
that decision or refused the next one.

Two failure modes are already visible in the 2.3.0 tree:

1. Optional capabilities have no component. Skills, the reviewer preset, the
   batch/import/leases/test tools and hot reload can only be changed by editing
   YAML under `tools:`, which is the discoverability problem components exist to
   solve. A config key is still a switch, just a worse-labelled one.
2. The safety nets are switchable. `tools.exposeOperational:false` removes all
   seven operational tools including `tower_recover` and `tower_doctor`, so the
   equipment that diagnoses and repairs a stale `state.lock` can itself be
   turned off, while the plugin stays mounted. That off state is worse than
   uninstalling the plugin, because uninstalling would remove the lock problem
   too.

`PRINCIPLES.md` already says an enforcement pointer that does not resolve is a
slogan; by that standard the component policy was a slogan.

## Decision

Adopt this shape and record it as principle 11:

- **The host is mandatory.** `tower` (and its worker preset dependency) is never
  a switch, not as a row and not as a boolean that removes it.
- **Each optional capability is its own component row**, individually toggleable
  from the plugin page, with `title`, `summary` and `disables` in both locales and
  a documented fallback stating what still works while it is off. A capability
  qualifies only when its off state leaves the rest of Tower intact and is not
  worse than uninstalling.
- **The safety nets are never switches.** The health contract, the recovery
  escape, the review contract and the merge gates are configuration or code; no
  group, row or boolean key may gate them. Enforcement covers both routes: a
  `cordis.patch.yml` row that defaults any key classified `forbidden-to-disable`
  to `false` is refused, and every `tools.expose*` route in
  `host/tool-registry.js` must match the `gateableTools` allowlist in the source
  of truth, so a new route to a review, merge or host tool fails even when that
  capability lists no tools of its own.
- **Config keys stay on the component axis.** Every config key is classified
  `core`, `optional-component`, `optional-config` or `forbidden-to-disable` in
  `docs/reference/component-surface.md`, generated from the single source of
  truth `scripts/component-surface.json`, so "should this be a component?" is a
  table lookup rather than a judgement call.
- **The component count is a baselined surface.** `scripts/surface-baseline.json`
  gains `components` (seed 4, the 2.0.4 row count; value 1, today's group row) and
  the 4 → 1 contraction is itself a dated decision. Unlike the other surfaces, the
  component count is two-way: a contraction needs a decision record just like
  growth does. `npm run surface:check` and `npm run docs:check:components` refuse a
  count that moved without one. That is what makes the next contraction — or the
  coming growth — visible in a diff.

This ADR records the policy. The individual instance fixes follow it: #121 turns
the qualifying capabilities into optional rows, and #122 deletes
`tools.exposeDoctor` / `tools.exposeRecovery`, removes the `exposeOperational`
master switch and the whole `tools` config group. While that migration was in
flight the two `tools.expose*` keys that gated the health and recovery contracts
were recorded as dated debt in `scripts/component-surface.json`, so a *new*
switch failed the gate immediately even before #122 landed.

## Migration (2.4.0): the #65 policy is restored from the carrier

- Date: 2026-10-23
- Status: implemented by #121 and #122

The one `tower-bundle` group is gone. `cordis.patch.yml` now ships the mandatory
`tower` host anchor (the Host plugin and the worker preset are its internal
sections) plus the individually switchable top-level rows `tower-skills`,
`tower-batch`, `tower-import`, `tower-leases`, `tower-tests`, `tower-hmr`
(shipped off) and `preset-tower-reviewer` (conditional on
`review.requireReview`). The visible component count moved 1 → 8 and is recorded
as a dated decision in `scripts/surface-baseline.json`.

The capability switches became rows: the seven `tools.expose*` keys and
`dev.hotReload` were deleted from the schema and are now rejected as unknown
keys. `tower_doctor` and `tower_recover` are registered for every configuration
and have no switch; the `gateableTools` allowlist is empty. This is the
carrier's promised instance fix, not a new policy: #120 wrote the rule down, and
this wave makes the shipped surface obey it instead of carrying debt.

## Consequences

- The user can control every capability that legitimately has an off state, from
  the place components are controlled, instead of editing YAML.
- The host, the diagnostics and the lock escape are always registered; a failure
  message may safely point at `tower_recover`.
- A component count change now needs a written decision, so the 2.3.0 4 → 1
  contraction can never recur silently; the 1 → 8 restoration is recorded the
  same way.
- The 2.3.0 debt is paid: `tools.exposeDoctor`, `tools.exposeRecovery` and the
  `exposeOperational` master switch are gone, so no configuration can remove the
  health contract or the lock escape. The `gateableTools` allowlist stays in the
  source of truth, empty, so the next `tools.expose*` route is refused rather
  than legalised by default.
- Adding a component costs a locale row in two languages and a fallback sentence
  in the source of truth; that is the intended marginal cost.

## Rejected alternatives

- **One all-or-nothing group row (the shipped 2.3.0 shape).** Simple, and it
  removes the orphan-mount hazard, but it removes every user control as well:
  the qualifying capabilities become unreachable from the plugin page. It also
  makes the "off state" question vacuous, because the only off state is
  "uninstalled".
- **Config-key switches instead of components.** `tools.expose*` and
  `dev.hotReload` carry the same capabilities with none of the discoverability,
  and they make safety nets disableable in a place where no label warns about it.
  A config key is a switch with worse labelling, not an absence of a switch.
- **Per-tool components.** 29 rows is a worse surface than 29 tools, and it turns
  every implementation detail of the tool registry into a user decision.
- **A denylist-only rule with no component count.** It would catch a forbidden
  switch but not the 4 → 1 contraction, which is the failure that actually
  happened; the count baseline is the part that keeps the policy alive across the
  next refactor.
- **A GitHub issue label or a docs-only policy.** The brake must run offline in
  `npm test` and in CI without a token, and the policy must survive the closure
  of the issue that introduced it.
