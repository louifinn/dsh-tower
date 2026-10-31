// Arbitraries for a whole `state.json` document, as accepted by
// `stateShapeError` and `assertStateSemantics`.
//
// Ids are unique per collection (those are the only cross-row invariants the
// schema enforces), and no value points at a real on-disk path or repository.
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
 * A full state document. Every optional top-level field the schema accepts is
 * populated, so a passing property covers the whole shape at once.
 */
export const stateArb = fc
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
    missions: fc.uniqueArray(missionArb, { selector: (mission) => mission.id, maxLength: 5 }),
    roster: fc.uniqueArray(rosterEntryArb, { selector: (entry) => entry.name, maxLength: 4 }),
    reviews: fc.uniqueArray(reviewArb, { selector: (review) => review.id, maxLength: 4 }),
    findings: fc.uniqueArray(findingArb, { selector: (finding) => finding.id, maxLength: 4 }),
    messages: fc.uniqueArray(messageArb, { selector: (message) => message.id, maxLength: 4 }),
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
