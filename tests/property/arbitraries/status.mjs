// Arbitraries for the closed status vocabularies owned by domain/mission.js.
//
// These mirror the runtime constants instead of re-declaring them: a status
// added to the domain automatically becomes reachable in every generated
// mission, review, finding or state document.
import fc from 'fast-check'

import {
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FINDING_TYPES,
  MERGE_VERDICTS,
  MISSION_STATUSES,
  PAUSE_CAUSES,
  REVIEW_STATUSES,
  isTerminal,
} from '../../../domain/mission.js'

/** Any documented mission status, including the terminal ones. */
export const missionStatusArb = fc.constantFrom(...MISSION_STATUSES)

/** Non-terminal statuses only: a merged/abandoned mission no longer owns work. */
export const openMissionStatusArb = fc.constantFrom(...MISSION_STATUSES.filter((status) => !isTerminal(status)))

/** `clean`, `p1-Nitems`, `p2-Nitems` (1 <= N <= 5), exactly as the review gate parses. */
export const reviewStatusArb = fc.constantFrom(...REVIEW_STATUSES)

/** The documented merge verdicts; a review row without one is invalid. */
export const mergeVerdictArb = fc.constantFrom(...MERGE_VERDICTS)

export const reviewPolicyArb = fc.constantFrom('required-clean', 'none')

export const missionKindArb = fc.constantFrom('build', 'survey')

export const taskStatusArb = fc.constantFrom('open', 'done', 'dropped')

export const pauseCauseArb = fc.constantFrom(...PAUSE_CAUSES)

export const findingTypeArb = fc.constantFrom(...FINDING_TYPES)

export const findingSeverityArb = fc.constantFrom(...FINDING_SEVERITIES)

export const findingStatusArb = fc.constantFrom(...FINDING_STATUSES)
