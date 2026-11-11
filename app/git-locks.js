// Stale Git-lock quarantine (W5-A).
//
// Extracted from app/tower.js without behavior change (#93/#149): the same
// snapshot/compare-and-swap protocol removes only lock files that are both old
// and unchanged since observation, and never deletes a foreign or newer lock.
// The store is passed in by the Tower instance, so this module imports no
// adapter.
import path from 'node:path'

export const GIT_LOCK_FILES = Object.freeze(['index.lock', 'HEAD.lock', 'MERGE_HEAD.lock', 'ORIG_HEAD.lock'])

/**
 * Identity of one lock file at observation time. Byte content alone cannot
 * distinguish a foreign empty lock from the empty lock we observed, so the
 * stat fingerprint (mtime, and size when the store exposes it) is part of the
 * compare-and-swap.
 * @typedef {{ raw: string, mtimeMs: number, size: number | null }} GitLockSnapshot
 */

/** @param {any} stat @returns {number | null} */
function statSize(stat) {
  return typeof stat?.size === 'number' && Number.isFinite(stat.size) ? stat.size : null
}

/**
 * Read one lock file and re-stat it, so a lock that changed while it was being
 * read is treated as in use and never claimed.
 * @param {any} store
 * @param {string} file
 * @returns {Promise<GitLockSnapshot | null>}
 */
async function snapshotGitLock(store, file) {
  let before
  try {
    before = await store.stat(file)
  } catch {
    return null
  }
  let raw
  try {
    raw = await store.readText(file)
  } catch {
    return null
  }
  let after
  try {
    after = await store.stat(file)
  } catch {
    return null
  }
  if (after.mtimeMs !== before.mtimeMs) return null
  return { raw, mtimeMs: before.mtimeMs, size: statSize(before) }
}

/**
 * Whether the quarantined file is still the one the snapshot described. A
 * rename preserves mtime on every supported platform; size is compared when
 * both the store and the snapshot expose it.
 * @param {any} store
 * @param {string} file
 * @param {GitLockSnapshot} snapshot
 * @returns {Promise<boolean>}
 */
async function sameLockSnapshot(store, file, snapshot) {
  let stat
  try {
    stat = await store.stat(file)
  } catch {
    return false
  }
  if (stat.mtimeMs !== snapshot.mtimeMs) return false
  const size = statSize(stat)
  return snapshot.size === null || size === null || size === snapshot.size
}

/**
 * Restore a mismatched quarantine with an exclusive create: EEXIST means a
 * newer writer owns the path (`exists()` + `rename()` would replace it), and
 * failures keep the quarantined bytes for audit.
 * @param {any} store
 * @param {string} quarantine
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function restoreQuarantinedGitLock(store, quarantine, file) {
  if (typeof store?.copyFileExclusive !== 'function') return false
  let restored = false
  try {
    await store.copyFileExclusive(quarantine, file)
    restored = true
    await store.unlink(quarantine)
  } catch {}
  return restored
}

/** Per-call unique quarantine name; pid and clocks separate processes and calls. */
async function gitLockQuarantinePath(store, file) {
  const base = `${file}.tower-stale-${process.pid}-${Date.now().toString(36)}-${process.hrtime.bigint().toString(36)}`
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`
    if (!(await store.exists(candidate))) return candidate
  }
  return null
}

/**
 * Remove only Git lock files that are both old and unchanged since the
 * observation. The lock is claimed by an atomic rename to a quarantine name,
 * then its bytes and stat fingerprint are compared with the snapshot; only the
 * quarantined copy that matches is unlinked. A foreign or newer lock is
 * restored (or kept in quarantine when its path was already reclaimed), never
 * deleted.
 * @param {any} tower
 * @param {string} commonDir
 * @param {number} [maxAgeMs]
 * @param {{ now?: number }} [options]
 * @returns {Promise<{ removed: string[], retained: Array<{ name: string, reason: string }> }>}
 */
export async function removeStaleGitLocks(tower, commonDir, maxAgeMs = 60000, options = {}) {
  const store = tower.deps.store
  const now = typeof options.now === 'number' ? options.now : Date.now()
  /** @type {string[]} */
  const removed = []
  /** @type {Array<{ name: string, reason: string }>} */
  const retained = []
  for (const name of GIT_LOCK_FILES) {
    const file = path.join(commonDir, name)
    const snapshot = await snapshotGitLock(store, file)
    if (!snapshot) continue
    // A fresh lock may belong to a concurrent Git process; deleting it would
    // let two writers into the index.
    if (now - snapshot.mtimeMs < maxAgeMs) {
      retained.push({ name, reason: 'fresh' })
      continue
    }
    const quarantine = await gitLockQuarantinePath(store, file)
    if (quarantine === null) continue
    try {
      // The rename is the claim; only the claimed bytes can now be deleted.
      await store.rename(file, quarantine)
    } catch {
      // Absent, or another process claimed it first. Never force.
      continue
    }
    let claimed = null
    try {
      claimed = await store.readText(quarantine)
    } catch {
      claimed = null
    }
    if (claimed === null || claimed !== snapshot.raw || !(await sameLockSnapshot(store, quarantine, snapshot))) {
      const restored = await restoreQuarantinedGitLock(store, quarantine, file)
      retained.push({ name, reason: restored ? 'replaced' : 'replaced-quarantined' })
      continue
    }
    try {
      await store.unlink(quarantine)
      removed.push(name)
    } catch {
      retained.push({ name, reason: 'unlink-failed' })
    }
  }
  return { removed, retained }
}
