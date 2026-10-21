// Pure roster-liveness decisions shared by rebase/teardown guards. A live
// worker is a roster row for the mission that is neither inactive nor finished
// and whose observed activity is "running".
// @ts-check
import { ROSTER_INACTIVE } from '../roster.js'

/** @typedef {import('../../types/index.js').RosterEntry} RosterEntry */
/** @typedef {import('../../types/index.js').TowerState} TowerState */

/**
 * @param {TowerState} state
 * @param {string} missionId
 * @param {Record<string, string | undefined>} activity
 * @returns {RosterEntry | undefined}
 */
export function liveAgentFor(state, missionId, activity) {
  return (state.roster ?? []).find(
    (entry) =>
      entry.missionId === missionId && !ROSTER_INACTIVE.has(entry.state) && activity[String(entry.agentId)] === 'running',
  )
}

/**
 * @param {TowerState} state
 * @param {string} missionId
 * @param {Record<string, string | undefined>} activity
 * @returns {boolean}
 */
export function hasLiveAgent(state, missionId, activity) {
  return liveAgentFor(state, missionId, activity) !== undefined
}
