// Roster observation and retirement use cases.
import { withLock, writeJsonAtomic, appendJsonl } from '../store.js'
import { validateState } from '../domain/state.js'
import { ROSTER_INACTIVE } from '../domain/roster.js'

function clearStale(entry) {
  delete entry.stale
  delete entry.staleAt
}

function fail(message) {
  throw new Error(message)
}

export async function recordRosterObservations(tower, { present = [], absent = [], confirmations = 2 }) {
    const presentIds = new Set(present)
    const absentIds = new Set(absent)
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      const candidates = []
      const now = Date.now()
      let changed = false
      for (const entry of state.roster ?? []) {
        if (presentIds.has(entry.agentId)) {
          if (entry.absentObservations !== undefined) {
            delete entry.absentObservations
            delete entry.absentSince
            changed = true
          }
          continue
        }
        if (!absentIds.has(entry.agentId)) continue
        entry.absentObservations = (entry.absentObservations ?? 0) + 1
        entry.absentSince ??= now
        changed = true
        if (entry.absentObservations >= Math.max(2, Number(confirmations) || 2)) candidates.push(entry.agentId)
      }
      if (changed) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, tower.paths.state)
        await writeJsonAtomic(tower.paths.state, state)
      }
      return { candidates }
    })
  }

  /** Release live roster slots whose catalog activity is explicitly inactive. */
  export async function reconcileObservedInactive(tower, activity = {}) {
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      const released = []
      const now = Date.now()
      for (const entry of state.roster ?? []) {
        if (entry.state === 'reserved' || ROSTER_INACTIVE.has(entry.state)) continue
        if (activity[entry.agentId] !== 'inactive') continue
        entry.state = 'inactive'
        entry.outcome = 'catalog reported inactive'
        entry.outcomeAt = now
        clearStale(entry)
        released.push(entry.name)
      }
      if (released.length > 0) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, tower.paths.state)
        await writeJsonAtomic(tower.paths.state, state)
        await appendJsonl(tower.paths.activity, {
          at: now,
          type: 'roster',
          text: `released inactive slots: ${released.join(', ')}`,
        })
      }
      return { released }
    })
  }

  export async function markRetired(tower, agentIds) {
    if (!Array.isArray(agentIds) || agentIds.length === 0) return { retired: [] }
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      const retired = []
      const now = Date.now()
      for (const entry of state.roster ?? []) {
        if (entry.state !== 'retired' && agentIds.includes(entry.agentId)) {
          entry.state = 'retired'
          entry.retiredAt = now
          clearStale(entry)
          retired.push(entry.agentId)
        }
      }
      if (retired.length > 0) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, tower.paths.state)
        await writeJsonAtomic(tower.paths.state, state)
        await appendJsonl(tower.paths.activity, {
          at: now,
          type: 'adopt',
          text: `retired ${retired.join(', ')}`,
        })
      }
      return { retired }
    })
  }

  export async function markMissing(tower, agentIds) {
    if (!Array.isArray(agentIds) || agentIds.length === 0) return { missing: [] }
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      const missing = []
      const now = Date.now()
      for (const entry of state.roster ?? []) {
        if (!ROSTER_INACTIVE.has(entry.state) && agentIds.includes(entry.agentId)) {
          entry.state = 'missing'
          entry.missingSince = now
          clearStale(entry)
          missing.push(entry.agentId)
        }
      }
      if (missing.length > 0) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, tower.paths.state)
        await writeJsonAtomic(tower.paths.state, state)
        await appendJsonl(tower.paths.activity, { at: now, type: 'adopt', text: `missing ${missing.join(', ')}` })
      }
      return { missing }
    })
  }

  /** Mark live roster entries whose catalog activity disappeared after staleMs.
   * `authoritative` must be true only when the parent catalog was readable;
   * unknown state is never treated as stopped. */
  export async function sweepRoster(tower, input = {}) {
    const staleMs = Number(input.staleMs) || 0
    if (staleMs <= 0 || input.authoritative !== true) return { marked: [], idled: [] }
    const activity = input.activity ?? {}
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      const now = Date.now()
      const marked = []
      const idled = []
      for (const entry of state.roster ?? []) {
        if (ROSTER_INACTIVE.has(entry.state)) continue
        const observed = activity[entry.agentId]
        if (observed === 'inactive') {
          entry.state = 'inactive'
          entry.outcome = entry.outcome ?? 'idle (catalog)'
          entry.outcomeAt = now
          idled.push(entry.name)
          continue
        }
        if (observed === 'running') continue
        if (observed !== undefined) continue
        const age = now - Number(entry.spawnedAt ?? now)
        if (age > staleMs) {
          entry.state = 'stale'
          entry.stale = true
          entry.staleAt = now
          marked.push(entry.name)
        }
      }
      if (marked.length > 0 || idled.length > 0) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, tower.paths.state)
        await writeJsonAtomic(tower.paths.state, state)
        await appendJsonl(tower.paths.activity, {
          at: now,
          type: 'watchdog',
          text: `stale ${marked.join(', ') || '-'}; idle ${idled.join(', ') || '-'}`,
        })
      }
      return { marked, idled }
    })
  }

export function unreadFor(tower, state, name) {
    return (state.messages ?? []).filter((message) => {
      if (message.from === name) return false
      if (message.to !== name && message.to !== 'all') return false
      return !(message.readBy ?? []).includes(name)
    })
  }
