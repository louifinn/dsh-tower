// Role × phase exposure model (#164 stages 2/4/5).
//
// `Exposed = L2 components ∩ L1 phase projection(state) ∩ L0 role contract`.
// This module is the pure L1 half for the *host* session (the tower itself)
// plus the data the gates need: the phase ladder, the per-tool exposure table
// and the transition→tool map the liveness property is checked against.
//
// Layers and who owns them:
//
//   L0 — role contracts. The four spawned presets (worker/reviewer/survey/
//        survey-sandbox) own theirs through `ctx.tools.restrict({ allow })` in
//        their policy modules; the host session has no preset, so its L0 is
//        "the mounted surface" and L1 is the only subtraction. #163 tightens
//        the preset lists and renames tools; this table follows the build.
//   L1 — this module. A pure function of (phase, registered names). Exposure
//        only subtracts: a phase row may hide a registered tool, never invent
//        or re-enable one that is not registered.
//   L2 — loader rows (`tower-batch`, `tower-import`, ...) already decide
//        whether a capability registers at all; the exposure table classifies
//        the tools those rows own, so a disabled row and a hidden tool compose.
//
// Principles encoded here (#164 §2): exposure only subtracts; the ladder is
// monotone (off ⊆ idle ⊆ active per tool); identical inputs produce
// byte-identical name lists (sorted, no ambient state); hiding is not refusal
// (the host resolves a hidden tool as UNKNOWN_TOOL — see the ADR).
// @ts-check

/**
 * The host session's phases. `off` is Tower mode off; `idle` is mode on with
 * no state file for the repository yet; `active` is mode on with state. The
 * issue's S1/S2/S3 collapse into `active`: the running→integrating switch is
 * one cache invalidation that only pays on sessions longer than the
 * break-even computed in the ADR, so `active` is the stable union.
 */
export const SESSION_PHASES = Object.freeze(['off', 'idle', 'active'])

/**
 * The agent-preset ids whose sessions run a Tower role contract. Agents
 * composed with one of these are gated by their preset's allow-list, not by
 * the host ladder: a worker legitimately calls `tower_mission` with Tower
 * mode off, so the phase gate must not subtract there.
 */
export const TOWER_PRESET_IDS = Object.freeze([
  'tower-worker',
  'tower-reviewer',
  'tower-survey',
  'tower-survey-sandbox',
])

/**
 * The exposure table: every tool this build can register, classified by the
 * phases that expose it. This is deliberately explicit — "no implicit all"
 * means a tool missing from this table is a gate failure (see
 * tests/exposure.test.mjs), not an implicit `active`.
 *
 *   off    — the entry affordance only. `tower_mode` is the read-only
 *            "where am I" pointer (#164 principle 5) and `tower_control` is
 *            the agent-driven mode entry that `allowAgentControl` ships; both
 *            are usable with mode off. Every orchestration tool is hidden: a
 *            mode-off session must not pay for tools it must not use.
 *   idle   — mode on, no state yet: add `tower_init`, the one tool that
 *            creates the state and thereby leaves the rung.
 *   active — mode on, state exists: the stable union. Merge/rebase/preflight
 *            are exposed from the start of the rung rather than switched in
 *            at "integrating"; the arithmetic is in the ADR.
 */
export const EXPOSURE_TABLE = Object.freeze({
  // entry affordance
  tower_mode: { off: true, idle: true, active: true },
  tower_control: { off: true, idle: true, active: true },
  // idle: state bootstrap
  tower_init: { off: false, idle: true, active: true },
  // active: planning and mission lifecycle
  tower_plan: { off: false, idle: false, active: true },
  tower_mission: { off: false, idle: false, active: true },
  tower_spawn: { off: false, idle: false, active: true },
  tower_adopt: { off: false, idle: false, active: true },
  // active: read-only views and health
  tower_status: { off: false, idle: false, active: true },
  tower_roster: { off: false, idle: false, active: true },
  tower_diff: { off: false, idle: false, active: true },
  tower_doctor: { off: false, idle: false, active: true },
  tower_inbox: { off: false, idle: false, active: true },
  // active: collaboration
  tower_send: { off: false, idle: false, active: true },
  tower_finding: { off: false, idle: false, active: true },
  tower_findings: { off: false, idle: false, active: true },
  tower_complete: { off: false, idle: false, active: true },
  tower_review: { off: false, idle: false, active: true },
  // active: integration and recovery (stable across the rung: `recover` is
  // the escape hatch, never worth a cache bounce — #164 §5)
  tower_merge: { off: false, idle: false, active: true },
  tower_rebase: { off: false, idle: false, active: true },
  tower_preflight: { off: false, idle: false, active: true },
  tower_interrupt: { off: false, idle: false, active: true },
  tower_recover: { off: false, idle: false, active: true },
  tower_teardown: { off: false, idle: false, active: true },
  // active: optional capability rows (L2 composes: a disabled row never
  // registers, so this row only matters while the row is on)
  tower_batch: { off: false, idle: false, active: true },
  tower_import_legacy: { off: false, idle: false, active: true },
  tower_legacy_map: { off: false, idle: false, active: true },
  tower_resource: { off: false, idle: false, active: true },
  tower_test: { off: false, idle: false, active: true },
  tower_reload: { off: false, idle: false, active: true },
})

/**
 * Whether a phase exposes one tool. Unknown names are never exposed by a
 * subtracting phase — but the caller (the host gate) fails open on errors, so
 * an unclassifiable name reaching here means the table is stale, which the
 * gate tests catch.
 * @param {string} phase one of SESSION_PHASES
 * @param {string} name registered tool name
 * @returns {boolean}
 */
export function exposes(phase, name) {
  const row = EXPOSURE_TABLE[name]
  return Boolean(row && row[phase] === true)
}

/**
 * The exposed names of one phase, sorted. Sorting (not registration order)
 * makes the pure projection byte-stable for the baseline and the property
 * tests; the advertised request order is the host's registration order, which
 * is fixed by `registerCoreTowerTools` (ADR).
 * @param {string} phase one of SESSION_PHASES
 * @param {readonly string[]} registeredNames every name this build registered
 * @returns {string[]}
 */
export function exposedNames(phase, registeredNames) {
  return [...registeredNames].filter((name) => exposes(phase, name)).sort()
}

/**
 * Derive the host session's phase from facts. Pure: the caller supplies the
 * mode bit and the state-existence bit, both read at the same turn boundary.
 * @param {{ mode: 'on' | 'off', stateExists: boolean }} facts
 * @returns {'off' | 'idle' | 'active'}
 */
export function phaseOfFacts({ mode, stateExists }) {
  if (mode !== 'on') return 'off'
  return stateExists ? 'active' : 'idle'
}

/**
 * Which tools drive each legal mission transition, per shape kind. The
 * liveness property (#164 §8) checks `drivers ⊆ Exposed` for the profile that
 * owns the driver, enumerating the shape registry's own transition tables so
 * the check cannot drift from the protocol: every edge here must exist in the
 * registry, and every registry edge must have drivers.
 *
 * `tower`-side drivers are exposed from `active`; worker-side drivers
 * (`tower_complete`) and reviewer-side ones (`tower_review`) are exposed
 * through their preset allow-lists.
 */
export const TRANSITION_TOOLS = Object.freeze({
  build: Object.freeze({
    'planned>active': Object.freeze(['tower_spawn']),
    'planned>blocked': Object.freeze(['tower_mission']),
    'planned>abandoned': Object.freeze(['tower_mission']),
    'active>completed': Object.freeze(['tower_complete']),
    'active>blocked': Object.freeze(['tower_mission']),
    'active>paused': Object.freeze(['tower_mission']),
    'active>abandoned': Object.freeze(['tower_mission']),
    'blocked>active': Object.freeze(['tower_mission']),
    'blocked>abandoned': Object.freeze(['tower_mission']),
    'paused>active': Object.freeze(['tower_mission']),
    'paused>blocked': Object.freeze(['tower_mission']),
    'paused>abandoned': Object.freeze(['tower_mission']),
    'completed>active': Object.freeze(['tower_mission', 'tower_review']),
    'completed>blocked': Object.freeze(['tower_mission']),
    'completed>abandoned': Object.freeze(['tower_mission']),
  }),
  survey: Object.freeze({
    'planned>active': Object.freeze(['tower_spawn']),
    'planned>blocked': Object.freeze(['tower_mission']),
    'planned>abandoned': Object.freeze(['tower_mission']),
    'active>completed': Object.freeze(['tower_complete']),
    'active>blocked': Object.freeze(['tower_mission']),
    'active>paused': Object.freeze(['tower_mission']),
    'active>abandoned': Object.freeze(['tower_mission']),
    'blocked>active': Object.freeze(['tower_mission']),
    'blocked>abandoned': Object.freeze(['tower_mission']),
    'paused>active': Object.freeze(['tower_mission']),
    'paused>blocked': Object.freeze(['tower_mission']),
    'paused>abandoned': Object.freeze(['tower_mission']),
  }),
})

/**
 * The preset allow-lists re-exported as data for the byte baseline and the
 * liveness gate. The policy modules (worker.js, ...) stay the authority: they
 * import nothing, so scripts and tests can load them cheaply, and #163's
 * explicit-contract work extends the same exports.
 */
export const PRESET_ALLOWS = Object.freeze({
  'tower-worker': Object.freeze([
    'read', 'write', 'edit', 'glob', 'grep', 'pwsh',
    'tower_mission', 'tower_status', 'tower_diff', 'tower_send', 'tower_inbox',
    'tower_complete', 'tower_finding', 'tower_findings', 'skill',
  ]),
  'tower-reviewer': Object.freeze([
    'read', 'glob', 'grep',
    'tower_diff', 'tower_status', 'tower_send', 'tower_inbox',
    'tower_finding', 'tower_findings', 'tower_review', 'skill',
  ]),
  'tower-survey': Object.freeze([
    'read', 'glob', 'grep',
    'tower_mission', 'tower_status', 'tower_finding', 'tower_findings',
    'tower_inbox', 'tower_complete', 'skill',
  ]),
  'tower-survey-sandbox': Object.freeze([
    'read', 'write', 'edit', 'glob', 'grep', 'pwsh',
    'tower_mission', 'tower_status', 'tower_finding', 'tower_findings',
    'tower_inbox', 'tower_complete', 'skill',
  ]),
})
