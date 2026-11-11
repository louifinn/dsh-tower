import { TowerToolError } from '../domain/errors.js'
// Durable repo-scoped store: exclusive lock + atomic JSON + append-only activity.
// The atomic/JSON helpers are shared with the mode store (#56 P2b); the lock
// protocol is the single kernel in ./lock.js (#167).
import { fsp } from './store-fs.js'
import {
  PROCESS_STARTED_AT,
  acquireLock,
  lockRecord,
  lockTiming,
  readLock,
} from './lock.js'
import { writeJsonAtomic } from './persistence.js'
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
 * Paths objects whose state lock this process currently holds, mapped to the
 * token of that acquisition. A state write may proceed only with the exact
 * token this process acquired: the loader uses the same map to tell a locked
 * mutation from a read-only load, and `writeStateLocked` refuses every write
 * that was not made inside the matching `withLock` section (#167).
 */
const HELD_STATE_LOCKS = new WeakMap()

/** @param {object} [paths] @returns {boolean} */
export function isStateLockHeld(paths) {
  return Boolean(paths) && HELD_STATE_LOCKS.has(paths)
}

/** The token of the state lock this process holds for `paths`, or null. */
export function stateLockToken(paths) {
  return (paths && HELD_STATE_LOCKS.get(paths)) ?? null
}

/**
 * The in-process token map proves this process *started* the mutation while
 * holding the lock; it cannot prove the on-disk record still exists, or still
 * belongs to this mutation. A reclaim/release race (or any other process) can
 * move our record out of the lock path between `withLock` and the commit, and
 * another writer can then own the path. Verify the record immediately before
 * state.json is replaced, so a state write never lands under a lock we no
 * longer hold (#167).
 */
async function verifyStateLockHolder(paths, token) {
  const lockPath = paths.lock
  const recordPath = String(paths?.state ?? 'state.json')
  const held = await readLock(lockPath)
  const failure = 'error' in held ? held.error : null
  if (failure) {
    throw new TowerToolError(
      'state-locked',
      `refusing to write ${recordPath}: the state lock at ${lockPath} could not be verified (${failure})`,
      {
        retryable: false,
        nextAction: `inspect ${lockPath} and retry the mutation through withLock`,
        details: { reason: 'state-lock-unreadable', lockPath, expectedToken: token, error: String(failure) },
      },
    )
  }
  const record = held.record
  if (!record) {
    throw new TowerToolError(
      'state-locked',
      `refusing to write ${recordPath}: the state lock at ${lockPath} is missing; the record was moved or reclaimed by another process while the mutation was in flight`,
      {
        retryable: false,
        nextAction: 'retry the mutation through withLock; it did not own the lock when the write was attempted',
        details: { reason: 'state-lock-missing', lockPath, expectedToken: token },
      },
    )
  }
  if (record.token !== token) {
    throw new TowerToolError(
      'state-locked',
      `refusing to write ${recordPath}: the state lock at ${lockPath} no longer carries this mutation token (owner pid ${record.pid ?? 'unknown'}, token ${record.token ?? 'missing'}); another writer owns the lock`,
      {
        retryable: false,
        nextAction: 'the mutation did not write state; retry it through withLock once the current holder finishes',
        details: {
          reason: 'state-lock-holder-mismatch',
          lockPath,
          expectedToken: token,
          actualToken: record.token ?? null,
          pid: record.pid ?? null,
        },
      },
    )
  }
}

/**
 * Persist state.json only while this process holds the state lock with the
 * token from `withLock`. Any other caller — a read-only load that decided to
 * write, a stale token after a reclaim, or a direct write that bypassed the
 * lock — is refused instead of overwriting a concurrent writer's document.
 * The on-disk record is re-verified before commit (and once more after
 * serialisation, via the atomic writer's `verify` hook) so a record moved by
 * another process during the mutation cannot slip a stale write through.
 *
 * @param {{ state: string }} paths
 * @param {unknown} state
 * @param {string | undefined} token
 */
export async function writeStateLocked(paths, state, token) {
  const heldToken = stateLockToken(paths)
  if (typeof token !== 'string' || token.length === 0 || heldToken !== token) {
    throw new TowerToolError(
      'state-locked',
      `refusing to write ${String(paths?.state ?? 'state.json')} outside the held state lock (token missing or mismatched)`,
      { retryable: false, nextAction: 'take the state lock with withLock and pass the token it issues' },
    )
  }
  await verifyStateLockHolder(paths, token)
  await writeJsonAtomic(paths.state, state, { verify: () => verifyStateLockHolder(paths, token) })
}

/** Human-readable facts about a held lock for a waiter's error message. */
function stateLockFacts(owner, options = {}) {
  const record = owner.record
  if (!record) {
    return owner.error
      ? `the lock record is unreadable (${owner.error})`
      : 'the lock was released before it could be inspected'
  }
  const timing = owner.timing ?? lockTiming(record, options)
  const heartbeat =
    timing.heartbeatAgeMs === null
      ? 'heartbeat unknown'
      : `last heartbeat ${formatSeconds(timing.heartbeatAgeMs)} ago (stale after ${formatSeconds(timing.staleAfterMs)})`
  const age = timing.ageMs === null ? 'held for an unknown time' : `held for ${formatSeconds(timing.ageMs)}`
  const dead = owner.alive === false ? '; the recorded PID is provably dead' : ''
  return `owner pid ${record.pid ?? 'unknown'} (token ${record.token ?? 'missing'}), ${age}, ${heartbeat}${dead}`
}

const STATE_LOCK_RECOVERY = 'tower_recover clear-stale-lock with confirm:"CLEAR_STALE_LOCK"'

/**
 * Hold the repo-wide tower lock for one mutation. A lock whose recorded PID is
 * provably dead is reclaimed atomically; a live lock is reported, never
 * stolen — a stale heartbeat is a diagnostic fact, not a death certificate.
 * While held the record heartbeats, so the waiter's error can name the owner,
 * PID, heartbeat age, and the explicit recovery command (#167).
 * `heartbeatMs`/`heartbeatStaleMs`/`now` are injectable for tests; production
 * callers use the defaults.
 */
export async function withLock(paths, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  const pollMs = options.pollMs ?? 25
  const token = crypto.randomUUID()
  const record = lockRecord(token, { startedAt: PROCESS_STARTED_AT }, options)
  const held = await acquireLock(paths.lock, { ...options, token, record, timeoutMs, pollMs })
  if (!held) {
    const owner = await readStateLock(paths, options)
    const facts = stateLockFacts(owner, options)
    throw new TowerToolError(
      'state-locked',
      `tower state is locked by another writer: ${facts}; retry after it finishes, or, if the owner is provably dead, run ${STATE_LOCK_RECOVERY} (force:true moves a live-but-silent record to a backup only after you confirm no writer is active)`,
      {
        details: {
          holderPid: owner.record?.pid ?? null,
          holderToken: owner.record?.token ?? null,
          heartbeatAgeMs: owner.timing?.heartbeatAgeMs ?? null,
          staleAfterMs: owner.timing?.staleAfterMs ?? null,
          heldMs: owner.timing?.ageMs ?? null,
          alive: owner.alive,
          recovery: `${STATE_LOCK_RECOVERY} force:true`,
        },
      },
    )
  }
  const startedAt = Date.now()
  HELD_STATE_LOCKS.set(paths, token)
  try {
    return await fn(paths, { token })
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
    const timing = record ? owner.timing ?? lockTiming(record, options) : null
    const heldMs = timing?.ageMs ?? null
    const holderPid = record?.pid ?? null
    const holderPhase = record?.phase ?? null
    const facts = record
      ? `held by pid ${holderPid ?? 'unknown'}${holderPhase ? ` (${holderPhase})` : ''} for ${formatSeconds(heldMs)}, last heartbeat ${formatSeconds(timing?.heartbeatAgeMs)} ago (stale after ${formatSeconds(timing?.staleAfterMs)}) — a stale heartbeat is diagnostic only, the live lock is not reclaimed; waited ${formatSeconds(waitedMs)}`
      : `the lock was released before it could be inspected; waited ${formatSeconds(waitedMs)}`
    throw new TowerToolError(
      'state-locked',
      `another git mutation is in progress for this repository: ${facts}; retry after it finishes`,
      {
        details: {
          holderPid,
          holderPhase,
          heldMs,
          heartbeatAgeMs: timing?.heartbeatAgeMs ?? null,
          staleAfterMs: timing?.staleAfterMs ?? null,
          waitedMs,
        },
      },
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
