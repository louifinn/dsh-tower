// #154: explicit, audited Tower ownership transfer.
//
// The decision surface is pure (`ownershipSnapshot`) so every refusal has one
// testable rule; the write path (`transferOwnership`) is exercised against a
// real temporary repository. No test here deletes state or touches the
// operator's profile.
//
// Run with: node --test tests/owner-takeover.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { Tower } from '../host/tower.js'
import { ownershipSnapshot } from '../app/ownership.js'
import { transferOwnership } from '../app/ownership.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-owner-takeover-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo }
}

function stateWith(owner, extra = {}) {
  return {
    schemaVersion: 5,
    revision: 4,
    base: 'main',
    caseInsensitive: null,
    towerAgentId: owner,
    missions: [],
    roster: [],
    messages: [],
    findings: [],
    reviews: [],
    activity: [],
    ...extra,
  }
}

function holder(agentId, sessionId = agentId) {
  return { token: `tok-${agentId}`, sessionId, agentId, pid: process.pid, at: Date.now() }
}

test('ownershipSnapshot: an active owner refuses takeover with owner-live', () => {
  const snapshot = ownershipSnapshot({
    state: stateWith('owner-a'),
    modes: new Map([['owner-a', { on: true }]]),
    caller: 'owner-b',
    lock: { held: true, self: false, stale: false, holder: holder('owner-a') },
  })
  assert.equal(snapshot.takeoverAvailable, false)
  assert.equal(snapshot.blockers[0].code, 'owner-live')
  assert.equal(snapshot.sameOwner, false)
})

test('ownershipSnapshot: an off or stale owner is available and leaves an orphan lock', () => {
  for (const scenario of [
    { modes: new Map([['owner-a', { on: false }]]), lock: { held: false, self: false, stale: false } },
    { modes: new Map([['owner-a', { on: true }]]), lock: { held: true, self: false, stale: true, holder: holder('owner-a') } },
  ]) {
    const snapshot = ownershipSnapshot({
      state: stateWith('owner-a'),
      modes: scenario.modes,
      caller: 'owner-b',
      lock: scenario.lock,
    })
    assert.equal(snapshot.takeoverAvailable, true, JSON.stringify(snapshot.blockers))
    assert.equal(snapshot.blockers.length, 0)
  }
  const orphan = ownershipSnapshot({
    state: stateWith('owner-a'),
    modes: new Map([['owner-a', { on: false }]]),
    caller: 'owner-b',
    lock: { held: true, self: false, stale: false, holder: holder('owner-a') },
  })
  assert.equal(orphan.orphanLock, true)
})

test('ownershipSnapshot: live roster and a foreign workspace lock both block', () => {
  const live = ownershipSnapshot({
    state: stateWith('owner-a'),
    modes: new Map([['owner-a', { on: false }]]),
    caller: 'owner-b',
    lock: { held: false, self: false, stale: false },
    liveRoster: [{ name: 'worker-m1', state: 'running' }],
  })
  assert.equal(live.blockers[0].code, 'owner-busy')
  assert.match(live.blockers[0].detail, /worker-m1/)

  const foreign = ownershipSnapshot({
    state: stateWith('owner-a'),
    modes: new Map([['owner-a', { on: false }]]),
    caller: 'owner-b',
    lock: { held: true, self: false, stale: false, holder: holder('owner-c', 'session-c') },
  })
  assert.equal(foreign.blockers[0].code, 'owner-busy')
  assert.match(foreign.blockers[0].detail, /session-c/)
})

test('transferOwnership: audited transfer, same-owner no-op, and live-owner refusal', async () => {
  const { root, repo } = makeRepo()
  try {
    const tower = await Tower.open(repo)
    const initial = await tower.init({ towerAgentId: 'owner-a' })
    const off = new Map([['owner-a', { on: false }]])

    const transferred = await transferOwnership(tower, {
      caller: 'owner-b',
      reason: 'previous session is gone',
      modes: off,
      lock: { held: false, self: false, stale: false },
    })
    assert.equal(transferred.transferred, true)
    assert.equal(transferred.previousOwner, 'owner-a')
    assert.equal(transferred.owner, 'owner-b')
    assert.equal(transferred.revision, initial.revision + 1)

    const snapshot = await tower.load()
    assert.equal(snapshot.towerAgentId, 'owner-b')
    const status = await tower.status()
    const entry = status.activity.find((line) => line.type === 'takeover')
    assert.ok(entry, JSON.stringify(status.activity))
    assert.equal(entry.text, 'tower owner transferred from owner-a to owner-b: previous session is gone')

    const noop = await transferOwnership(tower, {
      caller: 'owner-b',
      reason: 'again',
      modes: new Map([['owner-b', { on: true }]]),
      lock: { held: false, self: false, stale: false },
    })
    assert.equal(noop.alreadyOwner, true)
    assert.equal(noop.transferred, false)
    assert.equal(noop.revision, transferred.revision)

    await assert.rejects(
      () =>
        transferOwnership(tower, {
          caller: 'owner-c',
          reason: 'should not win',
          modes: new Map([['owner-b', { on: true }]]),
          lock: { held: true, self: false, stale: false, holder: holder('owner-b') },
        }),
      (error) => error.code === 'owner-live',
    )
    const after = await tower.load()
    assert.equal(after.towerAgentId, 'owner-b')
  } finally {
    removeTemp(root)
  }
})
