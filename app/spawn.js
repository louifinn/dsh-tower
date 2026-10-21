// Spawn reservation/outcome and roster recording use cases.
import { TowerToolError } from '../domain/errors.js'
import { ROSTER_INACTIVE, workerEntries, countLiveWorkers } from '../domain/roster.js'
import { validateState } from '../domain/state.js'
import { withLock, writeJsonAtomic, appendJsonl } from '../lib/store.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

function clearStale(entry) {
  delete entry.stale
  delete entry.staleAt
}

/** Record that a spawned agent failed or went idle, so roster state is truthful. */
export async function recordSpawnOutcome(tower, input) {
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    const entry = (state.roster ?? []).find((row) => row.name === input.name && row.missionId === input.missionId)
    if (!entry) return null
    const now = Date.now()
    entry.state = input.state ?? 'failed'
    entry.outcome = input.detail ? String(input.detail).slice(0, 1000) : null
    entry.outcomeAt = now
    clearStale(entry)
    state.revision += 1
    state.updatedAt = now
    validateState(state, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, state)
    await appendJsonl(tower.paths.activity, {
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
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    const entry = (state.roster ?? []).find(
      (row) =>
        (input.agentId !== undefined && row.agentId === input.agentId) ||
        (input.name !== undefined && row.name === input.name),
    )
    if (!entry) fail(`unknown roster agent "${input.name ?? input.agentId}"`)
    const now = Date.now()
    entry.state = 'interrupted'
    entry.outcome = String(input.reason ?? 'interrupted by tower').slice(0, 1000)
    entry.outcomeAt = now
    clearStale(entry)
    state.revision += 1
    state.updatedAt = now
    validateState(state, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, state)
    await appendJsonl(tower.paths.activity, {
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
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === input.missionId)
    if (!mission) fail(`unknown mission "${input.missionId}"`)
    if (!Array.isArray(state.roster)) state.roster = []
    if (state.roster.some((entry) => entry.name === input.name)) fail(`roster name already used: ${input.name}`)
    const now = Date.now()
    const entry = {
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
    state.roster.push(entry)
    state.revision += 1
    state.updatedAt = now
    validateState(state, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, state)
    await appendJsonl(tower.paths.activity, {
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
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === input.missionId)
    if (!mission) fail(`unknown mission "${input.missionId}"`)
    if (!Array.isArray(state.roster)) state.roster = []
    const reserved = state.roster.find((entry) => entry.name === input.name && entry.state === 'reserved' && !entry.agentId)
    if (!reserved && state.roster.some((entry) => entry.name === input.name)) {
      fail(`roster name already used: ${input.name}`)
    }
    if (state.roster.some((entry) => entry.agentId && entry.agentId === input.agentId)) {
      fail(`agent ${input.agentId} is already in the roster`)
    }
    const now = Date.now()
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
    if (input.role === 'worker') {
      const previous = workerEntries(state, mission.id)
      const live = previous.find((entry) => !ROSTER_INACTIVE.has(entry.state) && entry.state !== 'reserved')
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
      const liveCount = countLiveWorkers(state)
      const max = Number(tower.config.spawn.maxLiveWorkers) || 4
      if (liveCount >= max) {
        fail(`live worker limit reached (${max}); stop a worker or raise spawn.maxLiveWorkers`)
      }
      const generation = (mission.ownerGeneration ?? 0) + 1
      entry.generation = generation
      mission.ownerGeneration = generation
      mission.owner = input.name
      if (mission.status === 'planned') mission.status = 'active'
    }
    if (reserved) Object.assign(reserved, entry)
    else state.roster.push(entry)
    mission.updatedAt = now
    state.revision += 1
    state.updatedAt = now

    validateState(state, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, state)
    await appendJsonl(tower.paths.activity, {
      at: now,
      type: 'spawn',
      missionId: input.missionId,
      text: `${input.role} ${input.name} (${input.agentId})`,
    })
    return reserved ?? entry
  })
}

export async function rosterView(tower) {
  const state = await tower.load()
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
