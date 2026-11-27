// The short-lived commit mutex that fences the serialise→rename→read-back
// window of one state commit (#F24, #228).
//
// It lives in its own adapter module because it is the one lock in the store
// that is a *durable write* in its own right: it is created and released around
// the state rename, so a full disk has to report it with the same catalogued
// shape as the state write itself instead of a bare errno. The lock kernel
// (`./lock.js`) keeps its raw contract; the translation to `state-io-failed`
// lives here, one layer up (#228).
import crypto from 'node:crypto'
import path from 'node:path'

import { TowerToolError } from '../domain/errors.js'
import { acquireLock, lockRecord, lockTiming, readLock, releaseLock } from './lock.js'
import { translateStateIo } from './persistence.js'
import { fsp } from './store-fs.js'

/**
 * Wait budget for the commit mutex. The holder's critical section is one
 * temp-file write plus one rename (milliseconds), so a waiter that cannot get
 * the mutex in this window is told to retry rather than being allowed to wait
 * out the whole state-lock timeout.
 */
const COMMIT_LOCK_TIMEOUT_MS = 2000
const COMMIT_LOCK_POLL_MS = 10

/** The commit-mutex path for `paths`; older paths objects may not carry it. */
export function commitLockPath(paths) {
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
 * #228: a create that failed after it landed the record's name must not leave a
 * record behind. `writeFile` with `flag:'wx'` creates the file and then writes
 * the payload, so a full or failing volume can fail the second step and leave
 * an empty or partial record that the next writer would report forever as
 * `state-commit-busy`. Only bytes that cannot belong to a live holder are
 * removed: an unreadable or empty record, or a record carrying *this* attempt's
 * token. A readable record with a foreign token is never touched — the fixed
 * lock order says its holder also holds the state lock, so it is a real
 * (possibly operator-recovered) holder. A missing path is already clean.
 *
 * @param {string} lockPath
 * @param {string} token
 * @returns {Promise<boolean>} true when this call removed the record
 */
async function removePartialCommitRecord(lockPath, token) {
  const current = await fsp.readFile(lockPath, 'utf8').catch(() => null)
  if (current === null) return false
  let removable
  try {
    removable = JSON.parse(current)?.token === token
  } catch {
    // Empty or torn: the exclusive create can only have left this from our own
    // failed attempt (a complete record is written by one `writeFile` call).
    removable = true
  }
  if (!removable) return false
  await fsp.unlink(lockPath).catch(() => {})
  return true
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
 * #228: the create is a durable write like every other seam. The kernel keeps
 * its raw contract (it rethrows a create failure unchanged), so the translation
 * lives here: a full disk reports one catalogued `state-io-failed` naming this
 * path and the `state-commit-lock` phase instead of a bare errno that becomes
 * `tool-internal`. `commitLockCreate`/`commitLockSleep` are the matching test
 * seams, forwarded to the kernel's `create`/`createSleep`.
 *
 * @param {{ state: string, lock: string, dir: string, commitLock?: string }} paths
 * @param {{ commitLockTimeoutMs?: number, commitLockPollMs?: number, now?: number | (() => number), commitLockCreate?: Function, commitLockSleep?: Function }} [options]
 * @returns {Promise<{ lockPath: string, token: string }>}
 */
export async function acquireCommitLock(paths, options = {}) {
  const lockPath = commitLockPath(paths)
  const timeoutMs = Number(options.commitLockTimeoutMs ?? COMMIT_LOCK_TIMEOUT_MS)
  const pollMs = Number(options.commitLockPollMs ?? COMMIT_LOCK_POLL_MS)
  const token = crypto.randomUUID()
  let held
  try {
    held = await acquireLock(lockPath, {
      ...(typeof options.commitLockCreate === 'function' ? { create: options.commitLockCreate } : {}),
      ...(typeof options.commitLockSleep === 'function' ? { createSleep: options.commitLockSleep } : {}),
      token,
      record: lockRecord(token, { kind: 'state-commit' }, options),
      timeoutMs,
      pollMs,
      heartbeat: false,
      now: options.now,
    })
  } catch (error) {
    // Before the translation: a create that wrote part of the record and then
    // failed must not turn into a wedge the next writer reports.
    await removePartialCommitRecord(lockPath, token)
    throw translateStateIo(error, {
      path: lockPath,
      phase: 'state-commit-lock',
      action: 'create the Tower state commit mutex',
      note: 'the state document was not modified',
    })
  }
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
      nextAction: `retry the mutation; if it keeps failing, confirm no Tower writer is active and run tower_recover clear-stale-lock with confirm:"CLEAR_STALE_LOCK" (add force:true only after confirming the holder is gone) to move ${lockPath} to a backup`,
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
 * #228: the release renames the record to a quarantine and reads it back, so it
 * is a durable write too. A raw refusal here is translated, and the wording has
 * to be true for the situation the caller is in: this runs *after* the state
 * document may already have landed, so it must never borrow the "the previous
 * document is unchanged" note. `landed` says which of the two situations
 * applies; the catalogued error keeps `details.phase: 'state-commit-lock'` and
 * carries `details.released: false` plus the record path the next writer will
 * trip over.
 *
 * @param {{ lockPath: string, token: string } | null} commit
 * @param {{ landed?: boolean }} [options]
 */
export async function releaseCommitLock(commit, options = {}) {
  if (!commit) return
  try {
    await releaseLock(commit.lockPath, commit.token)
  } catch (error) {
    const translated = translateStateIo(error, {
      path: commit.lockPath,
      phase: 'state-commit-lock',
      action: 'release the Tower state commit mutex',
      note:
        options.landed === true
          ? `the state document was written, but the commit mutex could not be released, so the next writer reports state-commit-busy until ${commit.lockPath} is removed`
          : 'the state document was not written, and the commit mutex could not be released',
    })
    if (translated instanceof TowerToolError && translated.code === 'state-io-failed') {
      translated.details = { ...translated.details, released: false }
    }
    throw translated
  }
}

/**
 * Inspect the leftover commit mutex without touching it (#F71).
 *
 * A normal waiter never needs this: `acquireCommitLock` reclaims a provably
 * dead PID on EEXIST. The record is reported here so `tower_recover` and
 * `tower_inspect` can explain why every state write fails with
 * `state-commit-busy` instead of leaving an operator to delete a file by hand.
 *
 * @param {{ dir: string, commitLock?: string }} paths
 * @param {{ now?: number | (() => number) }} [options]
 */
export async function readStateCommitLock(paths, options = {}) {
  return readLock(commitLockPath(paths), options)
}

function formatSeconds(ms) {
  if (!Number.isFinite(ms)) return 'an unknown time'
  return `${Math.max(0, Math.round(ms / 1000))} s`
}
