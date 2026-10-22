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

/** Record that a spawned agent failed or went idle, so roster state is truthful. */
export async function recordSpawnOutcome(tower, input) {
  return tower.deps.store.withLock(tower.paths, async () => {
    const state = await tower.load()
    const entry = (state.roster ?? []).find((row) => row.name === input.name && row.missionId === input.missionId)
    if (!entry) return null
    const now = Date.now()
    applySpawnOutcome(entry, input, now)
    state.revision += 1
    state.updatedAt = now
    validateState(state, tower.paths.state)
    await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
    await tower.deps.store.appendJsonl(tower.paths.activity, {
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
  return tower.deps.store.withLock(tower.paths, async () => {
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
    state.updatedAt = now
    validateState(state, tower.paths.state)
    await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
    await tower.deps.store.appendJsonl(tower.paths.activity, {
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
  return tower.deps.store.withLock(tower.paths, async () => {
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === input.missionId)
    if (!mission) fail(`unknown mission "${input.missionId}"`)
    if (!Array.isArray(state.roster)) state.roster = []
    const now = Date.now()
    const entry = reserveRosterEntry({ roster: state.roster, input, now })
    state.roster.push(entry)
    state.revision += 1
    state.updatedAt = now
    validateState(state, tower.paths.state)
    await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
    await tower.deps.store.appendJsonl(tower.paths.activity, {
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
  return tower.deps.store.withLock(tower.paths, async () => {
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === input.missionId)
    if (!mission) fail(`unknown mission "${input.missionId}"`)
    if (!Array.isArray(state.roster)) state.roster = []
    const now = Date.now()
    const entry = recordSpawnEntry({
      roster: state.roster,
      mission,
      input,
      spawnTip,
      maxLiveWorkers: tower.config.spawn.maxLiveWorkers,
      now,
    })
    mission.updatedAt = now
    state.revision += 1
    state.updatedAt = now

    validateState(state, tower.paths.state)
    await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
    await tower.deps.store.appendJsonl(tower.paths.activity, {
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
