// Stale git-lock cleanup is a compare-and-swap (#M57): only a lock that is old
// *and* unchanged since it was observed may be removed. A foreign or newer lock
// is never unlinked, not even when the claim rename already moved it aside.
//
// Run with: node --test tests/git-lock-race.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'
import { Tower } from '../host/tower.js'
import { removeStaleGitLocks } from '../app/tower.js'
import { createStorePort } from '../adapters/store-fs.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function lockFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  const tower = await Tower.open(repo)
  const commonDir = tower.commonDir
  const lockPath = path.join(commonDir, 'index.lock')
  return { root, repo, tower, commonDir, lockPath }
}

function ageLock(file, ms) {
  const when = new Date(Date.now() - ms)
  fs.utimesSync(file, when, when)
}

function quarantineFiles(commonDir) {
  return fs
    .readdirSync(commonDir)
    .filter((name) => name.includes('.tower-stale-'))
}

const realStore = (tower) => tower.deps.store
const towerWithStore = (tower, store) => ({ deps: { ...tower.deps, store } })

test('git lock: removes an old lock that is unchanged since observation', async () => {
  const ctx = await lockFixture('dsh-tower-git-lock-old-')
  try {
    fs.writeFileSync(ctx.lockPath, '')
    ageLock(ctx.lockPath, 120000)

    const result = await removeStaleGitLocks(ctx.tower, ctx.commonDir)

    assert.deepEqual(result.removed, ['index.lock'])
    assert.deepEqual(result.retained, [])
    assert.equal(fs.existsSync(ctx.lockPath), false)
    assert.deepEqual(quarantineFiles(ctx.commonDir), [])
  } finally {
    removeTemp(ctx.root)
  }
})

test('git lock: keeps a fresh lock even when its bytes look stale', async () => {
  const ctx = await lockFixture('dsh-tower-git-lock-fresh-')
  try {
    fs.writeFileSync(ctx.lockPath, '')
    // No ageLock: the mtime is now, so a concurrent Git process may own it.

    const result = await removeStaleGitLocks(ctx.tower, ctx.commonDir)

    assert.deepEqual(result.removed, [])
    assert.deepEqual(result.retained, [{ name: 'index.lock', reason: 'fresh' }])
    assert.equal(fs.existsSync(ctx.lockPath), true)
    assert.deepEqual(quarantineFiles(ctx.commonDir), [])
  } finally {
    removeTemp(ctx.root)
  }
})

test('git lock: a lock rewritten with the same bytes while being claimed is restored', async () => {
  const ctx = await lockFixture('dsh-tower-git-lock-replaced-')
  try {
    fs.writeFileSync(ctx.lockPath, 'old lock\n')
    ageLock(ctx.lockPath, 120000)
    const store = realStore(ctx.tower)
    let raced = false
    const racing = {
      ...store,
      async rename(from, to) {
        if (!raced && from === ctx.lockPath) {
          raced = true
          // A foreign owner replaced the lock after our snapshot. Same bytes,
          // new mtime: only the stat fingerprint can tell them apart.
          fs.writeFileSync(from, 'old lock\n')
          const now = new Date()
          fs.utimesSync(from, now, now)
        }
        return store.rename(from, to)
      },
    }

    const result = await removeStaleGitLocks(towerWithStore(ctx.tower, racing), ctx.commonDir)

    assert.equal(raced, true)
    assert.deepEqual(result.removed, [])
    assert.deepEqual(result.retained, [{ name: 'index.lock', reason: 'replaced' }])
    assert.equal(fs.readFileSync(ctx.lockPath, 'utf8'), 'old lock\n', 'the foreign lock is put back')
    assert.deepEqual(quarantineFiles(ctx.commonDir), [])
  } finally {
    removeTemp(ctx.root)
  }
})

test('git lock: a newer lock created after the claim is never unlinked', async () => {
  const ctx = await lockFixture('dsh-tower-git-lock-newer-')
  try {
    fs.writeFileSync(ctx.lockPath, '')
    ageLock(ctx.lockPath, 120000)
    const store = realStore(ctx.tower)
    let raced = false
    const racing = {
      ...store,
      async rename(from, to) {
        const moved = await store.rename(from, to)
        if (!raced && from === ctx.lockPath) {
          raced = true
          // A new Git process claimed the path between our rename and unlink.
          fs.writeFileSync(from, 'newer lock\n')
        }
        return moved
      },
    }

    const result = await removeStaleGitLocks(towerWithStore(ctx.tower, racing), ctx.commonDir)

    assert.equal(raced, true)
    assert.deepEqual(result.removed, ['index.lock'])
    assert.deepEqual(result.retained, [])
    assert.equal(fs.readFileSync(ctx.lockPath, 'utf8'), 'newer lock\n', 'the newer lock must survive')
    assert.deepEqual(quarantineFiles(ctx.commonDir), [])
  } finally {
    removeTemp(ctx.root)
  }
})

// #M57 R68 P2-1: `exists()` + `rename()` is a check-then-act. A third writer
// can create its lock between the check and the rename, and rename replaces the
// destination on every supported platform, so the stale bytes would overwrite a
// live lock. The restore is an exclusive create instead: the third writer's
// record survives and the mismatched quarantine is kept for audit.
test('git lock: a lock created between the mismatch and the restore is never overwritten', async () => {
  const ctx = await lockFixture('dsh-tower-git-lock-restore-race-')
  try {
    fs.writeFileSync(ctx.lockPath, 'old lock\n')
    ageLock(ctx.lockPath, 120000)
    const store = realStore(ctx.tower)
    const foreign = 'foreign lock\n'
    const third = 'third writer lock\n'
    let thirdCreated = false
    const createThird = () => {
      if (thirdCreated) return
      thirdCreated = true
      fs.writeFileSync(ctx.lockPath, third)
    }
    const racing = {
      ...store,
      async rename(from, to) {
        if (from === ctx.lockPath) {
          // The record was replaced after our snapshot but before our claim:
          // the quarantined bytes no longer match, so the restore branch runs.
          fs.writeFileSync(from, foreign)
          return store.rename(from, to)
        }
        return store.rename(from, to)
      },
      // Pre-fix restore path: the check observed a free path and the third
      // writer created its lock immediately afterwards.
      async exists(file) {
        const free = await store.exists(file)
        if (file === ctx.lockPath && !thirdCreated) {
          createThird()
          return false
        }
        return free
      },
      // Fixed restore path: the third writer appears immediately before the
      // exclusive create, which must fail with EEXIST instead of replacing it.
      async copyFileExclusive(from, to) {
        if (to === ctx.lockPath) createThird()
        return store.copyFileExclusive(from, to)
      },
    }

    const result = await removeStaleGitLocks(towerWithStore(ctx.tower, racing), ctx.commonDir)

    assert.equal(thirdCreated, true)
    assert.deepEqual(result.removed, [])
    assert.deepEqual(result.retained, [{ name: 'index.lock', reason: 'replaced-quarantined' }])
    assert.equal(fs.readFileSync(ctx.lockPath, 'utf8'), third, 'the third writer keeps its lock')
    const preserved = quarantineFiles(ctx.commonDir)
    assert.equal(preserved.length, 1, 'the quarantined record is kept for audit')
    assert.equal(fs.readFileSync(path.join(ctx.commonDir, preserved[0]), 'utf8'), foreign)
  } finally {
    removeTemp(ctx.root)
  }
})

// The primitive the restore relies on is itself a CAS: COPYFILE_EXCL reports
// EEXIST and leaves both records byte-identical, unlike rename.
test('store port: copyFileExclusive refuses to replace an existing destination', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-store-exclusive-'))
  try {
    const source = path.join(root, 'quarantine')
    const destination = path.join(root, 'lock')
    fs.writeFileSync(source, 'quarantined\n')
    fs.writeFileSync(destination, 'newer writer\n')
    const store = createStorePort()

    await assert.rejects(
      () => store.copyFileExclusive(source, destination),
      (error) => error.code === 'EEXIST',
    )
    assert.equal(fs.readFileSync(destination, 'utf8'), 'newer writer\n')
    assert.equal(fs.readFileSync(source, 'utf8'), 'quarantined\n')
  } finally {
    removeTemp(root)
  }
})

test('git lock: multiple old lock names are handled independently', async () => {
  const ctx = await lockFixture('dsh-tower-git-lock-multi-')
  try {
    const names = ['index.lock', 'HEAD.lock']
    for (const name of names) {
      fs.writeFileSync(path.join(ctx.commonDir, name), '')
      ageLock(path.join(ctx.commonDir, name), 120000)
    }

    const result = await removeStaleGitLocks(ctx.tower, ctx.commonDir)

    assert.deepEqual([...result.removed].sort(), ['HEAD.lock', 'index.lock'])
    assert.deepEqual(result.retained, [])
    for (const name of names) assert.equal(fs.existsSync(path.join(ctx.commonDir, name)), false)
  } finally {
    removeTemp(ctx.root)
  }
})
