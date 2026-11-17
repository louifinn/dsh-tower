// Pure roster observation and stale/inactive policy.
//
// app/roster.js owns the state lock, load, persistence, and activity log; the
// transitions below mutate only the in-memory roster rows they are given.
// @ts-check
import { ROSTER_INACTIVE } from '../roster.js'
import { ROSTER_GONE_STATES } from '../vocabulary.js'

/** @typedef {import('../../types/index.js').RosterEntry} RosterEntry */

/**
 * The one spawn.staleMs staleness rule (#160): a roster row is stale when the
 * window is enabled, the authoritative catalog does not know the agent, the
 * parent session was reachable, the row is not already terminal, and it was
 * spawned longer than the window ago. The `tower_inspect` `roster` view, the
 * watchdog sweep and the /tasks panel all ask this function instead of
 * restating the arithmetic.
 * @param {RosterEntry} entry
 * @param {{ observed?: string, parentKnown?: boolean, staleMs?: unknown, now?: number }} input
 * @returns {boolean}
 */
export function rosterEntryStale(entry, input = {}) {
  const staleMs = Number(input.staleMs) || 0
  if (staleMs <= 0) return false
  if (input.observed !== undefined) return false
  if (input.parentKnown !== true) return false
  if (ROSTER_GONE_STATES.some((state) => state === entry.state)) return false
  return Number(input.now ?? 0) - Number(entry.spawnedAt ?? 0) > staleMs
}

/**
 * @param {RosterEntry} entry
 * @returns {void}
 */
export function clearStale(entry) {
  delete entry.stale
  delete entry.staleAt
}

/**
 * Count repeated absence observations and list rows ready to adopt.
 *
 * A candidate needs both repeated observations and, when `windowMs` is set, a
 * span of at least that long between the first and the current observation.
 * The watchdog passes twice `spawn.staleMs` so one missed sweep can never stale
 * a live worker (#F73); callers that omit `windowMs` keep the historical
 * count-only behavior (a single authoritative sweep may still adopt).
 * @param {RosterEntry[]} roster
 * @param {{ present?: unknown[], absent?: unknown[], confirmations?: unknown, windowMs?: unknown }} observations
 * @param {number} now
 * @returns {{ candidates: string[], changed: boolean }}
 */
export function recordRosterObservations(roster, { present = [], absent = [], confirmations = 2, windowMs = 0 }, now) {
  const presentIds = new Set(present)
  const absentIds = new Set(absent)
  const required = Math.max(2, Number(confirmations) || 2)
  const window = Number(windowMs) || 0
  /** @type {string[]} */
  const candidates = []
  let changed = false
  for (const entry of roster) {
    if (presentIds.has(entry.agentId)) {
      if (entry.absentObservations !== undefined) {
        delete entry.absentObservations
        delete entry.absentSince
        changed = true
      }
      continue
    }
    if (!absentIds.has(entry.agentId)) continue
    entry.absentObservations = (/** @type {number} */ (entry.absentObservations ?? 0)) + 1
    entry.absentSince ??= now
    changed = true
    const observations = /** @type {number} */ (entry.absentObservations)
    if (observations < required) continue
    const since = Number(entry.absentSince ?? now)
    if (window > 0 && now - since < window) continue
    candidates.push(/** @type {string} */ (entry.agentId))
  }
  return { candidates, changed }
}

/**
 * The roster row a self-reporting agent owns, if any.
 * @param {RosterEntry[]} roster
 * @param {string} missionId
 * @param {string} agentId
 * @returns {RosterEntry | undefined}
 */
function selfReportedEntry(roster, missionId, agentId) {
  return roster.find((entry) => String(entry.agentId) === String(agentId) && entry.missionId === missionId)
}

/**
 * Revive the row of a worker whose own `tower_complete` reached the host (#F73).
 *
 * A worker that calls a tool is, by that act, alive: a stopped child cannot
 * call anything. When the watchdog mis-marked the row stale (a transient empty
 * catalog, one missed observation), the row must be revived before admission,
 * otherwise the mission is stranded and the live child can neither finish nor
 * re-register. Only the caller's own row (`agentId` + `missionId`) is eligible;
 * every other terminal state is refused by `assertCompletionRequest`.
 *
 * Pure: the caller holds the state lock and persists the result.
 * @param {RosterEntry[]} roster
 * @param {{ missionId: string, agentId: string, now: number }} input
 * @returns {{ revived: boolean, name?: string, remark?: boolean }}
 */
export function reviveSelfReportedEntry(roster, { missionId, agentId, now }) {
  const entry = selfReportedEntry(roster, missionId, agentId)
  if (!entry || entry.state !== 'stale') return { revived: false }
  const remark = entry.stale === true
  entry.state = 'active'
  clearStale(entry)
  // The absence evidence described the old mis-marked state; a revived row
  // starts observing again from scratch.
  delete entry.absentObservations
  delete entry.absentSince
  entry.revivedAt = now
  entry.revivedReason = 'self-reported completion (a live worker cannot be judged dead)'
  return { revived: true, name: entry.name, remark }
}

/**
 * Close the roster row of a worker whose own completion is being accepted.
 *
 * Called inside the completion's state-lock transaction, right after the
 * revive, so a watchdog sweep must see either the pre-completion row or the
 * closed one — never an `active` row carrying no observation (which the sweep
 * would mark stale, leaving a completed mission blocked by `worker-stale`).
 *
 * Tolerates a row that is still `stale` at this point (a sweep that won the
 * lock between the pre-check and this transaction); the stale mark is cleared
 * in place. Any other state — retired, failed, interrupted, missing — is left
 * alone.
 * @param {RosterEntry[]} roster
 * @param {{ missionId: string, agentId: string, now: number }} input
 * @returns {{ marked: boolean, name?: string, remark?: boolean }}
 */
export function settleSelfReportedCompletion(roster, { missionId, agentId, now }) {
  const entry = selfReportedEntry(roster, missionId, agentId)
  if (!entry) return { marked: false }
  if (entry.state !== 'active' && entry.state !== 'stale') return { marked: false }
  const remark = entry.state === 'stale' || entry.stale === true
  entry.state = 'inactive'
  entry.outcome = 'completed (self-report)'
  entry.outcomeAt = now
  clearStale(entry)
  delete entry.absentObservations
  delete entry.absentSince
  return { marked: true, name: entry.name, remark }
}

/**
 * Release live slots whose catalog activity is explicitly inactive.
 * @param {RosterEntry[]} roster
 * @param {Record<string, string>} activity
 * @param {number} now
 * @returns {{ released: string[] }}
 */
export function reconcileObservedInactive(roster, activity = {}, now) {
  /** @type {string[]} */
  const released = []
  for (const entry of roster) {
    if (entry.state === 'reserved' || ROSTER_INACTIVE.has(entry.state)) continue
    const agentId = /** @type {string} */ (entry.agentId)
    if (activity[agentId] !== 'inactive') continue
    entry.state = 'inactive'
    entry.outcome = 'catalog reported inactive'
    entry.outcomeAt = now
    clearStale(entry)
    released.push(entry.name)
  }
  return { released }
}

/**
 * Retire entries by agent id, skipping rows already retired.
 * @param {RosterEntry[]} roster
 * @param {unknown[]} agentIds
 * @param {number} now
 * @returns {{ retired: string[] }}
 */
export function retireEntries(roster, agentIds, now) {
  if (!Array.isArray(agentIds) || agentIds.length === 0) return { retired: [] }
  /** @type {string[]} */
  const retired = []
  for (const entry of roster) {
    if (entry.state !== 'retired' && agentIds.includes(entry.agentId)) {
      entry.state = 'retired'
      entry.retiredAt = now
      clearStale(entry)
      retired.push(/** @type {string} */ (entry.agentId))
    }
  }
  return { retired }
}

/**
 * Mark entries missing unless they are already inactive.
 * @param {RosterEntry[]} roster
 * @param {unknown[]} agentIds
 * @param {number} now
 * @returns {{ missing: string[] }}
 */
export function markMissingEntries(roster, agentIds, now) {
  if (!Array.isArray(agentIds) || agentIds.length === 0) return { missing: [] }
  /** @type {string[]} */
  const missing = []
  for (const entry of roster) {
    if (!ROSTER_INACTIVE.has(entry.state) && agentIds.includes(entry.agentId)) {
      entry.state = 'missing'
      entry.missingSince = now
      clearStale(entry)
      missing.push(/** @type {string} */ (entry.agentId))
    }
  }
  return { missing }
}

/**
 * Watchdog sweep: catalog-inactive rows become inactive; rows absent from an
 * authoritative catalog and older than `staleMs` become stale. Unknown catalog
 * state is never treated as stopped.
 * @param {RosterEntry[]} roster
 * @param {{ activity?: Record<string, string>, staleMs?: unknown, authoritative?: unknown }} input
 * @param {number} now
 * @returns {{ marked: string[], idled: string[] }}
 */
export function sweepRosterState(roster, input = {}, now) {
  const staleMs = Number(input.staleMs) || 0
  if (staleMs <= 0 || input.authoritative !== true) return { marked: [], idled: [] }
  const activity = input.activity ?? {}
  /** @type {string[]} */
  const marked = []
  /** @type {string[]} */
  const idled = []
  for (const entry of roster) {
    if (ROSTER_INACTIVE.has(entry.state)) continue
    const observed = activity[/** @type {string} */ (entry.agentId)]
    if (observed === 'inactive') {
      entry.state = 'inactive'
      entry.outcome = entry.outcome ?? 'idle (catalog)'
      entry.outcomeAt = now
      idled.push(entry.name)
      continue
    }
    if (observed === 'running') continue
    if (observed !== undefined) continue
    if (rosterEntryStale(entry, { parentKnown: true, staleMs, now })) {
      entry.state = 'stale'
      entry.stale = true
      entry.staleAt = now
      marked.push(entry.name)
    }
  }
  return { marked, idled }
}
