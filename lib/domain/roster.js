// Pure roster predicates.
// @ts-check

/** @typedef {import('../../types/index.js').RosterEntry} RosterEntry */
/** @typedef {import('../../types/index.js').TowerState} TowerState */

/** @type {readonly string[]} */
export const ROSTER_INACTIVE_STATES = ['retired', 'failed', 'interrupted', 'missing', 'stale', 'inactive']
/** @type {ReadonlySet<string>} */
export const ROSTER_INACTIVE = new Set(ROSTER_INACTIVE_STATES)

/**
 * @param {TowerState} state
 * @param {string} missionId
 * @returns {RosterEntry | undefined}
 */
export function liveWorkerEntry(state, missionId) {
  return (state.roster ?? []).find(
    (entry) => entry.missionId === missionId && entry.role === 'worker' && !ROSTER_INACTIVE.has(entry.state),
  )
}

/**
 * @param {TowerState} state
 * @param {string} missionId
 * @returns {RosterEntry[]}
 */
export function workerEntries(state, missionId) {
  return (state.roster ?? []).filter((entry) => entry.missionId === missionId && entry.role === 'worker')
}

/**
 * @param {TowerState} state
 * @returns {number}
 */
export function countLiveWorkers(state) {
  return (state.roster ?? []).filter(
    (entry) => entry.role === 'worker' && !ROSTER_INACTIVE.has(entry.state) && entry.state !== 'reserved',
  ).length
}
