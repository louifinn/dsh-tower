// The only module in the plugin that imports node:fs (#50).
//
// Since #69 this is a real adapter, not a re-export shim: `createStorePort()`
// returns a runtime implementation of StorePort (ports/store.js) that the
// composition root injects into the app layer. The durable implementation still
// lives next door in adapters/store.js + adapters/persistence.js (#70). The
// raw `fs`/`fsp` exports remain for the adapter modules that are not behind
// the port yet.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { TowerToolError } from '../domain/errors.js'
import * as store from './store.js'
import { lockTiming, readLock } from './lock.js'

const { createWriteStream } = fs
export { fs, fsp, createWriteStream }

/**
 * Move a leftover commit mutex aside into an auditable backup (#F71).
 *
 * Safety: clearing this mutex alone does not let a second writer corrupt
 * `state.json`. Every writer still has to hold the state lock, and the commit
 * path re-verifies that lock, compares the exact document bytes before the
 * rename, and classifies the landed document by revision
 * (`classifyLandedState`, see `writeStateLocked`). If a holder is in fact
 * alive, the `finally` covers its whole commit window and either it has already
 * released the record (the ENOENT path below) or the recovery moves a record
 * the holder no longer owns; the next acquisition's token CAS prevents the old
 * holder from releasing a successor's record. The irreducible risk is the
 * classic check→rename gap: a holder that acquires *after* this function's
 * inspection and before its rename could have its record moved. That is why a
 * live PID is never cleared without `force`, and why the backup is kept: the
 * operator can see (and restore) exactly what was moved. Time alone is never
 * used as proof of death.
 *
 * An unreadable record is still a record (#F71 R1): `readLock` returns no
 * parsed record for a torn write, so this function reads the exact bytes itself
 * and treats them as the comparison value. Without `force` the unreadable
 * record is refused with the reason and the recovery command; with `force`
 * those bytes are renamed to a unique backup exactly like a parsed record,
 * never unlinked. A file left by a crash is therefore recoverable through the
 * tool instead of a manual deletion.
 *
 * @param {{ dir: string, commitLock?: string }} paths
 * @param {{ force?: boolean, now?: number | (() => number), expectedRaw?: string }} [options]
 * @returns {Promise<{ held: boolean, cleared: boolean, pid: number | null, alive: boolean | null, backup: string | null, forced: boolean, unreadable?: boolean }>}
 */
export async function clearStateCommitLock(paths, options = {}) {
  const lockPath = store.commitLockPath(paths)
  const force = options.force === true
  const inspected = await readLock(lockPath, options)
  const failure = 'error' in inspected ? inspected.error : null
  // readLock drops the raw text when it cannot parse a record; for a torn write
  // those bytes are both the audit trail and the only comparison value.
  const raw =
    typeof inspected.raw === 'string'
      ? inspected.raw
      : failure
        ? await fsp.readFile(lockPath, 'utf8').catch(() => null)
        : null
  if (failure && !force) {
    throw new TowerToolError(
      'state-locked',
      `refusing to recover ${lockPath}: the commit mutex exists but could not be read (${failure})`,
      {
        retryable: false,
        nextAction: `confirm no Tower writer is active, then run tower_recover clear-stale-lock force:true with confirm:"CLEAR_STALE_LOCK"; the unreadable record is renamed to an auditable backup, never deleted`,
        details: { reason: 'state-commit-lock-unreadable', lockPath, error: failure, forced: false },
      },
    )
  }
  if (!failure && !inspected.record) {
    return { held: false, cleared: false, pid: null, alive: null, backup: null, forced: force }
  }
  if (!failure && typeof options.expectedRaw === 'string' && inspected.raw !== options.expectedRaw) {
    throw new TowerToolError(
      'state-locked',
      `refusing to recover ${lockPath}: the record changed while the recovery was deciding; no file was moved`,
      {
        retryable: true,
        nextAction: 'run tower_recover with action:"status" again before retrying the clear',
        details: { reason: 'state-commit-lock-changed', lockPath },
      },
    )
  }
  if (!failure && inspected.alive !== false && !force) {
    const timing = inspected.timing ?? lockTiming(inspected.record, options)
    throw new TowerToolError(
      'state-locked',
      `the state commit mutex at ${lockPath} is still held by pid ${inspected.record.pid ?? 'unknown'} (token ${inspected.record.token ?? 'missing'}, held for ${timing.ageMs ?? 'unknown'}ms); a live holder is never reclaimed automatically, because it may be between the last document check and its rename; confirm no Tower writer is active, then pass force:true with confirm:"CLEAR_STALE_LOCK" to move the record to a backup`,
      {
        retryable: false,
        nextAction:
          'retry after the in-flight commit finishes; if the process is gone or stopped, run tower_recover clear-stale-lock force:true with confirm:"CLEAR_STALE_LOCK"',
        details: {
          reason: 'state-commit-lock-live',
          lockPath,
          holderPid: inspected.record.pid ?? null,
          holderToken: inspected.record.token ?? null,
          heldMs: timing.ageMs ?? null,
        },
      },
    )
  }
  // Always rename, never unlink: the record stays auditable. The plain rename
  // is used for the same reason as tools/recover.js: renameWithRetry has
  // temp-file semantics and would delete the bytes on a terminal failure. A
  // bare timestamp collides for two recoveries in the same millisecond (rename
  // replaces on POSIX and fails on Windows), so the monotonically increasing
  // process clock is appended: the name stays numeric, and two calls in one
  // millisecond cannot produce the same name.
  const tick = process.hrtime.bigint()
  const backup = `${lockPath}.recovered-${Date.now()}${tick}`
  try {
    await fsp.rename(lockPath, backup)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // The holder released (or another recovery moved) the record between the
      // read above and the rename. Nothing is left to clear; do not invent a
      // backup file.
      return {
        held: false,
        cleared: false,
        pid: inspected.record?.pid ?? null,
        alive: inspected.alive,
        backup: null,
        forced: force,
        ...(failure ? { unreadable: true } : {}),
      }
    }
    throw new TowerToolError(
      'state-locked',
      `refusing to recover ${lockPath}: the record could not be moved to ${backup} (${error?.message ?? error})`,
      {
        retryable: true,
        nextAction: `inspect ${lockPath} and ${backup}, then retry tower_recover`,
        details: { reason: 'state-commit-lock-move-failed', lockPath, backup, error: String(error?.message ?? error) },
      },
    )
  }
  // Verify the rename moved the bytes inspected above. A read failure after the
  // rename must not lose the backup path: for an unreadable record the move is
  // the whole repair, and for a readable one the operator gets an error naming
  // the backup instead of an unlabelled fs error.
  const movedRaw = await fsp.readFile(backup, 'utf8').catch(() => null)
  if (raw !== null && movedRaw !== null && movedRaw !== raw) {
    // Detect a record that replaced the one we inspected between the read and
    // the rename: put the newer bytes back with an exclusive create (EEXIST
    // means yet another writer owns the path) and leave them auditable either
    // way.
    let restored = false
    try {
      await fsp.copyFile(backup, lockPath, fs.constants.COPYFILE_EXCL)
      restored = true
      await fsp.unlink(backup)
    } catch {}
    throw new TowerToolError(
      'state-locked',
      `refusing to recover ${lockPath}: the record changed while it was being moved; ${
        restored ? 'the newer record was restored' : `the moved bytes are preserved at ${backup}`
      }`,
      {
        retryable: true,
        nextAction: 'run tower_recover with action:"status" and retry; a live writer must not lose its mutex',
        details: { reason: 'state-commit-lock-changed', lockPath, backup: restored ? null : backup },
      },
    )
  }
  if (failure) {
    return {
      held: true,
      cleared: true,
      pid: null,
      alive: null,
      backup,
      forced: force,
      unreadable: true,
    }
  }
  if (movedRaw === null) {
    throw new TowerToolError(
      'state-locked',
      `the commit mutex was moved to ${backup}, but its bytes could not be read back to verify the move; the record is preserved there`,
      {
        retryable: false,
        nextAction: `inspect ${backup} (the moved record); the mutex path is free, so a state write may proceed — do not delete the backup`,
        details: { reason: 'state-commit-lock-verify-failed', lockPath, backup },
      },
    )
  }
  return {
    held: true,
    cleared: true,
    pid: inspected.record?.pid ?? null,
    alive: inspected.alive,
    backup,
    forced: force,
  }
}

/**
 * Build the filesystem store port (#69).
 *
 * The object is assembled once by the composition root (index.js /
 * adapters/default.js) and injected into the app layer, so the app depends on
 * the port contract and an in-memory implementation can replace it wholesale.
 */
export function createStorePort() {
  return Object.freeze({
    ...store,
    // Optional StorePort capability (#F71): the fs adapter owns the recovery
    // rename, while the read-only inspector comes with `...store`.
    clearStateCommitLock,
    // fs.Stats satisfies the StorePort stat result ({ mtimeMs, isDirectory() },
    // plus an optional size app/git-locks.js compares when present), so the
    // directory probe in app/tower.js reads a declared capability instead of
    // duck-typing an undeclared method (#F70).
    stat: (file) => fsp.stat(file),
    unlink: (file) => fsp.unlink(file),
    readText: (file) => fsp.readFile(file, 'utf8'),
    writeText: (file, text) => fsp.writeFile(file, text, 'utf8'),
    appendText: (file, text) => fsp.appendFile(file, text, 'utf8'),
    rename: (from, to) => fsp.rename(from, to),
    // O_EXCL-style copy. This is the compare-and-swap a quarantine restore
    // needs: POSIX `rename` and Windows MoveFileExW(REPLACE_EXISTING) replace a
    // destination created after an `exists()` check, while COPYFILE_EXCL
    // reports EEXIST and leaves both records intact. The caller keeps the
    // quarantined bytes on EEXIST instead of overwriting the newer lock.
    copyFileExclusive: (from, to) => fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL),
    // Optional StorePort directory capabilities (#214). `readdir` returns bare
    // names; `fs.Stats`/dirent details stay in the app layer's decision logic.
    // `rmdir` is the non-recursive primitive on purpose: a non-empty directory
    // fails with ENOTEMPTY/EEXIST, which the sweep reads as "keep", so a shell
    // that gained a file after the inspection is never deleted.
    readdir: (dir) => fsp.readdir(dir),
    rmdir: (dir) => fsp.rmdir(dir),
  })
}
