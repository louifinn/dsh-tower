// Mission lifecycle update use case.
import { TowerToolError } from '../lib/errors.js'
import { MISSION_STATUSES, TERMINAL_STATUSES, canTransition, pauseCauseError } from '../domain/mission.js'
import { scopesOverlap, normalizeScope } from '../domain/scope.js'
import { validateState } from '../domain/state.js'
import { fullMission } from '../domain/summary.js'
import { withLock, writeJsonAtomic, appendJsonl } from '../lib/store.js'

const TERMINAL = TERMINAL_STATUSES

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

function normalizePauseCause(value) {
  const error = pauseCauseError(value)
  if (error) fail(error)
  return value === undefined || value === null || value === '' ? 'user' : value
}

export async function updateMission(tower, input = {}) {
  const missionId = typeof input.id === 'string' ? input.id.trim() : input.id
  if (typeof missionId !== 'string' || missionId.length === 0) fail('tower_mission requires id')
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === missionId)
    if (!mission) fail(`unknown mission "${missionId}"`, 'mission-not-found')
    const actor = input.actor ?? { name: 'tower', role: 'tower' }
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
    if (input.pause_cause !== undefined && input.status !== 'paused') {
      fail('pause_cause is only valid together with status "paused"')
    }
    if (input.status === 'abandoned' && (typeof input.note !== 'string' || input.note.trim().length === 0)) {
      fail('abandoning a mission requires a non-empty note (reason)')
    }
    const now = Date.now()
    const changes = []

    if (input.status !== undefined) {
      if (typeof input.status !== 'string' || !MISSION_STATUSES.includes(input.status)) {
        fail(`unknown mission status "${input.status}"`)
      }
      if (input.status === 'merged') fail('merged is recorded only by tower_merge, not by a generic mission patch', 'invalid-transition')
      if (!canTransition(mission.status, input.status)) {
        fail(`mission ${mission.id} cannot move from ${mission.status} to ${input.status}`, 'invalid-transition')
      }
      if (input.status === 'paused') {
        mission.pauseCause = normalizePauseCause(input.pause_cause)
      }
      if (mission.status === 'paused' && input.status === 'active') {
        const requireAuthorization = tower.config.mode.requireResumeAuthorization === true
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
      const task = mission.tasks.find(
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
      const task = mission.tasks.find(
        (entry) => entry.status === 'open' && entry.text.toLowerCase().includes(needle.toLowerCase()),
      )
      if (!task) fail(`no open task matching "${needle}" in mission ${mission.id}`)
      task.status = 'dropped'
      task.note = input.task_drop_reason.trim()
      mission.notes.push(`task dropped: ${task.text} — ${task.note}`)
      changes.push(`task_drop="${task.text}"`)
    }

    if (input.blocker !== undefined) {
      if (typeof input.blocker !== 'string' || input.blocker.trim().length === 0) {
        fail('blocker must be a non-empty string')
      }
      if (TERMINAL.has(mission.status)) {
        fail(`mission ${mission.id} is ${mission.status}; a blocker cannot reopen a terminal mission`)
      }
      mission.blockers.push(input.blocker.trim())
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
      mission.notes.push(input.note.trim())
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
      for (const other of others) {
        if (mission.kind !== 'survey' && scopesOverlap(scope, other.scope)) {
          fail(`widened scope overlaps mission ${other.id}; retire it or add an explicit ordering`)
        }
      }
      mission.scope = scope
      mission.scopeGeneration = (mission.scopeGeneration ?? 1) + 1
      mission.status = 'active'
      changes.push('scope widened')
    }

    if (changes.length === 0) fail('tower_mission requires at least one change')
    mission.updatedAt = now
    state.revision += 1
    state.updatedAt = now

    validateState(state, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, state)
    await appendJsonl(tower.paths.activity, {
      at: now,
      type: 'mission',
      missionId: mission.id,
      text: changes.join('; '),
    })
    return { revision: state.revision, mission: fullMission(mission) }
  })
}
