// Durable repo-scoped store: exclusive lock + atomic JSON + append-only activity.
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function pathsFor(commonDir) {
  const dir = path.join(commonDir, 'dsh-tower')
  return {
    dir,
    state: path.join(dir, 'state.json'),
    lock: path.join(dir, 'state.lock'),
    activity: path.join(dir, 'activity.jsonl'),
  }
}

export async function exists(file) {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

export async function readJson(file) {
  const text = await fsp.readFile(file, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`corrupt tower state at ${file}: ${error.message}`)
  }
}

export async function writeJsonAtomic(file, value) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`)
  const handle = await fsp.open(tmp, 'w')
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await renameWithRetry(tmp, file)
}

/**
 * Windows can reject a rename while an indexer, antivirus, or a concurrent
 * reader still holds the destination; retry briefly instead of failing a
 * successful mutation. The temp file is removed when the rename never lands.
 */
async function renameWithRetry(tmp, file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(tmp, file)
      return
    } catch (error) {
      const transient = error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES'
      if (!transient || attempt >= 12) {
        await fsp.unlink(tmp).catch(() => {})
        throw error
      }
      await sleep(10 + attempt * 15)
    }
  }
}

export { renameWithRetry }

export async function appendJsonl(file, value) {
  await fsp.appendFile(file, `${JSON.stringify(value)}\n`, 'utf8')
}

export function shortHash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 12)
}

/** Synchronous counterpart used by the mode store's short critical section. */
export function writeJsonAtomicSync(file, value) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`)
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (error) {
      const transient = error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES'
      if (!transient || attempt >= 12) {
        try {
          fs.unlinkSync(tmp)
        } catch {
          // best effort
        }
        throw error
      }
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + attempt * 15)
      } catch {
        // busy loop fallback is worse than a short retry
      }
    }
  }
}

export async function readActivityTail(file, limit = 12) {
  const text = await fsp.readFile(file, 'utf8').catch(() => '')
  const lines = text.split('\n').filter(Boolean)
  const tail = lines.slice(Math.max(0, lines.length - limit))
  const out = []
  for (const line of tail) {
    try {
      out.push(JSON.parse(line))
    } catch {
      // keep going: a truncated activity line must not hide the rest
    }
  }
  return out
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000)

function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    // EPERM means the process exists but belongs to another user.
    return true
  }
}

/** Read the current lock record without acquiring the lock. */
export async function readStateLock(paths) {
  try {
    const text = await fsp.readFile(paths.lock, 'utf8')
    const record = JSON.parse(text)
    const alive = processAlive(record?.pid)
    return { path: paths.lock, record, alive, raw: text }
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: paths.lock, record: null, alive: null, raw: null }
    return { path: paths.lock, record: null, alive: null, raw: null, error: String(error?.message ?? error) }
  }
}

async function reclaimDeadLock(paths) {
  let original
  try {
    original = await fsp.readFile(paths.lock, 'utf8')
  } catch {
    return false
  }
  let parsed
  try {
    parsed = JSON.parse(original)
  } catch {
    return false
  }
  if (processAlive(parsed?.pid) !== false) return false
  const quarantine = `${paths.lock}.stale-${process.pid}-${crypto.randomUUID()}`
  try {
    await fsp.rename(paths.lock, quarantine)
  } catch {
    return false
  }
  const moved = await fsp.readFile(quarantine, 'utf8').catch(() => null)
  if (moved === null || moved !== original) {
    // A concurrent writer replaced the lock between read and rename. Put the
    // newer record back rather than deleting it.
    if (moved !== null) await fsp.rename(quarantine, paths.lock).catch(() => {})
    return false
  }
  await fsp.unlink(quarantine).catch(() => {})
  return true
}

/**
 * Hold the repo-wide tower lock for one mutation. A lock whose recorded PID is
 * provably dead is reclaimed atomically; a live lock is reported, never stolen.
 */
export async function withLock(paths, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  const pollMs = options.pollMs ?? 25
  const token = crypto.randomUUID()
  const record = JSON.stringify({ token, pid: process.pid, startedAt: PROCESS_STARTED_AT, at: Date.now() })
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      await fsp.writeFile(paths.lock, record, { flag: 'wx' })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (await reclaimDeadLock(paths)) continue
      if (Date.now() > deadline) {
        const owner = /** @type {any} */ (await readStateLock(paths))
        const payload = owner.raw ?? (owner.record ? JSON.stringify(owner.record) : null)
        throw new Error(
          `tower state is locked by another writer${payload ? ` (${payload})` : ''}; retry after it finishes`,
        )
      }
      await sleep(pollMs)
    }
  }

  try {
    return await fn(paths)
  } finally {
    try {
      const current = await fsp.readFile(paths.lock, 'utf8').catch(() => null)
      if (current) {
        const parsed = JSON.parse(current)
        if (parsed && parsed.token === token) await fsp.unlink(paths.lock)
      }
    } catch {
      // a lock left behind by a crash is reported by the next writer, not fixed here
    }
  }
}
