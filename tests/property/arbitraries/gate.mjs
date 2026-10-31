// Arbitraries for the pure gate inputs (`domain/gate.js`).
//
// The gates take snapshots, not state rows: a mission, the roster rows that
// belong to it, the latest review, the config and the runtime activity maps.
// These generators assemble that tuple so a metamorphic property can change one
// witness at a time and compare `mergeGateBlockers` / `completionBlockers`
// before and after.
//
// Two families exist on purpose:
//   * `mergeEvidenceArb` is free-form: reviews may be missing, belong to another
//     mission, or sit at another tip, so a generic "adds a blocker" transform is
//     exercised against every shape the gate accepts.
//   * `cleanMergeEvidenceArb` is a *focused* snapshot: review required, mission
//     policy `required-clean`, a clean/merge review at the exact branch tip and a
//     config that does not allow an exemption. Its gate result therefore starts
//     clean (apart from unrelated roster/test blockers), which makes "worsening
//     the review adds a blocker" a non-vacuous claim.
//
// Nothing here reads the filesystem or a clock.
import fc from 'fast-check'

import { ROSTER_INACTIVE_STATES } from '../../../domain/roster.js'
import { commitShaArb } from './commitSha.mjs'
import { configArb } from './config.mjs'
import { missionArb, rosterNameArb } from './mission.mjs'
import { reviewArb } from './review.mjs'

/** The branch name every focused snapshot uses; a fixed value keeps the gate deterministic. */
export const PROPERTY_BRANCH = 'tower/m1-property'

/** A tip that no generated branch uses, so "move the tip" is always a real move. */
export const OTHER_TIP = 'f'.repeat(40)

const agentIdArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/).map((slug) => `agent-${slug}`)

const sessionIdArb = fc.stringMatching(/^session-[a-z0-9]{1,10}$/)

/** Every roster state the gate distinguishes: inactive states are skipped entirely. */
const rosterStateArb = fc.constantFrom(
  'running',
  'inactive',
  'retired',
  'failed',
  'interrupted',
  'missing',
  'stale',
  'reserved',
  'unknown',
  'inactive',
)

/** One roster row. `missionId` is bound to a real mission by `bindRows` below. */
const rosterRowArb = fc.record(
  {
    name: rosterNameArb,
    role: fc.constantFrom('worker', 'reviewer', 'tower'),
    state: rosterStateArb,
    agentId: agentIdArb,
    parentSessionId: fc.option(sessionIdArb, { nil: undefined }),
    stale: fc.option(fc.boolean(), { nil: undefined }),
  },
  { requiredKeys: ['name', 'role', 'state', 'agentId'] },
)

/**
 * Bind generated rows to one mission: even indices belong to it, odd indices are
 * another mission's rows (which the gate must ignore).
 * @param {{ missionId?: string }[]} rows
 * @param {string} missionId
 * @returns {Record<string, any>[]}
 */
function bindRows(rows, missionId) {
  return rows.map((row, index) => ({
    ...row,
    missionId: index % 2 === 0 ? missionId : 'M999',
  }))
}

/**
 * A free-form merge-gate snapshot. `testRuns` is an empty list (the mission
 * arbitrary does not generate receipts), so a config with `gates.requireTests`
 * reports `tests-missing` — a stable blocker the transforms must preserve.
 */
export const mergeEvidenceArb = fc
  .tuple(
    missionArb,
    fc.array(rosterRowArb, { maxLength: 3 }),
    fc.option(reviewArb, { nil: null }),
    configArb,
    commitShaArb,
  )
  .map(([mission, rows, review, config, branchTip]) => ({
    mission: { ...mission, testRuns: [] },
    roster: bindRows(rows, mission.id),
    branch: PROPERTY_BRANCH,
    branchTip,
    review,
    config,
    activity: {},
    parentStatus: null,
    inactiveStates: [...ROSTER_INACTIVE_STATES],
    rebaseWaived: false,
  }))

/**
 * A focused snapshot whose merge gate is clean apart from blockers unrelated to
 * the review: review required, policy `required-clean`, a clean/merge review at
 * the exact tip, and no review exemption.
 */
export const cleanMergeEvidenceArb = fc
  .tuple(
    missionArb,
    fc.array(rosterRowArb, { maxLength: 3 }),
    configArb,
    commitShaArb,
    reviewArb,
  )
  .map(([mission, rows, config, generatedTip, review]) => {
    // The "move the tip" transform uses OTHER_TIP, so the base tip must differ.
    const branchTip = generatedTip === OTHER_TIP ? 'e'.repeat(40) : generatedTip
    return {
      mission: {
        ...mission,
        reviewPolicy: 'required-clean',
        reviewExemptionReason: null,
        testRuns: [],
      },
      roster: bindRows(rows, mission.id),
      branch: PROPERTY_BRANCH,
      branchTip,
      review: {
        ...review,
        missionId: mission.id,
        branch: PROPERTY_BRANCH,
        reviewedCommit: branchTip,
        status: 'clean',
        mergeVerdict: 'merge',
      },
      config: {
        ...config,
        review: { ...(config.review ?? {}), requireReview: true },
        gates: { ...(config.gates ?? {}), allowReviewExemption: false },
      },
      activity: {},
      parentStatus: null,
      inactiveStates: [...ROSTER_INACTIVE_STATES],
      rebaseWaived: false,
    }
  })

/** A completion-gate snapshot: only the mission and the config are read. */
export const completionEvidenceArb = fc
  .tuple(missionArb, configArb)
  .map(([mission, config]) => ({ mission, config }))
