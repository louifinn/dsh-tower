// Pure completion gate checks (#49). No repository I/O.
import { isTerminal } from './mission.js'

export function completionBlockers(mission, config = {}) {
  const blockers = []
  const push = (code, detail) => blockers.push({ code, detail })
  if (isTerminal(mission.status)) {
    push(
      'branch-owned-by-closed-missions',
      `mission ${mission.id} is ${mission.status}; a merge never flips a closed mission — re-plan the work under a new title`,
    )
  }
  if (mission.status !== 'completed') {
    push('mission-not-completed', `mission ${mission.id} is ${mission.status}; completion is required`)
  }
  const openTasks = (mission.tasks ?? []).filter((task) => task.status === 'open')
  if (openTasks.length > 0) {
    push('tasks-open', `${openTasks.length} open task(s): ${openTasks.map((task) => task.text).join('; ')}`)
  }
  if ((mission.blockers ?? []).length > 0) push('blockers-present', mission.blockers.join('; '))
  if (config.gates?.requireChecks === true) {
    const checks = mission.completionReport?.checks ?? []
    if (checks.length === 0) {
      push('no-check-evidence', `mission ${mission.id} has no completion checks; gates.requireChecks is enabled`)
    }
  }
  return blockers
}
