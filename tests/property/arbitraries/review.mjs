// Arbitraries for one review row (`state.reviews` / the `Review` type).
//
// `status` and `mergeVerdict` are always present and always vocabulary-valid:
// a review with an unknown status or verdict is `state-corrupt`.
import fc from 'fast-check'

import { commitShaArb, branchNameArb } from './commitSha.mjs'
import { missionIdArb } from './mission.mjs'
import { mergeVerdictArb, reviewStatusArb } from './status.mjs'

/** Review ids are the tower's `R<n>` sequence. */
export const reviewIdArb = fc.integer({ min: 1, max: 999 }).map((value) => `R${value}`)

const timestampArb = fc.integer({ min: 0, max: 2_000_000_000_000 })

/** One review round bound to a mission branch tip. */
export const reviewArb = fc.record({
  id: reviewIdArb,
  seq: fc.integer({ min: 0, max: 10_000 }),
  missionId: missionIdArb,
  branch: branchNameArb,
  round: fc.integer({ min: 1, max: 5 }),
  status: reviewStatusArb,
  mergeVerdict: mergeVerdictArb,
  reviewedCommit: commitShaArb,
  at: timestampArb,
  findings: fc.array(fc.string({ maxLength: 80 }), { maxLength: 3 }),
  checks: fc.array(fc.string({ maxLength: 60 }), { maxLength: 3 }),
  decision: fc.string({ maxLength: 120 }),
  reviewer: fc.option(fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/), { nil: undefined }),
  reviewerRole: fc.constantFrom('reviewer', 'tower'),
})
