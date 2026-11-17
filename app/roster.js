// Roster observation and retirement use cases.
import { validateState } from '../domain/state.js'
import { isStalledReservation } from '../domain/collab/spawn.js'
import { removeReviewCheckout } from './reviewCheckout.js'
import {
  recordRosterObservations as recordObservations,
  reconcileObservedInactive as reconcileInactive,
  retireEntries,
  markMissingEntries,
  sweepRosterState,
  clearStale,
} from '../domain/collab/roster.js'
import { unreadMessages } from '../domain/collab/messages.js'

export async function recordRosterObservations(tower, { present = [], absent = [], confirmations = 2, windowMs = 0 }) {
    return tower.withStateLock(async (_paths, held) => {
      const state = await tower.load()
      const now = Date.now()
      const { candidates, changed } = recordObservations(
        state.roster ?? [],
        { present, absent, confirmations, windowMs },
        now,
      )
      if (changed) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, tower.paths.state)
        await tower.writeState(state, held)
      }
      return { candidates }
    })
  }

  /**
   * Accept a stale row's own completion report (#F73).
   *
   * A worker that calls `tower_complete` is, by that act, alive: a stopped
   * child cannot call a tool. When the watchdog has mis-marked the row stale
   * (a transiently empty catalog, one missed observation), refusing the report
   * strands the mission and leaves a live child that can neither finish nor
   * re-register. Revive exactly that row — the caller must be the row's own
   * agent id and mission — and record why in the activity log. Any other
   * terminal state (failed/interrupted/missing/retired) still refuses in
   * `assertCompletionRequest`; this cannot resurrect a worker that never
   * called a tool.
   * @param {any} tower
   * @param {{ missionId: string, agentId: string }} input
   * @returns {Promise<{ revived: boolean, name?: string, priorState?: string }>}
   */
  export async function reviveStaleSelfReporter(tower, { missionId, agentId }) {
    return tower.withStateLock(async (_paths, held) => {
      const state = await tower.load()
      const now = Date.now()
      const entry = (state.roster ?? []).find(
        (row) => String(row.agentId) === String(agentId) && row.missionId === missionId,
      )
      if (!entry || entry.state !== 'stale') return { revived: false }
      const priorState = entry.state
      entry.state = 'active'
      clearStale(entry)
      // The absence evidence described the old mis-marked state; a revived row
      // starts observing again from scratch.
      delete entry.absentObservations
      delete entry.absentSince
      entry.revivedAt = now
      entry.revivedReason = 'self-reported completion (a live worker cannot be judged dead)'
      state.revision += 1
      state.updatedAt = now
      validateState(state, tower.paths.state)
      await tower.writeState(state, held)
      await tower.appendActivity({
        at: now,
        type: 'roster',
        missionId,
        text: `revived ${entry.name} from stale: it called tower_complete itself, so the child is alive (F73)`,
      })
      return { revived: true, name: entry.name, priorState }
    })
  }

  /**
   * Close the roster row of a worker whose own completion was just accepted.
   * The mission is already completed; leaving the row `active` would keep a
   * dead-or-exiting child in the live budget and let a later miss stale it
   * again. There is no `completed` roster state (domain/roster.js owns that
   * vocabulary), so the terminal mapping is `inactive` plus an outcome that
   * names the self report.
   * @param {any} tower
   * @param {{ missionId: string, agentId: string }} input
   * @returns {Promise<{ marked: boolean }>}
   */
  export async function markSelfReportedCompletion(tower, { missionId, agentId }) {
    return tower.withStateLock(async (_paths, held) => {
      const state = await tower.load()
      const now = Date.now()
      const entry = (state.roster ?? []).find(
        (row) => String(row.agentId) === String(agentId) && row.missionId === missionId,
      )
      if (!entry || entry.state !== 'active') return { marked: false }
      entry.state = 'inactive'
      entry.outcome = 'completed (self-report)'
      entry.outcomeAt = now
      clearStale(entry)
      state.revision += 1
      state.updatedAt = now
      validateState(state, tower.paths.state)
      await tower.writeState(state, held)
      await tower.appendActivity({
        at: now,
        type: 'roster',
        missionId,
        text: `marked ${entry.name} inactive after self-reported completion (F73)`,
      })
      return { marked: true }
    })
  }

  /** Release live roster slots whose catalog activity is explicitly inactive. */
  export async function reconcileObservedInactive(tower, activity = {}) {
    return tower.withStateLock(async (_paths, held) => {
      const state = await tower.load()
      const now = Date.now()
      const { released } = reconcileInactive(state.roster ?? [], activity, now)
      if (released.length > 0) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, tower.paths.state)
        await tower.writeState(state, held)
        await tower.appendActivity({
          at: now,
          type: 'roster',
          text: `released inactive slots: ${released.join(', ')}`,
        })
      }
      return { released }
    })
  }

  /**
   * How long a reservation may stay `reserved` without an agent id before it is
   * treated as abandoned. `reserveRoster` -> `startActivation` -> `recordSpawn`
   * is a fast, serialized sequence, so a younger row may still belong to a
   * dispatch in flight; the grace window keeps the reap from racing it. Tests
   * backdate `reservedAt` by this constant instead of waiting.
   */
  export const STALLED_RESERVATION_GRACE_MS = 60_000

  /**
   * The age of a reservation in milliseconds. A row without a numeric
   * `reservedAt` (older releases wrote only `spawnedAt`) is treated as old.
   * @param {any} entry
   * @param {number} now
   * @returns {number}
   */
  function reservationAge(entry, now) {
    const at = Number(entry.reservedAt ?? entry.spawnedAt)
    return Number.isFinite(at) ? now - at : Number.POSITIVE_INFINITY
  }

  /** @param {any} entry @returns {string | null} */
  function checkoutPathOf(entry) {
    return typeof entry.reviewCheckout === 'string' && entry.reviewCheckout.length > 0
      ? entry.reviewCheckout
      : null
  }

  /**
   * True when `current` is still the same stalled reservation observed earlier:
   * same name, mission, reservedAt and reservation token, and still `reserved`
   * with no agent id.
   * @param {any} current
   * @param {any} candidate
   * @returns {boolean}
   */
  function sameReservation(current, candidate) {
    return (
      current !== undefined &&
      isStalledReservation(current) &&
      (current.missionId ?? null) === (candidate.missionId ?? null) &&
      current.reservedAt === candidate.reservedAt &&
      current.reservationId === candidate.reservationId
    )
  }

  /** Reap roster reservations that never received an agent id.
   *
   * A reservation is only a name claim bridging `reserveRoster` and
   * `recordSpawn`: `recordSpawn` binds the child id and flips the row to
   * `active`. A row still `reserved` with no agent id therefore records a spawn
   * that never got activation back (dispatch failed, process died); there is no
   * child to interrupt, adopt or observe, so the row can never converge on its
   * own and would wedge every later spawn for the mission. Delete it instead of
   * retiring it: no agent session ever existed, the activity log keeps the name,
   * and deleting leaves the name free so a spawn racing the reap can still
   * record. Any disposable review checkout is removed before the row is deleted
   * (see below); rows whose checkout cannot be removed are kept and reported. A
   * reserved row that already carries an agent id is past activation and is
   * never touched.
   *
   * A review spawn provisions a disposable detached checkout whose path is
   * recorded only on the roster row, so deleting the row without removing the
   * checkout leaks a live worktree registration. Removing a checkout shells out
   * to git and takes no state lock, so the reap is two-phase: scan and clean
   * checkouts outside the lock, then re-read under the lock and delete only the
   * reservations that are still the observed ones. A row whose checkout cannot
   * be removed is kept, with the path still on it, and reported in `unreaped`
   * so the caller can surface an actionable error instead of leaking silently.
   *
   * @param {any} tower
   * @param {{ graceMs?: number, now?: number }} [options]
   * @returns {Promise<{ reaped: any[], unreaped: any[] }>}
   */
  export async function reapStalledReservations(tower, options = {}) {
    const graceMs =
      Number.isFinite(options.graceMs) && /** @type {number} */ (options.graceMs) >= 0
        ? /** @type {number} */ (options.graceMs)
        : STALLED_RESERVATION_GRACE_MS
    const now = Number.isFinite(options.now) ? /** @type {number} */ (options.now) : Date.now()
    // Phase 1, outside the state lock: find reservations old enough to be
    // abandoned and remove their disposable checkouts.
    const observed = await tower.load()
    const candidates = (observed.roster ?? []).filter(
      (entry) => isStalledReservation(entry) && reservationAge(entry, now) >= graceMs,
    )
    if (candidates.length === 0) return { reaped: [], unreaped: [] }
    /** @type {Map<string, { checkout: string, error: string, attempts: number }>} */
    const failures = new Map()
    for (const candidate of candidates) {
      const checkout = checkoutPathOf(candidate)
      if (!checkout) continue
      // Re-read just before touching a checkout: another process may have
      // recorded the child (the reservation is then live) or reaped and
      // re-reserved the name in the meantime.
      const current = (await tower.load()).roster ?? []
      if (!sameReservation(current.find((entry) => entry.name === candidate.name), candidate)) continue
      const removal = await removeReviewCheckout(tower, checkout)
      if (!removal.ok) {
        failures.set(candidate.name, {
          checkout,
          error: removal.error ?? 'unknown removal error',
          attempts: removal.attempts ?? 0,
        })
      }
    }
    // Phase 2, under the lock: re-read and delete only the reservations that are
    // still exactly what phase 1 observed. The lock serializes the write, not
    // the scan, so a row that changed meanwhile must be left alone.
    return tower.withStateLock(async (_paths, held) => {
      const state = await tower.load()
      const roster = state.roster ?? []
      const reaped = []
      const unreaped = []
      const removedCheckouts = []
      /** @type {Set<any>} */
      const doomed = new Set()
      for (const candidate of candidates) {
        const current = roster.find((entry) => entry.name === candidate.name)
        if (!sameReservation(current, candidate)) continue
        const failure = failures.get(candidate.name)
        if (failure) {
          unreaped.push({
            name: current.name,
            missionId: current.missionId ?? null,
            role: current.role ?? null,
            checkout: failure.checkout,
            error: failure.error,
            attempts: failure.attempts,
          })
          continue
        }
        const checkout = checkoutPathOf(current)
        if (checkout) removedCheckouts.push(checkout)
        doomed.add(current)
        reaped.push({
          name: current.name,
          missionId: current.missionId ?? null,
          role: current.role ?? null,
          ...(checkout ? { checkout } : {}),
        })
      }
      if (reaped.length > 0) {
        const at = Date.now()
        state.roster = roster.filter((entry) => !doomed.has(entry))
        state.revision += 1
        state.updatedAt = at
        validateState(state, tower.paths.state)
        await tower.writeState(state, held)
        await tower.appendActivity({
          at,
          type: 'roster',
          text: `reaped stalled reservations: ${reaped
            .map((entry) => `${entry.name} (${entry.missionId ?? '-'})`)
            .join(', ')}${removedCheckouts.length > 0 ? `; removed review checkouts: ${removedCheckouts.join(', ')}` : ''}`,
        })
      }
      return { reaped, unreaped }
    })
  }

  export async function markRetired(tower, agentIds) {
    if (!Array.isArray(agentIds) || agentIds.length === 0) return { retired: [] }
    return tower.withStateLock(async (_paths, held) => {
      const state = await tower.load()
      const now = Date.now()
      const { retired } = retireEntries(state.roster ?? [], agentIds, now)
      if (retired.length > 0) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, tower.paths.state)
        await tower.writeState(state, held)
        await tower.appendActivity({
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
    return tower.withStateLock(async (_paths, held) => {
      const state = await tower.load()
      const now = Date.now()
      const { missing } = markMissingEntries(state.roster ?? [], agentIds, now)
      if (missing.length > 0) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, tower.paths.state)
        await tower.writeState(state, held)
        await tower.appendActivity({ at: now, type: 'adopt', text: `missing ${missing.join(', ')}` })
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
    return tower.withStateLock(async (_paths, held) => {
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
        await tower.writeState(state, held)
        await tower.appendActivity({
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
