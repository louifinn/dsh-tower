// Host binding for the ownership-transfer use case. The app/ layer stays free
// of mode-store and workspace-lock adapters; this module reads those facts and
// hands the decision to app/ownership.js.
import { loadModes } from './modeStore.js'
import { inspectWorkspaceLock, releaseWorkspaceLock } from '../adapters/workspaceLock.js'
import { ownershipSnapshot, transferOwnership } from '../app/ownership.js'

/**
 * @param {any} tower
 * @param {{ caller: string | null }} input
 */
export async function readOwnership(tower, { caller }) {
  const state = await tower.load()
  const modes = loadModes(tower.config?.mode?.storePath || undefined)
  const staleMs = Number(tower.config?.mode?.workspaceStaleMs) || 300000
  const lock = await inspectWorkspaceLock(tower.commonDir, {
    sessionId: caller ?? undefined,
    staleMs,
  })
  const roster = (await tower.rosterView()).roster
  return {
    state,
    modes,
    lock,
    roster,
    snapshot: ownershipSnapshot({ state, modes, caller, lock, liveRoster: roster }),
  }
}

/**
 * @param {any} tower
 * @param {{ caller: string, reason: string }} input
 */
export async function performTakeover(tower, { caller, reason }) {
  const facts = await readOwnership(tower, { caller })
  const result = await transferOwnership(tower, {
    caller,
    reason,
    modes: facts.modes,
    lock: facts.lock,
    liveRoster: facts.roster,
  })
  // A previous owner that is off or stale may have left an orphan lock behind.
  // The transfer is already audited by this point; releasing its token is the
  // same advisory cleanup /tower off performs.
  if (result.transferred && facts.snapshot.orphanLock && facts.lock?.holder?.token) {
    await releaseWorkspaceLock(tower.commonDir, { token: facts.lock.holder.token }).catch(() => {})
  }
  return { ...result, lock: facts.lock, ownerMode: facts.snapshot.ownerMode }
}
