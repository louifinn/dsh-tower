// Pure mission vocabulary (#49). No fs, git, or config.
//
// Per-kind status policy lives in `./shapes/` (#149): this module keeps only the
// vocabulary every kind shares. `isTerminal(kind, status)` and
// `canTransition(kind, from, to)` are exported from `./shapes/index.js`.
// @ts-check

/** @typedef {import('../types/index.js').FindingSeverity} FindingSeverity */
/** @typedef {import('../types/index.js').FindingStatus} FindingStatus */
/** @typedef {import('../types/index.js').FindingType} FindingType */
/** @typedef {import('../types/index.js').MergeVerdict} MergeVerdict */
/** @typedef {import('../types/index.js').MissionStatus} MissionStatus */

import { SHAPE_KINDS, shapeFor } from './shapes/index.js'

/**
 * The union of every shape's status vocabulary, in registry order. A build
 * mission can be `merged`; a survey cannot, but the union names the word.
 * @type {readonly MissionStatus[]}
 */
export const MISSION_STATUSES = /** @type {import('../types/index.js').MissionStatus[]} */ (
  [...new Set(SHAPE_KINDS.flatMap((kind) => shapeFor(kind).statuses))]
)
export const SCHEMA_VERSION = 4
/** @type {readonly MergeVerdict[]} */
export const MERGE_VERDICTS = ['merge', 'fix-then-merge', 'hold']
// #115: the review status vocabulary is one runtime source. The validator
// accepts any positive item count (`p1-7items`), while the published
// `ReviewStatus` type is generated from REVIEW_STATUS_ITEMS, which fixes the
// documented 1..5 range so a consumer sees a closed union.
export const REVIEW_STATUS_PRIORITIES = ['p1', 'p2']
export const REVIEW_STATUS_ITEMS = [1, 2, 3, 4, 5]
/** @type {readonly string[]} */
export const REVIEW_STATUSES = [
  'clean',
  ...REVIEW_STATUS_PRIORITIES.flatMap((priority) => REVIEW_STATUS_ITEMS.map((count) => `${priority}-${count}items`)),
]
export const REVIEW_STATUS_RE = new RegExp(`^(?:clean|(?:${REVIEW_STATUS_PRIORITIES.join('|')})-\\d+items)$`)
/** @type {readonly FindingType[]} */
export const FINDING_TYPES = ['bug', 'improve', 'vuln', 'idea']
/** @type {readonly FindingSeverity[]} */
export const FINDING_SEVERITIES = ['low', 'medium', 'high', 'critical']
/** @type {readonly FindingStatus[]} */
export const FINDING_STATUSES = ['open', 'triaged', 'fixed', 'wontfix']
/** @type {Record<string, readonly string[]>} */
export const FINDING_TRANSITIONS = {
  open: ['triaged', 'fixed', 'wontfix'],
  triaged: ['open', 'fixed', 'wontfix'],
  fixed: ['open'],
  wontfix: ['open'],
}
/** @type {readonly string[]} */
export const PAUSE_CAUSES = ['user', 'failure', 'resource', 'dependency']

/**
 * @param {string | null | undefined} [value]
 * @returns {string | null}
 */
export function pauseCauseError(value) {
  if (value === undefined || value === null || value === '') return null
  return PAUSE_CAUSES.includes(value) ? null : `pause_cause must be one of ${PAUSE_CAUSES.join('|')}`
}
