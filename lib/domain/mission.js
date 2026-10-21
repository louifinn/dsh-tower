// Pure mission vocabulary and transition rules (#49). No fs, git, or config.
export const MISSION_STATUSES = ['planned', 'active', 'completed', 'blocked', 'paused', 'merged', 'abandoned']
export const TERMINAL_STATUSES = new Set(['merged', 'abandoned'])
export const FINDING_STATUSES = ['open', 'triaged', 'fixed', 'wontfix']
export const PAUSE_CAUSES = ['user', 'failure', 'resource', 'dependency']
export const TRANSITIONS = {
  planned: ['active', 'abandoned'],
  active: ['completed', 'blocked', 'paused', 'abandoned'],
  blocked: ['active', 'paused', 'completed', 'abandoned'],
  paused: ['active', 'abandoned'],
  completed: ['active', 'abandoned'],
  merged: [],
  abandoned: [],
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(status)
}

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to)
}

export function pauseCauseError(value) {
  if (value === undefined || value === null || value === '') return null
  return PAUSE_CAUSES.includes(value) ? null : `pause_cause must be one of ${PAUSE_CAUSES.join('|')}`
}
