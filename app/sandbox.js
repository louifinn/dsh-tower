// Disposable detached survey sandboxes (#148 W2).
//
// A `survey.sandbox: 'detached'` survey reads in a detached git worktree with no
// branch. The checkout is disposable: completion, abandon and teardown remove it
// with a bounded retry. Cleanup is advisory — a removal failure leaves the
// recorded path and a visible diagnostic in state, and never fails or corrupts
// the transition that triggered it.
// @ts-check
import path from 'node:path'
import { validateState } from '../domain/state.js'

/** Bounded cleanup attempts: a transient git lock or busy file is retried. */
export const SANDBOX_CLEANUP_ATTEMPTS = 3
export const SANDBOX_RETRY_DELAY_MS = 50

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * @param {any} tower
 * @param {string} sandbox
 * @returns {Promise<boolean>}
 */
async function registered(tower, sandbox) {
  try {
    const entries = await tower.deps.vcs.listWorktrees(tower.root)
    return entries.some((entry) => entry.path && path.resolve(entry.path) === path.resolve(sandbox))
  } catch {
    return false
  }
}

/**
 * Remove one detached sandbox worktree, retrying a bounded number of times.
 * Never throws: the result is the diagnostic. A path git no longer registers is
 * treated as already removed, so a half-finished cleanup is not an error.
 * @param {any} tower
 * @param {string} sandbox
 * @param {{ attempts?: number, delayMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, removed: boolean, attempts: number, error?: string }>}
 */
export async function removeSandbox(tower, sandbox, options = {}) {
  const attempts = Math.max(1, options.attempts ?? SANDBOX_CLEANUP_ATTEMPTS)
  const delayMs = options.delayMs ?? SANDBOX_RETRY_DELAY_MS
  /** @type {unknown} */
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (!(await registered(tower, sandbox))) return { ok: true, removed: false, attempts: attempt }
      await tower.deps.store.withGitLock(tower.paths, async () => {
        await tower.git(tower.root, ['worktree', 'remove', '--force', sandbox])
      }, tower.gitMutexOptions({ phase: 'sandbox-cleanup' }))
      // Removing the registered worktree also removes its directory. Verify
      // both, so a git that reports success but leaves the entry is retried.
      if (!(await tower.deps.store.exists(sandbox)) && !(await registered(tower, sandbox))) {
        return { ok: true, removed: true, attempts: attempt }
      }
      lastError = new Error(`git still reports ${sandbox} after worktree remove`)
    } catch (error) {
      lastError = error
      if (!(await registered(tower, sandbox))) return { ok: true, removed: false, attempts: attempt }
    }
    if (attempt < attempts && delayMs > 0) await delay(delayMs)
  }
  return {
    ok: false,
    removed: false,
    attempts,
    error: String(/** @type {{ message?: unknown }} */ (lastError)?.message ?? lastError ?? 'sandbox cleanup failed').slice(0, 400),
  }
}

/**
 * Remove a mission's recorded sandbox and persist the outcome under a short
 * state lock. Success clears `mission.sandbox`; failure keeps it and records an
 * actionable `sandboxCleanupError` plus an activity entry, so the tower can see
 * the retained path and retry without the state contradicting the filesystem.
 *
 * Returns null when the mission has no sandbox (or no longer exists).
 * @param {any} tower
 * @param {string} missionId
 * @param {{ attempts?: number, delayMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, removed: boolean, attempts: number, path: string, error?: string } | null>}
 */
export async function cleanupSandbox(tower, missionId, options = {}) {
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === missionId)
  const sandbox = mission && typeof /** @type {any} */ (mission).sandbox === 'string' ? /** @type {any} */ (mission).sandbox : null
  if (!sandbox) return null
  const removal = await removeSandbox(tower, sandbox, options)
  const now = Date.now()
  await tower.deps.store.withLock(tower.paths, async () => {
    const fresh = await tower.load()
    const current = fresh.missions.find((entry) => entry.id === missionId)
    if (!current || /** @type {any} */ (current).sandbox !== sandbox) return
    const record = /** @type {any} */ (current)
    if (removal.ok) {
      delete record.sandbox
      delete record.sandboxCleanupError
      record.sandboxRemovedAt = now
    } else {
      record.sandboxCleanupError = removal.error
    }
    current.updatedAt = now
    fresh.revision += 1
    fresh.updatedAt = now
    validateState(fresh, tower.paths.state)
    await tower.deps.store.writeJsonAtomic(tower.paths.state, fresh)
    await tower.deps.store.appendJsonl(tower.paths.activity, {
      at: now,
      type: 'sandbox',
      missionId,
      text: removal.ok
        ? `removed detached sandbox at ${sandbox}`
        : `sandbox cleanup failed after ${removal.attempts} attempt(s): ${removal.error}; path retained at ${sandbox} — remove it with "git worktree remove --force ${sandbox}" and call tower_teardown to retry the record`,
    }).catch(() => {})
  })
  return { ...removal, path: sandbox }
}
