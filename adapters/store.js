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
  releaseLock,
} from './lock.js'
import {
  activityPolicy,
  activitySegmentIndices,
  activitySegmentPath,
  writeJsonAtomic,
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

/**
 * Parse a JSONL file tolerant of a truncated final line and corrupt lines.
 * A bad line never hides the rest of the segment.
 * @param {string} file
 * @returns {Promise<unknown[]>}
 */
async function readJsonlTolerant(file) {
  const text = await fsp.readFile(file, 'utf8').catch(() => '')
  const out = []
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      out.push(JSON.parse(line))
    } catch {
      // keep going: a truncated activity line must not hide the rest
    }
  }
  return out
}

/**
 * Last `limit` activity entries across the live file and its rotated segments.
 * Segments are numbered newest-first (`.1` newest), so the chronological order
 * is highest index, ..., `.1`, then `activity.jsonl`. Only as many segments as
 * needed are read: the live file first, then `.1`, `.2`, ... until enough parsed
 * lines are available; the collected groups are reversed at the end.
 * @param {string} file
 * @param {number} [limit]
 */
export async function readActivityTail(file, limit = 12) {
  const wanted = Number.isInteger(limit) && limit > 0 ? limit : 12
  /** @type {unknown[][]} */
  const groups = []
  let parsed = 0
  const readGroup = async (target) => {
    const group = await readJsonlTolerant(target)
    if (group.length > 0) {
      groups.push(group)
      parsed += group.length
    }
  }
  await readGroup(file)
  if (parsed < wanted) {
    const names = await fsp.readdir(path.dirname(file)).catch(() => [])
    const indices = activitySegmentIndices(file, names).sort((a, b) => a - b)
    for (const index of indices) {
      if (parsed >= wanted) break
      await readGroup(activitySegmentPath(file, index))
    }
  }
  return groups.reverse().flat().slice(-wanted)
}

/**
 * Read-only rotation facts for tower_doctor/status. Never writes, never
 * creates the directory, and tolerates a repo with no activity log yet.
 * @param {string} file
 * @param {{ maxBytes?: number, retention?: number }} [options]
 */
export async function inspectActivityLog(file, options = {}) {
  const policy = activityPolicy(options)
  let liveBytes = 0
  try {
    liveBytes = (await fsp.stat(file)).size
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const names = await fsp.readdir(path.dirname(file)).catch(() => [])
  const segments = []
  let rotatedBytes = 0
  for (const index of activitySegmentIndices(file, names)) {
    let bytes = 0
    try {
      bytes = (await fsp.stat(activitySegmentPath(file, index))).size
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    segments.push({ index, bytes })
    rotatedBytes += bytes
  }
  return {
    file,
    rotationEnabled: policy.enabled,
    maxBytes: policy.maxBytes,
    retention: policy.retention,
    liveBytes,
    rotatedBytes,
    segments,
  }
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
 * in-process record of that acquisition: the token, the lock handle (so a lost
 * heartbeat is visible here), and the exact state.json bytes this mutation may
 * replace. A state write may proceed only with the exact token this process
 * acquired: the loader uses the same map to tell a locked mutation from a
 * read-only load, and `writeStateLocked` refuses every write that was not made
 * inside the matching `withLock` section (#167).
 *
 * `baseRaw` is captured under the lock before the mutation loads state;
 * `lastWrittenRaw` chains a second commit in the same section. A state write
 * may replace either of those two documents and nothing else, which is what
 * makes a lost update impossible even when a takeover slips past the lock
 * (#F24).
 */
const HELD_STATE_LOCKS = new WeakMap()

/** @param {object} [paths] @returns {boolean} */
export function isStateLockHeld(paths) {
  return Boolean(paths) && HELD_STATE_LOCKS.has(paths)
}

/** The token of the state lock this process holds for `paths`, or null. */
export function stateLockToken(paths) {
  return heldStateLock(paths)?.token ?? null
}

/** The in-process state-lock section for `paths`, or null outside `withLock`. */
function heldStateLock(paths) {
  return (paths && HELD_STATE_LOCKS.get(paths)) ?? null
}

/**
 * True when this process still owns the in-process section but a heartbeat
 * found the on-disk record taken away (an operator recovery moved it, or a
 * successor acquired the path). The mutation must fail closed instead of
 * publishing state under a lock it no longer holds.
 */
export function stateLockLost(paths) {
  return heldStateLock(paths)?.handle?.lost === true
}

/**
 * The successor revision observed after this section's last commit (see
 * `classifyLandedState`), or null when the last commit landed unchanged. The
 * mutation responsible is applied: the caller must retry only when the store
 * reported `superseded: false`.
 */
export function stateLockSuperseded(paths) {
  return heldStateLock(paths)?.superseded ?? null
}

/**
 * The exact bytes on disk for `paths.state`, or null when the file does not
 * exist yet (a fresh repository being initialised). Any other read error is
 * propagated: a write whose base document cannot be read cannot be fenced.
 */
async function readStateBytes(paths) {
  try {
    return await fsp.readFile(paths.state, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** The `revision` of a serialised state document, for diagnostics only. */
function stateRevision(raw) {
  if (typeof raw !== 'string') return null
  try {
    const value = JSON.parse(raw)
    return Number.isFinite(value?.revision) ? value.revision : null
  } catch {
    return null
  }
}

/**
 * Classify the document left on disk after this mutation's rename returned.
 *
 * `superseded` is *not* an error: our bytes were renamed over state.json and a
 * successor built its revision on top of them, so the mutation is applied and
 * retrying it would apply the same change twice. `lost-update` is the only
 * outcome that means the document our mutation based itself on never reached
 * (or did not survive on) the disk; it is retryable because re-running against
 * the current document applies the mutation exactly once.
 *
 * @param {string} payloadRaw the bytes this mutation renamed over state.json
 * @param {string | null} landedRaw the bytes read back after the rename
 * @returns {{ outcome: 'ok' | 'superseded' | 'lost-update', revision: number | null, landedRevision: number | null }}
 */
export function classifyLandedState(payloadRaw, landedRaw) {
  const revision = stateRevision(payloadRaw)
  const landedRevision = stateRevision(landedRaw)
  if (landedRaw === payloadRaw) return { outcome: 'ok', revision, landedRevision }
  if (revision !== null && landedRevision !== null && landedRevision > revision) {
    return { outcome: 'superseded', revision, landedRevision }
  }
  return { outcome: 'lost-update', revision, landedRevision }
}

/**
 * Wait budget for the commit mutex. The holder's critical section is one
 * temp-file write plus one rename (milliseconds), so a waiter that cannot get
 * the mutex in this window is told to retry rather than being allowed to wait
 * out the whole state-lock timeout.
 */
const COMMIT_LOCK_TIMEOUT_MS = 2000
const COMMIT_LOCK_POLL_MS = 10

/** The commit-mutex path for `paths`; older paths objects may not carry it. */
function commitLockPath(paths) {
  return paths.commitLock ?? path.join(paths.dir, 'state.commit.lock')
}

/**
 * The short-lived commit mutex that fences the serialise→rename→read-back
 * window of one state commit (#F24). It lives next to `state.json` and is
 * derived from `paths.dir` rather than stored on `paths`, so adding the fence
 * did not widen the `pathsFor` contract every store implementation mirrors.
 *
 * @param {{ dir: string, commitLock?: string }} paths
 * @returns {string}
 */
export function stateCommitLockPath(paths) {
  return commitLockPath(paths)
}

/**
 * Acquire the short-lived commit mutex that fences one state commit.
 *
 * Lock order is fixed: the state lock is taken first and the commit mutex only
 * while it is held (see `writeStateLocked`). Nothing may take the commit mutex
 * without the state lock, and nothing holding the commit mutex may wait for
 * the state lock; that ordering is what makes a deadlock impossible.
 *
 * Reclaim follows the same contract as every other lock in this kernel: a
 * record is moved aside only when its PID is provably dead. A live holder
 * (even a silent one) is never stolen, so an operator's forced recovery of the
 * *state* lock cannot hand a second writer this mutex while its holder is
 * still committing. The record needs no heartbeat: it is held for a single
 * rename, and a waiter's timeout surfaces the holder's PID/token instead.
 *
 * @param {{ state: string, lock: string, dir: string, commitLock?: string }} paths
 * @param {{ commitLockTimeoutMs?: number, commitLockPollMs?: number, now?: number | (() => number) }} [options]
 * @returns {Promise<{ lockPath: string, token: string }>}
 */
async function acquireCommitLock(paths, options = {}) {
  const lockPath = commitLockPath(paths)
  const timeoutMs = Number(options.commitLockTimeoutMs ?? COMMIT_LOCK_TIMEOUT_MS)
  const pollMs = Number(options.commitLockPollMs ?? COMMIT_LOCK_POLL_MS)
  const token = crypto.randomUUID()
  const held = await acquireLock(lockPath, {
    token,
    record: lockRecord(token, { kind: 'state-commit' }, options),
    timeoutMs,
    pollMs,
    heartbeat: false,
    now: options.now,
  })
  if (held) return { lockPath, token }
  const owner = await readLock(lockPath, options)
  const timing = owner.record ? owner.timing ?? lockTiming(owner.record, options) : null
  const facts = owner.record
    ? `held by pid ${owner.record.pid ?? 'unknown'} for ${formatSeconds(timing?.ageMs)} (token ${owner.record.token ?? 'missing'})`
    : 'the holder released it before it could be inspected'
  throw new TowerToolError(
    'state-locked',
    `refusing to write ${paths.state}: another writer is committing tower state (the commit mutex at ${lockPath} is ${facts}); the commit window is short, so retry`,
    {
      retryable: true,
      nextAction: `retry the mutation; if it keeps failing, confirm no Tower writer is active (the mutex is reclaimed automatically only for a provably dead PID) and only then remove ${lockPath}`,
      details: {
        reason: 'state-commit-busy',
        lockPath,
        stateLockPath: paths.lock,
        holderPid: owner.record?.pid ?? null,
        holderToken: owner.record?.token ?? null,
        heldMs: timing?.ageMs ?? null,
        waitMs: timeoutMs,
      },
    },
  )
}

/**
 * Release the commit mutex with the token CAS, so a record replaced by another
 * writer is never removed. It runs in a `finally`: an exception or a timeout
 * below the write must not leave the mutex behind.
 *
 * @param {{ lockPath: string, token: string } | null} commit
 */
async function releaseCommitLock(commit) {
  if (!commit) return
  await releaseLock(commit.lockPath, commit.token)
}

/**
 * A mutation loaded a document that another writer has since replaced. The
 * write is refused rather than overwriting the newer document: applying the
 * same base revision twice is the lost update #F24 reports. Retryable, because
 * re-running the mutation against the new state succeeds.
 */
function lostUpdateError(paths, { token, expectedRaw, actualRaw }) {
  const expectedRevision = stateRevision(expectedRaw)
  const actualRevision = stateRevision(actualRaw)
  return new TowerToolError(
    'state-locked',
    `refusing to write ${paths.state}: the state document changed after this mutation loaded it (expected revision ${expectedRevision ?? 'unknown'}, found ${actualRevision ?? 'missing'}); another writer committed first, so this write would drop that update`,
    {
      retryable: true,
      nextAction: 're-run the mutation; it will load the committed state and apply again',
      details: {
        reason: 'state-lock-lost-update',
        lockPath: paths.lock,
        expectedToken: token,
        expectedRevision,
        actualRevision,
      },
    },
  )
}

/** A heartbeat observed that the lock record is no longer this mutation's. */
function ownershipLostError(paths, token) {
  return new TowerToolError(
    'state-locked',
    `refusing to write ${paths.state}: the state lock at ${paths.lock} was taken away from this mutation while it was in flight; another writer owns the lock`,
    {
      retryable: true,
      nextAction: 're-run the mutation; it will take a fresh lock and load the committed state',
      details: { reason: 'state-lock-ownership-lost', lockPath: paths.lock, expectedToken: token },
    },
  )
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
 * Invariant (lost-update fence, #F24): this mutation may replace only the
 * exact state.json bytes it loaded — the document present when `withLock`
 * took the lock — or the document its own previous commit in this section
 * wrote. Those bytes are compared against the disk immediately before the
 * atomic rename (inside the verify hook) and the landed bytes are compared to
 * the payload. A takeover, a revoked lock record resurrected by a late
 * heartbeat, or any other writer that committed in between therefore fails
 * this write closed with a retryable
 * 'state-locked' / 'state-lock-lost-update' instead of applying the same base
 * revision twice. Mutual exclusion is the fast path; this CAS is the guarantee.
 *
 * The CAS alone is not enough: the last check and the rename are two syscalls,
 * so a takeover can land a whole foreign commit in between (an operator moves
 * `paths.lock` aside; the renamed document then replaces the foreign one and
 * the read-back sees this mutation's own payload). The rename and the read-back
 * are therefore covered by the short-lived commit mutex at
 * `stateCommitLockPath(paths)`: lock order is state lock → commit mutex, never
 * the reverse, and the mutex is released in a `finally` covering the atomic
 * write and the read-back.
 *
 * The read-back is classified by revision (see `classifyLandedState`): a
 * successor revision built on our bytes means this mutation is applied, so it
 * is reported as `superseded` and must not be retried; only a document that
 * cannot contain this mutation is a retryable lost update.
 *
 * `options.onBeforeRename` / `options.onAfterRename` are test seams for the two
 * sides of the commit window; production callers omit them.
 *
 * @param {{ state: string, lock: string, dir: string, commitLock?: string }} paths
 * @param {unknown} state
 * @param {string | undefined} token
 * @param {{ commitLockTimeoutMs?: number, commitLockPollMs?: number, now?: number | (() => number), onBeforeRename?: (info: { file: string, tmp: string }) => void | Promise<void>, onAfterRename?: (info: { file: string, tmp: string }) => void | Promise<void> }} [options]
 * @returns {Promise<{ revision: number | null, landedRevision: number | null, superseded: boolean }>}
 */
export async function writeStateLocked(paths, state, token, options = {}) {
  const held = heldStateLock(paths)
  if (typeof token !== 'string' || token.length === 0 || held?.token !== token) {
    throw new TowerToolError(
      'state-locked',
      `refusing to write ${String(paths?.state ?? 'state.json')} outside the held state lock (token missing or mismatched)`,
      { retryable: false, nextAction: 'take the state lock with withLock and pass the token it issues' },
    )
  }
  await verifyStateLockHolder(paths, token)
  if (held.handle?.lost) throw ownershipLostError(paths, token)
  const expectedRaw = held.lastWrittenRaw ?? held.baseRaw
  const onDisk = await readStateBytes(paths)
  if (onDisk !== expectedRaw) throw lostUpdateError(paths, { token, expectedRaw, actualRaw: onDisk })
  const payload = JSON.stringify(state, null, 2)
  // Fence the whole serialise→verify→rename→read-back window before the last
  // ownership check: a takeover that moves the state lock aside can no longer
  // interleave a complete foreign commit between the check and the rename.
  const commit = await acquireCommitLock(paths, options)
  let failure = null
  try {
    await writeJsonAtomic(paths.state, state, {
      verify: async () => {
        // Re-check ownership and the exact base document at the last possible
        // moment: after serialisation, before the rename. A `toJSON` side effect,
        // a takeover, or a successor's commit between the checks above and this
        // hook fails the write and leaves state.json untouched.
        await verifyStateLockHolder(paths, token)
        if (held.handle?.lost) throw ownershipLostError(paths, token)
        const current = await readStateBytes(paths)
        if (current !== expectedRaw) throw lostUpdateError(paths, { token, expectedRaw, actualRaw: current })
      },
      onBeforeRename: options.onBeforeRename,
      onAfterRename: options.onAfterRename,
    })
    const written = await readStateBytes(paths)
    const verdict = classifyLandedState(payload, written)
    if (verdict.outcome === 'lost-update') {
      throw lostUpdateError(paths, { token, expectedRaw: payload, actualRaw: written })
    }
    // Chain the next commit of this section from the bytes actually on disk. A
    // successor that built on this commit is inherited, so the next write may
    // replace its document; our own payload would no longer be the base.
    held.lastWrittenRaw = verdict.outcome === 'superseded' ? written : payload
    if (verdict.outcome === 'superseded') {
      // Diagnostic record: the mutation landed and a later revision inherited
      // it, so the caller must not retry (a retry would apply it twice).
      held.superseded = { revision: verdict.revision, landedRevision: verdict.landedRevision }
    }
    return {
      revision: verdict.revision,
      landedRevision: verdict.landedRevision,
      superseded: verdict.outcome === 'superseded',
    }
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      await releaseCommitLock(commit)
    } catch (releaseError) {
      // A failed release must surface when the write itself succeeded (the
      // next writer would see a stuck mutex), but it must not mask the write
      // failure that is already on its way out.
      if (!failure) throw releaseError
    }
  }
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
  /** @type {{ token: string, handle: { lost?: boolean, release: () => Promise<boolean> }, baseRaw: string | null, lastWrittenRaw: string | null, superseded: { revision: number | null, landedRevision: number | null } | null }} */
  const heldState = { token, handle: held, baseRaw: null, lastWrittenRaw: null, superseded: null }
  HELD_STATE_LOCKS.set(paths, heldState)
  try {
    // Capture the base document under the lock, before the mutation loads it:
    // the first write may replace exactly these bytes. A mutation that loads a
    // document nobody replaced since this read is the only one allowed to
    // publish, which is the lost-update fence across processes (#F24).
    heldState.baseRaw = await readStateBytes(paths)
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
