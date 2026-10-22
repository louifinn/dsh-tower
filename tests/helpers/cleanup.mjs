// Shared teardown for tests that create a real repository under os.tmpdir() (#91).
//
// `fs.rmSync(root, { recursive: true, force: true })` is not deterministic on
// Windows: Defender, the search indexer, or a Git child that has just exited can
// still hold a handle inside the tree, and the delete fails with EPERM/EBUSY.
// Linux unlinks open files without complaint, which is why CI never saw it.
//
// This module removes a test tree with bounded backoff, and after the first
// transient failure renames it to a fresh sibling first, so a later attempt is
// not deleting a path another actor still resolves. The target must be a strict
// child of os.tmpdir(): this is the only test-side place allowed to delete a
// directory, so a typo cannot remove a checkout.
//
// `remove`, `rename` and `sleep` are injectable so the retry and quarantine
// paths can be seeded on every OS (tests/cleanup.test.mjs); callers omit them.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Total attempts, not retries. The backoff is 25, 50, ... capped at 500 ms, so
// the worst case is about seven seconds before a genuinely stuck tree is
// reported. A healthy tree pays none of it.
export const CLEANUP_ATTEMPTS = 24
export const TRANSIENT_CLEANUP_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES'])
const MAX_DELAY_MS = 500

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // best effort; a busy loop would be worse
  }
}

function backoff(attempt) {
  return Math.min(25 * attempt, MAX_DELAY_MS)
}

/** The raw recursive delete, exported so a seeded fixture can wrap it. */
export function removeOnce(target) {
  fs.rmSync(target, { recursive: true, force: true })
}

/**
 * Resolve `target` and prove it is a strict child of `options.tmpRoot`
 * (defaults to os.tmpdir()). Throws before any deletion happens.
 */
export function assertTempPath(target, options = {}) {
  if (typeof target !== 'string' || target.length === 0) {
    throw new TypeError('cleanup target must be a non-empty path string')
  }
  const canonical = (value) => {
    const resolvedPath = path.resolve(value)
    try {
      return fs.realpathSync.native(resolvedPath)
    } catch {
      return resolvedPath
    }
  }
  const tmpRoot = canonical(options.tmpRoot ?? os.tmpdir())
  const resolved = canonical(target)
  const relative = path.relative(tmpRoot, resolved)
  if (
    resolved === tmpRoot ||
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`refusing to remove ${resolved}: not inside the temp directory ${tmpRoot}`)
  }
  return resolved
}

/**
 * Remove a test-owned file or tree synchronously.
 *
 * Non-transient errors (a bug, a wrong path, a permission that will not clear)
 * fail on the first attempt. Transient errors retry with linear backoff; after
 * the first one the target is renamed to a sibling quarantine and the loop
 * continues there on the same budget. The final error names the original path
 * and keeps the underlying errno as its `cause`.
 */
export function removeTemp(target, options = {}) {
  const resolved = assertTempPath(target, options)
  const remove = options.remove ?? removeOnce
  const rename = options.rename ?? fs.renameSync
  const wait = options.sleep ?? sleepSync
  const attempts = options.attempts ?? CLEANUP_ATTEMPTS
  const moveOutOfTheWay = options.renameOutOfTheWay !== false
  let current = resolved
  let quarantined = false

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      remove(current)
      return
    } catch (error) {
      if (!TRANSIENT_CLEANUP_ERRORS.has(error?.code) || attempt === attempts) {
        const failure = new Error(
          `cleanup could not remove ${resolved} after ${attempt} attempt(s): ${error?.code ?? error?.message ?? error}`,
          { cause: error },
        )
        throw failure
      }
      if (!quarantined && moveOutOfTheWay) {
        const quarantine = `${resolved}.cleanup-${process.pid}-${crypto.randomUUID()}`
        try {
          rename(resolved, quarantine)
          current = quarantine
          quarantined = true
        } catch {
          // A handle on the directory itself can block the rename; keep
          // retrying in place instead of spending the budget on the move.
        }
      }
      wait(backoff(attempt))
    }
  }
}
