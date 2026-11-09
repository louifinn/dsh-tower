// Role vocabulary (#149). Roles are decided from one place so generic layers do
// not compare against role strings: the shape audit refuses `role === 'worker'`
// outside this module. `domain/vocabulary.js` re-exports these constants for the
// public vocabulary surface; `domain/roster.js` imports them directly so the
// roster/vocabulary cycle does not exist.
export const ROLE = Object.freeze({
  tower: 'tower',
  worker: 'worker',
  reviewer: 'reviewer',
  unknown: 'unknown',
})

/** Roles a spawned child may have. */
export const ROLES = Object.freeze([ROLE.worker, ROLE.reviewer])

/** Every actor role a tool may see. */
export const ACTOR_ROLES = Object.freeze([ROLE.tower, ROLE.worker, ROLE.reviewer, ROLE.unknown])

export const DEFAULT_ROLE = ROLE.worker

/** @param {unknown} role */
export function isTowerRole(role) {
  return role === ROLE.tower
}

/** @param {unknown} role */
export function isWorkerRole(role) {
  return role === ROLE.worker
}

/** @param {unknown} role */
export function isReviewerRole(role) {
  return role === ROLE.reviewer
}

/** @param {unknown} role */
export function isUnknownRole(role) {
  return role === ROLE.unknown
}
