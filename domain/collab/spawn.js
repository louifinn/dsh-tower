// Pure spawn reservation/outcome policy: roster entry projections, role and
// live-worker limit decisions.
//
// app/spawn.js owns the state lock, load, Git spawn-tip capture, persistence,
// and activity log. Preset/provider selection happens in tools/spawn.js and is
// intentionally not duplicated here.
// @ts-check
import { TowerToolError } from '../errors.js'
import { ROSTER_INACTIVE, countLiveWorkers, workerEntries } from '../roster.js'
import { clearStale } from './roster.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').RosterEntry} RosterEntry */

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new TowerToolError('invalid-argument', message)
}

/**
 * @param {unknown} role
 * @returns {boolean}
 */
export function isWorkerRole(role) {
  return role === 'worker'
}

/**
 * The configured live-worker ceiling, defaulting to four.
 * @param {unknown} maxLiveWorkers
 * @returns {number}
 */
export function liveWorkerLimit(maxLiveWorkers) {
  return Number(maxLiveWorkers) || 4
}

/**
 * Record that a spawned agent failed or went idle.
 * @param {RosterEntry} entry
 * @param {{ state?: string, detail?: unknown }} input
 * @param {number} now
 * @returns {RosterEntry}
 */
export function applySpawnOutcome(entry, input, now) {
  entry.state = input.state ?? 'failed'
  entry.outcome = input.detail ? String(input.detail).slice(0, 1000) : null
  entry.outcomeAt = now
  clearStale(entry)
  return entry
}

/**
 * Record that a live agent was interrupted by the tower.
 * @param {RosterEntry} entry
 * @param {{ reason?: unknown }} input
 * @param {number} now
 * @returns {RosterEntry}
 */
export function applyInterrupt(entry, input, now) {
  entry.state = 'interrupted'
  entry.outcome = String(input.reason ?? 'interrupted by tower').slice(0, 1000)
  entry.outcomeAt = now
  clearStale(entry)
  return entry
}

/**
 * A reserved roster row: the name is claimed before activation so a failed
 * spawn remains recoverable.
 * @param {any} input
 * @param {number} now
 * @returns {RosterEntry}
 */
export function reservedRosterEntry(input, now) {
  return {
    name: input.name,
    role: input.role,
    agentId: null,
    sessionId: null,
    parentSessionId: input.parentSessionId,
    missionId: input.missionId,
    cwd: input.cwd ?? null,
    branch: input.branch ?? null,
    spawnTip: null,
    state: 'reserved',
    reservedAt: now,
    spawnedAt: now,
  }
}

/**
 * Validate a reservation request and project its row.
 * @param {{ roster: RosterEntry[], input: any, now: number }} params
 * @returns {RosterEntry}
 */
export function reserveRosterEntry({ roster, input, now }) {
  if (roster.some((entry) => entry.name === input.name)) fail(`roster name already used: ${input.name}`)
  return reservedRosterEntry(input, now)
}

/**
 * Validate and apply a spawn record. Mutates the roster (retiring prior worker
 * rows and inserting/reusing the entry) and the mission owner/status/gen.
 * @param {{ roster: RosterEntry[], mission: Mission, input: any, spawnTip: string | null, maxLiveWorkers: unknown, now: number }} params
 * @returns {RosterEntry}
 */
export function recordSpawnEntry({ roster, mission, input, spawnTip, maxLiveWorkers, now }) {
  const reserved = roster.find((entry) => entry.name === input.name && entry.state === 'reserved' && !entry.agentId)
  if (!reserved && roster.some((entry) => entry.name === input.name)) {
    fail(`roster name already used: ${input.name}`)
  }
  if (roster.some((entry) => entry.agentId && entry.agentId === input.agentId)) {
    fail(`agent ${input.agentId} is already in the roster`)
  }
  /** @type {RosterEntry} */
  const entry = {
    name: input.name,
    role: input.role,
    agentId: input.agentId,
    sessionId: input.sessionId ?? input.agentId,
    parentSessionId: input.parentSessionId,
    missionId: input.missionId,
    cwd: input.cwd ?? null,
    branch: input.branch ?? null,
    spawnTip,
    state: 'active',
    spawnedAt: now,
  }
  if (isWorkerRole(input.role)) {
    const snapshot = /** @type {any} */ ({ roster })
    const previous = workerEntries(snapshot, mission.id)
    const live = previous.find((row) => !ROSTER_INACTIVE.has(row.state) && row.state !== 'reserved')
    if (live && !input.takeover) {
      fail(
        `mission ${mission.id} already has a live worker "${live.name}"; stop it with tower_interrupt, or pass takeover:true after it is no longer running`,
      )
    }
    // A new owner always retires the mission's older worker entries, including
    // idle `inactive` ones; otherwise the next spawn would see several entries
    // for the same mission and the old idle worker would block forever.
    for (const old of previous) {
      if (old.state === 'retired' || old.state === 'reserved') continue
      old.state = 'retired'
      old.outcome = `replaced by ${input.name}${input.takeover ? ' (takeover)' : ''}`
      old.outcomeAt = now
      clearStale(old)
    }
    const max = liveWorkerLimit(maxLiveWorkers)
    if (countLiveWorkers(snapshot) >= max) {
      fail(`live worker limit reached (${max}); stop a worker or raise spawn.maxLiveWorkers`)
    }
    const generation = (mission.ownerGeneration ?? 0) + 1
    entry.generation = generation
    mission.ownerGeneration = generation
    mission.owner = input.name
    if (mission.status === 'planned') mission.status = 'active'
  }
  if (reserved) Object.assign(reserved, entry)
  else roster.push(entry)
  return reserved ?? entry
}

/**
 * Pure read projection for `tower_roster`.
 * @param {import('../../types/index.js').TowerState} state
 * @returns {any}
 */
export function rosterProjection(state) {
  return {
    revision: state.revision,
    roster: (state.roster ?? []).map((entry) => ({ ...entry })),
    missions: state.missions.map((mission) => ({
      id: mission.id,
      status: mission.status,
      owner: mission.owner ?? null,
      worktree: mission.worktree
        ? {
            path: mission.worktree.path,
            branch: mission.worktree.branch,
            baseCommit: mission.worktree.baseCommit,
          }
        : null,
    })),
  }
}
