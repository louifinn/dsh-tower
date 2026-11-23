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
  LOCK_CREATE_TRANSIENT_ERRORS,
  LOCK_CREATE_BUDGET_MS,
  LOCK_CREATE_DELAYS,
  LOCK_CREATE_ATTEMPTS,
  createLockFile,
  createLockFileSync,
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

/**
 * #228: a host filesystem that refuses a durable write must never reach the
 * model as an untranslated `tool-internal`. A full disk on `tower_merge` used
 * to report `ENOSPC: no space left on device, write` with no path, no phase and
 * no remedy. These four errnos are the ones that mean "the host refused the
 * operation", so every write seam maps them onto one catalogued error whose
 * `details` is `{ code, path, phase }`. Any other error (a `verify` failure, a
 * catalogued TowerToolError, EPERM/EACCES from the lock kernel) passes through
 * untouched, which keeps the raw lock kernel contract intact.
 */
const STATE_IO_ERRNOS = new Set(['ENOSPC', 'EMFILE', 'ENFILE', 'EIO'])

/**
 * The volume a path lives on, for the message a full disk must name.
 * @param {string | null} file
 */
export function volumeOf(file) {
  if (typeof file !== 'string' || file.length === 0) return null
  return path.parse(path.resolve(file)).root || null
}

/**
 * Map a host I/O refusal onto the one catalogued `state-io-failed` error.
 * Everything else is returned unchanged so callers can keep rethrowing it.
 * @param {any} error
 * @param {{ path?: string | null, phase?: string, action?: string, note?: string }} [context]
 * @returns {any}
 */
export function translateStateIo(error, context = {}) {
  if (error instanceof TowerToolError || !STATE_IO_ERRNOS.has(error?.code)) return error
  const file = context.path ?? null
  const phase = context.phase ?? 'state-write'
  const volume = volumeOf(file)
  const where = file ? `${file}${volume ? ` (volume ${volume})` : ''}` : 'the Tower state directory'
  const note = context.note ? `; ${context.note}` : ''
  return new TowerToolError(
    'state-io-failed',
    `cannot ${context.action ?? 'write'} ${where} during ${phase}: ${String(error?.message ?? error)}${note}`,
    { cause: error, details: { code: error?.code ?? null, path: file, phase } },
  )
}

export async function readJson(file) {
  try {
    return parseJson(file, await fsp.readFile(file, 'utf8'))
  } catch (error) {
    throw translateStateIo(error, { path: file, phase: 'state-read', action: 'read' })
  }
}

/** Synchronous counterpart for the mode store's short critical section. */
export function readJsonSync(file) {
  try {
    return parseJson(file, fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw translateStateIo(error, { path: file, phase: 'state-read', action: 'read' })
  }
}

/**
 * Serialise, write a synced temp file, optionally verify a precondition, then
 * rename over the destination. `options.verify` runs after the document has
 * been serialised and the temp file closed but *before* the rename, so a
 * caller can re-check ownership at the last possible moment; when it throws,
 * the temp file is removed and state.json is left untouched. This keeps the
 * state-write lock check out of the serialisation window (a `toJSON` that
 * mutates the lock file cannot slip a stale write through).
 *
 * `options.onBeforeRename` and `options.onAfterRename` run immediately before
 * and immediately after the rename, with `{ file, tmp }`; both are test seams
 * that let a fixture land a foreign commit on either side of the atomic
 * commit window deterministically (production callers omit them). A
 * `onBeforeRename` failure is treated like a `verify` failure: the temp file
 * is removed and the destination is untouched.
 */
export async function writeJsonAtomic(file, value, options = {}) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`)
  const payload = JSON.stringify(value, null, 2)
  const phase = options.phase ?? 'state-write'
  let handle
  try {
    handle = await fsp.open(tmp, 'w')
  } catch (error) {
    // #228: no temp file exists yet, so the destination is untouched by
    // definition; report the path and phase instead of a bare errno, and make
    // the same promise every other refusal on this path makes.
    throw translateStateIo(error, { path: file, phase, action: 'write', note: 'the previous document is unchanged' })
  }
  try {
    await handle.writeFile(payload, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    // A partially written temp file is never renamed into place; drop it so a
    // retry starts clean and the destination keeps its previous bytes.
    await fsp.unlink(tmp).catch(() => {})
    throw translateStateIo(error, { path: file, phase, action: 'write', note: 'the previous document is unchanged' })
  }
  try {
    await handle.close()
  } catch (error) {
    // A close (and the flush it can trigger) can be the call that reports a full
    // volume; drop the temp file and keep the destination untouched.
    await fsp.unlink(tmp).catch(() => {})
    throw translateStateIo(error, { path: file, phase, action: 'write', note: 'the previous document is unchanged' })
  }
  try {
    if (options.verify) await options.verify()
    if (options.onBeforeRename) await options.onBeforeRename({ file, tmp })
  } catch (error) {
    await fsp.unlink(tmp).catch(() => {})
    throw error
  }
  try {
    await renameWithRetry(tmp, file)
  } catch (error) {
    throw translateStateIo(error, { path: file, phase, action: 'rename', note: 'the previous document is unchanged' })
  }
  if (options.onAfterRename) await options.onAfterRename({ file, tmp })
}
/** Synchronous counterpart used by the mode store's short critical section. */
export function writeJsonAtomicSync(file, value, options = {}) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`)
  const phase = options.phase ?? 'config-write'
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // best effort: the temp file may not exist
    }
    throw translateStateIo(error, { path: file, phase, action: 'write', note: 'the previous document is unchanged' })
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (error) {
      // A transient sharing violation is retried; every other failure (a full
      // volume included) is translated once the retry budget is spent.
      if (!TRANSIENT_RENAME_ERRORS.has(error?.code) || attempt >= RENAME_ATTEMPTS) {
        try {
          fs.unlinkSync(tmp)
        } catch {
          // best effort
        }
        throw translateStateIo(error, { path: file, phase, action: 'rename', note: 'the previous document is unchanged' })
      }
      sleepSync(10 + attempt * 15)
    }
  }
}

/**
 * Highest retention the schema accepts. Rotation prunes every segment index at
 * or above the configured retention, so this is also the pruning bound.
 */
const MAX_ACTIVITY_RETENTION = 100

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
    ? Math.min(MAX_ACTIVITY_RETENTION, Math.max(1, Math.trunc(rawRetention)))
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
 * remove every segment at or beyond the retention window, shift the surviving
 * `.retention-1` … `.1` up one, then move the live file to `.1`. Removing the
 * whole window (not only the oldest index) makes a lowered retention prune
 * segments an earlier, higher retention left behind; `unlinkRotated` treats a
 * missing segment as success, so the plan stays unconditional. Exposed for the
 * simulation property; the adapter performs the same steps through retrying
 * renames.
 * @param {string} file
 * @param {number} retention
 * @returns {{ remove: string[], moves: Array<{ from: string, to: string }>, liveTo: string }}
 */
export function activityRotationPlan(file, retention) {
  const keep = Math.min(
    MAX_ACTIVITY_RETENTION,
    Math.max(1, Number.isFinite(Number(retention)) ? Math.trunc(Number(retention)) : DEFAULT_ACTIVITY_RETENTION),
  )
  const remove = []
  for (let index = keep; index <= MAX_ACTIVITY_RETENTION; index += 1) {
    remove.push(activitySegmentPath(file, index))
  }
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
 * @param {{ maxBytes?: number, retention?: number, phase?: string }} [options]
 */
export async function appendJsonl(file, value, options = {}) {
  const line = `${JSON.stringify(value)}\n`
  const policy = activityPolicy(options)
  const phase = options.phase ?? 'activity-append'
  const append = async () => {
    try {
      await fsp.appendFile(file, line, 'utf8')
    } catch (error) {
      // #228: the audit line is a durable record too. A full disk here used to
      // escape as a bare errno while the state write it accompanies had already
      // landed, so the caller could not tell which record survived.
      throw translateStateIo(error, { path: file, phase, action: 'append to' })
    }
  }
  if (!policy.enabled) {
    await append()
    return
  }
  await serializedAppend(file, async () => {
    const lineBytes = Buffer.byteLength(line, 'utf8')
    let liveBytes = 0
    try {
      liveBytes = (await fsp.stat(file)).size
    } catch (error) {
      if (error?.code !== 'ENOENT') throw translateStateIo(error, { path: file, phase, action: 'inspect' })
    }
    if (shouldRotateActivity(liveBytes, lineBytes, policy.maxBytes)) {
      try {
        await rotateActivityFile(file, policy.retention)
      } catch {
        // Best effort: keep the live file and the line. The next append retries
        // rotation; an unbounded log is preferable to losing an audit record.
      }
    }
    await append()
  })
}
