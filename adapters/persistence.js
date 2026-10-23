// Shared durable-persistence contract (#56 P2b).
//
// state.json (adapters/store.js) and modes.json (host/modeStore.js) both persist a
// whole JSON document behind a token-owned writer lock. They must agree on:
//
//   - atomic replacement: serialise completely, write a temp file, rename;
//   - dead-PID reclamation: a provably dead owner is moved to a quarantine
//     name, verified, and only then removed; a live/foreign lock is never
//     stolen or deleted;
//   - bounded waiting: a held lock is reported after a timeout, not stolen.
//
// Keeping the primitives here means a protocol fix applies to both contracts
// at once. This module is the only adapter besides store.js that talks to the
// fs adapter; it never imports node:fs directly (#50).
import { fs, fsp } from './store-fs.js'
import path from 'node:path'
import crypto from 'node:crypto'
import { TowerToolError } from '../domain/errors.js'

export const DEFAULT_LOCK_TIMEOUT_MS = 5000
export const DEFAULT_LOCK_POLL_MS = 25
/**
 * While a lock is held its `at` field is rewritten on this interval (#92).
 * A record whose heartbeat is older than `LOCK_HEARTBEAT_STALE_FACTOR`
 * intervals is abandoned, whatever its PID currently points at: a PID may be
 * recycled, a heartbeat cannot. The default grace (3 s) stays inside the 5 s
 * state-lock wait, so the next mutation reclaims a crashed lock instead of
 * failing until someone deletes the file by hand.
 */
export const DEFAULT_LOCK_HEARTBEAT_MS = 1000
export const LOCK_HEARTBEAT_STALE_FACTOR = 3

// Exported with the retry loop so a test can assert the budget and the exact
// transient set instead of copying them (#86).
export const RENAME_ATTEMPTS = 12
export const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES'])
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000)

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // best effort; a busy loop would be worse
  }
}

// ---------------------------------------------------------------------------
// JSON document I/O
// ---------------------------------------------------------------------------

function parseJson(file, text) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new TowerToolError('state-corrupt', `corrupt tower state at ${file}: ${error.message}`)
  }
}

export async function readJson(file) {
  return parseJson(file, await fsp.readFile(file, 'utf8'))
}

/** Synchronous counterpart for the mode store's short critical section. */
export function readJsonSync(file) {
  return parseJson(file, fs.readFileSync(file, 'utf8'))
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
 *
 * `options.rename` and `options.sleep` inject the syscall and the backoff so
 * both outcomes are testable on any OS (#86); production callers omit them.
 */
export async function renameWithRetry(tmp, file, options = {}) {
  const rename = options.rename ?? fsp.rename
  const wait = options.sleep ?? sleep
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, file)
      return
    } catch (error) {
      if (!TRANSIENT_RENAME_ERRORS.has(error?.code) || attempt >= RENAME_ATTEMPTS) {
        await fsp.unlink(tmp).catch(() => {})
        throw error
      }
      await wait(10 + attempt * 15)
    }
  }
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
      if (!TRANSIENT_RENAME_ERRORS.has(error?.code) || attempt >= RENAME_ATTEMPTS) {
        try {
          fs.unlinkSync(tmp)
        } catch {
          // best effort
        }
        throw error
      }
      sleepSync(10 + attempt * 15)
    }
  }
}

export async function appendJsonl(file, value) {
  await fsp.appendFile(file, `${JSON.stringify(value)}\n`, 'utf8')
}

// ---------------------------------------------------------------------------
// Lock records
// ---------------------------------------------------------------------------

/**
 * true = process exists, false = provably gone, null = the record carries no
 * usable PID. The tri-state matters: a malformed state lock must be reported,
 * not silently reclaimed as if its owner were dead.
 *
 * This is a fast path, not the liveness decision (#92): `true` only means the
 * PID currently exists, and that PID may be a recycled one.
 */
export function processAlive(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return null
  try {
    process.kill(value, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    // EPERM means the process exists but belongs to another user.
    return true
  }
}

/** Injected clock: a function, a timestamp, or the real `Date.now`. */
function nowValue(options = {}) {
  const now = typeof options.now === 'function' ? options.now() : options.now
  const value = Number(now)
  return Number.isFinite(value) ? value : Date.now()
}

export function lockHeartbeatMs(options = {}) {
  const value = Number(options.heartbeatMs ?? DEFAULT_LOCK_HEARTBEAT_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_LOCK_HEARTBEAT_MS
}

export function lockStaleAfterMs(options = {}) {
  const explicit = Number(options.heartbeatStaleMs)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return lockHeartbeatMs(options) * LOCK_HEARTBEAT_STALE_FACTOR
}

/**
 * Age the record was written (`since`) and age of its last heartbeat (`at`).
 * Records written by a build before #92 carry no `since`; their creation time
 * is the last (only) `at`, so both ages are equal until the first heartbeat.
 */
export function lockTiming(record, options = {}) {
  const now = nowValue(options)
  const at = Number(record?.at)
  const since = Number(record?.since ?? record?.at)
  const heartbeatAgeMs = Number.isFinite(at) ? Math.max(0, now - at) : null
  const ageMs = Number.isFinite(since) ? Math.max(0, now - since) : null
  const staleAfterMs = lockStaleAfterMs(options)
  return {
    now,
    ageMs,
    heartbeatAgeMs,
    staleAfterMs,
    stale: heartbeatAgeMs !== null && heartbeatAgeMs > staleAfterMs,
  }
}

/**
 * Classify a record without touching the filesystem.
 *
 * - `esrch`: the PID provably does not exist → reclaim immediately.
 * - `invalid-pid`: no usable PID → only the caller that opts in treats it as dead.
 * - `heartbeat-stale`: the PID may exist, but the holder stopped heartbeating →
 *   reclaim after byte verification. Immune to PID reuse by construction.
 * - `held`: a live holder with a fresh heartbeat → wait, never steal.
 */
export function lockLiveness(record, options = {}) {
  const alive = processAlive(record?.pid)
  const timing = lockTiming(record, options)
  if (alive === false) return { alive, dead: true, reason: 'esrch', timing }
  if (alive === null) {
    // The mode store historically treated a lock without a usable PID as dead;
    // preserve that where callers opt in, while the state lock stays defensive.
    return { alive, dead: options.invalidPidIsDead === true, reason: 'invalid-pid', timing }
  }
  if (timing.stale) return { alive, dead: true, reason: 'heartbeat-stale', timing }
  return { alive, dead: false, reason: 'held', timing }
}

export function lockRecord(token, extra = {}, options = {}) {
  const now = nowValue(options)
  return { token, pid: process.pid, ...extra, since: now, at: now }
}

// ---------------------------------------------------------------------------
// Lock inspection / reclamation
// ---------------------------------------------------------------------------

export async function readLock(lockPath, options = {}) {
  try {
    const raw = await fsp.readFile(lockPath, 'utf8')
    const record = JSON.parse(raw)
    return { path: lockPath, record, alive: processAlive(record?.pid), raw, ...lockTiming(record, options) }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { path: lockPath, record: null, alive: null, raw: null, ...lockTiming(null, options) }
    }
    return {
      path: lockPath,
      record: null,
      alive: null,
      raw: null,
      error: String(error?.message ?? error),
      ...lockTiming(null, options),
    }
  }
}

export function readLockSync(lockPath, options = {}) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8')
    const record = JSON.parse(raw)
    return { path: lockPath, record, alive: processAlive(record?.pid), raw, ...lockTiming(record, options) }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { path: lockPath, record: null, alive: null, raw: null, ...lockTiming(null, options) }
    }
    return {
      path: lockPath,
      record: null,
      alive: null,
      raw: null,
      error: String(error?.message ?? error),
      ...lockTiming(null, options),
    }
  }
}

/**
 * Dispose of a quarantined record after its bytes were verified. A
 * PID-reuse reclaim (`heartbeat-stale`) is kept as an audit backup because the
 * PID was alive: the operator may want to see what was moved. A provably dead
 * PID is unlinked as before. `options.keepReclaimBackup:false` disables the
 * backup (tests inject it to assert the dead-PID path leaves nothing behind).
 */
async function discardQuarantine(lockPath, quarantine, reason, options) {
  if (reason !== 'heartbeat-stale' || options.keepReclaimBackup === false) {
    await fsp.unlink(quarantine).catch(() => {})
    return null
  }
  const backup = `${lockPath}.reclaimed-${nowValue(options)}-${crypto.randomUUID()}`
  try {
    await fsp.rename(quarantine, backup)
    return backup
  } catch {
    // The bytes could not be preserved; leaving the verified stale record in
    // place is safer than deleting it.
    return null
  }
}

export async function reclaimDeadLock(lockPath, options = {}) {
  let original
  try {
    original = await fsp.readFile(lockPath, 'utf8')
  } catch {
    return false
  }
  let parsed
  try {
    parsed = JSON.parse(original)
  } catch {
    return false
  }
  const verdict = lockLiveness(parsed, options)
  if (!verdict.dead) return false
  const rename = options.rename ?? fsp.rename
  // Move, never delete: a concurrent writer may have replaced the record
  // between the read and the rename, so verify the quarantined bytes first.
  const quarantine = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`
  try {
    await rename(lockPath, quarantine)
  } catch {
    return false
  }
  const moved = await fsp.readFile(quarantine, 'utf8').catch(() => null)
  if (moved === null || moved !== original) {
    if (moved !== null) await rename(quarantine, lockPath).catch(() => {})
    return false
  }
  await discardQuarantine(lockPath, quarantine, verdict.reason, options)
  return true
}

export function reclaimDeadLockSync(lockPath, options = {}) {
  let original
  try {
    original = fs.readFileSync(lockPath, 'utf8')
  } catch {
    return false
  }
  let parsed
  try {
    parsed = JSON.parse(original)
  } catch {
    return false
  }
  const verdict = lockLiveness(parsed, options)
  if (!verdict.dead) return false
  const renameSync = options.renameSync ?? fs.renameSync
  const quarantine = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`
  try {
    renameSync(lockPath, quarantine)
  } catch {
    return false
  }
  let moved = null
  try {
    moved = fs.readFileSync(quarantine, 'utf8')
  } catch {
    moved = null
  }
  if (moved === null || moved !== original) {
    if (moved !== null) {
      try {
        renameSync(quarantine, lockPath)
      } catch {
        // the newer record could not be restored; never delete it silently
      }
    }
    return false
  }
  if (verdict.reason === 'heartbeat-stale' && options.keepReclaimBackup !== false) {
    const backup = `${lockPath}.reclaimed-${nowValue(options)}-${crypto.randomUUID()}`
    try {
      renameSync(quarantine, backup)
      return true
    } catch {
      return true
    }
  }
  try {
    fs.unlinkSync(quarantine)
  } catch {
    // the lock is already reclaimed; a leftover quarantine is inert
  }
  return true
}

// ---------------------------------------------------------------------------
// Lock heartbeat
// ---------------------------------------------------------------------------

/**
 * Rewrite `at` only while the file still belongs to this token. The write goes
 * through a temp file + rename so a reader never sees a torn record. The temp
 * name is per-process, so two holders that briefly overlap (a reclaimed record
 * whose old process is still alive) never overwrite each other's heartbeat.
 */
export async function touchLock(lockPath, token, options = {}) {
  const tmp = `${lockPath}.heartbeat-${process.pid}-${crypto.randomUUID()}`
  try {
    const raw = await fsp.readFile(lockPath, 'utf8')
    const record = JSON.parse(raw)
    if (!record || record.token !== token) return false
    const next = { ...record, at: nowValue(options) }
    await fsp.writeFile(tmp, JSON.stringify(next), 'utf8')
    await renameWithRetry(tmp, lockPath)
    return true
  } catch {
    // A failed heartbeat must never throw into the lock holder; the next
    // interval retries, and a genuinely stuck holder is reclaimed by a waiter.
    await fsp.unlink(tmp).catch(() => {})
    return false
  }
}

/**
 * Start the unref'd heartbeat timer for a held lock. Returns a stop function
 * that also waits for an in-flight refresh, so release cannot unlink the lock
 * only to have a late heartbeat recreate it.
 */
function startHeartbeat(lockPath, token, options) {
  const intervalMs = lockHeartbeatMs(options)
  const setIntervalFn = options.setInterval ?? setInterval
  const clearIntervalFn = options.clearInterval ?? clearInterval
  let stopped = false
  let inFlight = null
  const timer = setIntervalFn(() => {
    if (stopped || inFlight) return
    inFlight = touchLock(lockPath, token, options)
      .catch(() => false)
      .finally(() => {
        inFlight = null
      })
  }, intervalMs)
  if (timer && typeof timer.unref === 'function') timer.unref()
  return async function stopHeartbeat() {
    stopped = true
    clearIntervalFn(timer)
    if (inFlight) await inFlight
  }
}

// ---------------------------------------------------------------------------
// Lock acquire / token-checked release
// ---------------------------------------------------------------------------

function handleFor(lockPath, token, record, stopHeartbeat = async () => {}) {
  return {
    path: lockPath,
    token,
    record,
    async release() {
      await stopHeartbeat()
      return releaseLock(lockPath, token)
    },
  }
}

function syncHandleFor(lockPath, token, record) {
  return {
    path: lockPath,
    token,
    record,
    release() {
      return releaseLockSync(lockPath, token)
    },
  }
}

/**
 * Acquire a token-owned lock with a bounded wait. Returns null when another
 * writer still holds a live lock at the deadline; callers translate that into
 * their own [tower:state-locked] message (or a false return for modes).
 * While held, the record heartbeats so waiters can distinguish a live holder
 * from a PID that was recycled after a crash (#92).
 */
export async function acquireLock(lockPath, options = {}) {
  const token = options.token ?? crypto.randomUUID()
  const record = options.record ?? lockRecord(token, {}, options)
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)
  const pollMs = Number(options.pollMs ?? DEFAULT_LOCK_POLL_MS)
  // Only a clock function advances the wait budget; a fixed `now` timestamp
  // stays a timestamp and must not create an endless deadline.
  const clock = typeof options.now === 'function' ? options.now : Date.now
  const deadline = clock() + Math.max(0, timeoutMs)
  for (;;) {
    try {
      await fsp.writeFile(lockPath, JSON.stringify(record), { flag: 'wx' })
      const stopHeartbeat = startHeartbeat(lockPath, token, options)
      return handleFor(lockPath, token, record, stopHeartbeat)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (await reclaimDeadLock(lockPath, options)) continue
      if (clock() > deadline) return null
      await sleep(pollMs)
    }
  }
}

export function acquireLockSync(lockPath, options = {}) {
  const token = options.token ?? crypto.randomUUID()
  const record = options.record ?? lockRecord(token, {}, options)
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)
  const pollMs = Number(options.pollMs ?? DEFAULT_LOCK_POLL_MS)
  const clock = typeof options.now === 'function' ? options.now : Date.now
  const deadline = clock() + Math.max(0, timeoutMs)
  for (;;) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(record), { flag: 'wx' })
      // Synchronous callers (the mode store) hold the lock for a short, fixed
      // critical section and cannot run a timer; the record's `at` is its only
      // heartbeat, which is why the stale window is three intervals wide.
      return syncHandleFor(lockPath, token, record)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (reclaimDeadLockSync(lockPath, options)) continue
      if (clock() > deadline) return null
      sleepSync(pollMs)
    }
  }
}

export async function releaseLock(lockPath, token) {
  try {
    const current = await fsp.readFile(lockPath, 'utf8').catch(() => null)
    if (current === null) return false
    const parsed = JSON.parse(current)
    if (!parsed || parsed.token !== token) return false
    await fsp.unlink(lockPath)
    return true
  } catch {
    // a foreign or unreadable lock is not ours to remove
    return false
  }
}

export function releaseLockSync(lockPath, token) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    if (!parsed || parsed.token !== token) return false
    fs.unlinkSync(lockPath)
    return true
  } catch {
    return false
  }
}

export { PROCESS_STARTED_AT }
