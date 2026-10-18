// Repository-level configuration: <git-common-dir>/dsh-tower/config.json.
// Precedence: code defaults < profile config < repository config < tool args.
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Tower } from '../lib/tower.js'
import { configureRuntime, repoConfigPath } from '../lib/config.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-config-'))
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

function writeRepoConfig(repo, value) {
  const file = repoConfigPath(path.join(repo, '.git'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  return file
}

test('repo config: path is exposed, missing file is not an error', async () => {
  const { root, repo } = makeRepo()
  try {
    const tower = await Tower.open(repo)
    const expected = path.join(repo, '.git', 'dsh-tower', 'config.json')
    assert.equal(tower.config.configPath, expected)
    assert.equal(tower.config.repoConfigPresent, false)
    assert.equal(tower.config.merge.timeoutMs, 900000)
    assert.equal(tower.config.spawn.workerPreset, 'tower-worker')

    await tower.init({})
    const status = await tower.status()
    assert.equal(status.config.path, expected)
    assert.equal(status.config.repoConfigPresent, false)
    assert.equal(status.config.spawn.reviewerPreset, 'tower-reviewer')
    assert.deepEqual(status.findingsByStatus, { open: 0, triaged: 0, fixed: 0, wontfix: 0 })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('repo config: overrides profile values and keeps unset profile values', async () => {
  const { root, repo } = makeRepo()
  try {
    configureRuntime({
      merge: { timeoutMs: 300000 },
      spawn: { maxDepth: 2 },
      review: { maxRoundsPerReviewer: 3 },
    })
    writeRepoConfig(repo, {
      merge: { timeoutMs: 60000 },
      spawn: { workerPreset: 'custom-worker' },
      review: { maxRoundsPerReviewer: 1 },
    })
    const tower = await Tower.open(repo)
    assert.equal(tower.config.merge.timeoutMs, 60000, 'repo value wins over profile')
    assert.equal(tower.config.spawn.workerPreset, 'custom-worker', 'repo value wins over profile')
    assert.equal(tower.config.spawn.maxDepth, 2, 'profile value survives when the repo does not set it')
    assert.equal(tower.config.review.maxRoundsPerReviewer, 1)
    assert.equal(tower.config.repoConfigPresent, true)
  } finally {
    configureRuntime({})
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('repo config: legacy section/allowAgentControl names are accepted', async () => {
  const { root, repo } = makeRepo()
  try {
    configureRuntime({})
    writeRepoConfig(repo, { section: 'repo-specific tower text', allowAgentControl: true })
    const tower = await Tower.open(repo)
    assert.equal(tower.config.section, 'repo-specific tower text')
    assert.equal(tower.config.mode.promptSection, 'repo-specific tower text')
    assert.equal(tower.config.mode.allowAgentControl, true)

    // Canonical keys win over the legacy aliases when both are present.
    writeRepoConfig(repo, { section: 'legacy text', mode: { promptSection: 'canonical text' } })
    const both = await Tower.open(repo)
    assert.equal(both.config.section, 'canonical text')
    assert.equal(both.config.mode.promptSection, 'canonical text')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('repo config: worktrees.root places new mission worktrees there', async () => {
  const { root, repo } = makeRepo()
  try {
    configureRuntime({})
    const worktreeRoot = path.join(root, 'custom-worktrees')
    writeRepoConfig(repo, { worktrees: { root: worktreeRoot } })
    const tower = await Tower.open(repo)
    await tower.init({})
    const planned = await tower.plan({ missions: [{ title: 'Repo config worktree', scope: ['src/**'] }] })
    const provisioned = await tower.provision({ missionId: planned.missions[0].id })
    assert.ok(provisioned.worktree.path.startsWith(worktreeRoot + path.sep), provisioned.worktree.path)
    assert.equal(provisioned.worktree.path, path.join(worktreeRoot, planned.missions[0].id))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('repo config: invalid JSON, unknown keys and bad values are rejected with stable codes', async () => {
  const { root, repo } = makeRepo()
  try {
    configureRuntime({})
    writeRepoConfig(repo, '{ this is not json')
    await assert.rejects(() => Tower.open(repo), /\[tower:config-invalid\].*not valid JSON/)

    writeRepoConfig(repo, { allowAgentToggle: true })
    await assert.rejects(() => Tower.open(repo), /\[tower:config-unknown-key\].*unknown key/)

    writeRepoConfig(repo, { merge: { timeoutMs: 5 } })
    await assert.rejects(() => Tower.open(repo), /\[tower:config-invalid\]/)

    writeRepoConfig(repo, '[]')
    await assert.rejects(() => Tower.open(repo), /\[tower:config-invalid\].*JSON object/)

    // Prototype-pollution style keys are rejected anywhere in the file.
    writeRepoConfig(repo, '{"mode":{"__proto__":{"polluted":true}}}')
    await assert.rejects(() => Tower.open(repo), /\[tower:config-invalid\].*forbidden key/)

    // A repository config is bounded so a huge file cannot stall every tool.
    writeRepoConfig(repo, ' '.repeat(1024 * 1024 + 1))
    await assert.rejects(() => Tower.open(repo), /\[tower:config-invalid\].*too large/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
