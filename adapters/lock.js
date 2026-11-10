// Token-owned lock kernel shared by the state store, the mode store, the
// workspace lock, and the lease lock.
//
// One protocol, four users:
//
//   - creation is an O_EXCL write of a JSON record carrying a random token;
//   - a waiter may reclaim only a record whose PID is provably dead (or whose
//     PID is unusable and the caller explicitly opted in);
//   - a live PID whose heartbeat is stale is diagnostic, never a steal: the
//     PID may be alive and simply slow, and a clock-based steal is exactly the
//     lost-update race this kernel exists to remove;
//   - release and reclaim move the record to a private quarantine name, read
//     the bytes back, and unlink only the record whose token (and, when given,
//     exact bytes) still match. A foreign or newer record is restored.
//
// The JSON/atomic helpers live in persistence.js; this module owns the lock
// records and must not import persistence.js (persistence re-exports lockTiming
// for compatibility, so a reverse import would create a cycle).
import { fs, fsp } from './store-fs.js'
import crypto from 'node:crypto'

export const DEFAULT_LOCK_TIMEOUT_MS = 5000
export const DEFAULT_LOCK_POLL_MS = 25

/**
 * While a lock is held its `at` field is rewritten on this interval (#92).
 * A heartbeat older than `LOCK_HEARTBEAT_STALE_FACTOR` intervals is reported as
 * stale. Staleness is a diagnostic fact about the holder, not proof of death:
 * the PID remains the only reclaim authority (#167).
 */
export const DEFAULT_LOCK_HEARTBEAT_MS = 1000
export const LOCK_HEARTBEAT_STALE_FACTOR = 3

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

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

/**
 * true = process exists, false = provably gone, null = the record carries no
 * usable PID. The tri-state matters: a malformed lock must be reported, not
 * silently reclaimed as if its owner were dead.
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
 * - `esrch`: the PID provably does not exist -> reclaim safety.
 * - `invalid-pid`: no usable PID -> only the caller that opts in treats it as
 *   dead (the mode store's historical `invalidPidIsDead`).
 * - `heartbeat-stale`: the PID exists but the holder stopped heartbeating.
 *   This is DIAGNOSTIC ONLY: a live process can pause for longer than the
 *   window, and a clock-based steal lets two writers into the same state. The
 *   waiter reports it and the operator recovers explicitly.
 * - `held`: a live holder with a fresh heartbeat -> wait, never steal.
 */
export function lockLiveness(record, options = {}) {
  const alive = processAlive(record?.pid)
  const timing = lockTiming(record, options)
  if (alive === false) return { alive, dead: true, reason: 'esrch', timing }
  if (alive === null) {
    return { alive, dead: options.invalidPidIsDead === true, reason: 'invalid-pid', timing }
  }
  if (timing.stale) return { alive, dead: false, reason: 'heartbeat-stale', timing }
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
    const timing = lockTiming(record, options)
    return { path: lockPath, record, alive: processAlive(record?.pid), raw, timing, ...timing }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const timing = lockTiming(null, options)
      return { path: lockPath, record: null, alive: null, raw: null, timing, ...timing }
    }
    const timing = lockTiming(null, options)
    return {
      path: lockPath,
      record: null,
      alive: null,
      raw: null,
      error: String(error?.message ?? error),
      timing,
      ...timing,
    }
  }
}

export function readLockSync(lockPath, options = {}) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8')
    const record = JSON.parse(raw)
    const timing = lockTiming(record, options)
    return { path: lockPath, record, alive: processAlive(record?.pid), raw, timing, ...timing }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const timing = lockTiming(null, options)
      return { path: lockPath, record: null, alive: null, raw: null, timing, ...timing }
    }
    const timing = lockTiming(null, options)
    return {
      path: lockPath,
      record: null,
      alive: null,
      raw: null,
      error: String(error?.message ?? error),
      timing,
      ...timing,
    }
  }
}

/**
 * Reclaim only a record whose owner is provably dead. The record is moved to a
 * private quarantine, read back, and compared with the exact bytes inspected
 * before the move; a concurrent writer's newer record is restored instead.
 * A live-but-silent holder is never touched.
 */
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
  await fsp.unlink(quarantine).catch(() => {})
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
  try {
    fs.unlinkSync(quarantine)
  } catch {
    // the lock is already reclaimed; a leftover quarantine is inert
  }
  return true
}

// ---------------------------------------------------------------------------
// Token-checked removal (CAS)
// ---------------------------------------------------------------------------

/**
 * Remove the lock only if the moved bytes still carry `expectedToken` and, when
 * `expectedRaw` is supplied, are byte-identical to the record the caller
 * inspected. The temporary quarantine is restored on any mismatch, so a
 * release can never unlink a foreign or newer record.
 *
 * `expectedRaw` makes the comparison a true CAS. Callers that only know the
 * token (legacy workspace release) still get the token check.
 */
export async function removeLockIfMatches(file, expectedToken, expectedRaw, options = {}) {
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) return false
  const rename = options.rename ?? fsp.rename
  const quarantine = `${file}.release-${process.pid}-${crypto.randomUUID()}`
  try {
    await rename(file, quarantine)
  } catch (error) {
    // The record disappeared between the caller's read and the move; it is not
    // ours to remove anymore (and never existed as this token).
    if (error?.code === 'ENOENT') return false
    throw error
  }
  let moved = null
  try {
    moved = await fsp.readFile(quarantine, 'utf8')
  } catch {
    moved = null
  }
  let same = moved !== null
  if (same && expectedRaw !== null && expectedRaw !== undefined) same = moved === expectedRaw
  if (same && moved !== null) {
    try {
      same = JSON.parse(moved)?.token === expectedToken
    } catch {
      same = false
    }
  }
  if (!same) {
    if (moved !== null) await rename(quarantine, file).catch(() => {})
    return false
  }
  await fsp.unlink(quarantine).catch(() => {})
  return true
}

export function removeLockIfMatchesSync(file, expectedToken, expectedRaw, options = {}) {
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) return false
  const renameSync = options.renameSync ?? fs.renameSync
  const quarantine = `${file}.release-${process.pid}-${crypto.randomUUID()}`
  try {
    renameSync(file, quarantine)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  let moved = null
  try {
    moved = fs.readFileSync(quarantine, 'utf8')
  } catch {
    moved = null
  }
  let same = moved !== null
  if (same && expectedRaw !== null && expectedRaw !== undefined) same = moved === expectedRaw
  if (same && moved !== null) {
    try {
      same = JSON.parse(moved)?.token === expectedToken
    } catch {
      same = false
    }
  }
  if (!same) {
    if (moved !== null) {
      try {
        renameSync(quarantine, file)
      } catch {
        // the foreign record stays quarantined rather than being deleted
      }
    }
    return false
  }
  try {
    fs.unlinkSync(quarantine)
  } catch {
    // inert leftover
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
    // interval retries, and a genuinely stuck holder is reported by a waiter.
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
  if (options.heartbeat === false) return async () => {}
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
 * their own error or false return. A record is reclaimed only when its PID is
 * provably dead; a stale heartbeat alone is reported, never stolen.
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
  let reclaimed = false
  for (;;) {
    try {
      await fsp.writeFile(lockPath, JSON.stringify(record), { flag: 'wx' })
      const stopHeartbeat = startHeartbeat(lockPath, token, options)
      const held = handleFor(lockPath, token, record, stopHeartbeat)
      held.reclaimed = reclaimed
      return held
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (await reclaimDeadLock(lockPath, options)) {
        reclaimed = true
        continue
      }
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
  let reclaimed = false
  for (;;) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(record), { flag: 'wx' })
      // Synchronous callers (the mode store) hold the lock for a short, fixed
      // critical section and cannot run a timer; the record's `at` is its only
      // heartbeat and a stale one is diagnostic only.
      const held = syncHandleFor(lockPath, token, record)
      held.reclaimed = reclaimed
      return held
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (reclaimDeadLockSync(lockPath, options)) {
        reclaimed = true
        continue
      }
      if (clock() > deadline) return null
      sleepSync(pollMs)
    }
  }
}

/**
 * Release only the record whose token still matches. The record is moved to a
 * quarantine, its bytes are compared with the bytes read, and a foreign or
 * newer record is restored: a release can never unlink another writer's lock.
 */
export async function releaseLock(lockPath, token) {
  if (typeof token !== 'string' || token.length === 0) return false
  const current = await fsp.readFile(lockPath, 'utf8').catch(() => null)
  if (current === null) return false
  let parsed
  try {
    parsed = JSON.parse(current)
  } catch {
    return false
  }
  if (!parsed || parsed.token !== token) return false
  return removeLockIfMatches(lockPath, token, current)
}

export function releaseLockSync(lockPath, token) {
  if (typeof token !== 'string' || token.length === 0) return false
  let current
  try {
    current = fs.readFileSync(lockPath, 'utf8')
  } catch {
    return false
  }
  let parsed
  try {
    parsed = JSON.parse(current)
  } catch {
    return false
  }
  if (!parsed || parsed.token !== token) return false
  return removeLockIfMatchesSync(lockPath, token, current)
}

export { PROCESS_STARTED_AT }
