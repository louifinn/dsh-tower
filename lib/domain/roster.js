// Pure roster predicates.
export const ROSTER_INACTIVE_STATES = ['retired', 'failed', 'interrupted', 'missing', 'stale', 'inactive']
export const ROSTER_INACTIVE = new Set(ROSTER_INACTIVE_STATES)

export function liveWorkerEntry(state, missionId) {
  return (state.roster ?? []).find(
    (entry) => entry.missionId === missionId && entry.role === 'worker' && !ROSTER_INACTIVE.has(entry.state),
  )
}

export function workerEntries(state, missionId) {
  return (state.roster ?? []).filter((entry) => entry.missionId === missionId && entry.role === 'worker')
}

export function countLiveWorkers(state) {
  return (state.roster ?? []).filter(
    (entry) => entry.role === 'worker' && !ROSTER_INACTIVE.has(entry.state) && entry.state !== 'reserved',
  ).length
}
