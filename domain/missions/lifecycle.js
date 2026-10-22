// Pure mission lifecycle transition policy.
//
// app/mission.js supplies the loaded mission/state and persists the result;
// this module owns the authorization and transition rules and mutates only the
// in-memory mission draft it is given.
// @ts-check
import { TowerToolError } from '../errors.js'
import { MISSION_STATUSES, TERMINAL_STATUSES, canTransition, pauseCauseError } from '../mission.js'
import { normalizeScope, scopesOverlap } from '../scope.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').TowerState} TowerState */

const TERMINAL = TERMINAL_STATUSES

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
 * @returns {string}
 */
export function normalizePauseCause(value) {
  const error = pauseCauseError(/** @type {string | null | undefined} */ (value))
  if (error) fail(error)
  return value === undefined || value === null || value === '' ? 'user' : /** @type {string} */ (value)
}

/**
 * Reject actor/input combinations a worker may not perform. The tower owns
 * status, scope, blockers, and pause metadata; a worker only reports work.
 * @param {Mission} mission
 * @param {{ name?: string, role?: string }} actor
 * @param {any} input
 * @returns {void}
 */
export function assertMissionActor(mission, actor, input) {
  const workerRequest = actor.role === 'worker'
  if (actor.role === 'reviewer') {
    fail('only the tower or a worker may update a mission; reviewers submit tower_review', 'not-authorized')
  }
  if (workerRequest && mission.owner && mission.owner !== actor.name) {
    fail(`worker ${actor.name} does not own mission ${mission.id} (owner: ${mission.owner})`, 'not-authorized')
  }
  if (workerRequest) {
    if (input.status !== undefined) {
      fail('only the tower can change mission status directly; workers report completion with tower_complete', 'not-authorized')
    }
    if (input.scope !== undefined) fail('only the tower can change mission scope', 'not-authorized')
    if (input.clear_blockers === true) fail('only the tower can clear blockers', 'not-authorized')
    if (input.pause_cause !== undefined || input.authorization !== undefined) {
      fail('only the tower can record pause/authorization metadata', 'not-authorized')
    }
  }
}

/**
 * Apply one validated `tower_mission` patch to the mission draft and return
 * the human-readable change list used by the activity log.
 * @param {{ mission: Mission, state: TowerState, input: any, config: any }} params
 * @returns {{ changes: string[] }}
 */
export function applyMissionUpdate({ mission, state, input, config }) {
  const actor = input.actor ?? { name: 'tower', role: 'tower' }
  assertMissionActor(mission, actor, input)
  if (input.pause_cause !== undefined && input.status !== 'paused') {
    fail('pause_cause is only valid together with status "paused"')
  }
  if (input.status === 'abandoned' && (typeof input.note !== 'string' || input.note.trim().length === 0)) {
    fail('abandoning a mission requires a non-empty note (reason)')
  }
  /** @type {string[]} */
  const changes = []

  if (input.status !== undefined) {
    if (typeof input.status !== 'string' || !MISSION_STATUSES.includes(input.status)) {
      fail(`unknown mission status "${input.status}"`)
    }
    if (input.status === 'merged') {
      fail('merged is recorded only by tower_merge, not by a generic mission patch', 'invalid-transition')
    }
    if (!canTransition(mission.status, input.status)) {
      fail(`mission ${mission.id} cannot move from ${mission.status} to ${input.status}`, 'invalid-transition')
    }
    if (input.status === 'paused') {
      mission.pauseCause = normalizePauseCause(input.pause_cause)
    }
    if (mission.status === 'paused' && input.status === 'active') {
      const requireAuthorization = config.mode.requireResumeAuthorization === true
      if (requireAuthorization && (mission.pauseCause ?? 'user') === 'user') {
        if (typeof input.authorization !== 'string' || input.authorization.trim().length === 0) {
          fail('resuming a user-paused mission requires a non-empty authorization reference')
        }
      }
      if (typeof input.authorization === 'string' && input.authorization.trim()) {
        mission.authorizationRef = input.authorization.trim()
      }
    }
    mission.status = input.status
    changes.push(`status=${input.status}`)
  }

  if (input.task_done !== undefined) {
    const needle = String(input.task_done)
    const tasks = /** @type {any[]} */ (mission.tasks)
    const task = tasks.find(
      (entry) => entry.status === 'open' && entry.text.toLowerCase().includes(needle.toLowerCase()),
    )
    if (!task) fail(`no open task matching "${needle}" in mission ${mission.id}`)
    task.status = 'done'
    changes.push(`task_done="${task.text}"`)
  }

  if (input.task_drop !== undefined) {
    if (typeof input.task_drop_reason !== 'string' || input.task_drop_reason.trim().length === 0) {
      fail('task_drop requires task_drop_reason')
    }
    const needle = String(input.task_drop)
    const tasks = /** @type {any[]} */ (mission.tasks)
    const task = tasks.find(
      (entry) => entry.status === 'open' && entry.text.toLowerCase().includes(needle.toLowerCase()),
    )
    if (!task) fail(`no open task matching "${needle}" in mission ${mission.id}`)
    task.status = 'dropped'
    task.note = input.task_drop_reason.trim()
    const notes = /** @type {string[]} */ (mission.notes)
    notes.push(`task dropped: ${task.text} — ${task.note}`)
    changes.push(`task_drop="${task.text}"`)
  }

  if (input.blocker !== undefined) {
    if (typeof input.blocker !== 'string' || input.blocker.trim().length === 0) {
      fail('blocker must be a non-empty string')
    }
    if (TERMINAL.has(mission.status)) {
      fail(`mission ${mission.id} is ${mission.status}; a blocker cannot reopen a terminal mission`)
    }
    const blockers = /** @type {string[]} */ (mission.blockers)
    blockers.push(input.blocker.trim())
    mission.status = 'blocked'
    changes.push('blocker added')
  }

  if (input.clear_blockers === true) {
    mission.blockers = []
    changes.push('blockers cleared')
  }

  if (input.note !== undefined) {
    if (typeof input.note !== 'string' || input.note.trim().length === 0) {
      fail('note must be a non-empty string')
    }
    const notes = /** @type {string[]} */ (mission.notes)
    notes.push(input.note.trim())
    changes.push('note added')
  }

  if (input.scope !== undefined) {
    if (!['active', 'completed'].includes(mission.status)) {
      fail(`scope can only be widened for active or completed missions, not ${mission.status}`)
    }
    const scope = normalizeScope(input.scope, { allowEmpty: mission.kind === 'survey' })
    const others = state.missions.filter(
      (entry) => entry.id !== mission.id && !TERMINAL.has(entry.status) && entry.kind !== 'survey',
    )
    const caseInsensitive = state.caseInsensitive === true
    for (const other of others) {
      if (mission.kind !== 'survey' && scopesOverlap(scope, other.scope, { caseInsensitive })) {
        fail(`widened scope overlaps mission ${other.id}; retire it or add an explicit ordering`)
      }
    }
    mission.scope = scope
    mission.scopeGeneration = (mission.scopeGeneration ?? 1) + 1
    mission.status = 'active'
    changes.push('scope widened')
  }

  if (changes.length === 0) fail('tower_mission requires at least one change')
  return { changes }
}
