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

## Addendum (wave 2): board, archive, UI and explicit development tooling

- Date: 2026-11-02
- Decisions: #132, #133, #134, #135, #141

Four components were component-shaped but sat outside the policy: `docs.board` and
`archive.enabled` were booleans in the config form, `tower-ui` shipped as a real
plugin-page row that no source-of-truth entry described, and the group rows never
stated their off consequence where a reader sees it. Wave 2 closes those gaps
without widening the mechanism.

- **`tower-board` (#133).** `docs.board` is deleted; the board is the optional
  `tower-board` row with its own capability module. Its fallback: no `MISSIONS.md`
  is written or refreshed, an existing board goes stale, and every state tool and
  gate keeps working. `docs.boardLocation` stays a tuning key because it only
  chooses a path. With the row off, the composition behaves like an all-Tower-off
  profile for the board (nothing is written) while the rest of Tower keeps working.
- **`tower-archive` (#135).** `archive.enabled` is deleted; archival is the
  optional `tower-archive` row. Its fallback is deliberately honest: terminal
  missions stay hot in `state.json`, the hot state keeps growing, and `status` /
  `doctor` keep loading their full history; merges and gates are unaffected and
  nothing is deleted. `archive.afterDays` / `archive.maxMissions` stay tuning.
- **Removed keys fail loudly.** A config that still sets `docs.board` or
  `archive.enabled` is rejected with `config-unknown-key` and an upgrade note that
  names the replacing row and points here. There is no silent alias: a switch that
  moved to the plugin page must not keep working from a config file.
- **`tower-ui` is classified (#134).** The UI plugin row is now a visible
  component with a documented fallback (the web UI plugin does not load: no tool
  cards, composer-dock summary or status strip; host tools, missions and the board
  are unaffected). Because it ships in `ui-bundle/`, the gate reads **every**
  shipped `cordis.patch.yml` (root and `ui-bundle/`), classifies every visible row
  and enforces a label source for each: either a generated `<specifier>/locale`
  row, or the row package's own `meta` label when the labels live there. A row
  added to any shipped patch without a source-of-truth entry fails
  `npm run docs:check:components`.
- **A group row states its consequence where it is read (#132).** The plugin page
  renders the group row from the package `meta` block, so the off-equals-uninstall
  consequence lives in the root `meta.description` in both languages, and the gate
  pins it there instead of trusting only the `components` block. This is a label
  fix, not a new mechanism.
- **`tower-hmr` stays shipped off (#141).** Moving it to a separate install path
  would hide the switch and re-open the orphan-mount hazard; the row is kept as
  explicit development tooling instead: its locale copy and its source-of-truth
  fallback say that it exists for a linked dev profile, that a normal profile
  behaves exactly as before, and that it is off on purpose.
- **Count decision.** The visible component count moved 8 → 9 → 10 → 11 across
  #133, #135 and #134; the three dated steps are recorded in
  `scripts/surface-baseline.json`. The config surface contracted 55 → 53, which the
  other surfaces allow without a decision record.

## Addendum (wave 3): close the gate's blind spots

- Date: 2026-11-03
- Decisions: #138

Wave 2 made the gate read every shipped row, but four ways to evade it remained:
a class was free text, the operational route table was scraped with a regex, only
the patches named in `COMPONENT_PATCH_FILES` were read, and only booleans were
reviewed. Wave 3 closes them without changing the shipped decisions: 53 config
keys, 11 visible components.

- **The class is checked against the key's shape (#138.1).** A boolean that
  removes a capability cannot file as `optional-config` by assertion. Every live
  boolean must be `core`, `optional-component` or `forbidden-to-disable`, or an
  `optional-config` key carrying a dated `exemption` whose reason names its
  tuning-only nature. The same rule covers the non-boolean behaviour knobs below.
  An exemption is only legal on a reviewed boolean/knob, and its `ref` must exist.
- **The config-key count is two-way (#138.1).** Wave 2's closing note ("the config
  surface contracted 55 → 53, which the other surfaces allow without a decision
  record") is retracted. Removing a switch is a capability decision, so
  `configKeys` now joins `components` in `SURFACE_TWO_WAY_KEYS`: any later increase
  or decrease needs a dated decision in `scripts/surface-baseline.json`. The gate
  requires the `date` field itself (`YYYY-MM-DD`) on every decision of a two-way
  surface, so a bare from/to record fails even when its chain reaches the value
  (review of #138). The 64 → 53 history is recorded as one dated decision there;
  sections and tools keep the ADR 0004 cheap-shrink rule.
- **The route table is imported, not scraped (#138.2).** `host/tool-registry.js`
  exports `OPERATIONAL_TOOLS`, and the gate imports that module instead of
  regex-matching its source. A missing file, a failed import, or a missing/non-Map
  export is `registry-unreadable` and fails the gate. An empty Map is still the
  correct determined state (#122): "nothing is gated" is distinct from "could not
  read".
- **Every shipped patch is discovered (#138.3).** The gate walks the package for
  `cordis.patch.yml` and compares the result with `COMPONENT_PATCH_FILES` in both
  directions. An unlisted patch fails `patch-unclassified`; a listed patch that is
  missing fails `patch-missing`. The row checks stay bidirectional: every shipped
  row needs a source-of-truth entry, and every source-of-truth row needs a shipped
  row.
- **Behaviour knobs and row overrides are reviewed (#138.4).** `spawn.requireLease`
  and `tests.admission` are recorded in `behaviorKnobs` and carry tuning-only
  exemptions: the optional `tower-leases` / `tower-tests` row owns the capability,
  while these keys choose the safety level or timing inside it. A row's scalar
  `config:` overrides are now parsed and must name a live config key and be listed
  in that component's `allowedOverrides`. A row that sets `docs.board`,
  `archive.enabled` or `tests.enabled` therefore fails as `row-override-unknown`
  (those capabilities are rows), a row that enables or disables a key it does not
  own fails as `row-override-foreign`, and `allowedOverrides` may never name a
  forbidden-to-disable key. Fixtures reproduce the #133/#135/#136 shapes and a
  foreign override, proving they fail before the fix passes.

## Addendum (wave 4): broad-audience labels and a copy gate

- Date: 2026-11-04
- Decisions: #137

Wave 3 made the gate fail closed, but every label it admitted still passed. The
plugin page leaked config keys (`gates.requireTests:true`, `review.requireReview`)
and bare tool ids (`tower_batch`, `tower_resource`) into the off-state copy, the
Chinese copy mixed 咨询式租约 / 重型工作 / untranslated `mission` and `preset`, and
the Web UI used 任务线 while the plugin page left `mission` in English. The counts
do not move: 53 config keys, 13 components, 11 visible.

- **The labels are rewritten for a reader, not for an operator (#137.1).** Every
  visible row, the group row and the UI row now say what the capability is for
  and what stops when it is off, in plain language. Config keys, tool ids, slash
  commands and module specifiers are gone from `title`, `summary`, `disables` and
  the two `meta` descriptions. The off copy says "refused with an explanation",
  not "locked", and names Tower mode. The `tower-leases` fix also removes the F19
  claim that "nothing else depends on a lease": a lease is coordination only, but
  a worker configured to require one cannot start while the row is off; planning
  and Tower-mode entry are refused with an explanation until the setting is
  cleared or the row is re-enabled, and everything else keeps working.
- **One bilingual vocabulary, recorded (#137.2).** `GLOSSARY.md` is the single
  table for mission/任务线, batch/批次, doctor/体检, board/看板, archive/归档,
  preset/预设, worktree/工作树, review/审查, lease/租约, worker/执行代理 and
  reviewer/审查代理. It also records the copy rules (two sentences, no
  identifiers, truthful off effect, natural Chinese) and is a gate input: a label
  that uses a term the table does not pair with its other-language field fails.
  The Web client's own string catalogue shares this table but is migrated
  separately; the runtime error copy in `host/presets.js` is likewise a follow-up.
- **The copy is checked mechanically (#137.3).** `checkLocaleCopy` runs over the
  root locale pair, the ui-bundle meta pair and every generated row-locale pair.
  It fails on config-key syntax, `tower_*` ids, `/tower` commands, `dsh-tower/*`
  specifiers, empty fields, zh/en path drift and glossary mismatches in both
  directions; the Chinese side may not leave glossary words untranslated.
  `checkMetaRowCopy` pins the hand-written ui-bundle `meta.title` / `description`
  to the root `components['tower-ui']` entry and the same composition the
  generator renders, so the one row that ships its own label cannot drift.
  `checkGlossaryFile` keeps `GLOSSARY.md` present and complete. Negative
  fixtures in `tests/locale-copy.test.mjs` prove a raw key, a bare tool id and a
  term mismatch fail in both languages before the fixed copy passes.
- **Review of #137 corrected three claims and hardened the guard.** The
  `tower-tests` off copy promised that "merges … keep working", but
  `domain/gate.js` emits the `tests-missing` merge blocker while the test
  requirement is on and `host/presets.js` refuses planning and Tower-mode entry,
  so the copy now says planning and entry are refused and merges stay blocked
  until the requirement is cleared. The reviewer preset summary said "only used
  when review before merging is required"; the row is usable while review is
  optional and becomes a precondition for merging only when the requirement is
  on, so the summary says that instead. The Chinese calques 锁状态的恢复出口,
  收口, 一项命名工作, 在线状态文件 and 关闭该行 were replaced with 卡住的锁如何
  恢复, 关闭该批次, 某一具体工作, 当前状态文件 and 关闭这一项. The guard now
  normalizes full-width punctuation and matches case-insensitively, so
  `Gates.requireTests`, `Tower_batch` and `gates。requireTests` fail; the worker
  and reviewer role nouns accept an initial capital but exclude the product names
  "Tower Worker" and "Tower Reviewer", in both the en→zh and zh→en directions.
  `GLOSSARY.md` ships in the package (`package.json` `files`, pinned by
  `scripts/pack-manifest.txt`) because it is a gate input, not repository-only
  prose.
- **Rejected: a prose style guide with no gate.** It is what let wave 1–3 pass;
  a reviewer's attention does not survive the next rename.
- **Rejected: translating the developer reference table.** The fallback text in
  `scripts/component-surface.json` and the generated
  `docs/reference/component-surface.md` is an operator reference for auditors, not
  a plugin-page label. It may name keys and tools; the locale fields may not.
