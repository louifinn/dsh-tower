// Arbitraries for a whole `state.json` document, as accepted by
// `stateShapeError` and `assertStateSemantics`.
//
// Ids are unique per collection (those are the only cross-row invariants the
// schema enforces), and no value points at a real on-disk path or repository.
// Cross-collection links (`roster[].missionId`, `reviews[].missionId`,
// `reviews[].branch`) are app-level coherence, not part of the state contract,
// so they are generated independently here; a property that needs a coherent
// fixture builds one deliberately (tests/property/no-illegal-path.prop.mjs).
import fc from 'fast-check'

import { branchNameArb, commitShaArb, snapshotRefArb } from './commitSha.mjs'
import { findingArb } from './finding.mjs'
import { missionArb, rosterNameArb } from './mission.mjs'
import { posixPathArb } from './path.mjs'
import { reviewArb } from './review.mjs'

const timestampArb = fc.integer({ min: 0, max: 2_000_000_000_000 })
const countArb = fc.integer({ min: 0, max: 10_000 })

/**
 * Roster rows are reserved (no agent yet) or owned by an agent id derived
 * from the unique name, which keeps `agentIds` unique by construction.
 */
const rosterEntryArb = fc
  .tuple(
    rosterNameArb,
    fc.constantFrom('worker', 'reviewer', 'tower'),
    fc.constantFrom('running', 'inactive', 'retired', 'missing', 'unknown', 'reserved'),
    fc.option(branchNameArb, { nil: undefined }),
    fc.option(commitShaArb, { nil: undefined }),
  )
  .map(([name, role, state, missionId, spawnTip]) => {
    const reserved = state === 'reserved'
    return {
      name,
      role,
      state,
      agentId: reserved ? null : `agent-${name}`,
      missionId,
      parentSessionId: reserved ? undefined : `parent-${name}`,
      spawnTip,
    }
  })

/** One inbox message row. */
const messageArb = fc.record({
  id: fc.integer({ min: 1, max: 999_999 }).map((value) => `MSG-${value}`),
  from: rosterNameArb,
  to: rosterNameArb,
  subject: fc.string({ maxLength: 80 }),
  body: fc.string({ maxLength: 200 }),
  readBy: fc.array(rosterNameArb, { maxLength: 3 }),
  at: timestampArb,
})

/** A batch record (only its identity matters for the schema). */
const batchArb = fc.record({
  id: fc.integer({ min: 1, max: 999 }).map((value) => `B${value}`),
  status: fc.constantFrom('open', 'closed', 'abandoned'),
  missionIds: fc.array(fc.integer({ min: 1, max: 999 }).map((value) => `M${value}`), { maxLength: 3 }),
  createdAt: timestampArb,
})

/**
 * Build a full state document. Every optional top-level field the schema accepts
 * is populated, so a passing property covers the whole shape at once.
 *
 * `options` raises the minimum size of one collection. A property that mutates
 * one row kind (a duplicate review id, say) gets a generator that cannot draw an
 * empty collection, so the mutation is never vacuous. The defaults stay at zero
 * so M24/M25 keep the distribution they were written against.
 *
 * @param {{ missions?: number, roster?: number, reviews?: number, findings?: number, messages?: number }} [options]
 */
function buildStateArb(options = {}) {
  const min = {
    missions: options.missions ?? 0,
    roster: options.roster ?? 0,
    reviews: options.reviews ?? 0,
    findings: options.findings ?? 0,
    messages: options.messages ?? 0,
  }
  return fc
    .record({
      revision: countArb,
      base: branchNameArb,
      repoRoot: posixPathArb,
      commonDir: posixPathArb,
      createdAt: timestampArb,
      updatedAt: timestampArb,
      dirtyBase: fc.boolean(),
      caseInsensitive: fc.oneof(fc.boolean(), fc.constant(null)),
      towerAgentId: fc.option(fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/), { nil: null }),
      snapshotCommit: fc.option(commitShaArb, { nil: null }),
      snapshotRef: fc.option(snapshotRefArb, { nil: null }),
      missions: fc.uniqueArray(missionArb, {
        selector: (mission) => mission.id,
        minLength: min.missions,
        maxLength: 5,
      }),
      roster: fc.uniqueArray(rosterEntryArb, {
        selector: (entry) => entry.name,
        minLength: min.roster,
        maxLength: 4,
      }),
      reviews: fc.uniqueArray(reviewArb, {
        selector: (review) => review.id,
        minLength: min.reviews,
        maxLength: 4,
      }),
      findings: fc.uniqueArray(findingArb, {
        selector: (finding) => finding.id,
        minLength: min.findings,
        maxLength: 4,
      }),
      messages: fc.uniqueArray(messageArb, {
        selector: (message) => message.id,
        minLength: min.messages,
        maxLength: 4,
      }),
      batches: fc.array(batchArb, { maxLength: 2 }),
      messageSeq: countArb,
      reviewSeq: countArb,
      findingSeq: countArb,
      batchSeq: countArb,
      deliverySeq: countArb,
      mergeIntent: fc.constant(null),
      rebaseIntent: fc.constant(null),
    })
    .map((state) => ({
      schemaVersion: 3,
      ...state,
    }))
}

/** A generated state document; collections may be empty. */
export const stateArb = buildStateArb()

/** A generated state with at least one mission. */
export const stateWithMissionsArb = buildStateArb({ missions: 1 })

/** A generated state with at least one roster row. */
export const stateWithRosterArb = buildStateArb({ roster: 1 })

/** A generated state with at least two roster rows (for duplicate-agent tests). */
export const stateWithRosterPairArb = buildStateArb({ roster: 2 })

/** A generated state with at least one review. */
export const stateWithReviewsArb = buildStateArb({ reviews: 1 })

/** A generated state with at least one finding. */
export const stateWithFindingsArb = buildStateArb({ findings: 1 })

/** A generated state with at least one message. */
export const stateWithMessagesArb = buildStateArb({ messages: 1 })
