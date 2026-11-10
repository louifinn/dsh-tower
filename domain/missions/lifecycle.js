// Pure mission lifecycle transition policy.
//
// app/mission.js supplies the loaded mission/state and persists the result;
// this module owns the authorization and transition rules and mutates only the
// in-memory mission draft it is given.
// @ts-check
import { TowerToolError } from '../errors.js'
import { abandonedEvent, completedEvent } from '../events.js'
import { pauseCauseError } from '../mission.js'
import { normalizeScope, scopesOverlap } from '../scope.js'
import { shapeFor } from '../shapes/index.js'
import { isReviewerRole, isWorkerRole } from '../vocabulary.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').TowerState} TowerState */

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
  const workerRequest = isWorkerRole(actor.role)
  if (isReviewerRole(actor.role)) {
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
 * Mark a mission blocked from a machine-derived failure (a merge or rebase
 * conflict). `blocked` is derived from open blockers, so the blocker is recorded
 * with the status in one write path; no caller assigns the status directly
 * (#149 W3). Repeating the same failure does not duplicate the blocker.
 * @param {Mission} mission
 * @param {string} blocker
 * @param {number} [now]
 * @returns {Mission}
 */
export function markBlocked(mission, blocker, now = Date.now()) {
  if (typeof blocker !== 'string' || blocker.trim().length === 0) fail('a blocker must be a non-empty string')
  const text = blocker.trim()
  const blockers = /** @type {string[]} */ (mission.blockers)
  if (!blockers.includes(text)) blockers.push(text)
  mission.status = 'blocked'
  // A blocker wins over a pause: the human cause is superseded by the failure.
  delete mission.pauseCause
  mission.updatedAt = now
  return mission
}

/**
 * Resolve blockers that a successful machine operation has cleared (a rebase
 * conflict that the retried rebase resolved). Blockers that do not match stay,
 * and the mission stays blocked while any remain — recovery is always "the
 * recorded blockers are gone", never a status assignment.
 * @param {Mission} mission
 * @param {(blocker: string) => boolean} matches
 * @param {number} [now]
 * @returns {boolean} whether any blocker was removed
 */
export function resolveBlockers(mission, matches, now = Date.now()) {
  const blockers = /** @type {string[]} */ (mission.blockers ?? [])
  const kept = blockers.filter((blocker) => !matches(blocker))
  if (kept.length === blockers.length) return false
  mission.blockers = kept
  if (kept.length === 0 && mission.status === 'blocked') mission.status = 'active'
  mission.updatedAt = now
  return true
}

/**
 * Apply one validated `tower_mission` patch to the mission draft and return
 * the human-readable change list used by the activity log plus the domain
 * events the transition describes.
 * @param {{ mission: Mission, state: TowerState, input: any, config: any }} params
 * @returns {{ state: Mission, changes: string[], events: Array<{ type: string, missionId: string }> }}
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
  /** @type {Array<{ type: string, missionId: string }>} */
  const events = []

  const shape = shapeFor(mission.kind)
  // W3: `blocked` is derived state, `paused` is a deliberate stop. Clearing the
  // blockers is what resumes a blocked mission, so it is applied before any
  // status patch: `{clear_blockers:true,status:"active"}` and
  // `{clear_blockers:true,status:"completed"}` both describe one coherent step.
  if (input.clear_blockers === true) {
    if ((mission.blockers ?? []).length > 0) {
      mission.blockers = []
      changes.push('blockers cleared')
    }
    if (mission.status === 'blocked') {
      mission.status = 'active'
      changes.push('status=active (blocked until the blockers were cleared)')
    }
  }
  if (input.status !== undefined) {
    if (typeof input.status !== 'string' || !shape.statuses.includes(input.status)) {
      fail(`unknown mission status "${input.status}" for a ${shape.kind} mission`)
    }
    if (input.status === 'merged') {
      fail('merged is recorded only by tower_merge, not by a generic mission patch', 'invalid-transition')
    }
    if (input.status === 'blocked') {
      fail(
        'blocked is derived from open blockers: record blocker:"..." instead of setting status "blocked"',
        'invalid-transition',
      )
    }
    const openBlockers = mission.blockers ?? []
    if (mission.status === 'blocked' && input.status !== 'abandoned') {
      // A blocked mission is resumed by clearing its blockers, never by a
      // status patch that skips the blocker record (#149 W3).
      fail(
        `mission ${mission.id} is blocked (${openBlockers.join('; ')}); clear_blockers resumes it — it cannot move to ${input.status} directly`,
        'invalid-transition',
      )
    }
    if (openBlockers.length > 0 && ['active', 'completed', 'paused'].includes(input.status)) {
      fail(
        `mission ${mission.id} has open blockers (${openBlockers.join('; ')}); clear_blockers resumes it — do not move it to ${input.status}`,
        'invalid-transition',
      )
    }
    // A status patch is a real move: the target must differ and be a legal edge.
    // `paused` is re-entered only from a different status (a pause cause is
    // meaningful when the pause begins, not as an in-place metadata edit).
    // `{clear_blockers:true,status:"active"}` is one coherent resume step: the
    // clear already moved the mission, so the redundant patch is not a second
    // transition.
    const redundantResume =
      input.clear_blockers === true && input.status === 'active' && mission.status === 'active'
    if (!redundantResume) {
      if (!shape.canTransition(mission.status, input.status)) {
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
      if (input.status === 'completed') events.push(completedEvent(mission))
      if (input.status === 'abandoned') events.push(abandonedEvent(mission))
    }
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
    if (shape.isTerminal(mission.status)) {
      fail(`mission ${mission.id} is ${mission.status}; a blocker cannot reopen a terminal mission`)
    }
    const blockers = /** @type {string[]} */ (mission.blockers)
    blockers.push(input.blocker.trim())
    // W3: a blocker always wins over a pause; the paused cause is superseded and
    // the mission is blocked until the blockers are cleared.
    if (mission.status !== 'blocked') {
      if (!shape.canTransition(mission.status, 'blocked')) {
        fail(`mission ${mission.id} cannot move from ${mission.status} to blocked`, 'invalid-transition')
      }
      if (mission.status === 'paused') delete mission.pauseCause
      mission.status = 'blocked'
    }
    changes.push('blocker added')
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
    if (!shape.ownsScope) {
      fail(`mission ${mission.id} is a ${shape.kind}: it reads a commit and does not own scope`)
    }
    if (!['active', 'completed'].includes(mission.status)) {
      fail(`scope can only be widened for active or completed missions, not ${mission.status}`)
    }
    const scope = normalizeScope(input.scope)
    const others = state.missions.filter((entry) => {
      if (entry.id === mission.id) return false
      const other = shapeFor(entry.kind)
      return other.ownsScope && !other.isTerminal(entry.status)
    })
    const caseInsensitive = state.caseInsensitive === true
    for (const other of others) {
      if (scopesOverlap(scope, other.scope, { caseInsensitive })) {
        fail(`widened scope overlaps mission ${other.id}; retire it or add an explicit ordering`)
      }
    }
    mission.scope = scope
    mission.scopeGeneration = (mission.scopeGeneration ?? 1) + 1
    mission.status = 'active'
    changes.push('scope widened')
  }

  if (changes.length === 0) fail('tower_mission requires at least one change')
  return { state: mission, changes, events }
}
