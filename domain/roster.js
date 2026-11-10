// Pure roster predicates.
// @ts-check
import { isWorkerRole, roleCountsTowardBudget } from './roles.js'
import { shapeFor } from './shapes/index.js'

/** @typedef {import('../types/index.js').RosterEntry} RosterEntry */
/** @typedef {import('../types/index.js').TowerState} TowerState */

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
    (entry) => entry.missionId === missionId && isWorkerRole(entry.role) && !ROSTER_INACTIVE.has(entry.state),
  )
}

/**
 * @param {TowerState} state
 * @param {string} missionId
 * @returns {RosterEntry[]}
 */
export function workerEntries(state, missionId) {
  return (state.roster ?? []).filter((entry) => entry.missionId === missionId && isWorkerRole(entry.role))
}

/**
 * @param {TowerState} state
 * @returns {number}
 */
export function countLiveWorkers(state) {
  const kinds = new Map((state.missions ?? []).map((mission) => [mission.id, mission.kind]))
  return (state.roster ?? []).filter(
    (entry) =>
      roleCountsTowardBudget(entry.role, shapeFor(kinds.get(entry.missionId ?? ''))) &&
      !ROSTER_INACTIVE.has(entry.state) &&
      entry.state !== 'reserved',
  ).length
}
