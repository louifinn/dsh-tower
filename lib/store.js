import { TowerToolError } from '../domain/errors.js'
// Durable repo-scoped store: exclusive lock + atomic JSON + append-only activity.
// The atomic/lock/JSON primitives are shared with the mode store (#56 P2b).
import { fsp } from '../adapters/store-fs.js'
import {
  PROCESS_STARTED_AT,
  acquireLock,
  lockRecord,
  readLock,
} from './persistence.js'
import path from 'node:path'
import crypto from 'node:crypto'

export {
  readJson,
  writeJsonAtomic,
  writeJsonAtomicSync,
  renameWithRetry,
  appendJsonl,
} from './persistence.js'

export function pathsFor(commonDir) {
  const dir = path.join(commonDir, 'dsh-tower')
  return {
    dir,
    state: path.join(dir, 'state.json'),
    lock: path.join(dir, 'state.lock'),
    gitLock: path.join(dir, 'git.lock'),
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

export async function readStateLock(paths) {
  return readLock(paths.lock)
}

/**
 * Hold the repo-wide tower lock for one mutation. A lock whose recorded PID is
 * provably dead is reclaimed atomically; a live lock is reported, never stolen.
 */
export async function withLock(paths, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  const pollMs = options.pollMs ?? 25
  const token = crypto.randomUUID()
  const record = lockRecord(token, { startedAt: PROCESS_STARTED_AT })
  const held = await acquireLock(paths.lock, { token, record, timeoutMs, pollMs })
  if (!held) {
    const owner = await readStateLock(paths)
    const ownerRecord = owner.record
    const payload = owner.raw ?? (ownerRecord ? JSON.stringify(ownerRecord) : null)
    throw new TowerToolError(
      'state-locked',
      `tower state is locked by another writer${payload ? ` (${payload})` : ''}; retry after it finishes`,
    )
  }
  const startedAt = Date.now()
  try {
    return await fn(paths)
  } finally {
    await held.release()
    await fsp
      .appendFile(path.join(paths.dir, 'lock-holds.jsonl'), `${JSON.stringify({ at: Date.now(), ms: Date.now() - startedAt, pid: process.pid })}\n`, 'utf8')
      .catch(() => {})
  }
}

/** Serialize git mutations without holding the state lock. */
export async function withGitLock(paths, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60000
  const pollMs = options.pollMs ?? 25
  const lock = paths.gitLock
  const token = crypto.randomUUID()
  const startedAt = Date.now()
  const held = await acquireLock(lock, { token, record: lockRecord(token, { kind: 'git' }), timeoutMs, pollMs })
  if (!held) {
    throw new TowerToolError('state-locked', 'another git mutation is in progress for this repository; retry after it finishes')
  }
  try {
    return await fn(paths)
  } finally {
    await held.release()
    await fsp
      .appendFile(path.join(paths.dir, 'lock-holds.jsonl'), `${JSON.stringify({ at: Date.now(), ms: Date.now() - startedAt, pid: process.pid, phase: 'git' })}\n`, 'utf8')
      .catch(() => {})
  }
}
