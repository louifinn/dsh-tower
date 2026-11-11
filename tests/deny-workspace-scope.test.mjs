// #161 D4: the synchronous helpers the deny guard uses to scope Tower mode to
// the workspace — the common-dir walk (plain repository and worktree pointer)
// and the synchronous workspace-lock read.
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { removeTemp } from './helpers/cleanup.mjs'

import { resolveCommonDirSync } from '../adapters/git.js'
import { inspectWorkspaceLockSync, workspaceLockPath } from '../adapters/workspaceLock.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-scope-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo }
}

test('resolveCommonDirSync: a subdirectory resolves to the repository .git', () => {
  const { repo } = makeRepo()
  const nested = path.join(repo, 'a', 'b')
  fs.mkdirSync(nested, { recursive: true })
  assert.equal(resolveCommonDirSync(nested), path.join(repo, '.git'))
  assert.equal(resolveCommonDirSync(repo), path.join(repo, '.git'))
})

test('resolveCommonDirSync: a worktree pointer resolves to the shared common dir', () => {
  const { repo } = makeRepo()
  const worktree = path.join(path.dirname(repo), 'wt')
  git(repo, ['worktree', 'add', '--detach', worktree, 'HEAD'])
  const commonDir = path.join(repo, '.git')
  assert.equal(resolveCommonDirSync(worktree), commonDir)
})

test('resolveCommonDirSync: outside a repository and bad input resolve to null', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-scope-none-'))
  test.after(() => removeTemp(outside))
  assert.equal(resolveCommonDirSync(outside), null)
  assert.equal(resolveCommonDirSync(path.join(outside, 'not', 'absolute')), null)
  assert.equal(resolveCommonDirSync(''), null)
  assert.equal(resolveCommonDirSync(null), null)
})

test('inspectWorkspaceLockSync: missing, held, and corrupt records', () => {
  const { repo } = makeRepo()
  const commonDir = path.join(repo, '.git')
  const file = workspaceLockPath(commonDir)
  assert.deepEqual(inspectWorkspaceLockSync(commonDir), { held: false })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const record = { token: 't-1', sessionId: 'owner', agentId: 'owner', pid: process.pid, at: Date.now() }
  fs.writeFileSync(file, JSON.stringify(record))
  assert.deepEqual(inspectWorkspaceLockSync(commonDir), { held: true, corrupt: false, holder: record })
  // Staleness never demotes the owner: the guard denies on presence.
  const stale = { ...record, at: Date.now() - 10 * 60 * 1000 }
  fs.writeFileSync(file, JSON.stringify(stale))
  assert.equal(inspectWorkspaceLockSync(commonDir).held, true)
  fs.writeFileSync(file, '{corrupt bytes')
  const corrupt = inspectWorkspaceLockSync(commonDir)
  assert.equal(corrupt.held, true, 'unreadable bytes are an unknown owner, not a free repo')
  assert.equal(corrupt.corrupt, true)
  assert.equal(corrupt.holder, null)
})
