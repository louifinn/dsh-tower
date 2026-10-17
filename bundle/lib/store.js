// Durable repo-scoped store: exclusive lock + atomic JSON + append-only activity.
import fsp from 'node:fs/promises'
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
  await fsp.rename(tmp, file)
}

export async function appendJsonl(file, value) {
  await fsp.appendFile(file, `${JSON.stringify(value)}\n`, 'utf8')
}

export function shortHash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 12)
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

/**
 * Hold the repo-wide tower lock for one mutation. Stale locks are reported,
 * never silently stolen (matches the fail-closed protocol).
 */
export async function withLock(paths, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  const pollMs = options.pollMs ?? 25
  const token = crypto.randomUUID()
  const record = JSON.stringify({ token, pid: process.pid, at: Date.now() })
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      await fsp.writeFile(paths.lock, record, { flag: 'wx' })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (Date.now() > deadline) {
        let owner = null
        try {
          owner = await fsp.readFile(paths.lock, 'utf8')
        } catch {
          owner = null
        }
        throw new Error(
          `tower state is locked by another writer${owner ? ` (${owner})` : ''}; retry after it finishes`,
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
