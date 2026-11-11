// W1-D: takeover facts are read only inside the state lock.
//
// The pre-lock snapshot used to authorize a transfer; these tests pin the
// replacement rule: `transferOwnership` obtains modes/lock/roster through a
// `readFacts` callback that runs while the state lock is held, a mode/lock
// change between the approval precheck and the write is refused, a corrupt
// mode store fails closed with `mode-store-corrupt`, and the previous owner's
// orphan workspace lock is released with the token observed under the lock
// (never a blind unlink, never a foreign or newer lock).
//
// Run with: node --test tests/ownership-lock-scope.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { Tower } from '../host/tower.js'
import { readOwnership, performTakeover } from '../host/ownership.js'
import { transferOwnership } from '../app/ownership.js'
import { workspaceLockPath } from '../adapters/workspaceLock.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo(prefix = 'dsh-tower-owner-lock-scope-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  const modeDir = path.join(root, 'mode-store')
  fs.mkdirSync(modeDir, { recursive: true })
  return { root, repo, modeDir }
}

function holder(token, agentId = 'owner-a') {
  return { token, sessionId: agentId, agentId, pid: process.pid, at: Date.now() }
}

function writeWorkspaceLock(commonDir, record) {
  const file = workspaceLockPath(commonDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(record))
  return file
}

function writeModeStore(modeDir, payload) {
  fs.mkdirSync(modeDir, { recursive: true })
  fs.writeFileSync(path.join(modeDir, 'modes.json'), JSON.stringify(payload))
}

async function openOwned(repo, modeDir, owner = 'owner-a') {
  const tower = await Tower.open(repo)
  await tower.init({ towerAgentId: owner })
  // Keep the test away from the profile's mode store without touching DSH_HOME.
  tower.config = { ...tower.config, mode: { ...(tower.config.mode ?? {}), storePath: modeDir } }
  return tower
}

// The process-default deps object is frozen. Use a per-test wrapper that
// inherits the real tower but gets a mutable copy of the store port.
function wrapTower(tower, storePatch) {
  const wrapped = Object.create(tower)
  wrapped.deps = { ...tower.deps, store: { ...tower.deps.store, ...storePatch } }
  return wrapped
}

test('transferOwnership: readFacts runs only while the state lock is held', async () => {
  const { root, repo, modeDir } = makeRepo()
  try {
    const tower = await openOwned(repo, modeDir)
    const originalWithLock = tower.deps.store.withLock
    let lockHeld = false
    const wrapped = wrapTower(tower, {
      withLock: async (paths, fn) =>
        originalWithLock(paths, async (lockPaths, held) => {
          lockHeld = true
          try {
            return await fn(lockPaths, held)
          } finally {
            lockHeld = false
          }
        }),
    })
    const result = await transferOwnership(wrapped, {
      caller: 'owner-b',
      reason: 'facts are read under the lock',
      readFacts: async () => {
        assert.equal(lockHeld, true, 'readFacts must be called inside tower.deps.store.withLock')
        return {
          modes: new Map([['owner-a', { on: false }]]),
          lock: { held: false, self: false, stale: false },
          liveRoster: [],
        }
      },
    })
    assert.equal(result.transferred, true)
    assert.equal((await tower.load()).towerAgentId, 'owner-b')
  } finally {
    removeTemp(root)
  }
})

test('performTakeover: a mode change between precheck and lock is refused', async () => {
  const { root, repo, modeDir } = makeRepo()
  try {
    const tower = await openOwned(repo, modeDir)
    const initial = await tower.load()

    // The approval precheck sees the owner off; after the human says yes the
    // owning session enters Tower mode again before the locked write runs.
    const precheck = await readOwnership(tower, { caller: 'owner-b' })
    assert.equal(precheck.snapshot.takeoverAvailable, true, JSON.stringify(precheck.snapshot.blockers))
    assert.equal(precheck.snapshot.ownerMode, 'off')
    assert.equal(precheck.snapshot.modeStoreStatus, 'missing')
    writeModeStore(modeDir, { version: 1, modes: { 'owner-a': { on: true, at: Date.now() } } })

    await assert.rejects(
      () => performTakeover(tower, { caller: 'owner-b', reason: 'precheck said the owner was off' }),
      (error) => error.code === 'owner-live' && /Tower mode on/.test(error.message),
    )
    const after = await tower.load()
    assert.equal(after.towerAgentId, 'owner-a')
    assert.equal(after.revision, initial.revision)
  } finally {
    removeTemp(root)
  }
})

test('performTakeover: a corrupt mode store fails closed with mode-store-corrupt', async () => {
  const { root, repo, modeDir } = makeRepo()
  try {
    const tower = await openOwned(repo, modeDir)
    const initial = await tower.load()
    fs.writeFileSync(path.join(modeDir, 'modes.json'), '{ "version": 1, "modes": ')

    const facts = await readOwnership(tower, { caller: 'owner-b' })
    assert.equal(facts.modeStore.status, 'corrupt')
    assert.equal(facts.snapshot.modeStoreStatus, 'corrupt')
    assert.equal(facts.snapshot.modeStoreError !== null, true)
    assert.match(facts.snapshot.modeStoreFile, /modes\.json$/)
    assert.equal(facts.snapshot.ownerMode, 'unknown')
    assert.equal(facts.snapshot.takeoverAvailable, false)
    assert.equal(facts.snapshot.blockers[0].code, 'mode-store-corrupt')

    await assert.rejects(
      () => performTakeover(tower, { caller: 'owner-b', reason: 'repair the store first' }),
      (error) => {
        assert.equal(error.code, 'mode-store-corrupt')
        assert.match(error.message, /\[tower:mode-store-corrupt\]/)
        assert.match(error.nextAction, /repair or move aside the mode store/)
        return true
      },
    )
    const after = await tower.load()
    assert.equal(after.towerAgentId, 'owner-a')
    assert.equal(after.revision, initial.revision)
  } finally {
    removeTemp(root)
  }
})

test('performTakeover: an unreadable mode store is corrupt, not empty', async () => {
  const { root, repo, modeDir } = makeRepo()
  try {
    const tower = await openOwned(repo, modeDir)
    // A directory at modes.json is unreadable bytes, never "no modes".
    fs.mkdirSync(path.join(modeDir, 'modes.json'))
    const facts = await readOwnership(tower, { caller: 'owner-b' })
    assert.equal(facts.snapshot.modeStoreStatus, 'corrupt')
    assert.equal(facts.snapshot.ownerMode, 'unknown')
    await assert.rejects(
      () => performTakeover(tower, { caller: 'owner-b', reason: 'unreadable store' }),
      (error) => error.code === 'mode-store-corrupt',
    )
    assert.equal((await tower.load()).towerAgentId, 'owner-a')
  } finally {
    removeTemp(root)
  }
})

test('performTakeover: releases the previous owner orphan lock with the observed token', async () => {
  const { root, repo, modeDir } = makeRepo()
  try {
    const tower = await openOwned(repo, modeDir)
    const lockFile = writeWorkspaceLock(tower.commonDir, holder('tok-owner-a', 'owner-a'))

    const result = await performTakeover(tower, { caller: 'owner-b', reason: 'previous session is gone' })
    assert.equal(result.transferred, true)
    assert.equal(result.previousOwner, 'owner-a')
    assert.equal(result.releasedOrphanLock, true)
    assert.equal(result.workspaceLock.held, true)
    assert.equal(fs.existsSync(lockFile), false, 'the previous owner orphan lock must be released')
    assert.equal(JSON.stringify(result).includes('tok-owner-a'), false, 'never leak the lock token')
    assert.equal((await tower.load()).towerAgentId, 'owner-b')
  } finally {
    removeTemp(root)
  }
})

test('performTakeover: same-owner retry is idempotent even with a corrupt store and an orphan lock', async () => {
  const { root, repo, modeDir } = makeRepo()
  try {
    const tower = await openOwned(repo, modeDir)
    const initial = await tower.load()
    fs.writeFileSync(path.join(modeDir, 'modes.json'), 'not-json')
    const lockFile = writeWorkspaceLock(tower.commonDir, holder('tok-owner-a', 'owner-a'))

    const result = await performTakeover(tower, { caller: 'owner-a', reason: 'retry the same takeover' })
    assert.equal(result.alreadyOwner, true)
    assert.equal(result.transferred, false)
    assert.equal(result.releasedOrphanLock, false)
    assert.equal(result.revision, initial.revision)
    assert.equal(fs.existsSync(lockFile), true, 'an already-owner retry must not release the owner lock')
  } finally {
    removeTemp(root)
  }
})

test('performTakeover: a foreign workspace lock blocks and is never released', async () => {
  const { root, repo, modeDir } = makeRepo()
  try {
    const tower = await openOwned(repo, modeDir)
    const lockFile = writeWorkspaceLock(tower.commonDir, holder('tok-owner-c', 'owner-c'))

    await assert.rejects(
      () => performTakeover(tower, { caller: 'owner-b', reason: 'foreign lock' }),
      (error) => error.code === 'owner-busy' && /owner-c/.test(error.message),
    )
    assert.equal((await tower.load()).towerAgentId, 'owner-a')
    assert.equal(fs.existsSync(lockFile), true)
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'tok-owner-c')
  } finally {
    removeTemp(root)
  }
})

test('performTakeover: a lock replaced after the in-lock read survives the release', async () => {
  const { root, repo, modeDir } = makeRepo()
  try {
    const tower = await openOwned(repo, modeDir)
    const lockFile = writeWorkspaceLock(tower.commonDir, holder('tok-old', 'owner-a'))
    const appendJsonl = tower.deps.store.appendJsonl
    const wrapped = wrapTower(tower, {
      appendJsonl: async (file, entry) => {
        const written = await appendJsonl(file, entry)
        // Between the state-lock read and the release, a newer session writes
        // its own workspace lock. Releasing the observed token must not remove it.
        fs.writeFileSync(lockFile, JSON.stringify(holder('tok-new', 'owner-a')))
        return written
      },
    })
    const result = await performTakeover(wrapped, { caller: 'owner-b', reason: 'lock race' })
    assert.equal(result.transferred, true)
    assert.equal(result.releasedOrphanLock, false)
    assert.equal(fs.existsSync(lockFile), true, 'a newer lock must survive the orphan release')
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'tok-new')
  } finally {
    removeTemp(root)
  }
})
