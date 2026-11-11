// Repo-scoped leases: acquire/conflict/renew/release/token/expiry/force,
// corrupt-ledger and stale-lock handling. Offline, temp dirs only.
// Run with: node --test tests/leases.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import {
  acquireLease,
  inspectLeases,
  leasesLockPath,
  leasesPath,
  releaseLease,
} from '../adapters/leases.js'

function tempCommonDir(prefix = 'dsh-tower-leases-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const commonDir = path.join(root, '.git')
  fs.mkdirSync(commonDir, { recursive: true })
  return { root, commonDir }
}

function readLedger(commonDir) {
  return JSON.parse(fs.readFileSync(leasesPath(commonDir), 'utf8'))
}

function expectCode(code, pattern) {
  return (error) => {
    assert.equal(error.code, code, error.message)
    if (pattern) assert.match(error.message, pattern)
    return true
  }
}

test('leases: acquire writes the repo ledger and inspect reports holder/token/pid', async () => {
  const { root, commonDir } = tempCommonDir()
  try {
    assert.equal(leasesPath(commonDir), path.join(commonDir, 'dsh-tower', 'leases.json'))
    assert.equal(leasesLockPath(commonDir), `${leasesPath(commonDir)}.lock`)

    const empty = await inspectLeases(commonDir, { now: 1000 })
    assert.equal(empty.count, 0)
    assert.deepEqual(empty.leases, [])
    assert.equal(fs.existsSync(leasesPath(commonDir)), false, 'inspect must not create the ledger')

    const lease = await acquireLease(commonDir, {
      name: 'plugin-load',
      holder: 'claude',
      token: 'token-1',
      pid: 4242,
      ttlMs: 60_000,
      now: 1000,
    })
    assert.equal(lease.name, 'plugin-load')
    assert.equal(lease.holder, 'claude')
    assert.equal(lease.token, 'token-1')
    assert.equal(lease.pid, 4242)
    assert.equal(lease.createdAt, 1000)
    assert.equal(lease.expiresAt, 61_000)
    assert.equal(lease.renewed, false)

    const ledger = readLedger(commonDir)
    assert.equal(ledger.schemaVersion, 1)
    assert.deepEqual(ledger.leases['plugin-load'], {
      name: 'plugin-load',
      holder: 'claude',
      token: 'token-1',
      pid: 4242,
      createdAt: 1000,
      expiresAt: 61_000,
    })
    assert.equal(fs.existsSync(leasesLockPath(commonDir)), false, 'the writer lock must be released')

    const inspected = await inspectLeases(commonDir, { now: 2000 })
    assert.equal(inspected.count, 1)
    assert.equal(inspected.path, leasesPath(commonDir))
    assert.deepEqual(inspected.leases, [
      {
        name: 'plugin-load',
        holder: 'claude',
        token: 'token-1',
        pid: 4242,
        createdAt: 1000,
        expiresAt: 61_000,
        expired: false,
      },
    ])
  } finally {
    removeTemp(root)
  }
})

test('leases: a live lease is refused, the same token renews, another holder is a token error', async () => {
  const { root, commonDir } = tempCommonDir()
  try {
    await acquireLease(commonDir, { name: 'heavy-ci', holder: 'a', token: 'token-a', pid: 1, ttlMs: 10_000, now: 1000 })

    // Different token: busy, never taken over.
    await assert.rejects(
      () => acquireLease(commonDir, { name: 'heavy-ci', holder: 'b', token: 'token-b', pid: 2, ttlMs: 10_000, now: 2000 }),
      expectCode('lease-busy', /held by a \(pid 1\)/),
    )
    assert.equal(readLedger(commonDir).leases['heavy-ci'].token, 'token-a')

    // Same token + holder: idempotent renewal (createdAt stays, expiry moves).
    const renewed = await acquireLease(commonDir, {
      name: 'heavy-ci',
      holder: 'a',
      token: 'token-a',
      pid: 1,
      ttlMs: 10_000,
      now: 5000,
    })
    assert.equal(renewed.renewed, true)
    assert.equal(renewed.createdAt, 1000)
    assert.equal(renewed.expiresAt, 15_000)

    // Same token, different holder: token proves the holder identity.
    await assert.rejects(
      () => acquireLease(commonDir, { name: 'heavy-ci', holder: 'b', token: 'token-a', pid: 2, ttlMs: 10_000, now: 6000 }),
      expectCode('lease-token', /belongs to holder "a"/),
    )

    // Expired but not yet released: still refused, never silently taken over.
    await assert.rejects(
      () => acquireLease(commonDir, { name: 'heavy-ci', holder: 'b', token: 'token-b', pid: 2, ttlMs: 10_000, now: 20_000 }),
      expectCode('lease-busy', /expired at .*not taken over automatically/),
    )
    assert.equal(readLedger(commonDir).leases['heavy-ci'].token, 'token-a')
  } finally {
    removeTemp(root)
  }
})

test('leases: a live lease needs its token; an expired lease is recoverable only with force', async () => {
  const { root, commonDir } = tempCommonDir()
  try {
    await acquireLease(commonDir, { name: 'plugin-load', holder: 'a', token: 'token-a', pid: 1, ttlMs: 1000, now: 1000 })

    // Live lease: a foreign token is refused even with force. Force is crash
    // recovery for an expired lease, never an ownership bypass.
    await assert.rejects(
      () => releaseLease(commonDir, { name: 'plugin-load', token: 'token-b', force: true, now: 1500 }),
      expectCode('lease-token', /live lease can only be released by its holder/),
    )
    assert.equal(readLedger(commonDir).leases['plugin-load'].token, 'token-a')

    // Unknown name with a valid token is a harmless no-op.
    assert.equal(await releaseLease(commonDir, { name: 'other', token: 'token-a', now: 2000 }), false)

    // Expired lease, foreign token, no force: refused with the recovery remedy.
    await assert.rejects(
      () => releaseLease(commonDir, { name: 'plugin-load', token: 'token-b', now: 5000 }),
      expectCode('lease-token', /pass force: true to take over the expired lease/),
    )
    // Expired lease, matching token, no force: still the explicit busy contract.
    await assert.rejects(
      () => releaseLease(commonDir, { name: 'plugin-load', token: 'token-a', now: 5000 }),
      expectCode('lease-busy', /expired at .*force: true/),
    )
    // Crashed holder recovery: an expired lease can be force-released by the tower
    // with a foreign token, and the ledger is clean afterwards.
    assert.equal(await releaseLease(commonDir, { name: 'plugin-load', token: 'token-b', force: true, now: 5000 }), true)
    assert.deepEqual(readLedger(commonDir).leases, {})
    assert.equal(await releaseLease(commonDir, { name: 'plugin-load', token: 'token-a', force: true, now: 6000 }), false)

    const inspected = await inspectLeases(commonDir, { now: 6000 })
    assert.equal(inspected.count, 0)
  } finally {
    removeTemp(root)
  }
})

test('leases: concurrent acquires of one name serialize to exactly one winner', async () => {
  const { root, commonDir } = tempCommonDir()
  try {
    const results = await Promise.allSettled([
      acquireLease(commonDir, { name: 'plugin-load', holder: 'a', token: 'token-a', pid: 1, ttlMs: 60_000 }),
      acquireLease(commonDir, { name: 'plugin-load', holder: 'b', token: 'token-b', pid: 2, ttlMs: 60_000 }),
    ])
    const fulfilled = results.filter((entry) => entry.status === 'fulfilled')
    const rejected = results.filter((entry) => entry.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].reason.code, 'lease-busy')
    const winners = await inspectLeases(commonDir)
    assert.equal(winners.count, 1)
    assert.equal(winners.leases[0].token, fulfilled[0].value.token)
    assert.equal(fs.existsSync(leasesLockPath(commonDir)), false)
  } finally {
    removeTemp(root)
  }
})

test('leases: corrupt ledger fails closed, a live stale writer lock is reported, a dead one is reclaimed', async () => {
  const { root, commonDir } = tempCommonDir()
  try {
    fs.mkdirSync(path.dirname(leasesPath(commonDir)), { recursive: true })
    fs.writeFileSync(leasesPath(commonDir), 'not json at all')
    await assert.rejects(() => inspectLeases(commonDir), expectCode('state-corrupt', /corrupt tower leases/))
    await assert.rejects(
      () => acquireLease(commonDir, { name: 'plugin-load', holder: 'a', token: 'token-a', pid: 1, ttlMs: 1000 }),
      expectCode('state-corrupt', /corrupt tower leases/),
    )
    assert.equal(fs.readFileSync(leasesPath(commonDir), 'utf8'), 'not json at all', 'a corrupt ledger must not be rewritten')

    // A malformed lease entry is corruption too.
    fs.writeFileSync(
      leasesPath(commonDir),
      JSON.stringify({ schemaVersion: 1, leases: { broken: { name: 'broken' } } }),
    )
    await assert.rejects(() => inspectLeases(commonDir), expectCode('state-corrupt', /corrupt lease entry "broken"/))

    // A valid ledger with a live writer whose `at` is old: the waiter reports it
    // and never unlinks the record on a timer.
    fs.writeFileSync(leasesPath(commonDir), JSON.stringify({ schemaVersion: 1, updatedAt: 1, leases: {} }))
    const liveLock = JSON.stringify({ token: 'old', pid: process.pid, at: Date.now() - 60_000 })
    fs.writeFileSync(leasesLockPath(commonDir), liveLock)
    await assert.rejects(
      () => acquireLease(commonDir, { name: 'plugin-load', holder: 'a', token: 'token-a', pid: 1, ttlMs: 1000 }),
      (error) => {
        assert.equal(error.code, 'lease-busy', error.message)
        assert.match(error.message, /last heartbeat/)
        assert.match(error.message, /not reclaimed/)
        return true
      },
    )
    assert.equal(fs.readFileSync(leasesLockPath(commonDir), 'utf8'), liveLock, 'a live lock must stay byte-identical')

    // A provably dead writer is reclaimed by the shared kernel.
    fs.writeFileSync(leasesLockPath(commonDir), JSON.stringify({ token: 'old', pid: 999999, at: Date.now() - 60_000 }))
    const lease = await acquireLease(commonDir, { name: 'plugin-load', holder: 'a', token: 'token-a', pid: 1, ttlMs: 1000 })
    assert.equal(lease.name, 'plugin-load')
    assert.equal(fs.existsSync(leasesLockPath(commonDir)), false)
  } finally {
    removeTemp(root)
  }
})

test('leases: invalid arguments are rejected before any write', async () => {
  const { root, commonDir } = tempCommonDir()
  try {
    assert.throws(() => leasesPath('relative/.git'), expectCode('invalid-argument', /absolute path/))
    await assert.rejects(
      () => acquireLease(commonDir, { name: '../escape', holder: 'a', token: 't', pid: 1, ttlMs: 1000 }),
      expectCode('invalid-argument', /lease name must match/),
    )
    await assert.rejects(
      () => acquireLease(commonDir, { name: 'ok', holder: '', token: 't', pid: 1, ttlMs: 1000 }),
      expectCode('invalid-argument', /holder is required/),
    )
    await assert.rejects(
      () => acquireLease(commonDir, { name: 'ok', holder: 'a', token: 't', pid: 1, ttlMs: 0 }),
      expectCode('invalid-argument', /ttlMs must be a positive integer/),
    )
    await assert.rejects(
      () => acquireLease(commonDir, { name: 'ok', holder: 'a', token: 't', pid: -1, ttlMs: 1000 }),
      expectCode('invalid-argument', /pid must be a positive integer/),
    )
    await assert.rejects(
      () => releaseLease(commonDir, { name: 'ok' }),
      expectCode('invalid-argument', /token is required/),
    )
    assert.equal(fs.existsSync(leasesPath(commonDir)), false)
  } finally {
    removeTemp(root)
  }
})
