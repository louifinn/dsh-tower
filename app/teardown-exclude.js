// #186: exclude ids that match nothing.
//
// `tower_teardown({ exclude })` keeps whatever the ids name. A typo used to keep
// nothing at all and say nothing about it, so this module answers "which ids
// matched nothing" and the caller turns each into a visible keep decision.
// @ts-check

/**
 * @param {any} state
 * @param {unknown[] | undefined} exclude
 * @returns {{ ids: string[], decisions: any[] }}
 */
export function unmatchedExclusions(state, exclude) {
  const requested = []
  const seen = new Set()
  for (const value of exclude ?? []) {
    const id = String(value)
    if (seen.has(id)) continue
    seen.add(id)
    requested.push(id)
  }
  if (requested.length === 0) return { ids: [], decisions: [] }
  const known = new Set((state.missions ?? []).map((/** @type {any} */ mission) => String(mission.id)))
  for (const entry of state.roster ?? []) {
    if (entry.missionId != null) known.add(String(entry.missionId))
  }
  const ids = requested.filter((id) => !known.has(id))
  return {
    ids,
    decisions: ids.map((missionId) => ({ missionId, action: 'keep', reason: 'exclude did not match any mission' })),
  }
}
