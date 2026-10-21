// Pure teardown decisions: keep/remove eligibility and the revalidation of a
// prepared candidate. Worktree ownership checks and git removals stay in
// app/teardown.js.
// @ts-check
import { hasLiveAgent } from './liveness.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').TowerState} TowerState */

export const STALE_TEARDOWN = 'tower state changed while teardown was being prepared; retry'

/** @typedef {{ missionId: string, action: string, reason?: string, forced?: boolean }} Decision */

/**
 * Replace a decision object in place so mission order is preserved.
 * @param {Decision} decision
 * @param {Record<string, unknown>} value
 * @returns {void}
 */
export function replaceDecision(decision, value) {
  const missionId = decision.missionId
  for (const key of Object.keys(decision)) delete /** @type {Record<string, unknown>} */ (decision)[key]
  Object.assign(decision, { missionId, ...value })
}

/**
 * Snapshot-only eligibility before ownership/dirty diagnostics run.
 * `skip` means the mission has no removable worktree; `decision` is a keep
 * outcome; `proceed` means the caller must run the ownership/dirty checks.
 * @param {Mission} mission
 * @param {object} input
 * @param {boolean} [input.excluded]
 * @param {boolean} [input.hasLiveAgent]
 * @returns {{ skip: true } | { decision: Decision } | { proceed: true }}
 */
export function teardownPrecheck(mission, { excluded = false, hasLiveAgent = false } = {}) {
  const record = /** @type {Record<string, any>} */ (mission)
  if (!record.worktree || record.worktreeRemovedAt) return { skip: true }
  if (excluded) return { decision: { missionId: mission.id, action: 'keep', reason: 'excluded' } }
  if (hasLiveAgent) return { decision: { missionId: mission.id, action: 'keep', reason: 'live agent' } }
  if (!['merged', 'abandoned'].includes(mission.status)) {
    return { decision: { missionId: mission.id, action: 'keep', reason: `mission is ${mission.status}` } }
  }
  return { proceed: true }
}

/**
 * @param {string} missionId
 * @param {unknown} error
 * @returns {Decision}
 */
export function ownershipUnverifiedDecision(missionId, error) {
  return {
    missionId,
    action: 'keep',
    reason: `worktree ownership/registration unverified: ${String(/** @type {{ message?: unknown }} */ (error)?.message ?? error).slice(0, 240)}`,
  }
}

/**
 * @param {boolean} dirty
 * @param {boolean} [force]
 * @returns {{ action: 'keep', reason: string } | null}
 */
export function teardownDirtyDecision(dirty, force) {
  return dirty && force !== true ? { action: 'keep', reason: 'uncommitted changes' } : null
}

/**
 * @param {boolean} dirty
 * @returns {{ action: 'remove', reason: 'eligible', forced: boolean }}
 */
export function teardownRemoveDecision(dirty) {
  return { action: 'remove', reason: 'eligible', forced: dirty }
}

/**
 * Revalidate a prepared candidate against the current state. Used both before
 * the git lock and again after re-reading state inside it.
 * @param {TowerState} state
 * @param {{ missionId: string, worktree: { path: string } }} candidate
 * @param {Record<string, string | undefined>} [activity]
 * @returns {{ ok: true, mission: Mission } | { ok: false, reason: string }}
 */
export function revalidateTeardownCandidate(state, candidate, activity = {}) {
  const mission = state.missions.find((entry) => entry.id === candidate.missionId)
  const record = mission ? /** @type {Record<string, any>} */ (mission) : null
  if (!record || !record.worktree || record.worktreeRemovedAt) return { ok: false, reason: 'worktree is already gone' }
  if (record.worktree.path !== candidate.worktree.path) {
    return { ok: false, reason: 'worktree path changed during teardown' }
  }
  if (!['merged', 'abandoned'].includes(record.status)) return { ok: false, reason: `mission is ${record.status}` }
  if (hasLiveAgent(state, record.id, activity)) return { ok: false, reason: 'live agent' }
  return { ok: true, mission: /** @type {Mission} */ (mission) }
}

/**
 * @param {object} input
 * @param {string} input.branch
 * @param {string | null} [input.branchDeleteError]
 * @returns {{ action: 'removed', branch: string, branchRetained?: true, branchDeleteError?: string }}
 */
export function teardownRemovedDecision({ branch, branchDeleteError = null }) {
  return {
    action: 'removed',
    branch,
    ...(branchDeleteError ? { branchRetained: true, branchDeleteError } : {}),
  }
}

/**
 * @param {string} branch
 * @param {string | null} [branchDeleteError]
 * @returns {string}
 */
export function teardownActivityText(branch, branchDeleteError = null) {
  return `${branch}${branchDeleteError ? ' (branch retained)' : ''}`
}
