// Host binding for the ownership-transfer use case. The app/ layer stays free
// of mode-store and workspace-lock adapters; this module reads those facts and
// hands the decision to app/ownership.js.
//
// Read paths (`readOwnership`, used by tower_status and tower_doctor) take a
// best-effort snapshot for display. The mutation path (`performTakeover`) reads
// the same facts *inside* the state lock through `transferOwnership`'s
// `readFacts` callback, so nothing observed before the lock can authorize a
// transfer.
import { loadModesDetailed } from './modeStore.js'
import { inspectWorkspaceLock, releaseWorkspaceLock } from '../adapters/workspaceLock.js'
import { ownershipSnapshot, transferOwnership } from '../app/ownership.js'

/**
 * @param {any} tower
 */
function modeStoreBase(tower) {
  const configured = tower.config?.mode?.storePath
  return configured ? String(configured) : undefined
}

/**
 * @param {any} tower
 */
function workspaceStaleMs(tower) {
  return Number(tower.config?.mode?.workspaceStaleMs) || 300000
}

/**
 * @param {any} tower
 * @param {string | null} caller
 */
async function readFacts(tower, caller) {
  const modeStore = loadModesDetailed(modeStoreBase(tower))
  const lock = await inspectWorkspaceLock(tower.commonDir, {
    sessionId: caller ?? undefined,
    staleMs: workspaceStaleMs(tower),
  })
  const roster = (await tower.rosterView()).roster
  return { modeStore, lock, roster }
}

/**
 * Read-only ownership view for status/doctor. `state` may be passed by a caller
 * that has already loaded the document (doctor does) so both checks describe
 * the same read.
 *
 * @param {any} tower
 * @param {{ caller: string | null, state?: any }} input
 */
export async function readOwnership(tower, { caller, state }) {
  const current = state ?? (await tower.load())
  const { modeStore, lock, roster } = await readFacts(tower, caller)
  return {
    state: current,
    modes: modeStore.modes,
    modeStore,
    lock,
    roster,
    snapshot: ownershipSnapshot({
      state: current,
      modes: modeStore.modes,
      modeStore,
      caller: caller ?? null,
      lock,
      liveRoster: roster,
    }),
  }
}

/**
 * Release the previous owner's orphan workspace lock with the token observed
 * under the state lock. Two guards protect the release: the holder must be the
 * previous owner (a foreign or new owner's lock is never touched), and
 * `releaseWorkspaceLock` only removes the exact token + bytes it inspected, so
 * a lock replaced after the state-lock section survives.
 *
 * @param {any} tower
 * @param {{ lock: any, previousOwner: string | null }} input
 */
async function releasePreviousOwnerLock(tower, { lock, previousOwner }) {
  const holder = lock?.holder ?? null
  if (!lock?.held || lock.self || lock.corrupt || !holder || !previousOwner) return false
  const ownsLock =
    String(holder.agentId ?? '') === previousOwner || String(holder.sessionId ?? '') === previousOwner
  if (!ownsLock || typeof holder.token !== 'string' || holder.token.length === 0) return false
  return releaseWorkspaceLock(tower.commonDir, { token: holder.token }).catch(() => false)
}

/**
 * @param {any} tower
 * @param {{ caller: string, reason: string, authorization?: string }} input
 */
export async function performTakeover(tower, { caller, reason, authorization }) {
  // The closure keeps the in-lock facts for the orphan-lock release. They are
  // never returned to the model, so the workspace lock token stays in process.
  /** @type {null | { lock: any, roster: any[] }} */
  let observed = null
  const result = await transferOwnership(tower, {
    caller,
    reason,
    authorization,
    async readFacts() {
      const facts = await readFacts(tower, caller)
      observed = { lock: facts.lock, roster: facts.roster }
      return {
        modes: facts.modeStore.modes,
        modeStore: facts.modeStore,
        lock: facts.lock,
        liveRoster: facts.roster,
      }
    },
  })
  // TypeScript cannot see the assignment inside the callback; assert the box.
  const heldFacts = /** @type {null | { lock: any, roster: any[] }} */ (observed)
  let releasedOrphanLock = false
  if (result.transferred && result.orphanLock && heldFacts) {
    releasedOrphanLock = await releasePreviousOwnerLock(tower, {
      lock: heldFacts.lock,
      previousOwner: result.previousOwner,
    })
  }
  return {
    ...result,
    releasedOrphanLock,
    // Public lock facts only: never the holder token.
    workspaceLock: heldFacts
      ? {
          held: heldFacts.lock?.held === true,
          stale: heldFacts.lock?.stale === true,
          corrupt: heldFacts.lock?.corrupt === true,
        }
      : { held: false, stale: false, corrupt: false },
  }
}
