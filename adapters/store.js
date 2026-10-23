import { TowerToolError } from '../domain/errors.js'
// Durable repo-scoped store: exclusive lock + atomic JSON + append-only activity.
// The atomic/lock/JSON primitives are shared with the mode store (#56 P2b).
import { fsp } from './store-fs.js'
import {
  PROCESS_STARTED_AT,
  acquireLock,
  lockRecord,
  lockTiming,
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

export async function readStateLock(paths, options = {}) {
  return readLock(paths.lock, options)
}

/** Read the repo-scoped git mutex; a missing/free lock is not an error. */
export async function readGitLock(paths, options = {}) {
  return readLock(paths.gitLock, options)
}

// The git-mutex budget is pure policy over the resolved config (#93) and is
// shared with the app layer, so it lives in the domain (#69). Re-exported here
// for the store's callers and tests; the state lock keeps its short 5 s default.
export { GIT_LOCK_MARGIN_MS, gitLockTimeoutMs } from '../domain/lockBudget.js'

/**
 * Read-only projection of the git mutex for tower_status/tower_doctor: the
 * shape is `{ held: true, pid, phase, heldMs }` while a holder exists and
 * `{ held: false }` when it is free.
 */
export function gitLockView(lock, options = {}) {
  const record = lock?.record
  if (!record) return { held: false }
  return {
    held: true,
    pid: record.pid ?? null,
    phase: record.phase ?? null,
    heldMs: lockTiming(record, options).ageMs,
  }
}

/**
 * Paths objects whose state lock this process currently holds. A state
 * migration may be persisted only inside `withLock`: the loader reads this to
 * tell a locked mutation (which may write) from a read-only load (which must
 * migrate in memory and leave the file alone).
 */
const HELD_STATE_LOCKS = new WeakSet()

/** @param {object} [paths] @returns {boolean} */
export function isStateLockHeld(paths) {
  return Boolean(paths) && HELD_STATE_LOCKS.has(paths)
}

/**
 * Hold the repo-wide tower lock for one mutation. A lock whose recorded PID is
 * provably dead is reclaimed atomically; a live lock is reported, never
 * stolen. While held the record heartbeats, so another process can tell a live
 * writer from a recycled PID (#92). `heartbeatMs`/`heartbeatStaleMs`/`now` are
 * injectable for tests; production callers use the defaults.
 */
export async function withLock(paths, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  const pollMs = options.pollMs ?? 25
  const token = crypto.randomUUID()
  const record = lockRecord(token, { startedAt: PROCESS_STARTED_AT }, options)
  const held = await acquireLock(paths.lock, { ...options, token, record, timeoutMs, pollMs })
  if (!held) {
    const owner = await readStateLock(paths, options)
    const ownerRecord = owner.record
    const payload = owner.raw ?? (ownerRecord ? JSON.stringify(ownerRecord) : null)
    throw new TowerToolError(
      'state-locked',
      `tower state is locked by another writer${payload ? ` (${payload})` : ''}; retry after it finishes`,
    )
  }
  const startedAt = Date.now()
  HELD_STATE_LOCKS.add(paths)
  try {
    return await fn(paths)
  } finally {
    HELD_STATE_LOCKS.delete(paths)
    await held.release()
    await fsp
      .appendFile(path.join(paths.dir, 'lock-holds.jsonl'), `${JSON.stringify({ at: Date.now(), ms: Date.now() - startedAt, pid: process.pid })}\n`, 'utf8')
      .catch(() => {})
  }
}

function formatSeconds(ms) {
  if (!Number.isFinite(ms)) return 'an unknown time'
  return `${Math.max(0, Math.round(ms / 1000))} s`
}

/**
 * Serialize git mutations without holding the state lock. The caller owns the
 * wait budget: a merge passes its resolved `plan.timeoutMs`, and the other git
 * mutations pass the same merge-derived budget (#93). While held the record
 * carries `kind: 'git'` and the caller's `phase` (merge/rebase/init/teardown/
 * provision), so a waiter and the read-only diagnostics can name the holder.
 */
export async function withGitLock(paths, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60000
  const pollMs = options.pollMs ?? 25
  const phase = options.phase ?? 'git'
  const lock = paths.gitLock
  const token = crypto.randomUUID()
  const clock = typeof options.now === 'function' ? options.now : Date.now
  const waitStartedAt = clock()
  const startedAt = Date.now()
  // The heartbeat matters here too: a legitimate pre-merge hook can hold this
  // lock for minutes, and a stale-heartbeat reclaim must not mistake that for
  // a crash (#92, #93).
  const held = await acquireLock(lock, {
    ...options,
    token,
    record: lockRecord(token, { kind: 'git', phase }, options),
    timeoutMs,
    pollMs,
  })
  if (!held) {
    const owner = await readLock(lock, options)
    const record = owner.record
    const waitedMs = Math.max(0, clock() - waitStartedAt)
    const heldMs = record ? lockTiming(record, options).ageMs : null
    const holderPid = record?.pid ?? null
    const holderPhase = record?.phase ?? null
    const facts = record
      ? `held by pid ${holderPid ?? 'unknown'}${holderPhase ? ` (${holderPhase})` : ''} for ${formatSeconds(heldMs)}; waited ${formatSeconds(waitedMs)}`
      : `the lock was released before it could be inspected; waited ${formatSeconds(waitedMs)}`
    throw new TowerToolError(
      'state-locked',
      `another git mutation is in progress for this repository: ${facts}; retry after it finishes`,
      { details: { holderPid, holderPhase, heldMs, waitedMs } },
    )
  }
  const waitedMs = Math.max(0, clock() - waitStartedAt)
  try {
    return await fn(paths)
  } finally {
    await held.release()
    await fsp
      .appendFile(
        path.join(paths.dir, 'lock-holds.jsonl'),
        `${JSON.stringify({ at: Date.now(), ms: Date.now() - startedAt, pid: process.pid, kind: 'git', phase, budgetMs: timeoutMs, waitedMs })}\n`,
        'utf8',
      )
      .catch(() => {})
  }
}
