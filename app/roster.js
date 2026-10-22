// Roster observation and retirement use cases.
import { validateState } from '../domain/state.js'
import {
  recordRosterObservations as recordObservations,
  reconcileObservedInactive as reconcileInactive,
  retireEntries,
  markMissingEntries,
  sweepRosterState,
} from '../domain/collab/roster.js'
import { unreadMessages } from '../domain/collab/messages.js'

export async function recordRosterObservations(tower, { present = [], absent = [], confirmations = 2 }) {
    return tower.deps.store.withLock(tower.paths, async () => {
      const state = await tower.load()
      const now = Date.now()
      const { candidates, changed } = recordObservations(
        state.roster ?? [],
        { present, absent, confirmations },
        now,
      )
      if (changed) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, tower.paths.state)
        await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
      }
      return { candidates }
    })
  }

  /** Release live roster slots whose catalog activity is explicitly inactive. */
  export async function reconcileObservedInactive(tower, activity = {}) {
    return tower.deps.store.withLock(tower.paths, async () => {
      const state = await tower.load()
      const now = Date.now()
      const { released } = reconcileInactive(state.roster ?? [], activity, now)
      if (released.length > 0) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, tower.paths.state)
        await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
        await tower.deps.store.appendJsonl(tower.paths.activity, {
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
    return tower.deps.store.withLock(tower.paths, async () => {
      const state = await tower.load()
      const now = Date.now()
      const { retired } = retireEntries(state.roster ?? [], agentIds, now)
      if (retired.length > 0) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, tower.paths.state)
        await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
        await tower.deps.store.appendJsonl(tower.paths.activity, {
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
    return tower.deps.store.withLock(tower.paths, async () => {
      const state = await tower.load()
      const now = Date.now()
      const { missing } = markMissingEntries(state.roster ?? [], agentIds, now)
      if (missing.length > 0) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, tower.paths.state)
        await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
        await tower.deps.store.appendJsonl(tower.paths.activity, { at: now, type: 'adopt', text: `missing ${missing.join(', ')}` })
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
    return tower.deps.store.withLock(tower.paths, async () => {
      const state = await tower.load()
      const now = Date.now()
      const { marked, idled } = sweepRosterState(
        state.roster ?? [],
        { activity, staleMs, authoritative: input.authoritative },
        now,
      )
      if (marked.length > 0 || idled.length > 0) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, tower.paths.state)
        await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
        await tower.deps.store.appendJsonl(tower.paths.activity, {
          at: now,
          type: 'watchdog',
          text: `stale ${marked.join(', ') || '-'}; idle ${idled.join(', ') || '-'}`,
        })
      }
      return { marked, idled }
    })
  }

  export function unreadFor(tower, state, name) {
    return /** @type {any} */ (unreadMessages(state, name))
  }
