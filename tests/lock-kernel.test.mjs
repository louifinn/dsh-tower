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
  lockLiveness,
  lockRecord,
  readLock,
  reclaimDeadLock,
  reclaimDeadLockSync,
  releaseLock,
  removeLockIfMatches,
  removeLockIfMatchesSync,
} from '../adapters/lock.js'
import { pathsFor, withLock } from '../adapters/store.js'

const DEAD_PID = 999999

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
