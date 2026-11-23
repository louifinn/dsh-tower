// Roster observation and retirement use cases.
import { validateState } from '../domain/state.js'
import { isStalledReservation } from '../domain/collab/spawn.js'
import { removeReviewCheckout } from './reviewCheckout.js'
import {
  recordRosterObservations as recordObservations,
  reconcileObservedInactive as reconcileInactive,
  retireEntries,
  markMissingEntries,
  reviveSelfReportedEntry,
  sweepRosterState,
  sweepCandidate,
  residueRecord,
  countPorcelainPaths,
} from '../domain/collab/roster.js'
import { unreadMessages } from '../domain/collab/messages.js'

/**
 * #211: stamp the roster rows a use case changed with the revision it just
 * wrote, so `tower_inspect status sinceRevision` can return only newer rows.
 * @param {any} state
 * @param {any[]} rows
 * @returns {void}
 */
function stampRevision(state, rows) {
  for (const row of rows) row.revision = state.revision
}

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
        const presentIds = new Set(present)
        const absentIds = new Set(absent)
        stampRevision(
          state,
          (state.roster ?? []).filter((row) => presentIds.has(row.agentId) || absentIds.has(row.agentId)),
        )
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
   *
   * `tower_complete` does not call this separately any more: its completion
   * transaction applies the same transition together with the settle, under
   * one state lock (`app/checkCompletion.js`). This use case stays as the
   * revival-only path (recovery, tests) and shares the pure rule.
   * @param {any} tower
   * @param {{ missionId: string, agentId: string }} input
   * @returns {Promise<{ revived: boolean, name?: string, remark?: boolean }>}
   */
  export async function reviveStaleSelfReporter(tower, { missionId, agentId }) {
    return tower.withStateLock(async (_paths, held) => {
      const state = await tower.load()
      const now = Date.now()
      const revived = reviveSelfReportedEntry(state.roster ?? [], { missionId, agentId, now })
      if (!revived.revived) return { revived: false }
      state.revision += 1
      stampRevision(
        state,
        (state.roster ?? []).filter((row) => row.name === revived.name && row.missionId === missionId),
      )
      state.updatedAt = now
      validateState(state, tower.paths.state)
      await tower.writeState(state, held)
      await tower.appendActivity({
        at: now,
        type: 'roster',
        missionId,
        text: `revived ${revived.name} from stale: it called tower_complete itself, so the child is alive (F73)`,
      })
      return revived
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
        stampRevision(
          state,
          (state.roster ?? []).filter((row) => released.includes(row.name)),
        )
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
        stampRevision(
          state,
          (state.roster ?? []).filter((row) => retired.includes(row.agentId)),
        )
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
        stampRevision(
          state,
          (state.roster ?? []).filter((row) => missing.includes(row.agentId)),
        )
        state.updatedAt = now
        validateState(state, tower.paths.state)
        await tower.writeState(state, held)
        await tower.appendActivity({ at: now, type: 'adopt', text: `missing ${missing.join(', ')}` })
      }
      return { missing }
    })
  }

  /**
   * Probe the worktree of one dying row for the residue it leaves behind (#231).
   *
   * Runs outside the state lock: it shells out to git, and the lock must never
   * be held across a subprocess. Every probe tolerates failure — a worktree that
   * was torn down (or a git that refused) degrades to a zero-file record instead
   * of aborting the sweep, because recording the death matters more than the
   * counts.
   * @param {any} tower
   * @param {any} row
   * @param {any} mission
   * @param {number} now
   * @returns {Promise<any>}
   */
  async function probeResidue(tower, row, mission, now) {
    const worktree = mission?.worktree ?? null
    const cwd = row.cwd ?? worktree?.path ?? null
    const branch = row.branch ?? worktree?.branch ?? null
    if (!cwd) return residueRecord({ at: now, branch, cause: row.failureReason ?? row.outcome ?? null })
    const status = await tower.tryGit(cwd, ['status', '--porcelain'])
    const tip = await tower.tryGit(cwd, ['rev-parse', 'HEAD'])
    return residueRecord({
      at: now,
      status,
      filesChanged: status === null ? 0 : countPorcelainPaths(status),
      branch,
      tip: typeof tip === 'string' ? tip.trim() : null,
      cause: row.failureReason ?? row.outcome ?? null,
    })
  }

  /** Mark live roster entries whose catalog activity disappeared after staleMs.
   * `authoritative` must be true only when the parent catalog was readable;
   * unknown state is never treated as stopped.
   *
   * #231: a row the sweep marks stale also records the residue it leaves behind
   * — the git facts are probed here (outside the commit-critical section, before
   * the shared lock) and carried in as plain values, and the same record is
   * copied onto the mission as `predecessorResidue` so a successor's briefing
   * can name the count without reading git itself. */
  export async function sweepRoster(tower, input = {}) {
    const staleMs = Number(input.staleMs) || 0
    if (staleMs <= 0 || input.authoritative !== true) return { marked: [], idled: [] }
    const activity = input.activity ?? {}
    // Phase 1, outside the lock: find the rows this sweep would mark and probe
    // each one's worktree. The predicate is the shared one (sweepCandidate), so
    // the pre-scan and the sweep can never disagree about the rule.
    const observed = await tower.load()
    const now = Date.now()
    const candidates = (observed.roster ?? []).filter((row) => sweepCandidate(row, { activity, staleMs, now }))
    /** @type {Record<string, any>} */
    const residue = {}
    for (const row of candidates) {
      const mission = (observed.missions ?? []).find((entry) => entry.id === row.missionId)
      residue[row.name] = await probeResidue(tower, row, mission, now)
    }
    return tower.withStateLock(async (_paths, held) => {
      const state = await tower.load()
      const sweptAt = Date.now()
      const { marked, idled } = sweepRosterState(
        state.roster ?? [],
        { activity, staleMs, authoritative: input.authoritative, residue },
        sweptAt,
      )
      if (marked.length > 0 || idled.length > 0) {
        state.revision += 1
        const names = new Set([...marked, ...idled])
        stampRevision(
          state,
          (state.roster ?? []).filter((row) => names.has(row.name)),
        )
        // #231: the death of a mission's worker is mission-scoped news: a
        // successor spawned later must see the residue in its briefing without
        // running git. Only a predecessor that actually left work behind is
        // news — a clean tree produces no sentence and no response field, so
        // "the predecessor finished its edits and died" does not fill the next
        // briefing with a paragraph about nothing.
        for (const row of state.roster ?? []) {
          if (!marked.includes(row.name)) continue
          const mission = (state.missions ?? []).find((entry) => entry.id === row.missionId)
          if (!mission || !row.residue) continue
          if (!(row.residue.filesChanged > 0)) continue
          mission.predecessorResidue = { name: row.name, ...row.residue }
        }
        state.updatedAt = sweptAt
        validateState(state, tower.paths.state)
        await tower.writeState(state, held)
        await tower.appendActivity({
          at: sweptAt,
          type: 'watchdog',
          text: `stale ${marked.join(', ') || '-'}; idle ${idled.join(', ') || '-'}`,
        })
        for (const row of state.roster ?? []) {
          if (!marked.includes(row.name) || !row.residue) continue
          await tower.appendActivity({
            at: sweptAt,
            type: 'watchdog',
            missionId: row.missionId ?? undefined,
            text: `residue ${row.name}: ${row.residue.filesChanged} file(s) changed on ${row.residue.branch ?? '-'} at ${String(row.residue.tip ?? '-').slice(0, 12)}`,
          })
        }
      }
      return { marked, idled }
    })
  }

  export function unreadFor(tower, state, name) {
    return /** @type {any} */ (unreadMessages(state, name))
  }
