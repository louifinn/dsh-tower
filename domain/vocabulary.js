// Pure shared vocabulary (#56 P5): every status/type/action enum used by the
// tool contracts and handlers. Keeping one canonical value set here lets
// tools/** import constants/predicates instead of spelling literals.
// No fs, git, or config.
// @ts-check

import {
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FINDING_TYPES,
  MERGE_VERDICTS,
  MISSION_STATUSES,
  PAUSE_CAUSES,
} from './mission.js'
import { ROSTER_INACTIVE_STATES } from './roster.js'

export {
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FINDING_TYPES,
  MERGE_VERDICTS,
  MISSION_STATUSES,
  PAUSE_CAUSES,
  ROSTER_INACTIVE_STATES,
}

// Mission inputs accepted by tower_plan.
/** @type {readonly string[]} */
export const MISSION_KINDS = ['build', 'survey']
/** @type {readonly string[]} */
export const REVIEW_POLICIES = ['required-clean', 'none']

// Roster actors (the caller resolved by actorFor) and createable agent roles.
export const ROLE = Object.freeze({
  tower: 'tower',
  worker: 'worker',
  reviewer: 'reviewer',
  unknown: 'unknown',
})
/** @type {readonly string[]} */
export const ROLES = Object.freeze([ROLE.worker, ROLE.reviewer])
/** @type {readonly string[]} */
export const ACTOR_ROLES = Object.freeze([ROLE.tower, ROLE.worker, ROLE.reviewer, ROLE.unknown])
export const DEFAULT_ROLE = ROLE.worker

/** @param {string | null | undefined} role */
export function isTowerRole(role) {
  return role === ROLE.tower
}

/** @param {string | null | undefined} role */
export function isWorkerRole(role) {
  return role === ROLE.worker
}

/** @param {string | null | undefined} role */
export function isReviewerRole(role) {
  return role === ROLE.reviewer
}

/** @param {string | null | undefined} role */
export function isUnknownRole(role) {
  return role === ROLE.unknown
}

// Inbox recipients: a roster name, the tower, or a broadcast.
export const RECIPIENT = Object.freeze({ tower: ROLE.tower, all: 'all' })

/** @param {string | null | undefined} to */
export function isTowerRecipient(to) {
  return to === RECIPIENT.tower
}

/** @param {string | null | undefined} to */
export function isBroadcast(to) {
  return to === RECIPIENT.all
}

// Action discriminators for the repository tools.
export const BATCH_ACTION = Object.freeze({
  create: 'create',
  status: 'status',
  close: 'close',
  abandon: 'abandon',
})
/** @type {readonly string[]} */
export const BATCH_ACTIONS = Object.freeze(Object.values(BATCH_ACTION))

export const RECOVERY_ACTION = Object.freeze({ status: 'status', clearStaleLock: 'clear-stale-lock' })
/** @type {readonly string[]} */
export const RECOVERY_ACTIONS = Object.freeze(Object.values(RECOVERY_ACTION))
export const RECOVERY_CONFIRM = 'CLEAR_STALE_LOCK'

export const LEASE_ACTION = Object.freeze({ acquire: 'acquire', release: 'release', status: 'status' })
/** @type {readonly string[]} */
export const LEASE_ACTIONS = Object.freeze(Object.values(LEASE_ACTION))

export const LEGACY_MAP_ACTION = Object.freeze({ map: 'map', status: 'status' })
/** @type {readonly string[]} */
export const LEGACY_MAP_ACTIONS = Object.freeze(Object.values(LEGACY_MAP_ACTION))

export const STATUS_FORMAT = Object.freeze({ json: 'json', markdown: 'markdown' })
/** @type {readonly string[]} */
export const STATUS_FORMATS = Object.freeze(Object.values(STATUS_FORMAT))

/** @param {string | null | undefined} format */
export function isMarkdownFormat(format) {
  return format === STATUS_FORMAT.markdown
}

// Finding filters extend the lifecycle statuses with the read-only "all".
export const FINDING_FILTER_ALL = 'all'
/** @type {readonly string[]} */
export const FINDING_FILTER_STATUSES = Object.freeze([...FINDING_STATUSES, FINDING_FILTER_ALL])

// Test admission modes read from config by tower_spawn/tower_complete.
export const TESTS_ADMISSION = Object.freeze({ off: 'off', spawn: 'spawn', complete: 'complete' })
/** @type {readonly string[]} */
export const TESTS_ADMISSIONS = Object.freeze(Object.values(TESTS_ADMISSION))

/** @param {string | null | undefined} admission */
export function isSpawnAdmission(admission) {
  return admission === TESTS_ADMISSION.spawn
}

/** @param {string | null | undefined} admission */
export function isCompleteAdmission(admission) {
  return admission === TESTS_ADMISSION.complete
}

// Roster row states and observed catalog activity.
export const ROSTER_STATE = Object.freeze({
  reserved: 'reserved',
  active: 'active',
  inactive: 'inactive',
  retired: 'retired',
  failed: 'failed',
  interrupted: 'interrupted',
  missing: 'missing',
  stale: 'stale',
})
export const ROSTER_STATES = Object.freeze([...ROSTER_INACTIVE_STATES, ROSTER_STATE.reserved, ROSTER_STATE.active])
/** States treated as gone by roster reporting, excluding "inactive". */
export const ROSTER_GONE_STATES = Object.freeze([
  ROSTER_STATE.retired,
  ROSTER_STATE.failed,
  ROSTER_STATE.interrupted,
  ROSTER_STATE.missing,
  ROSTER_STATE.stale,
])
export const ROSTER_ACTIVITY = Object.freeze({
  running: 'running',
  inactive: 'inactive',
  missing: 'missing',
  unknown: 'unknown',
})
export const PARENT_STATUS_OK = 'ok'

/** @param {string | null | undefined} state */
export function isReservedState(state) {
  return state === ROSTER_STATE.reserved
}

/** @param {string | null | undefined} activity */
export function isRunningActivity(activity) {
  return activity === ROSTER_ACTIVITY.running
}

// Spawn completion outcomes recorded in the roster.
export const SPAWN_OUTCOME = Object.freeze({ failed: 'failed', inactive: 'inactive' })
export const STOP_REASON = Object.freeze({ completed: 'completed' })

/** @param {string | null | undefined} reason */
export function isCompletedStopReason(reason) {
  return reason === STOP_REASON.completed
}

// Doctor check severities.
export const DOCTOR_STATUS = Object.freeze({ pass: 'pass', warn: 'warn', fail: 'fail' })
