// Advisory repository workspace lock: one Tower session at a time when
// `mode.workspaceLock` is enabled. Same-user trusted model, like the rest of
// the Tower store: it prevents accidental double control, not a malicious
// writer.
//
// Since #167 this lock uses the shared kernel in ./lock.js. A different live
// session is never taken over because its heartbeat or `at` is old: only a
// provably dead PID is reclaimed. A corrupt record fails closed (reported,
// never removed), and release requires the exact token and bytes.
import { fs, fsp } from './store-fs.js'
import path from 'node:path'
import crypto from 'node:crypto'
import { acquireLock, lockRecord, removeLockIfMatches, touchLock } from './lock.js'

export function workspaceLockPath(commonDir) {
  return path.join(commonDir, 'dsh-tower', 'tower.lock')
}

export function workspaceLockToken() {
  return crypto.randomUUID()
}

async function readRecord(commonDir) {
  const file = workspaceLockPath(commonDir)
  let text = null
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, record: null, corrupt: false, raw: null }
    return { file, record: null, corrupt: true, raw: null }
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return { file, record: null, corrupt: true, raw: text }
    return { file, record: parsed, corrupt: false, raw: text }
  } catch {
    return { file, record: null, corrupt: true, raw: text }
  }
}

/**
 * Try to become the repository's Tower session.
 *
 * A record owned by the same session/agent is re-adopted with its existing
 * token (the caller may have restarted and lost the in-memory token). Every
 * other record is refused unless its PID is provably dead, in which case the
 * kernel reclaims it by byte-verified CAS.
 *
 * @returns {Promise<{acquired:boolean, record?:object, holder?:object|null, tookOver?:boolean, corrupt?:boolean}>}
 */
export async function acquireWorkspaceLock(commonDir, options) {
  const { token, sessionId, agentId, staleMs = 300000, now = Date.now() } = options
  const file = workspaceLockPath(commonDir)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = lockRecord(token, { sessionId, agentId }, { now })
    const held = await acquireLock(file, {
      token,
      record,
      now,
      timeoutMs: 0,
      pollMs: 10,
      heartbeat: false,
      // A workspace record without a usable PID is never assumed dead: only
      // the mode store's historical records opt into `invalidPidIsDead`.
      invalidPidIsDead: false,
    })
    if (held) return { acquired: true, record, tookOver: held.reclaimed === true || attempt > 0 }

    const current = await readRecord(commonDir)
    if (current.corrupt) {
      // Unreadable bytes are an unknown owner, not an abandoned lock. Removing
      // them on a timer is how a concurrent writer gets overwritten.
      return { acquired: false, holder: null, corrupt: true }
    }
    if (!current.record) continue // raced with a release; try the exclusive create again
    if (current.record.sessionId === sessionId && current.record.agentId === agentId) {
      const refreshed = await touchLock(file, current.record.token, { now })
      if (refreshed) {
        return {
          acquired: true,
          record: { ...current.record, at: now },
          tookOver: false,
        }
      }
      continue // the record changed between read and touch
    }
    return { acquired: false, holder: current.record }
  }
  return { acquired: false, holder: null, corrupt: true }
}

/** Refresh the timestamp only when the lock still belongs to this session. */
export async function touchWorkspaceLock(commonDir, options) {
  const { token, now = Date.now() } = options
  if (typeof token !== 'string' || token.length === 0) return false
  return touchLock(workspaceLockPath(commonDir), token, { now })
}

/**
 * Release the lock only when this session owns it. A missing token never
 * releases anything: there is no blind unlink.
 */
export async function releaseWorkspaceLock(commonDir, options) {
  const { token } = options
  if (typeof token !== 'string' || token.length === 0) return false
  const { record, file, raw, corrupt } = await readRecord(commonDir)
  if (corrupt || !record || record.token !== token) return false
  return removeLockIfMatches(file, token, raw)
}

export async function inspectWorkspaceLock(commonDir, options = {}) {
  const { sessionId, staleMs = 300000, now = Date.now() } = options
  const { record, corrupt } = await readRecord(commonDir)
  if (!record) return { held: false, corrupt, self: false, holder: null, stale: false }
  return {
    held: true,
    corrupt,
    self: sessionId !== undefined && record.sessionId === sessionId,
    holder: record,
    // Diagnostic only: a stale live session is still the owner, not a target.
    stale: now - Number(record.at ?? 0) > staleMs,
  }
}

/**
 * Synchronous workspace-lock read for the mode guard (#161 D4). The guard is a
 * synchronous call, so it reads the record without the async kernel: held
 * means a record exists — a corrupt file fails closed exactly like
 * `acquireWorkspaceLock`, and staleness never demotes a live owner. Returns
 * `{ held: false }` when no lock file exists.
 * @param {string} commonDir
 * @returns {{ held: boolean, corrupt?: boolean, holder?: object | null }}
 */
export function inspectWorkspaceLockSync(commonDir) {
  const file = workspaceLockPath(commonDir)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { held: false }
    // Unreadable bytes are an unknown owner, not an abandoned lock.
    return { held: true, corrupt: true, holder: null }
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return { held: true, corrupt: true, holder: null }
    return { held: true, corrupt: false, holder: parsed }
  } catch {
    return { held: true, corrupt: true, holder: null }
  }
}
