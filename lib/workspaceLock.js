// Advisory repository workspace lock: one Tower session at a time when
// `mode.workspaceLock` is enabled. Same-user trusted model, like the rest of
// the Tower store: it prevents accidental double control, not a malicious
// writer.
import fsp from 'node:fs/promises'
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
  try {
    const text = await fsp.readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return { file, record: null, corrupt: true }
    return { file, record: parsed, corrupt: false }
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, record: null, corrupt: false }
    return { file, record: null, corrupt: true }
  }
}

async function removeLock(file) {
  await fsp.unlink(file).catch((error) => {
    if (error?.code !== 'ENOENT') throw error
  })
}

/**
 * Try to become the repository's Tower session.
 * @returns {{acquired:boolean, record?:object, holder?:object|null, tookOver?:boolean, corrupt?:boolean}}
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
      const { record: current, corrupt, file } = await readRecord(commonDir)
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
          await removeLock(file)
          continue
        }
        return { acquired: false, holder: null, corrupt: true }
      }
      if (current.sessionId === sessionId && current.agentId === agentId) {
        await fsp.writeFile(workspaceLockPath(commonDir), JSON.stringify({ ...record, token: current.token }))
        return { acquired: true, record: { ...record, token: current.token }, tookOver: false }
      }
      if (now - Number(current.at ?? 0) > staleMs) {
        await removeLock(file)
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
  const { record, file } = await readRecord(commonDir)
  if (!record || (token && record.token !== token)) return false
  await removeLock(file)
  return true
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
