// Arbitraries for one finding row (`state.findings` / the `Finding` type).
//
// `type`, `severity` and `status` come from the domain vocabulary, so a
// generated row is always one the finding lifecycle could have produced.
import fc from 'fast-check'

import { missionIdArb, rosterNameArb } from './mission.mjs'
import { branchNameArb } from './commitSha.mjs'
import { findingSeverityArb, findingStatusArb, findingTypeArb } from './status.mjs'

/** Finding ids are the tower's `F<n>` sequence. */
export const findingIdArb = fc.integer({ min: 1, max: 999 }).map((value) => `F${value}`)

const timestampArb = fc.integer({ min: 0, max: 2_000_000_000_000 })

const findingTitleArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .,:_()/'+-]{0,60}$/)

/** One reported finding, with the optional lifecycle fields. */
export const findingArb = fc.record({
  id: findingIdArb,
  type: findingTypeArb,
  title: findingTitleArb,
  severity: findingSeverityArb,
  status: findingStatusArb,
  missionId: fc.option(missionIdArb, { nil: undefined }),
  branch: fc.option(branchNameArb, { nil: undefined }),
  reportedBy: fc.option(rosterNameArb, { nil: undefined }),
  at: timestampArb,
  updatedAt: timestampArb,
  closedAt: fc.option(timestampArb, { nil: undefined }),
  summary: fc.string({ maxLength: 120 }),
  details: fc.string({ maxLength: 400 }),
  suggestedFix: fc.string({ maxLength: 200 }),
  location: fc.option(fc.stringMatching(/^[A-Za-z0-9_/.-]{1,60}$/), { nil: undefined }),
})
