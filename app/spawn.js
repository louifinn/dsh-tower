// Spawn reservation/outcome and roster recording use cases.
import { TowerToolError } from '../domain/errors.js'
import {
  applySpawnOutcome,
  applyInterrupt,
  reserveRosterEntry,
  recordSpawnEntry,
  rosterProjection,
} from '../domain/collab/spawn.js'
import { validateState } from '../domain/state.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

/**
 * Reservation identities minted by `reserveRoster` in this process, keyed by
 * tower instance and then `missionId\0name`. Each row carries its token, so
 * `recordSpawnOutcome` can verify that the row it would write is still the
 * reservation it was dispatched for. After the stalled-reservation reap frees a
 * name, another process can reserve the same `name` for the same mission; a
 * delayed cleanup from the first dispatch must not mark that in-use row failed
 * (F64).
 *
 * The map is deliberately process-local: it identifies only reservations this
 * process created, which is exactly the scope a caller of
 * `recordSpawnOutcome` can vouch for. A row reserved by another process has a
 * token this process's map never saw, so the outcome is skipped instead of
 * applied.
 * @type {WeakMap<object, Map<string, string>>}
 */
const reservationTokens = new WeakMap()

function reservationKey(input) {
  return `${input.missionId ?? ''}\u0000${input.name ?? ''}`
}

/** @param {any} tower @param {{ missionId?: string, name?: string }} input */
function reservationTokenFor(tower, input) {
  return reservationTokens.get(tower)?.get(reservationKey(input))
}

function rememberReservation(tower, input, reservationId) {
  let tokens = reservationTokens.get(tower)
  if (!tokens) {
    tokens = new Map()
    reservationTokens.set(tower, tokens)
  }
  tokens.set(reservationKey(input), reservationId)
}

/** Record that a spawned agent failed or went idle, so roster state is truthful. */
export async function recordSpawnOutcome(tower, input) {
  return tower.withStateLock(async (_paths, held) => {
    const state = await tower.load()
    const entry = (state.roster ?? []).find((row) => row.name === input.name && row.missionId === input.missionId)
    if (!entry) return null
    const now = Date.now()
    const expected = reservationTokenFor(tower, input)
    // Only the dispatch that wrote this reservation may record its outcome.
    // The reap frees names, so a delayed cleanup can find a same-named row that
    // a newer dispatch reserved and activated: applying the old outcome would
    // fail an in-use worker, and rewriting a converged row would resurrect it.
    if (expected === undefined || entry.reservationId !== expected || !['reserved', 'active'].includes(entry.state)) {
      await tower.appendActivity({
        at: now,
        type: 'spawn',
        missionId: input.missionId,
        text: `${input.name} outcome skipped: roster row is ${entry.state}${entry.agentId ? ` (agent ${entry.agentId})` : ''}, not the reservation that requested it`,
      })
      return null
    }
    applySpawnOutcome(entry, input, now)
    state.revision += 1
    // #211: a per-row stamp lets tower_inspect status sinceRevision return only
    // rows written after the caller's last read.
    entry.revision = state.revision
    state.updatedAt = now
    validateState(state, tower.paths.state)
    await tower.writeState(state, held)
    await tower.appendActivity({
      at: now,
      type: 'spawn',
      missionId: input.missionId,
      text: `${entry.name} ${entry.state}${entry.outcome ? `: ${entry.outcome.slice(0, 160)}` : ''}`,
    })
    return entry
  })
}

/** Record that a live agent was interrupted by the tower. */
export async function recordInterrupt(tower, input) {
  return tower.withStateLock(async (_paths, held) => {
    const state = await tower.load()
    const entry = (state.roster ?? []).find(
      (row) =>
        (input.agentId !== undefined && row.agentId === input.agentId) ||
        (input.name !== undefined && row.name === input.name),
    )
    if (!entry) fail(`unknown roster agent "${input.name ?? input.agentId}"`)
    const now = Date.now()
    applyInterrupt(entry, input, now)
    state.revision += 1
    entry.revision = state.revision
    state.updatedAt = now
    validateState(state, tower.paths.state)
    await tower.writeState(state, held)
    await tower.appendActivity({
      at: now,
      type: 'spawn',
      missionId: entry.missionId,
      text: `${entry.name} interrupted: ${entry.outcome}`,
    })
    return entry
  })
}

/** Reserve a roster name before activation so a failed spawn is recoverable. */
export async function reserveRoster(tower, input) {
  return tower.withStateLock(async (_paths, held) => {
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === input.missionId)
    if (!mission) fail(`unknown mission "${input.missionId}"`)
    if (!Array.isArray(state.roster)) state.roster = []
    const now = Date.now()
    // Mint the reservation identity before the row exists: the row carries it so
    // the outcome of this dispatch can prove it still owns the name (F64).
    const reservationId = globalThis.crypto.randomUUID()
    const entry = reserveRosterEntry({ roster: state.roster, input: { ...input, reservationId }, now })
    state.roster.push(entry)
    state.revision += 1
    entry.revision = state.revision
    state.updatedAt = now
    validateState(state, tower.paths.state)
    await tower.writeState(state, held)
    rememberReservation(tower, input, reservationId)
    await tower.appendActivity({
      at: now,
      type: 'spawn',
      missionId: input.missionId,
      text: `reserved ${input.role} ${input.name}`,
    })
    return entry
  })
}

export async function recordSpawn(tower, input) {
  // Capture the spawn tip before taking the state lock (#51).
  const spawnTip = input.cwd ? ((await tower.tryGit(input.cwd, ['rev-parse', 'HEAD'])) ?? '').trim() || null : null
  return tower.withStateLock(async (_paths, held) => {
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === input.missionId)
    if (!mission) fail(`unknown mission "${input.missionId}"`)
    if (!Array.isArray(state.roster)) state.roster = []
    const now = Date.now()
    // Carry the reservation identity onto the active row so the delayed outcome
    // write can verify ownership (see recordSpawnOutcome).
    const reservationId = reservationTokenFor(tower, input)
    const entry = recordSpawnEntry({
      roster: state.roster,
      // The live-worker count resolves each roster row's kind, so the whole
      // mission list is required: a survey row is not a build worker (#148).
      missions: state.missions,
      mission,
      input: reservationId ? { ...input, reservationId } : input,
      spawnTip,
      maxLiveWorkers: tower.config.spawn.maxLiveWorkers,
      now,
    })
    mission.updatedAt = now
    state.revision += 1
    // The new row and every row this spawn retired changed at this revision.
    for (const row of state.roster) {
      if (row.spawnedAt === now || row.outcomeAt === now) row.revision = state.revision
    }
    mission.revision = state.revision
    state.updatedAt = now

    validateState(state, tower.paths.state)
    await tower.writeState(state, held)
    await tower.appendActivity({
      at: now,
      type: 'spawn',
      missionId: input.missionId,
      text: `${input.role} ${input.name} (${input.agentId})`,
    })
    return entry
  })
}

export async function rosterView(tower) {
  const state = await tower.load()
  return rosterProjection(state)
}
