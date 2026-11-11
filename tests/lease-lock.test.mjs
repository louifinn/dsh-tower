// #167: the lease writer lock and the state lock are separate files that share
// one kernel. Holding one must never block or free the other, and a dead lease
// writer is reclaimed while a live one is reported.
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
import { pathsFor, withLock } from '../adapters/store.js'

const DEAD_PID = 999999
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tempCommonDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-lease-lock-'))
  const commonDir = path.join(root, '.git')
  fs.mkdirSync(commonDir)
  return { root, commonDir }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(5)
  }
  return false
}

test('lease lock and state lock are independent: holding one does not block the other', async () => {
  const { root, commonDir } = tempCommonDir()
  const paths = pathsFor(commonDir)
  fs.mkdirSync(paths.dir, { recursive: true })
  let releaseHolder
  const gate = new Promise((resolve) => {
    releaseHolder = resolve
  })
  try {
    const holdingState = withLock(paths, () => gate, { heartbeatMs: 1000 })
    assert.ok(await waitFor(() => fs.existsSync(paths.lock)), 'state lock is held')
    assert.equal(fs.existsSync(leasesLockPath(commonDir)), false)

    // The lease writer lock is a different file; the state lock must not block it.
    const lease = await acquireLease(commonDir, {
      name: 'plugin-load',
      holder: 'a',
      token: 'lease-token',
      pid: process.pid,
      ttlMs: 1000,
    })
    assert.equal(lease.name, 'plugin-load')
    const inspected = await inspectLeases(commonDir)
    assert.equal(inspected.count, 1)
    assert.equal(await releaseLease(commonDir, { name: 'plugin-load', token: 'lease-token' }), true)

    // Finish the state-lock section before testing the opposite direction.
    releaseHolder()
    await holdingState
    assert.equal(fs.existsSync(paths.lock), false)

    // A live lease writer lock does not block the state lock.
    fs.writeFileSync(
      leasesLockPath(commonDir),
      JSON.stringify({ token: 'live-lease-writer', pid: process.pid, at: Date.now() - 60_000, since: Date.now() - 60_000 }),
    )
    assert.equal(await withLock(paths, async () => 'state-ok', { timeoutMs: 500 }), 'state-ok')
    assert.equal(fs.existsSync(paths.lock), false)
    fs.unlinkSync(leasesLockPath(commonDir))
  } finally {
    releaseHolder?.()
    removeTemp(root)
  }
})

test('a lease writer lock left by a dead PID is reclaimed; the ledger stays intact', async () => {
  const { root, commonDir } = tempCommonDir()
  try {
    fs.mkdirSync(path.dirname(leasesPath(commonDir)), { recursive: true })
    fs.writeFileSync(
      leasesPath(commonDir),
      JSON.stringify({ schemaVersion: 1, updatedAt: 1, leases: {} }),
    )
    fs.writeFileSync(
      leasesLockPath(commonDir),
      JSON.stringify({ token: 'dead-writer', pid: DEAD_PID, at: Date.now() - 60_000, since: Date.now() - 60_000 }),
    )
    const lease = await acquireLease(commonDir, {
      name: 'heavy-ci',
      holder: 'b',
      token: 'lease-token-b',
      pid: process.pid,
      ttlMs: 1000,
    })
    assert.equal(lease.name, 'heavy-ci')
    assert.equal(fs.existsSync(leasesLockPath(commonDir)), false)
    const disk = JSON.parse(fs.readFileSync(leasesPath(commonDir), 'utf8'))
    assert.equal(disk.leases['heavy-ci'].holder, 'b')
    assert.equal(disk.leases['heavy-ci'].token, 'lease-token-b')
  } finally {
    removeTemp(root)
  }
})
