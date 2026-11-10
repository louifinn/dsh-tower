// Shared durable JSON persistence helpers (#56 P2b).
//
// This module owns the JSON document I/O used by state.json, modes.json, and
// the quarantine audit trail: serialise completely, write a temp file, rename
// atomically, and append complete JSONL lines. The token-owned lock protocol
// that guards those documents now lives in ./lock.js (#167); the exports below
// are re-exported for callers that still import a lock primitive from this
// module (host/doctor.js, host/tool-registry.js, and tests written before the
// split).
//
// This module is one of the two adapters allowed to talk to the fs adapter; it
// never imports node:fs directly (#50).
import { fs, fsp } from './store-fs.js'
import path from 'node:path'
import crypto from 'node:crypto'
import { TowerToolError } from '../domain/errors.js'
import { RENAME_ATTEMPTS, TRANSIENT_RENAME_ERRORS, renameWithRetry } from './lock.js'

export {
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_LOCK_POLL_MS,
  DEFAULT_LOCK_HEARTBEAT_MS,
  LOCK_HEARTBEAT_STALE_FACTOR,
  RENAME_ATTEMPTS,
  TRANSIENT_RENAME_ERRORS,
  PROCESS_STARTED_AT,
  sleep,
  renameWithRetry,
  processAlive,
  lockHeartbeatMs,
  lockStaleAfterMs,
  lockTiming,
  lockLiveness,
  lockRecord,
  readLock,
  readLockSync,
  reclaimDeadLock,
  reclaimDeadLockSync,
  touchLock,
  acquireLock,
  acquireLockSync,
  releaseLock,
  releaseLockSync,
} from './lock.js'

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // best effort; a busy loop would be worse
  }
}

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
