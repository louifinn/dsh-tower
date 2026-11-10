// Dependency freshness (#148 W2 / D5): a build that depends on a survey wants
// the survey's evidence to describe the code it starts from. A survey records
// the exact commit it read; when that commit is not an ancestor-or-equal of the
// build's base, the evidence may be stale. This is advisory by default and a
// blocker only when `gates.requireFreshSurvey` is true.
// @ts-check
import { shapeFor } from '../domain/shapes/index.js'

/**
 * @typedef {import('../types/index.js').Mission} Mission
 * @typedef {import('../types/index.js').TowerState} TowerState
 */

/**
 * One stable, self-describing freshness warning. The same shape is promoted to a
 * blocker (with `detail` carrying the message) when the gate asks for it.
 * @param {{ missionId: string, dep: { id: string }, readCommit: string, baseCommit: string }} input
 * @returns {{ code: 'survey-stale', missionId: string, depId: string, readCommit: string, baseCommit: string, message: string }}
 */
export function surveyStaleWarning({ missionId, dep, readCommit, baseCommit }) {
  const read = String(readCommit).slice(0, 12)
  const base = String(baseCommit).slice(0, 12)
  return {
    code: 'survey-stale',
    missionId,
    depId: dep.id,
    readCommit,
    baseCommit,
    message: `survey ${dep.id} read ${read}, which is not an ancestor of ${missionId}'s base ${base}; the survey evidence may not describe the code this mission starts from — re-plan the survey against the current base, or record why the read is still valid`,
  }
}

/**
 * Compute `survey-stale` warnings for one build mission's survey dependencies.
 * A survey dependency is recognised through the shape contract (`fields.readCommit`),
 * not a kind literal. The base is `mission.baseCommit` for a provisioned build,
 * otherwise the current state base (resolved once by the caller or here).
 * @param {any} tower
 * @param {object} input
 * @param {Mission} input.mission
 * @param {TowerState} input.state
 * @param {Mission[]} [input.missions]
 * @param {Map<string, { id?: string, status: string, kind?: string, readCommit?: string }>} [input.archived]
 * @param {string | null} [input.baseCommit] already-resolved build base
 * @returns {Promise<Array<ReturnType<typeof surveyStaleWarning>>>}
 */
export async function surveyStaleWarnings(tower, { mission, state, missions, archived = new Map(), baseCommit = null }) {
  if (!shapeFor(mission.kind).fields.worktree) return []
  const deps = mission.deps ?? []
  if (deps.length === 0) return []
  let base = baseCommit ?? /** @type {any} */ (mission).baseCommit ?? null
  if (typeof base !== 'string' || base.length === 0) {
    try {
      base = await tower.revParse(tower.root, state.base)
    } catch {
      return []
    }
  }
  const byId = new Map((missions ?? state.missions).map((entry) => [entry.id, entry]))
  /** @type {Array<ReturnType<typeof surveyStaleWarning>>} */
  const warnings = []
  for (const depId of deps) {
    const dep = byId.get(depId) ?? archived.get(depId)
    if (!dep || !shapeFor(dep.kind).fields.readCommit) continue
    const readCommit = typeof /** @type {any} */ (dep).readCommit === 'string' ? /** @type {any} */ (dep).readCommit : null
    if (!readCommit) continue
    let fresh = false
    try {
      fresh = await tower.isAncestor(tower.root, readCommit, base)
    } catch {
      fresh = false
    }
    if (fresh) continue
    warnings.push(surveyStaleWarning({ missionId: mission.id, dep: /** @type {{ id: string }} */ (dep), readCommit, baseCommit: base }))
  }
  return warnings
}
