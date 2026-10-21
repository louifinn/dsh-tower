// Pure worker-completion policy and check normalization.
//
// app/checkCompletion.js still loads state, verifies the worktree/commits with
// Git, and persists the transition; the rules below are repository-free.
// @ts-check
import { TowerToolError } from '../errors.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').RosterEntry} RosterEntry */

/**
 * @param {string} message
 * @param {string} [code]
 * @returns {never}
 */
function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Normalize `tower_complete` check evidence.
 * @param {any} checks
 * @returns {any[]}
 */
export function normalizeChecks(checks) {
  if (checks === undefined) return []
  if (!Array.isArray(checks)) fail('checks must be an array')
  if (checks.length > 20) fail('checks may contain at most 20 entries')
  return checks.map((check, index) => {
    if (!isPlainObject(check)) fail(`checks[${index}] must be an object`)
    const name = typeof check.name === 'string' ? check.name.trim() : ''
    if (!name) fail(`checks[${index}].name must be a non-empty string`)
    /** @type {Record<string, any>} */
    const entry = { name }
    if (typeof check.command === 'string' && check.command.trim()) entry.command = check.command.trim()
    if (check.exitCode !== undefined && check.exitCode !== null) {
      if (!Number.isInteger(check.exitCode)) fail(`checks[${index}].exitCode must be an integer`)
      entry.exitCode = check.exitCode
    }
    if (typeof check.evidence === 'string' && check.evidence.trim()) entry.evidence = check.evidence.trim().slice(0, 4000)
    return entry
  })
}

/**
 * Resolve and validate the reporting worker and the mission's completion
 * preconditions that need no repository access.
 * @param {{ mission: Mission, roster: RosterEntry[] | undefined, input: any }} params
 * @returns {RosterEntry}
 */
export function assertCompletionRequest({ mission, roster, input }) {
  const worker = (roster ?? []).find((entry) => entry.agentId === input.agentId)
  if (!worker || worker.missionId !== mission.id) {
    fail(`agent ${input.agentId} is not assigned to mission ${mission.id}`)
  }
  if (worker.role !== 'worker') fail(`agent ${worker.name} is a ${worker.role}, not a worker`)
  if (['retired', 'failed', 'interrupted', 'missing', 'stale'].includes(worker.state)) {
    fail(`agent ${worker.name} is ${worker.state}; a stopped worker cannot report completion`)
  }
  if (mission.owner && mission.owner !== worker.name) {
    fail(`agent ${worker.name} is not the current owner of mission ${mission.id} (owner: ${mission.owner})`)
  }
  if (mission.status === 'completed') fail(`mission ${mission.id} is already completed`)
  if (!['active', 'planned'].includes(mission.status)) {
    fail(`mission ${mission.id} is ${mission.status}; it cannot be completed from that state`)
  }
  if (typeof input.report !== 'string' || input.report.trim().length === 0) {
    fail('tower_complete requires a non-empty report')
  }
  const openTasks = (mission.tasks ?? []).filter((task) => task.status === 'open')
  if (openTasks.length > 0) {
    fail(
      `mission ${mission.id} still has ${openTasks.length} open task(s): ${openTasks
        .map((task) => task.text)
        .join('; ')}`,
    )
  }
  const blockers = mission.blockers ?? []
  if (blockers.length > 0) {
    fail(`mission ${mission.id} has unresolved blockers: ${blockers.join('; ')}`)
  }
  if (!mission.worktree) fail(`mission ${mission.id} has no worktree`)
  return worker
}

/**
 * Unread inbox messages block completion.
 * @param {{ mission: Mission, worker: RosterEntry, unread: unknown[] }} params
 * @returns {void}
 */
export function assertCompletionInbox({ mission, worker, unread }) {
  if (unread.length > 0) {
    fail(
      `mission ${mission.id} cannot complete with ${unread.length} unread inbox message(s) for ${worker.name}; call tower_inbox until unread is 0, incorporate them, then retry`,
    )
  }
}

/**
 * Project the completion report stored on the mission.
 * @param {{ report: string, worker: RosterEntry, checks: any[], now: number }} params
 * @returns {any}
 */
export function completionReport({ report, worker, checks, now }) {
  return { report: report.trim(), by: worker.name, at: now, checks }
}
