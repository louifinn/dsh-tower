// Shared durable-persistence contract (#56 P2b).
//
// state.json (lib/store.js) and modes.json (lib/modeStore.js) both persist a
// whole JSON document behind a token-owned writer lock. They must agree on:
//
//   - atomic replacement: serialise completely, write a temp file, rename;
//   - dead-PID reclamation: a provably dead owner is moved to a quarantine
//     name, verified, and only then removed; a live/foreign lock is never
//     stolen or deleted;
//   - bounded waiting: a held lock is reported after a timeout, not stolen.
//
// Keeping the primitives here means a protocol fix applies to both contracts
// at once. This module is the only lib/ file besides store.js that talks to
// the fs adapter; it never imports node:fs directly (#50).
import { fs, fsp } from '../adapters/store-fs.js'
import path from 'node:path'
import crypto from 'node:crypto'
import { TowerToolError } from '../domain/errors.js'

export const DEFAULT_LOCK_TIMEOUT_MS = 5000
export const DEFAULT_LOCK_POLL_MS = 25

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

export function lockRecord(token, extra = {}) {
  return { token, pid: process.pid, ...extra, at: Date.now() }
}

function isDeadLock(record, options) {
  const alive = processAlive(record?.pid)
  if (alive === false) return true
  // The mode store historically treated a lock without a usable PID as dead;
  // preserve that where callers opt in, while the state lock stays defensive.
  return alive === null && options.invalidPidIsDead === true
}

// ---------------------------------------------------------------------------
// Lock inspection / reclamation
// ---------------------------------------------------------------------------

export async function readLock(lockPath) {
  try {
    const raw = await fsp.readFile(lockPath, 'utf8')
    const record = JSON.parse(raw)
    return { path: lockPath, record, alive: processAlive(record?.pid), raw }
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: lockPath, record: null, alive: null, raw: null }
    return { path: lockPath, record: null, alive: null, raw: null, error: String(error?.message ?? error) }
  }
}

export function readLockSync(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8')
    const record = JSON.parse(raw)
    return { path: lockPath, record, alive: processAlive(record?.pid), raw }
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: lockPath, record: null, alive: null, raw: null }
    return { path: lockPath, record: null, alive: null, raw: null, error: String(error?.message ?? error) }
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
  if (!isDeadLock(parsed, options)) return false
  // Move, never delete: a concurrent writer may have replaced the record
  // between the read and the rename, so verify the quarantined bytes first.
  const quarantine = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`
  try {
    await fsp.rename(lockPath, quarantine)
  } catch {
    return false
  }
  const moved = await fsp.readFile(quarantine, 'utf8').catch(() => null)
  if (moved === null || moved !== original) {
    if (moved !== null) await fsp.rename(quarantine, lockPath).catch(() => {})
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
  if (!isDeadLock(parsed, options)) return false
  const quarantine = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`
  try {
    fs.renameSync(lockPath, quarantine)
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
        fs.renameSync(quarantine, lockPath)
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
// Lock acquire / token-checked release
// ---------------------------------------------------------------------------

function handleFor(lockPath, token, record) {
  return {
    path: lockPath,
    token,
    record,
    async release() {
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
 */
export async function acquireLock(lockPath, options = {}) {
  const token = options.token ?? crypto.randomUUID()
  const record = options.record ?? lockRecord(token)
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)
  const pollMs = Number(options.pollMs ?? DEFAULT_LOCK_POLL_MS)
  const deadline = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    try {
      await fsp.writeFile(lockPath, JSON.stringify(record), { flag: 'wx' })
      return handleFor(lockPath, token, record)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (await reclaimDeadLock(lockPath, options)) continue
      if (Date.now() > deadline) return null
      await sleep(pollMs)
    }
  }
}

export function acquireLockSync(lockPath, options = {}) {
  const token = options.token ?? crypto.randomUUID()
  const record = options.record ?? lockRecord(token)
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)
  const pollMs = Number(options.pollMs ?? DEFAULT_LOCK_POLL_MS)
  const deadline = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(record), { flag: 'wx' })
      return syncHandleFor(lockPath, token, record)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (reclaimDeadLockSync(lockPath, options)) continue
      if (Date.now() > deadline) return null
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
