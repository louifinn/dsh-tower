// #167: the shared lock kernel must never steal a live holder. A stale
// heartbeat is diagnostic; only a provably dead PID is reclaimed, and every
// release is a token + byte CAS so a late release cannot unlink a newer record.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { fsp } from '../adapters/store-fs.js'
import {
  acquireLock,
  acquireLockSync,
  createLockFile,
  createLockFileSync,
  LOCK_CREATE_ATTEMPTS,
  LOCK_CREATE_BUDGET_MS,
  LOCK_CREATE_DELAYS,
  LOCK_CREATE_TRANSIENT_ERRORS,
  lockLiveness,
  lockRecord,
  readLock,
  reclaimDeadLock,
  reclaimDeadLockSync,
  releaseLock,
  removeLockIfMatches,
  removeLockIfMatchesSync,
  touchLock,
} from '../adapters/lock.js'
import { pathsFor, withLock } from '../adapters/store.js'

const DEAD_PID = 999999

/** Poll a predicate that flips when an injected heartbeat finishes. */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return true
}

function deadRecord(token) {
  const at = Date.now() - 60_000
  return JSON.stringify({ token, pid: DEAD_PID, startedAt: at, since: at, at })
}

function quarantines(paths, prefix) {
  return fs
    .readdirSync(paths.dir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(paths.dir, name))
}

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-lock-kernel-'))
  const paths = pathsFor(path.join(root, '.git'))
  fs.mkdirSync(paths.dir, { recursive: true })
  return { root, paths }
}

test('lock kernel: a stalled live holder makes the waiter fail, a dead holder is reclaimed', async () => {
  const { root, paths } = tempPaths()
  try {
    const original = JSON.stringify({
      token: 'live-holder',
      pid: process.pid,
      startedAt: Date.now() - 60_000,
      since: Date.now() - 60_000,
      at: Date.now() - 10_000,
    })
    fs.writeFileSync(paths.lock, original)

    let ran = false
    await assert.rejects(
      () =>
        withLock(
          paths,
          async () => {
            ran = true
          },
          { timeoutMs: 120, pollMs: 10, heartbeatMs: 1000 },
        ),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.retryable, true)
        assert.equal(error.details.holderPid, process.pid)
        assert.equal(error.details.holderToken, 'live-holder')
        assert.ok(error.details.heartbeatAgeMs >= 9000)
        assert.ok(error.details.staleAfterMs > 0)
        assert.match(error.message, /tower_recover clear-stale-lock/)
        return true
      },
    )
    assert.equal(ran, false, 'the critical section must not run')
    assert.equal(fs.readFileSync(paths.lock, 'utf8'), original, 'the live record stays byte-identical')
    assert.equal(lockLiveness(JSON.parse(original)).dead, false)

    // Same record with a provably dead PID: the kernel reclaims it.
    fs.writeFileSync(paths.lock, JSON.stringify({ ...JSON.parse(original), pid: DEAD_PID }))
    const value = await withLock(paths, async () => 'ran', { timeoutMs: 500 })
    assert.equal(value, 'ran')
    assert.equal(fs.existsSync(paths.lock), false, 'the dead record is reclaimed and then released')
  } finally {
    removeTemp(root)
  }
})

test('lock kernel: release is a token CAS and never unlinks a newer record', async () => {
  const { root, paths } = tempPaths()
  try {
    const token = 'token-a'
    const held = await acquireLock(paths.lock, { token, heartbeat: false, timeoutMs: 0 })
    assert.ok(held)
    assert.equal(held.token, token)
    assert.equal(await releaseLock(paths.lock, 'token-b'), false)
    assert.equal(fs.existsSync(paths.lock), true, 'a wrong token must not remove the record')

    // Simulate a new owner replacing the record while the old holder is still
    // on its way to release: the quarantine comparison restores the newer bytes.
    const staleRaw = fs.readFileSync(paths.lock, 'utf8')
    const newer = JSON.stringify(lockRecord('token-b', { marker: 'newer' }))
    fs.writeFileSync(paths.lock, newer)
    assert.equal(await removeLockIfMatches(paths.lock, token, staleRaw), false)
    assert.equal(fs.readFileSync(paths.lock, 'utf8'), newer, 'the newer record must be restored')
    assert.equal(fs.existsSync(paths.lock), true)

    // The legitimate owner can still release its own current record.
    const current = JSON.parse(fs.readFileSync(paths.lock, 'utf8'))
    assert.equal(await releaseLock(paths.lock, current.token), true)
    assert.equal(fs.existsSync(paths.lock), false)
  } finally {
    removeTemp(root)
  }
})

test('lock kernel: an acquire/release race leaves the winner owning the lock', async () => {
  const { root, paths } = tempPaths()
  try {
    // The old release reads the record, then a new owner replaces it before the
    // CAS rename. `removeLockIfMatches` compares bytes, so the release loses.
    const token = 'old-holder'
    await acquireLock(paths.lock, { token, heartbeat: false, timeoutMs: 0 })
    const readRaw = fs.readFileSync(paths.lock, 'utf8')
    const winner = JSON.stringify(lockRecord('new-holder', { marker: 'winner' }))
    fs.writeFileSync(paths.lock, winner)
    assert.equal(await removeLockIfMatches(paths.lock, token, readRaw), false)
    assert.equal(JSON.parse(fs.readFileSync(paths.lock, 'utf8')).token, 'new-holder')
    assert.equal(await releaseLock(paths.lock, token), false)
    assert.equal(JSON.parse(fs.readFileSync(paths.lock, 'utf8')).token, 'new-holder')
  } finally {
    removeTemp(root)
  }
})

test('lock kernel: a corrupt lock fails closed and is never deleted', async () => {
  const { root, paths } = tempPaths()
  try {
    fs.writeFileSync(paths.lock, 'not json at all')
    await assert.rejects(
      () => withLock(paths, async () => 'never', { timeoutMs: 120, pollMs: 10 }),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.match(error.message, /unreadable/)
        return true
      },
    )
    assert.equal(fs.readFileSync(paths.lock, 'utf8'), 'not json at all')
    const inspected = await readLock(paths.lock)
    assert.equal(inspected.record, null)
    assert.ok(inspected.error)
  } finally {
    removeTemp(root)
  }
})

test('lock kernel: release and acquire agree on the token that owns the file', async () => {
  const { root, paths } = tempPaths()
  try {
    const first = await acquireLock(paths.lock, { token: 'first', heartbeat: false, timeoutMs: 0 })
    assert.ok(first)
    const second = await acquireLock(paths.lock, { token: 'second', heartbeat: false, timeoutMs: 50, pollMs: 5 })
    assert.equal(second, null, 'a live owner blocks a second acquisition')
    assert.equal(JSON.parse(fs.readFileSync(paths.lock, 'utf8')).token, 'first')

    assert.equal(await first.release(), true)
    assert.equal(fs.existsSync(paths.lock), false)
    const secondTry = await acquireLock(paths.lock, { token: 'second', heartbeat: false, timeoutMs: 0 })
    assert.ok(secondTry)
    assert.equal(await secondTry.release(), true)
    assert.equal(await fsp.readFile(paths.lock, 'utf8').catch(() => null), null)
  } finally {
    removeTemp(root)
  }
})

// #167 R63 P2-1: the restore of a quarantined record is an exclusive-create
// CAS, not an overwriting rename. B reads a dead record, A replaces it with a
// live one, and a third waiter wins the free path while B holds the bytes in
// quarantine. B must keep C's record, preserve the moved bytes for audit, and
// fail closed instead of reporting a clean loss and entering the critical
// section.
test('lock kernel: a three-waiter reclaim never clobbers the record that won the free path', async () => {
  const { root, paths } = tempPaths()
  try {
    fs.writeFileSync(paths.lock, deadRecord('dead-holder'))
    const successor = JSON.stringify(lockRecord('a-holder', { marker: 'reclaimed-by-a' }))
    const third = JSON.stringify(lockRecord('c-holder', { marker: 'third-waiter' }))
    let moves = 0
    await assert.rejects(
      () =>
        reclaimDeadLock(paths.lock, {
          rename: async (from, to) => {
            moves += 1
            assert.equal(from, paths.lock)
            // A reclaimed the dead record and re-acquired before B's move...
            fs.writeFileSync(from, successor)
            // B now quarantines A's live record; C wins the free lock path.
            await fsp.rename(from, to)
            assert.equal(fs.readFileSync(to, 'utf8'), successor)
            fs.writeFileSync(from, third)
          },
          sleep: async () => {},
        }),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.retryable, false)
        assert.match(error.message, /lock integrity anomaly/)
        assert.match(error.message, /was not overwritten/)
        assert.equal(error.details.reason, 'lock-quarantine')
        assert.equal(error.details.outcome, 'occupied')
        assert.match(error.nextAction, /confirming no other writer is active/)
        return true
      },
    )
    assert.equal(moves, 1)
    assert.equal(fs.readFileSync(paths.lock, 'utf8'), third, 'C keeps the record it created')
    const preserved = quarantines(paths, 'state.lock.stale-')
    assert.equal(preserved.length, 1, 'the moved live record is preserved for audit')
    assert.equal(fs.readFileSync(preserved[0], 'utf8'), successor)
  } finally {
    removeTemp(root)
  }
})

test('lock kernel: a reclaim whose restore cannot complete fails closed', async () => {
  const { root, paths } = tempPaths()
  try {
    fs.writeFileSync(paths.lock, deadRecord('dead-holder'))
    const successor = JSON.stringify(lockRecord('live-successor', { marker: 'swapped-in' }))
    let ran = false
    await assert.rejects(
      () =>
        withLock(paths, async () => {
          ran = true
        }, {
          timeoutMs: 150,
          pollMs: 10,
          heartbeatMs: 1000,
          rename: async (from, to) => {
            fs.writeFileSync(from, successor)
            await fsp.rename(from, to)
          },
          copyFile: async () => {
            const error = new Error('denied by test')
            error.code = 'EPERM'
            throw error
          },
          sleep: async () => {},
        }),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.retryable, false)
        assert.match(error.message, /restoring the quarantined lock record/)
        assert.equal(error.details.outcome, 'failed')
        assert.equal(error.details.error, 'EPERM')
        return true
      },
    )
    assert.equal(ran, false, 'the critical section must not run when the reclaim cannot be completed')
    assert.equal(fs.existsSync(paths.lock), false)
    const preserved = quarantines(paths, 'state.lock.stale-')
    assert.equal(preserved.length, 1, 'the un-restorable live record stays on disk for recovery')
    assert.equal(fs.readFileSync(preserved[0], 'utf8'), successor)
  } finally {
    removeTemp(root)
  }
})

test('lock kernel: a sync reclaim also fails closed instead of clobbering a third waiter', () => {
  const { root, paths } = tempPaths()
  try {
    fs.writeFileSync(paths.lock, deadRecord('dead-holder'))
    const successor = JSON.stringify(lockRecord('a-holder', { marker: 'reclaimed-by-a' }))
    const third = JSON.stringify(lockRecord('c-holder', { marker: 'third-waiter' }))
    assert.throws(
      () =>
        reclaimDeadLockSync(paths.lock, {
          renameSync: (from, to) => {
            fs.writeFileSync(from, successor)
            fs.renameSync(from, to)
            fs.writeFileSync(from, third)
          },
        }),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.retryable, false)
        assert.equal(error.details.outcome, 'occupied')
        return true
      },
    )
    assert.equal(fs.readFileSync(paths.lock, 'utf8'), third)
    const preserved = quarantines(paths, 'state.lock.stale-')
    assert.equal(preserved.length, 1)
    assert.equal(fs.readFileSync(preserved[0], 'utf8'), successor)
  } finally {
    removeTemp(root)
  }
})

test('lock kernel: a release restore never overwrites a record created after the move', async () => {
  const { root, paths } = tempPaths()
  try {
    const token = 'release-holder'
    await acquireLock(paths.lock, { token, heartbeat: false, timeoutMs: 0 })
    const staleRaw = fs.readFileSync(paths.lock, 'utf8')
    const foreign = JSON.stringify(lockRecord('foreign-owner', { marker: 'foreign' }))
    const third = JSON.stringify(lockRecord('c-holder', { marker: 'third-waiter' }))
    fs.writeFileSync(paths.lock, foreign)
    await assert.rejects(
      () =>
        removeLockIfMatches(paths.lock, token, staleRaw, {
          rename: async (from, to) => {
            await fsp.rename(from, to)
            // C wins the path while the foreign record sits in quarantine.
            fs.writeFileSync(from, third)
          },
          sleep: async () => {},
        }),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.retryable, false)
        assert.equal(error.details.reason, 'lock-quarantine')
        assert.equal(error.details.outcome, 'occupied')
        return true
      },
    )
    assert.equal(fs.readFileSync(paths.lock, 'utf8'), third, 'the release must not clobber C')
    const preserved = quarantines(paths, 'state.lock.release-')
    assert.equal(preserved.length, 1, 'the foreign record is preserved for audit')
    assert.equal(fs.readFileSync(preserved[0], 'utf8'), foreign)
  } finally {
    removeTemp(root)
  }
})

test('lock kernel: a sync release restore never overwrites a newer record', () => {
  const { root, paths } = tempPaths()
  try {
    const staleRaw = deadRecord('stale-owner')
    fs.writeFileSync(paths.lock, staleRaw)
    const foreign = JSON.stringify(lockRecord('foreign-owner', { marker: 'foreign' }))
    const third = JSON.stringify(lockRecord('c-holder', { marker: 'third-waiter' }))
    assert.throws(
      () =>
        removeLockIfMatchesSync(paths.lock, 'stale-owner', staleRaw, {
          renameSync: (from, to) => {
            fs.writeFileSync(from, foreign)
            fs.renameSync(from, to)
            fs.writeFileSync(from, third)
          },
        }),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.retryable, false)
        assert.equal(error.details.outcome, 'occupied')
        return true
      },
    )
    assert.equal(fs.readFileSync(paths.lock, 'utf8'), third)
    const preserved = quarantines(paths, 'state.lock.release-')
    assert.equal(preserved.length, 1)
    assert.equal(fs.readFileSync(preserved[0], 'utf8'), foreign)
  } finally {
    removeTemp(root)
  }
})

// #F24: a heartbeat may only publish a record for the token it read. The
// previous kernel checked the token before writing its temp file, but a takeover
// between that read and the rename made the rename recreate the old record over
// the successor's — and the old holder then kept writing state under a record
// that said it still owned the lock.
test('lock kernel: a heartbeat superseded right after its rename reports the loss (#F24)', async () => {
  const { root, paths } = tempPaths()
  try {
    await acquireLock(paths.lock, { token: 'late-holder', heartbeat: false, timeoutMs: 0 })
    const successor = JSON.stringify(lockRecord('successor-holder', { marker: 'successor' }))
    const refreshed = await touchLock(paths.lock, 'late-holder', {
      rename: async (from, to) => {
        await fsp.rename(from, to)
        // A recovery frees the path and a successor acquires it in the instant
        // after this heartbeat's rename landed.
        fs.writeFileSync(paths.lock, successor)
      },
      sleep: async () => {},
    })
    assert.equal(refreshed, false, 'a heartbeat must not claim a record a successor already owns')
    assert.equal(fs.readFileSync(paths.lock, 'utf8'), successor, "the successor's record must survive untouched")
  } finally {
    removeTemp(root)
  }
})

test('lock kernel: a heartbeat never rewrites another token record', async () => {
  const { root, paths } = tempPaths()
  try {
    const foreign = JSON.stringify(lockRecord('other-holder', { marker: 'foreign' }))
    fs.writeFileSync(paths.lock, foreign)
    assert.equal(await touchLock(paths.lock, 'stale-holder'), false)
    assert.equal(fs.readFileSync(paths.lock, 'utf8'), foreign)
    const leftovers = fs.readdirSync(paths.dir).filter((name) => name.includes('.heartbeat-'))
    assert.deepEqual(leftovers, [], 'a refused heartbeat must remove its temp file')
  } finally {
    removeTemp(root)
  }
})

test('lock kernel: a holder whose record is taken away reports the loss on its handle (#F24)', async () => {
  const { root, paths } = tempPaths()
  try {
    let tick = null
    const holder = await acquireLock(paths.lock, {
      token: 'abandoned-holder',
      setInterval: (callback) => {
        tick = callback
        return { unref() {} }
      },
      clearInterval: () => {},
      timeoutMs: 0,
    })
    assert.equal(holder.lost, false)
    // An operator recovery moves the live record aside; a successor acquires it.
    fs.renameSync(paths.lock, `${paths.lock}.recovered-1`)
    fs.writeFileSync(paths.lock, JSON.stringify(lockRecord('successor-holder')))
    tick()
    assert.equal(await waitFor(() => holder.lost === true), true, 'the heartbeat must observe the lost record')
    assert.equal(await holder.release(), false, 'the abandoned holder must not release the successor record')
    assert.equal(JSON.parse(fs.readFileSync(paths.lock, 'utf8')).token, 'successor-holder')
  } finally {
    removeTemp(root)
  }
})

// #F24: the state store must fail a write closed even when the old record is
// back at the path (a late heartbeat won the rename race). The heartbeat health
// flags the loss, and the document CAS backs it up for a silent takeover.
test('lock kernel: a resurrected record cannot publish state after the loss was observed (#F24)', async () => {
  const { root, paths } = tempPaths()
  try {
    const { stateLockLost, writeStateLocked } = await import('../adapters/store.js')
    const committed = JSON.stringify({ revision: 2, marker: 'successor' }, null, 2)
    fs.writeFileSync(paths.state, JSON.stringify({ revision: 1, marker: 'base' }, null, 2))
    let tick = null
    await assert.rejects(
      () =>
        withLock(
          paths,
          async (_paths, held) => {
            const recordRaw = fs.readFileSync(paths.lock, 'utf8')
            fs.renameSync(paths.lock, `${paths.lock}.recovered-1`)
            fs.writeFileSync(paths.lock, JSON.stringify(lockRecord('successor-holder')))
            fs.writeFileSync(paths.state, committed)
            tick()
            assert.equal(await waitFor(() => stateLockLost(paths)), true)
            // The late heartbeat puts the old record back at the lock path.
            fs.writeFileSync(paths.lock, recordRaw)
            await writeStateLocked(paths, { revision: 2, marker: 'first' }, held.token)
          },
          {
            setInterval: (callback) => {
              tick = callback
              return { unref() {} }
            },
            clearInterval: () => {},
          },
        ),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.retryable, true)
        assert.equal(error.details.reason, 'state-lock-ownership-lost')
        return true
      },
    )
    assert.equal(fs.readFileSync(paths.state, 'utf8'), committed, 'the committed update must survive')
  } finally {
    removeTemp(root)
  }
})

// ---------------------------------------------------------------------------
// F10: the exclusive create of a lock record must survive the transient Windows
// sharing errors (antivirus/indexer holds the name for a few milliseconds), and
// must fail loudly and immediately for every other error.
// ---------------------------------------------------------------------------

/** A sharing violation as Windows reports it: EPERM on open, errno -4048. */
function sharingViolation(code = 'EPERM') {
  return Object.assign(new Error(`${code}: operation not permitted, open 'git.lock'`), {
    code,
    errno: -4048,
    syscall: 'open',
  })
}

test('lock kernel: a create retries the transient sharing errors and still takes the lock (#F10)', async () => {
  const { root, paths } = tempPaths()
  try {
    const failures = [sharingViolation('EPERM'), sharingViolation('EBUSY')]
    const waits = []
    let creates = 0
    const create = async (file, payload) => {
      creates += 1
      const failure = failures.shift()
      if (failure) throw failure
      await fsp.writeFile(file, payload, { flag: 'wx' })
    }
    await createLockFile(paths.lock, JSON.stringify(lockRecord('retried')), {
      create,
      sleep: async (ms) => waits.push(ms),
    })
    assert.deepEqual(waits, [LOCK_CREATE_DELAYS[0], LOCK_CREATE_DELAYS[1]])
    assert.equal(JSON.parse(fs.readFileSync(paths.lock, 'utf8')).token, 'retried')
    assert.equal(creates, 3)
  } finally {
    removeTemp(root)
  }
})

test('lock kernel: acquireLock survives the same failures and keeps single-flight semantics (#F10)', async () => {
  const { root, paths } = tempPaths()
  try {
    const waits = []
    let creates = 0
    const create = async (file, payload) => {
      creates += 1
      if (creates <= 2) throw sharingViolation('EACCES')
      await fsp.writeFile(file, payload, { flag: 'wx' })
    }
    const held = await acquireLock(paths.lock, {
      token: 'retry-owner',
      heartbeat: false,
      timeoutMs: 0,
      create,
      createSleep: async (ms) => waits.push(ms),
    })
    assert.ok(held, 'two transient failures must not lose the lock')
    assert.equal(creates, 3)
    assert.deepEqual(waits, [10, 20])
    assert.equal(JSON.parse(fs.readFileSync(paths.lock, 'utf8')).token, 'retry-owner')

    // A retried create is still one exclusive owner: a rival cannot slip in.
    const rival = await acquireLock(paths.lock, { token: 'rival', heartbeat: false, timeoutMs: 0 })
    assert.equal(rival, null)
    assert.equal(creates, 3, 'the retry created exactly one record, on the third attempt')
    assert.equal(await held.release(), true)
    assert.equal(fs.existsSync(paths.lock), false)
  } finally {
    removeTemp(root)
  }
})

test('lock kernel: only EPERM/EBUSY/EACCES are retried, and the retry is bounded (#F10)', async () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    let creates = 0
    const failure = sharingViolation(code)
    await assert.rejects(
      () =>
        createLockFile('unused', 'x', {
          create: async () => {
            creates += 1
            throw failure
          },
          sleep: async () => {},
        }),
      (error) => {
        assert.equal(error, failure, `${code} must surface unchanged`)
        return true
      },
    )
    assert.equal(creates, LOCK_CREATE_ATTEMPTS, `${code} must exhaust the bounded attempts`)
  }

  // Every other code is a real failure: one attempt, no wait, no masking.
  for (const code of ['EEXIST', 'ENOENT', 'EIO', 'EROFS', 'ENOSPC']) {
    const failure = Object.assign(new Error(`${code}: nope`), { code })
    let creates = 0
    let waits = 0
    await assert.rejects(
      () =>
        createLockFile('unused', 'x', {
          create: async () => {
            creates += 1
            throw failure
          },
          sleep: async () => {
            waits += 1
          },
        }),
      (error) => {
        assert.equal(error, failure, `${code} must be rethrown unchanged`)
        return true
      },
    )
    assert.deepEqual([creates, waits], [1, 0], `${code} must fail immediately`)
  }
})

test('lock kernel: an exhausted retry rethrows the last error and respects the time budget (#F10)', async () => {
  const failures = Array.from({ length: LOCK_CREATE_ATTEMPTS + 2 }, (_, index) =>
    Object.assign(new Error(`EPERM: attempt ${index}`), { code: 'EPERM' }),
  )
  const waits = []
  let creates = 0
  await assert.rejects(
    () =>
      createLockFile('unused', 'x', {
        create: async () => {
          creates += 1
          throw failures[creates - 1]
        },
        sleep: async (ms) => waits.push(ms),
      }),
    (error) => {
      assert.equal(error, failures[LOCK_CREATE_ATTEMPTS - 1], 'the last observed error is the one rethrown')
      return true
    },
  )
  assert.equal(creates, LOCK_CREATE_ATTEMPTS)
  const waitedMs = waits.reduce((sum, ms) => sum + ms, 0)
  assert.ok(waitedMs <= LOCK_CREATE_BUDGET_MS, `${waitedMs} ms must fit the ${LOCK_CREATE_BUDGET_MS} ms budget`)
  assert.deepEqual(waits, LOCK_CREATE_DELAYS, 'the backoff must be the published schedule')
  assert.equal(waitedMs, 1270, 'the full retry spends less than the budget, never more')
  assert.equal(LOCK_CREATE_TRANSIENT_ERRORS.size, 3)
})

test('lock kernel: the synchronous create retries the same codes (#F10)', () => {
  const { root, paths } = tempPaths()
  try {
    const failure = sharingViolation('EPERM')
    const waits = []
    let creates = 0
    const outcome = createLockFileSync(paths.lock, JSON.stringify(lockRecord('sync-retried')), {
      createSync: (file, payload) => {
        creates += 1
        if (creates === 1) throw failure
        fs.writeFileSync(file, payload, { flag: 'wx' })
      },
      sleepSync: (ms) => waits.push(ms),
    })
    assert.equal(outcome, undefined, 'the create reports success by returning, not by a result object')
    assert.deepEqual(waits, [LOCK_CREATE_DELAYS[0]])
    assert.equal(JSON.parse(fs.readFileSync(paths.lock, 'utf8')).token, 'sync-retried')

    const held = acquireLockSync(paths.lock, { token: 'sync-owner', timeoutMs: 0 })
    assert.equal(held, null, 'single-flight must still hold after a retried create')
  } finally {
    removeTemp(root)
  }
})

