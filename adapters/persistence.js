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
import {
  DEFAULT_ACTIVITY_MAX_BYTES,
  DEFAULT_ACTIVITY_RETENTION,
} from '../domain/config/schema.js'
import { RENAME_ATTEMPTS, TRANSIENT_RENAME_ERRORS, renameWithRetry, sleep } from './lock.js'

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

/**
 * Serialise, write a synced temp file, optionally verify a precondition, then
 * rename over the destination. `options.verify` runs after the document has
 * been serialised and the temp file closed but *before* the rename, so a
 * caller can re-check ownership at the last possible moment; when it throws,
 * the temp file is removed and state.json is left untouched. This keeps the
 * state-write lock check out of the serialisation window (a `toJSON` that
 * mutates the lock file cannot slip a stale write through).
 */
export async function writeJsonAtomic(file, value, options = {}) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`)
  const payload = JSON.stringify(value, null, 2)
  const handle = await fsp.open(tmp, 'w')
  try {
    await handle.writeFile(payload, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (options.verify) {
    try {
      await options.verify()
    } catch (error) {
      await fsp.unlink(tmp).catch(() => {})
      throw error
    }
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

/**
 * Resolve one activity-log rotation policy. Missing/undefined options keep the
 * documented bounded default; an explicit `maxBytes: 0` disables rotation. The
 * values are clamped here as well as in the schema because the adapter can be
 * called without a resolved Tower config (tests and embedders do).
 * @param {{ maxBytes?: number, retention?: number }} [options]
 * @returns {{ maxBytes: number, retention: number, enabled: boolean }}
 */
export function activityPolicy(options = {}) {
  const rawMaxBytes = Number(options.maxBytes)
  const maxBytes = Number.isFinite(rawMaxBytes)
    ? Math.min(1024 * 1024 * 1024, Math.max(0, Math.trunc(rawMaxBytes)))
    : DEFAULT_ACTIVITY_MAX_BYTES
  const rawRetention = Number(options.retention)
  const retention = Number.isFinite(rawRetention)
    ? Math.min(100, Math.max(1, Math.trunc(rawRetention)))
    : DEFAULT_ACTIVITY_RETENTION
  return { maxBytes, retention, enabled: maxBytes > 0 }
}

/** Path of one rotated activity segment: `.1` is the newest, retention is oldest. */
export function activitySegmentPath(file, index) {
  return `${file}.${index}`
}

/**
 * Pure segment-name parser. Read paths must tolerate arbitrary neighbouring
 * files, so only `<basename>.<positive integer>` names are segments. Returns
 * ascending indices (oldest segment last after the live file).
 * @param {string} file
 * @param {string[]} names
 * @returns {number[]}
 */
export function activitySegmentIndices(file, names = []) {
  const prefix = `${path.basename(file)}.`
  const indices = new Set()
  for (const name of names ?? []) {
    if (typeof name !== 'string' || !name.startsWith(prefix)) continue
    const suffix = name.slice(prefix.length)
    if (!/^\d+$/.test(suffix)) continue
    const index = Number(suffix)
    if (Number.isSafeInteger(index) && index > 0) indices.add(index)
  }
  return [...indices].sort((a, b) => a - b)
}

/** True when appending `lineBytes` to a live log of `liveBytes` crosses the cap. */
export function shouldRotateActivity(liveBytes, lineBytes, maxBytes) {
  return Number.isFinite(maxBytes) && maxBytes > 0 && liveBytes > 0 && liveBytes + lineBytes > maxBytes
}

/**
 * Pure rotation plan, expressed as filesystem operations. Ordered as applied:
 * remove the oldest segment, shift the remaining segments up one, then move the
 * live file to `.1`. Exposed for the simulation property; the adapter performs
 * the same steps through retrying renames.
 * @param {string} file
 * @param {number} retention
 * @returns {{ remove: string[], moves: Array<{ from: string, to: string }>, liveTo: string }}
 */
export function activityRotationPlan(file, retention) {
  const keep = Math.min(100, Math.max(1, Number.isFinite(Number(retention)) ? Math.trunc(Number(retention)) : DEFAULT_ACTIVITY_RETENTION))
  const remove = [activitySegmentPath(file, keep)]
  const moves = []
  for (let index = keep - 1; index >= 1; index -= 1) {
    moves.push({ from: activitySegmentPath(file, index), to: activitySegmentPath(file, index + 1) })
  }
  return { remove, moves, liveTo: activitySegmentPath(file, 1) }
}

/**
 * Unlink a rotation target, retrying the same transient Windows errors the
 * rename kernel retries. A missing file is success: the plan names targets
 * unconditionally and segments need not exist.
 */
async function unlinkRotated(file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.unlink(file)
      return
    } catch (error) {
      if (error?.code === 'ENOENT') return
      if (!TRANSIENT_RENAME_ERRORS.has(error?.code) || attempt >= RENAME_ATTEMPTS) throw error
      await sleep(10 + attempt * 15)
    }
  }
}

async function moveSegment(from, to) {
  try {
    await fsp.stat(from)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  await unlinkRotated(to)
  // Never let a failed rename unlink its source: the source is a durable
  // activity segment (or the live file), not a disposable temp document.
  await renameWithRetry(from, to, { unlinkOnFailure: false })
}

/** One rotation step; if any rename fails, the caller keeps appending live. */
async function rotateActivityFile(file, retention) {
  const plan = activityRotationPlan(file, retention)
  for (const target of plan.remove) await unlinkRotated(target)
  for (const move of plan.moves) await moveSegment(move.from, move.to)
  await moveSegment(file, plan.liveTo)
}

// Append order is a contract: two appends that land in different segments must
// still read oldest-line-first. Serialise per-file rotation inside this process;
// cross-process rotation remains advisory (activity appends normally run under
// the repo state lock) and a concurrent writer may at worst extend a segment.
const APPEND_QUEUES = new Map()

function serializedAppend(file, task) {
  const previous = APPEND_QUEUES.get(file) ?? Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.then(
    () => {},
    () => {},
  )
  APPEND_QUEUES.set(file, tail)
  tail.finally(() => {
    if (APPEND_QUEUES.get(file) === tail) APPEND_QUEUES.delete(file)
  })
  return run
}

/**
 * Append one complete JSONL line, rotating the live file first when the line
 * would push it past `maxBytes`. Rotation is an atomic rename chain: the live
 * file is moved to segment `.1` and only then is the new line appended to a
 * fresh live file. A rotation failure never drops the line and never deletes
 * the live file; the adapter falls back to appending to the live file and a
 * later append retries rotation.
 * @param {string} file
 * @param {unknown} value
 * @param {{ maxBytes?: number, retention?: number }} [options]
 */
export async function appendJsonl(file, value, options = {}) {
  const line = `${JSON.stringify(value)}\n`
  const policy = activityPolicy(options)
  if (!policy.enabled) {
    await fsp.appendFile(file, line, 'utf8')
    return
  }
  await serializedAppend(file, async () => {
    const lineBytes = Buffer.byteLength(line, 'utf8')
    let liveBytes = 0
    try {
      liveBytes = (await fsp.stat(file)).size
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (shouldRotateActivity(liveBytes, lineBytes, policy.maxBytes)) {
      try {
        await rotateActivityFile(file, policy.retention)
      } catch {
        // Best effort: keep the live file and the line. The next append retries
        // rotation; an unbounded log is preferable to losing an audit record.
      }
    }
    await fsp.appendFile(file, line, 'utf8')
  })
}
