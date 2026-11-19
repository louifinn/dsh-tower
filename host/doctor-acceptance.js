// Extra read-only doctor checks kept out of host/doctor.js.
//
// #159: an artifact mission's merge gate is a human acceptance of the committed
// tip, never a review. A pending acceptance is a warning (the human decides when
// to accept it), and a recorded one is reported so the decision stays visible
// without running preflight.
//
// #F32/#F71: the state writer lock and the short-lived state-commit mutex are
// the two records that can wedge every Tower mutation. Both checks live here
// too, so host/doctor.js stays under its file-size ceiling and the two records
// are described by one module: the doctor never reclaims or writes anything.
import { shapeFor } from '../domain/shapes/index.js'
import { lockTiming } from '../adapters/persistence.js'
import { inventoryOrphanWorktrees } from '../app/teardown.js'

// #F75: the remedy an artifact acceptance row injects is user-facing copy. The
// component gate reads this table, so the sentence names the human decision and
// the merge consequence without a tool id.
const DOCTOR_ACTION_COPY = Object.freeze({
  artifactAcceptance:
    'the human accepts through the approval channel; no agent may self-accept and the merge gate refuses without it',
  // #187: `create_worktree` is allowed and not denied; its checkouts become
  // visible here instead. The copy names the explicit sweep, never a tool id,
  // and states the boundary the sweep cannot cross (outside the worktree root).
  orphanWorktrees:
    'run the worktree teardown step with its orphan option; it removes only clean checkouts inside the worktree root, never the main checkout or a path outside it, and nothing is removed automatically',
})

/**
 * One `artifact-acceptance` doctor check over the loaded state.
 * @param {{ missions?: any[] }} state
 */
export function artifactAcceptanceCheck(state) {
  const missions = (state.missions ?? []).filter((mission) => shapeFor(mission.kind).fields.acceptance)
  const pending = missions.filter((mission) => !shapeFor(mission.kind).isTerminal(mission.status) && !(/** @type {any} */ (mission).acceptance))
  const accepted = missions.filter((mission) => Boolean(/** @type {any} */ (mission).acceptance))
  if (pending.length > 0) {
    return {
      id: 'artifact-acceptance',
      status: 'warn',
      detail: `${pending.length} artifact mission(s) wait on a human acceptance of the committed tip (${pending.map((mission) => mission.id).join(', ')})`,
      action: DOCTOR_ACTION_COPY.artifactAcceptance,
    }
  }
  return {
    id: 'artifact-acceptance',
    status: 'pass',
    detail:
      accepted.length > 0
        ? `${accepted.length} artifact mission(s) with a recorded human acceptance`
        : 'no artifact missions pending acceptance',
  }
}

/**
 * #187: report the checkouts git knows that no mission, sandbox or review row
 * records. `create_worktree` stays allowed (Tower does not deny the capability)
 * and this check is what makes its checkouts visible; a lost state file or a
 * crashed provision shows up the same way. Doctor is read-only — only the
 * explicit orphan sweep in `tower_teardown` removes anything, and only a clean
 * checkout strictly inside the worktree root. A checkout outside that root is
 * reported but can never be removed by the sweep, so the limitation is stated in
 * the row instead of hidden.
 * @param {any} tower
 * @param {any} state
 */
export async function orphanWorktreeCheck(tower, state) {
  let inventory
  try {
    inventory = await inventoryOrphanWorktrees(tower, state)
  } catch (error) {
    return {
      id: 'worktrees-orphans',
      status: 'warn',
      detail: `could not inventory git worktrees: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 240)}`,
      action: DOCTOR_ACTION_COPY.orphanWorktrees,
    }
  }
  const externalNote =
    inventory.external.length > 0
      ? `; ${inventory.external.length} checkout(s) outside the worktree root are unrecorded too and are never removed by Tower`
      : ''
  if (inventory.orphans.length === 0 && inventory.external.length === 0) {
    return { id: 'worktrees-orphans', status: 'pass', detail: 'no unrecorded worktrees' }
  }
  if (inventory.orphans.length === 0) {
    return {
      id: 'worktrees-orphans',
      status: 'warn',
      detail: `no unrecorded worktree inside the worktree root${externalNote}`,
      action: DOCTOR_ACTION_COPY.orphanWorktrees,
    }
  }
  const dirty = inventory.orphans.filter((entry) => entry.action === 'keep').length
  const prunable = inventory.orphans.filter((entry) => entry.action === 'prune').length
  const removable = inventory.orphans.length - dirty - prunable
  const parts = []
  if (removable > 0) parts.push(`${removable} clean`)
  if (dirty > 0) parts.push(`${dirty} with uncommitted changes (kept)`)
  if (prunable > 0) parts.push(`${prunable} with a stale registration`)
  return {
    id: 'worktrees-orphans',
    status: 'warn',
    detail: `${inventory.orphans.length} unrecorded worktree(s) under the worktree root (${parts.join(', ')})${externalNote}; run the worktree teardown step with its orphan option`,
    action: DOCTOR_ACTION_COPY.orphanWorktrees,
  }
}

function check(id, status, detail, action) {
  return { id, status, detail, ...(action ? { action } : {}) }
}

/**
 * Facts and the `state-lock` check for the state writer lock (#F32/#92).
 *
 * An unreadable record is a warning, never a pass (#F71 R1): the lock file
 * exists and every mutation keeps failing on it, so "no state lock" would hide
 * exactly the state the operator needs to repair.
 * @param {{ record: any, alive: boolean | null, path?: string, error?: string }} lock
 */
export function stateLockFacts(lock) {
  const timing = lockTiming(lock.record)
  const report = {
    held: Boolean(lock.record),
    unreadable: Boolean(lock.error),
    path: lock.path ?? null,
    error: lock.error ?? null,
    pid: lock.record?.pid ?? null,
    startedAt: lock.record?.startedAt ?? null,
    at: lock.record?.at ?? null,
    alive: lock.alive,
    ageMs: timing.ageMs,
    heartbeatAgeMs: timing.heartbeatAgeMs,
    staleAfterMs: timing.staleAfterMs,
    stale: timing.stale,
  }
  // The PID alone cannot distinguish a live writer from a recycled PID (#92);
  // report the heartbeat age so a stuck tower is diagnosable without reading
  // the file.
  const heartbeatText =
    timing.heartbeatAgeMs === null
      ? 'no heartbeat timestamp'
      : `last heartbeat ${timing.heartbeatAgeMs}ms ago (stale after ${timing.staleAfterMs}ms)`
  const row = lock.error
    ? check(
        'state-lock',
        'warn',
        `unreadable state lock at ${lock.path ?? 'the state lock file'} (${lock.error}); every mutation retries it and then fails until it is moved aside`,
        'confirm no Tower writer is active, then run the clear-stale-lock recovery step with force:true and confirm:"CLEAR_STALE_LOCK" to rename the unreadable record to a backup (never delete it)',
      )
    : !lock.record
      ? check('state-lock', 'pass', 'no state lock file')
      : lock.alive === false
      ? check(
          'state-lock',
          'warn',
          `stale state lock (pid ${lock.record.pid ?? 'unknown'} is gone; ${heartbeatText}); the next mutation reclaims it atomically`,
        )
      : timing.stale
        ? check(
            'state-lock',
            'warn',
            `state lock pid ${lock.record.pid ?? 'unknown'} is alive but silent (${heartbeatText}); a live-but-silent holder is never reclaimed automatically`,
            'confirm the process is gone (or stop it), then run the clear-stale-lock recovery step with force:true and confirm:"CLEAR_STALE_LOCK" to move the record to a backup',
          )
        : check(
            'state-lock',
            'warn',
            `state lock held by pid ${lock.record.pid ?? 'unknown'}; ${heartbeatText}; retry after it finishes`,
          )
  return { report, check: row }
}

/**
 * Facts and the `commit-lock` check for the short-lived commit mutex (#F71).
 *
 * The mutex is held for one serialise→rename→read-back window, so a record
 * that outlives its process is a leftover fence, not a lock anyone waits out.
 * This check is diagnostic only: `tower_recover clear-stale-lock` is the
 * audited way to move the record aside, and the live holder path always keeps
 * the record (a writer may be between its last CAS and the rename).
 *
 * An unreadable mutex is a warning, never a pass (#F71 R1): the torn record
 * exists and every state write keeps failing on it with `state-commit-busy`.
 * @param {{ record: any, alive: boolean | null, path?: string, error?: string } | null} lock
 */
export function commitLockFacts(lock) {
  const timing = lockTiming(lock?.record ?? null)
  const report = {
    held: Boolean(lock?.record),
    unreadable: Boolean(lock?.error),
    path: lock?.path ?? null,
    error: lock?.error ?? null,
    pid: lock?.record?.pid ?? null,
    token: lock?.record?.token ?? null,
    at: lock?.record?.at ?? null,
    alive: lock?.alive ?? null,
    ageMs: timing.ageMs,
    heartbeatAgeMs: timing.heartbeatAgeMs,
    staleAfterMs: timing.staleAfterMs,
    stale: timing.stale,
  }
  const heldText =
    timing.ageMs === null ? 'an unknown duration' : `${Math.max(0, Math.round(timing.ageMs))}ms`
  const row = lock?.error
    ? check(
        'commit-lock',
        'warn',
        `unreadable state commit mutex at ${lock.path ?? 'the commit lock file'} (${lock.error}); every state write retries it and then fails with state-commit-busy until it is moved aside`,
        'confirm no Tower writer is active, then run the clear-stale-lock recovery step with force:true and confirm:"CLEAR_STALE_LOCK" to rename the unreadable record to a backup (never delete it)',
      )
    : !lock?.record
      ? check('commit-lock', 'pass', 'no state commit mutex')
      : lock.alive === false
      ? check(
          'commit-lock',
          'warn',
          `leftover state commit mutex (pid ${lock.record.pid ?? 'unknown'} is gone; held for ${heldText}); the next state mutation reclaims it atomically`,
        )
      : timing.stale
        ? check(
            'commit-lock',
            'warn',
            `state commit mutex pid ${lock.record.pid ?? 'unknown'} is alive but silent (last activity ${heldText} ago); a live commit holder is never reclaimed automatically`,
            'confirm no Tower writer is active, then run the clear-stale-lock recovery step with force:true and confirm:"CLEAR_STALE_LOCK" to move the record to a backup',
          )
        : check(
            'commit-lock',
            'warn',
            `state commit in progress (pid ${lock.record.pid ?? 'unknown'}, held for ${heldText}); retry after it finishes`,
          )
  return { report, check: row }
}
