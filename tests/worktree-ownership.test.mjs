// Worktree ownership: a stored path must still be the same real Git worktree,
// on the recorded branch, in the recorded repository. Uses a real temporary
// Git repo + linked worktree; the symlink/junction case skips only when the OS
// refuses to create one (Windows privilege).
// Run with: node --test tests/worktree-ownership.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { assertOwnership, canonicalPath } from '../lib/worktreeOwnership.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-ownership-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  const worktreeRoot = path.join(root, 'worktrees')
  fs.mkdirSync(worktreeRoot)
  return { root, repo, worktreeRoot, commonDir: path.join(repo, '.git') }
}

function addWorktree(fixture, { name = 'M1', branch = 'tower/m1-demo' } = {}) {
  const worktreePath = path.join(fixture.worktreeRoot, name)
  git(fixture.repo, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'])
  return { worktreePath, realPath: fs.realpathSync(worktreePath) }
}

function expectCode(code, pattern) {
  return (error) => {
    assert.equal(error.code, code, error.message)
    if (pattern) assert.match(error.message, pattern)
    return true
  }
}

test('ownership: a real linked worktree passes with path and realpath identity', async () => {
  const fixture = seedRepo()
  try {
    const { worktreePath, realPath } = addWorktree(fixture)
    const result = await assertOwnership({
      storedPath: worktreePath,
      storedRealPath: realPath,
      branch: 'tower/m1-demo',
      commonDir: fixture.commonDir,
      missionId: 'M1',
    })
    assert.deepEqual(result, { path: path.resolve(worktreePath), realPath })

    // storedRealPath is optional; the Git identity checks still run.
    const withoutRealPath = await assertOwnership({
      storedPath: worktreePath,
      branch: 'tower/m1-demo',
      commonDir: fixture.commonDir,
    })
    assert.equal(withoutRealPath.realPath, realPath)
  } finally {
    removeTemp(fixture.root)
  }
})

test('ownership: a moved branch is rejected with the expected branch in the message', async () => {
  const fixture = seedRepo()
  try {
    const { worktreePath, realPath } = addWorktree(fixture)
    await assert.rejects(
      () =>
        assertOwnership({
          storedPath: worktreePath,
          storedRealPath: realPath,
          branch: 'tower/other',
          commonDir: fixture.commonDir,
          missionId: 'M1',
        }),
      expectCode('invalid-transition', /is on tower\/m1-demo, expected tower\/other/),
    )
  } finally {
    removeTemp(fixture.root)
  }
})

test('ownership: a nested path is rejected as not the worktree root', async () => {
  const fixture = seedRepo()
  try {
    const { worktreePath } = addWorktree(fixture)
    const nested = path.join(worktreePath, 'src')
    fs.mkdirSync(nested)
    await assert.rejects(
      () =>
        assertOwnership({
          storedPath: nested,
          branch: 'tower/m1-demo',
          commonDir: fixture.commonDir,
        }),
      expectCode('invalid-transition', /is not the Git worktree root/),
    )
  } finally {
    removeTemp(fixture.root)
  }
})

test('ownership: a replaced realpath is rejected', async () => {
  const fixture = seedRepo()
  try {
    const { worktreePath } = addWorktree(fixture)
    await assert.rejects(
      () =>
        assertOwnership({
          storedPath: worktreePath,
          storedRealPath: fixture.repo,
          branch: 'tower/m1-demo',
          commonDir: fixture.commonDir,
        }),
      expectCode('invalid-transition', /real path changed: expected .*repo, found .*M1/),
    )
  } finally {
    removeTemp(fixture.root)
  }
})

test('ownership: a worktree from a different repository is rejected', async () => {
  const fixture = seedRepo()
  const other = seedRepo()
  try {
    const { worktreePath } = addWorktree(other, { branch: 'tower/m1-demo' })
    await assert.rejects(
      () =>
        assertOwnership({
          storedPath: worktreePath,
          branch: 'tower/m1-demo',
          commonDir: fixture.commonDir,
        }),
      expectCode('invalid-transition', /belongs to a different repository/),
    )
  } finally {
    removeTemp(fixture.root)
    removeTemp(other.root)
  }
})

test('ownership: a missing path is rejected before any Git call', async () => {
  const fixture = seedRepo()
  try {
    const { worktreePath } = addWorktree(fixture)
    await assert.rejects(
      () =>
        assertOwnership({
          storedPath: path.join(worktreePath, 'gone'),
          branch: 'tower/m1-demo',
          commonDir: fixture.commonDir,
        }),
      expectCode('invalid-transition', /is missing/),
    )
  } finally {
    removeTemp(fixture.root)
  }
})

test('ownership: a symlink/junction replacement is rejected (SKIP when the OS refuses to create one)', async (t) => {
  const fixture = seedRepo()
  try {
    const { worktreePath, realPath } = addWorktree(fixture)
    const linkPath = path.join(fixture.root, 'worktree-link')
    try {
      fs.symlinkSync(worktreePath, linkPath, 'junction')
    } catch (error) {
      t.skip(`skipped: this OS/user cannot create a symlink or junction (${error.code ?? error.message})`)
      return
    }
    try {
      assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true)
    } catch (error) {
      t.skip(`skipped: the created link is not reported as a symlink (${error.code ?? error.message})`)
      return
    }

    // The link resolves to the real worktree, which is exactly why ownership
    // must refuse it: a later replacement can redirect the "owned" path.
    assert.equal(await canonicalPath(linkPath), realPath)
    await assert.rejects(
      () =>
        assertOwnership({
          storedPath: linkPath,
          storedRealPath: realPath,
          branch: 'tower/m1-demo',
          commonDir: fixture.commonDir,
        }),
      expectCode('invalid-transition', /symlink or junction/),
    )
  } finally {
    removeTemp(fixture.root)
  }
})

test('canonicalPath: realpath of an existing path, and clear errors otherwise', async () => {
  const fixture = seedRepo()
  try {
    const { worktreePath, realPath } = addWorktree(fixture)
    assert.equal(await canonicalPath(worktreePath), realPath)
    await assert.rejects(() => canonicalPath('relative/path'), expectCode('invalid-argument', /absolute path/))
    await assert.rejects(
      () => canonicalPath(path.join(fixture.root, 'missing')),
      expectCode('invalid-transition', /does not exist/),
    )
  } finally {
    removeTemp(fixture.root)
  }
})

test('ownership: a plain directory and invalid arguments are rejected', async () => {
  const fixture = seedRepo()
  try {
    const plain = path.join(fixture.root, 'plain')
    fs.mkdirSync(plain)
    await assert.rejects(
      () =>
        assertOwnership({
          storedPath: plain,
          branch: 'tower/m1-demo',
          commonDir: fixture.commonDir,
        }),
      expectCode('invalid-transition', /is not a Git worktree/),
    )

    await assert.rejects(
      () => assertOwnership({ storedPath: 'relative/worktree', branch: 'b', commonDir: fixture.commonDir }),
      expectCode('invalid-argument', /storedPath must be an absolute path/),
    )
    await assert.rejects(
      () => assertOwnership({ storedPath: plain, commonDir: fixture.commonDir }),
      expectCode('invalid-argument', /branch is required/),
    )
    await assert.rejects(
      () => assertOwnership({ storedPath: plain, branch: 'b', commonDir: 'relative/.git' }),
      expectCode('invalid-argument', /commonDir must be an absolute path/),
    )
  } finally {
    removeTemp(fixture.root)
  }
})
