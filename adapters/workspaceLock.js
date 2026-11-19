// Advisory repository workspace lock: one Tower session at a time when
// `mode.workspaceLock` is enabled. Same-user trusted model, like the rest of
// the Tower store: it prevents accidental double control, not a malicious
// writer.
//
// Since #167 this lock uses the shared kernel in ./lock.js. A different live
// session is never taken over because its heartbeat or `at` is old: only a
// provably dead PID is reclaimed. A torn record (a writer killed between the
// exclusive create and its write) is recoverable (F87) once its bytes are not a
// record and its mtime is older than a grace window; it is moved to a backup,
// never deleted. Release requires the exact token and bytes.
import { fs, fsp } from './store-fs.js'
import path from 'node:path'
import crypto from 'node:crypto'
import { TowerToolError } from '../domain/errors.js'
import { acquireLock, lockRecord, processAlive, removeLockIfMatches, touchLock } from './lock.js'

export function workspaceLockPath(commonDir) {
  return path.join(commonDir, 'dsh-tower', 'tower.lock')
}

export function workspaceLockToken() {
  return crypto.randomUUID()
}

// #F87: how long a non-record lock file must be untouched before it is treated
// as torn rather than half-written. Three default mode heartbeats (10000ms
// each) matches the kernel's stale factor: a writer paused in the middle of its
// write keeps its record, while a killed writer is recoverable without a hand
// edit. The comparison is against the file's wall-clock mtime, never an
// injected `now`, so a test clock cannot make a live write look ancient.
export const WORKSPACE_LOCK_TORN_GRACE_MS = 30000

/**
 * True when the raw lock bytes are not a lock record at all: empty, whitespace
 * only, or not a JSON object. A parseable record is never torn, whatever its
 * PID or heartbeat says.
 * @param {string | null} text
 */
export function isTornWorkspaceLockBytes(text) {
  if (typeof text !== 'string') return false
  if (text.trim() === '') return true
  try {
    const parsed = JSON.parse(text)
    return !parsed || typeof parsed !== 'object'
  } catch {
    return true
  }
}

function backupName(file) {
  return `${file}.recovered-${Date.now()}${process.hrtime.bigint()}`
}

/**
 * One read of the lock file and its file facts. `raw` is null only when the
 * bytes exist but could not be read at all (for example EACCES); that is
 * different from zero bytes, which are torn.
 * @param {string} commonDir
 */
async function readState(commonDir) {
  const file = workspaceLockPath(commonDir)
  let stat
  try {
    stat = await fsp.stat(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, exists: false, stat: null, raw: null, error: null }
    return { file, exists: true, stat: null, raw: null, error: error?.message ?? String(error) }
  }
  try {
    const raw = await fsp.readFile(file, 'utf8')
    return { file, exists: true, stat, raw, error: null }
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, exists: false, stat: null, raw: null, error: null }
    return { file, exists: true, stat, raw: null, error: error?.message ?? String(error) }
  }
}

/**
 * Classify one read: held, torn, aged, reclaimable, self, stale. `aged` is
 * wall-clock based (see WORKSPACE_LOCK_TORN_GRACE_MS); `reclaimable` is exactly
 * torn and aged, the only automatic takeover F87 adds.
 * @param {Awaited<ReturnType<typeof readState>>} state
 * @param {{ sessionId?: string, agentId?: string, now?: number, staleMs?: number, tornGraceMs?: number }} [options]
 */
function stateFacts(state, options = {}) {
  const { sessionId, agentId, now = Date.now(), staleMs = 300000, tornGraceMs = WORKSPACE_LOCK_TORN_GRACE_MS } = options
  const bytes = state.stat && Number.isFinite(state.stat.size) ? state.stat.size : null
  const mtimeMs = state.stat && Number.isFinite(state.stat.mtimeMs) ? state.stat.mtimeMs : null
  const facts = {
    path: state.file,
    exists: state.exists,
    bytes,
    mtime: mtimeMs === null ? null : new Date(mtimeMs).toISOString(),
    mtimeMs,
    held: state.exists,
    corrupt: false,
    unreadable: false,
    error: null,
    record: null,
    holder: null,
    self: false,
    stale: false,
    torn: false,
    aged: false,
    reclaimable: false,
  }
  if (!state.exists) return facts
  if (state.raw === null) return { ...facts, corrupt: true, unreadable: true, error: state.error }
  const torn = isTornWorkspaceLockBytes(state.raw)
  const record = torn ? null : JSON.parse(state.raw)
  const aged = mtimeMs !== null && Date.now() - mtimeMs >= Math.max(0, Number(tornGraceMs) || 0)
  const self =
    record !== null &&
    ((sessionId !== undefined && record.sessionId === sessionId) ||
      (agentId !== undefined && record.agentId === agentId))
  return {
    ...facts,
    corrupt: torn,
    record,
    holder: record,
    self,
    stale: record !== null && now - Number(record.at ?? 0) > staleMs,
    torn,
    aged,
    reclaimable: torn && aged,
  }
}

/** The tool-facing facts. The record token stays out of every report. */
function publicFacts(facts) {
  const record = facts.record ?? null
  return {
    path: facts.path,
    exists: facts.exists,
    bytes: facts.bytes,
    mtime: facts.mtime,
    held: facts.held,
    corrupt: facts.corrupt,
    unreadable: facts.unreadable,
    self: facts.self,
    stale: facts.stale,
    torn: facts.torn,
    aged: facts.aged,
    reclaimable: facts.reclaimable,
    pid: record?.pid ?? null,
    sessionId: record?.sessionId ?? null,
    agentId: record?.agentId ?? null,
    since: record?.since ?? null,
    at: record?.at ?? null,
    error: facts.error,
  }
}

/**
 * Workspace-lock facts including file size and mtime, for `tower_recover
 * status` and the gate's workspace-busy message.
 * @param {string} commonDir
 * @param {{ sessionId?: string, agentId?: string, now?: number, staleMs?: number, tornGraceMs?: number }} [options]
 */
export async function workspaceLockFacts(commonDir, options = {}) {
  return stateFacts(await readState(commonDir), options)
}

/** Public (no token) version of {@link workspaceLockFacts}. */
export async function workspaceLockStatus(commonDir, options = {}) {
  return publicFacts(await workspaceLockFacts(commonDir, options))
}

/**
 * Move the record to a backup only when the bytes and mtime still match the
 * classified read. A concurrent writer's newer record is left alone. The
 * record is renamed, never unlinked: the recovered bytes stay auditable.
 */
async function moveIfUnchanged(file, expected) {
  let stat
  try {
    stat = await fsp.stat(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return { moved: false, reason: 'missing', backup: null }
    throw error
  }
  if (expected.mtimeMs !== null && Number(stat.mtimeMs) !== Number(expected.mtimeMs)) {
    return { moved: false, reason: 'changed', backup: null }
  }
  if (typeof expected.raw === 'string') {
    let raw
    try {
      raw = await fsp.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { moved: false, reason: 'missing', backup: null }
      return { moved: false, reason: 'changed', backup: null }
    }
    if (raw !== expected.raw) return { moved: false, reason: 'changed', backup: null }
  }
  const backup = backupName(file)
  try {
    await fsp.rename(file, backup)
  } catch (error) {
    if (error?.code === 'ENOENT') return { moved: false, reason: 'missing', backup: null }
    throw new TowerToolError(
      'workspace-busy',
      `the workspace lock at ${file} could not be moved to ${backup} (${error?.message ?? error})`,
      { retryable: true, nextAction: `inspect ${file} and ${backup}, then retry tower_recover status` },
    )
  }
  return { moved: true, reason: 'cleared', backup }
}

/**
 * Reclaim exactly one torn and aged record. Fresh torn bytes refuse: the
 * writer may be between its exclusive create and its write.
 * @returns {Promise<{reclaimed: boolean, reason: string | null, backup: string | null, workspaceLock: object}>}
 */
export async function reclaimTornWorkspaceLock(commonDir, options = {}) {
  const state = await readState(commonDir)
  const facts = stateFacts(state, options)
  const base = { reclaimed: false, reason: null, backup: null, workspaceLock: publicFacts(facts) }
  if (!facts.exists) return { ...base, reason: 'missing' }
  if (!facts.reclaimable) {
    return { ...base, reason: facts.unreadable ? 'unreadable' : facts.torn ? 'torn-fresh' : 'record' }
  }
  const moved = await moveIfUnchanged(state.file, { mtimeMs: facts.mtimeMs, raw: state.raw })
  if (!moved.moved) return { ...base, reason: moved.reason }
  return { reclaimed: true, reason: 'reclaimed', backup: moved.backup, workspaceLock: base.workspaceLock }
}

/**
 * Move a workspace record aside for recovery. Without force a well-formed
 * record is moved only when its PID is provably dead; a live or unprovable
 * holder, a fresh torn file, and an unreadable file all refuse. Force is the
 * operator override after confirming no session is writing.
 * @returns {Promise<{cleared: boolean, reason: string, backup: string | null, forced: boolean, workspaceLock: object | null}>}
 */
export async function clearWorkspaceLock(commonDir, options = {}) {
  const { force = false } = options
  const state = await readState(commonDir)
  const facts = stateFacts(state, options)
  const base = { cleared: false, reason: null, backup: null, forced: force === true, workspaceLock: publicFacts(facts) }
  if (!facts.exists) return { ...base, reason: 'missing' }
  if (!force) {
    if (facts.unreadable) return { ...base, reason: 'unreadable' }
    const alive = facts.record ? processAlive(facts.record.pid) : null
    if (alive === true) return { ...base, reason: 'holder-alive' }
    if (alive === null && facts.record) return { ...base, reason: 'holder-unprovable' }
    if (facts.torn && !facts.reclaimable) return { ...base, reason: 'torn-fresh' }
  }
  const moved = await moveIfUnchanged(state.file, { mtimeMs: facts.mtimeMs, raw: state.raw })
  if (!moved.moved) return { ...base, reason: moved.reason }
  return { cleared: true, reason: 'cleared', backup: moved.backup, forced: force === true, workspaceLock: base.workspaceLock }
}

/**
 * The refusal for a clear/acquire attempt: names the lock path, its size and
 * mtime, and one runnable next step, so an operator can choose between waiting
 * and force.
 * @param {{ reason: string, workspaceLock: any }} result
 * @param {{ graceMs?: number }} [options]
 */
export function workspaceLockRefusal(result, options = {}) {
  const facts = result.workspaceLock ?? null
  const graceMs = Number(options.graceMs ?? WORKSPACE_LOCK_TORN_GRACE_MS)
  const where = facts?.path ?? 'the workspace lock'
  const size = facts?.bytes === null || facts?.bytes === undefined ? 'unknown bytes' : `${facts.bytes} bytes`
  const when = facts?.mtime ?? 'unknown mtime'
  const forceStep =
    'confirm no Tower session is writing, then pass force:true with confirm:"CLEAR_WORKSPACE_LOCK" to move it to a backup (never deleted)'
  const details = {
    reason: result.reason,
    lockPath: where,
    bytes: facts?.bytes ?? null,
    mtime: facts?.mtime ?? null,
    forced: false,
  }
  if (result.reason === 'torn-fresh') {
    return new TowerToolError(
      'workspace-busy',
      `the workspace lock at ${where} (${size}, mtime ${when}) holds non-record bytes but was written less than ${graceMs}ms ago, so a writer may still be finishing; wait ${graceMs}ms and retry, or ${forceStep}`,
      {
        retryable: true,
        nextAction: `retry tower_recover status after ${graceMs}ms; if the record is still torn, ${forceStep}`,
        details,
      },
    )
  }
  if (result.reason === 'holder-alive') {
    return new TowerToolError(
      'workspace-busy',
      `the workspace lock at ${where} (${size}, mtime ${when}) is held by pid ${facts?.pid ?? 'unknown'} (session ${facts?.sessionId ?? 'unknown'}); a provably live holder is never moved, so run /tower off in that session and retry, or ${forceStep}`,
      {
        retryable: false,
        nextAction: `run /tower off in the holding session; if the session is gone but its PID was recycled, ${forceStep}`,
        details: { ...details, pid: facts?.pid ?? null, sessionId: facts?.sessionId ?? null },
      },
    )
  }
  if (result.reason === 'holder-unprovable') {
    return new TowerToolError(
      'workspace-busy',
      `the workspace lock at ${where} (${size}, mtime ${when}) has no provably dead owner (pid ${facts?.pid ?? 'missing'}), so the kernel never reclaims it; ${forceStep}`,
      { retryable: false, nextAction: forceStep, details: { ...details, pid: facts?.pid ?? null } },
    )
  }
  if (result.reason === 'unreadable') {
    return new TowerToolError(
      'workspace-busy',
      `the workspace lock at ${where} exists but could not be read (${facts?.error ?? 'unknown error'}); ${forceStep}`,
      { retryable: false, nextAction: forceStep, details: { ...details, error: facts?.error ?? null } },
    )
  }
  if (result.reason === 'changed') {
    return new TowerToolError(
      'workspace-busy',
      `the workspace lock at ${where} changed while the recovery ran; nothing was moved`,
      { retryable: true, nextAction: 'run tower_recover status, then retry', details },
    )
  }
  return new TowerToolError(
    'workspace-busy',
    `the workspace lock at ${where} (${size}, mtime ${when}) could not be cleared (${result.reason ?? 'unknown reason'})`,
    { retryable: true, nextAction: 'run tower_recover status, then retry', details },
  )
}

/**
 * The host-injected capability `tower_recover` uses. Tools never import this
 * adapter (composition-root); the host entry passes this object through deps.
 * `status` never exposes the record token; `clear` throws the refusal error.
 */
export const workspaceLockCapability = Object.freeze({
  graceMs: WORKSPACE_LOCK_TORN_GRACE_MS,
  status: workspaceLockStatus,
  async clear(commonDir, options = {}) {
    const result = await clearWorkspaceLock(commonDir, options)
    if (result.cleared || result.reason === 'missing') return result
    throw workspaceLockRefusal(result, { graceMs: options.tornGraceMs ?? WORKSPACE_LOCK_TORN_GRACE_MS })
  },
})

async function readRecord(commonDir) {
  const file = workspaceLockPath(commonDir)
  let text = null
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, record: null, corrupt: false, raw: null }
    return { file, record: null, corrupt: true, raw: null }
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return { file, record: null, corrupt: true, raw: text }
    return { file, record: parsed, corrupt: false, raw: text }
  } catch {
    return { file, record: null, corrupt: true, raw: text }
  }
}

/**
 * Try to become the repository's Tower session.
 *
 * A record owned by the same session/agent is re-adopted with its existing
 * token (the caller may have restarted and lost the in-memory token). Every
 * other record is refused unless its PID is provably dead, in which case the
 * kernel reclaims it by byte-verified CAS. A torn record is reclaimed once,
 * and only after the F87 grace window, by moving it to a backup and retrying
 * the exclusive create.
 *
 * @param {string} commonDir
 * @param {{ token: string, sessionId: string, agentId: string, staleMs?: number, now?: number, tornGraceMs?: number }} options
 * @returns {Promise<{acquired:boolean, record?:object, holder?:object|null, tookOver?:boolean, corrupt?:boolean, reason?:string|null, workspaceLock?:object, backup?:string}>}
 */
export async function acquireWorkspaceLock(commonDir, options) {
  const {
    token,
    sessionId,
    agentId,
    staleMs = 300000,
    now = Date.now(),
    tornGraceMs = WORKSPACE_LOCK_TORN_GRACE_MS,
  } = options
  const file = workspaceLockPath(commonDir)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  let reclaimAttempted = false
  let reclaimedBackup = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = lockRecord(token, { sessionId, agentId }, { now })
    const held = await acquireLock(file, {
      token,
      record,
      now,
      timeoutMs: 0,
      pollMs: 10,
      heartbeat: false,
      // A workspace record without a usable PID is never assumed dead: only
      // the mode store's historical records opt into `invalidPidIsDead`.
      invalidPidIsDead: false,
    })
    if (held) {
      return {
        acquired: true,
        record,
        tookOver: held.reclaimed === true || attempt > 0,
        ...(reclaimedBackup ? { backup: reclaimedBackup } : {}),
      }
    }

    const current = await readRecord(commonDir)
    if (current.corrupt) {
      // Unreadable bytes are an unknown owner, not an abandoned lock. F87: only
      // a record that is not a lock at all AND older than the torn grace window
      // is moved aside (to a backup, never deleted), then the exclusive create
      // is retried once. A fresh torn file is still a half-finished write.
      if (!reclaimAttempted) {
        reclaimAttempted = true
        const reclaimed = await reclaimTornWorkspaceLock(commonDir, { now, tornGraceMs })
        if (reclaimed.reclaimed) {
          reclaimedBackup = reclaimed.backup
          continue
        }
        return {
          acquired: false,
          holder: null,
          corrupt: true,
          reason: reclaimed.reason,
          workspaceLock: reclaimed.workspaceLock,
        }
      }
      return { acquired: false, holder: null, corrupt: true }
    }
    if (!current.record) continue // raced with a release; try the exclusive create again
    if (current.record.sessionId === sessionId && current.record.agentId === agentId) {
      const refreshed = await touchLock(file, current.record.token, { now })
      if (refreshed) {
        return {
          acquired: true,
          record: { ...current.record, at: now },
          tookOver: false,
        }
      }
      continue // the record changed between read and touch
    }
    return { acquired: false, holder: current.record }
  }
  return { acquired: false, holder: null, corrupt: true }
}

/** Refresh the timestamp only when the lock still belongs to this session. */
export async function touchWorkspaceLock(commonDir, options) {
  const { token, now = Date.now() } = options
  if (typeof token !== 'string' || token.length === 0) return false
  return touchLock(workspaceLockPath(commonDir), token, { now })
}

/**
 * Release the lock only when this session owns it. A missing token never
 * releases anything: there is no blind unlink.
 */
export async function releaseWorkspaceLock(commonDir, options) {
  const { token } = options
  if (typeof token !== 'string' || token.length === 0) return false
  const { record, file, raw, corrupt } = await readRecord(commonDir)
  if (corrupt || !record || record.token !== token) return false
  return removeLockIfMatches(file, token, raw)
}

export async function inspectWorkspaceLock(commonDir, options = {}) {
  const { sessionId, staleMs = 300000, now = Date.now() } = options
  const { record, corrupt } = await readRecord(commonDir)
  if (!record) return { held: false, corrupt, self: false, holder: null, stale: false }
  return {
    held: true,
    corrupt,
    self: sessionId !== undefined && record.sessionId === sessionId,
    holder: record,
    // Diagnostic only: a stale live session is still the owner, not a target.
    stale: now - Number(record.at ?? 0) > staleMs,
  }
}

/**
 * Synchronous workspace-lock read for the mode guard (#161 D4). The guard is a
 * synchronous call, so it reads the record without the async kernel: held
 * means a record exists — a corrupt file fails closed exactly like
 * `acquireWorkspaceLock`, and staleness never demotes a live owner. Returns
 * `{ held: false }` when no lock file exists.
 * @param {string} commonDir
 * @returns {{ held: boolean, corrupt?: boolean, holder?: object | null }}
 */
export function inspectWorkspaceLockSync(commonDir) {
  const file = workspaceLockPath(commonDir)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { held: false }
    // Unreadable bytes are an unknown owner, not an abandoned lock.
    return { held: true, corrupt: true, holder: null }
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return { held: true, corrupt: true, holder: null }
    return { held: true, corrupt: false, holder: parsed }
  } catch {
    return { held: true, corrupt: true, holder: null }
  }
}
