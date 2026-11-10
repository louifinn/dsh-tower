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
  releaseLock,
  removeLockIfMatches,
} from '../adapters/lock.js'
import { pathsFor, withLock } from '../adapters/store.js'

const DEAD_PID = 999999

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
