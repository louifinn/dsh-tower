// Advisory repository workspace lock: one Tower session at a time when
// `mode.workspaceLock` is enabled. Same-user trusted model, like the rest of
// the Tower store: it prevents accidental double control, not a malicious
// writer.
import { fsp } from '../adapters/store-fs.js'
import path from 'node:path'
import crypto from 'node:crypto'

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
 * Remove the lock only if it is still the record we inspected. A concurrent
 * release/re-acquire must not be deleted by the loser of the race.
 */
async function removeLockIfMatches(file, expectedToken, expectedRaw) {
  const quarantine = `${file}.stale-${process.pid}-${crypto.randomUUID()}`
  try {
    await fsp.rename(file, quarantine)
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
  let moved = null
  try {
    moved = await fsp.readFile(quarantine, 'utf8')
  } catch {
    moved = null
  }
  const same = expectedToken ? (() => {
    try {
      return JSON.parse(moved ?? '')?.token === expectedToken
    } catch {
      return false
    }
  })() : moved !== null && moved === expectedRaw
  if (!same && moved !== null) {
    await fsp.rename(quarantine, file).catch(() => {})
    return false
  }
  await fsp.unlink(quarantine).catch(() => {})
  return true
}

/**
 * Try to become the repository's Tower session.
 * @returns {Promise<{acquired:boolean, record?:object, holder?:object|null, tookOver?:boolean, corrupt?:boolean}>}
 */
export async function acquireWorkspaceLock(commonDir, options) {
  const { token, sessionId, agentId, staleMs = 300000, now = Date.now() } = options
  await fsp.mkdir(path.dirname(workspaceLockPath(commonDir)), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = { token, sessionId, agentId, pid: process.pid, at: now }
    try {
      await fsp.writeFile(workspaceLockPath(commonDir), JSON.stringify(record), { flag: 'wx' })
      return { acquired: true, record, tookOver: attempt > 0 }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const { record: current, corrupt, file, raw } = await readRecord(commonDir)
      if (corrupt || !current) {
        // A corrupt lock is treated like an unknown holder; only a stale one
        // is removed, so a concurrent writer is never silently overwritten.
        let stale = false
        try {
          const stat = await fsp.stat(file)
          stale = now - stat.mtimeMs > staleMs
        } catch {
          stale = true
        }
        if (stale) {
          await removeLockIfMatches(file, null, raw)
          continue
        }
        return { acquired: false, holder: null, corrupt: true }
      }
      if (current.sessionId === sessionId && current.agentId === agentId) {
        await fsp.writeFile(workspaceLockPath(commonDir), JSON.stringify({ ...record, token: current.token }))
        return { acquired: true, record: { ...record, token: current.token }, tookOver: false }
      }
      if (now - Number(current.at ?? 0) > staleMs) {
        await removeLockIfMatches(file, current.token, raw)
        continue
      }
      return { acquired: false, holder: current }
    }
  }
  return { acquired: false, holder: null, corrupt: true }
}

/** Refresh the timestamp only when the lock still belongs to this session. */
export async function touchWorkspaceLock(commonDir, options) {
  const { token, now = Date.now() } = options
  const { record, file } = await readRecord(commonDir)
  if (!record || record.token !== token) return false
  await fsp.writeFile(file, JSON.stringify({ ...record, at: now }))
  return true
}

/** Release the lock only when this session owns it. */
export async function releaseWorkspaceLock(commonDir, options) {
  const { token } = options
  const { record, file, raw } = await readRecord(commonDir)
  if (!record || (token && record.token !== token)) return false
  return removeLockIfMatches(file, record.token, raw)
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
    stale: now - Number(record.at ?? 0) > staleMs,
  }
}
