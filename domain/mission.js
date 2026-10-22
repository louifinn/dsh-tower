// Pure mission vocabulary and transition rules (#49). No fs, git, or config.
// @ts-check

/** @typedef {import('../types/index.js').FindingSeverity} FindingSeverity */
/** @typedef {import('../types/index.js').FindingStatus} FindingStatus */
/** @typedef {import('../types/index.js').FindingType} FindingType */
/** @typedef {import('../types/index.js').MergeVerdict} MergeVerdict */
/** @typedef {import('../types/index.js').MissionStatus} MissionStatus */

/** @type {readonly MissionStatus[]} */
export const MISSION_STATUSES = ['planned', 'active', 'completed', 'blocked', 'paused', 'merged', 'abandoned']
export const SCHEMA_VERSION = 3
/** @type {readonly MergeVerdict[]} */
export const MERGE_VERDICTS = ['merge', 'fix-then-merge', 'hold']
export const REVIEW_STATUS_RE = /^(clean|p1-\d+items|p2-\d+items)$/
/** @type {ReadonlySet<string>} */
export const TERMINAL_STATUSES = new Set(['merged', 'abandoned'])
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
/** @type {Record<string, readonly string[] | undefined>} */
export const TRANSITIONS = {
  planned: ['active', 'abandoned'],
  active: ['completed', 'blocked', 'paused', 'abandoned'],
  blocked: ['active', 'paused', 'completed', 'abandoned'],
  paused: ['active', 'abandoned'],
  completed: ['active', 'abandoned'],
  merged: [],
  abandoned: [],
}

/**
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminal(status) {
  return TERMINAL_STATUSES.has(status)
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to)
}

/**
 * @param {string | null | undefined} [value]
 * @returns {string | null}
 */
export function pauseCauseError(value) {
  if (value === undefined || value === null || value === '') return null
  return PAUSE_CAUSES.includes(value) ? null : `pause_cause must be one of ${PAUSE_CAUSES.join('|')}`
}
