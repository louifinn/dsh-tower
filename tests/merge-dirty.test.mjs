// Non-destructive merges (#M57): a checkout that became dirty between the gate
// and the Git mutation must be refused with `worktree-dirty`, and a merge that
// fails after creating its commit must leave the operator's files alone.
//
// Run with: node --test tests/merge-dirty.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'
import { Tower } from '../host/tower.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function readState(tower) {
  return JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
}

/** Build a repository with one completed, clean-reviewed mission ready to merge. */
async function reviewedMission(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  fs.mkdirSync(path.join(repo, 'src'))
  // The file the mission will change, already tracked on the base branch.
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'base\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])

  const tower = await Tower.open(repo)
  await tower.init({})
  await tower.plan({
    missions: [{ title: 'Merge dirty race', scope: ['src/**'], tasks: ['write file', 'commit'] }],
  })
  const provisioned = await tower.provision({ missionId: 'M1' })
  const wt = provisioned.worktree.path
  fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'branch\n')
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-m', 'M1 a'])

  await tower.mission({ id: 'M1', status: 'active' })
  await tower.mission({ id: 'M1', task_done: 'write file' })
  await tower.mission({ id: 'M1', task_done: 'commit' })
  const agentId = 'agent-merge-dirty'
  await tower.recordSpawn({
    missionId: 'M1',
    name: 'worker-merge-dirty',
    role: 'worker',
    agentId,
    parentSessionId: 'session-merge-dirty',
    cwd: wt,
    branch: provisioned.worktree.branch,
  })
  await tower.complete({ missionId: 'M1', agentId, report: 'done' })
  await tower.submitReview({
    missionId: 'M1',
    agentId: 'reviewer-not-in-roster',
    status: 'clean',
    merge: 'merge',
    findings: 'none',
    decision: 'single in-scope file',
    actor: { name: 'tower', role: 'tower' },
    breakGlassReason: 'merge dirty test has no independent reviewer',
  })
  return { root, repo, tower, wt, branch: provisioned.worktree.branch }
}

test('merge: a checkout dirtied after the gate is refused with worktree-dirty and preserved', async () => {
  const ctx = await reviewedMission('dsh-tower-merge-dirty-race-')
  try {
    const baseTip = git(ctx.repo, ['rev-parse', 'HEAD'])
    const gitCalls = []
    const realGit = ctx.tower.git.bind(ctx.tower)
    ctx.tower.git = async (cwd, args, options) => {
      gitCalls.push([...args])
      return realGit(cwd, args, options)
    }

    const realGate = ctx.tower.evaluateGate.bind(ctx.tower)
    let gateOk = null
    ctx.tower.evaluateGate = async (input) => {
      const gate = await realGate(input)
      gateOk = gate.ok
      // Simulate the operator editing the base checkout after preflight passed,
      // before the merge acquires the git mutex.
      if (gate.ok) fs.writeFileSync(path.join(ctx.repo, 'src', 'a.txt'), 'local edit\n')
      return gate
    }

    const result = await ctx.tower.merge({ missionId: 'M1', activity: {} })

    assert.equal(gateOk, true, 'the fixture must reach an open gate')
    assert.equal(result.ok, false)
    const blocker = result.blockers.find((entry) => entry.code === 'worktree-dirty')
    assert.ok(blocker, JSON.stringify(result.blockers))
    assert.match(blocker.detail, /src\/a\.txt/)
    assert.match(blocker.detail, /commit/)
    assert.match(blocker.detail, /stash/)
    assert.equal(git(ctx.repo, ['rev-parse', 'HEAD']), baseTip, 'HEAD must not move')
    assert.equal(fs.readFileSync(path.join(ctx.repo, 'src', 'a.txt'), 'utf8'), 'local edit\n')
    assert.equal(git(ctx.repo, ['diff', '--name-only']), 'src/a.txt', 'the edit is unstaged and preserved')
    assert.match(git(ctx.repo, ['status', '--porcelain']), /src\/a\.txt/m)
    assert.equal(readState(ctx.tower).mergeIntent ?? null, null, 'no intent may be recorded')
    assert.equal(readState(ctx.tower).missions[0].status, 'completed')
    assert.equal(
      gitCalls.some((args) => args[0] === 'reset'),
      false,
      'a refused merge must never reset the checkout',
    )
  } finally {
    removeTemp(ctx.root)
  }
})

test('merge: a failure after the merge commit is treated as merged without resetting local work', async () => {
  const ctx = await reviewedMission('dsh-tower-merge-post-failure-')
  try {
    const baseTip = git(ctx.repo, ['rev-parse', 'HEAD'])
    const gitCalls = []
    const realGit = ctx.tower.git.bind(ctx.tower)
    let injected = false
    ctx.tower.git = async (cwd, args, options) => {
      gitCalls.push([...args])
      const output = await realGit(cwd, args, options)
      if (!injected && args[0] === 'merge' && args[1] === '--no-ff') {
        injected = true
        fs.writeFileSync(path.join(ctx.repo, 'src', 'a.txt'), 'local after merge\n')
        throw new Error('simulated post-merge reporting failure')
      }
      return output
    }

    const result = await ctx.tower.merge({ missionId: 'M1', activity: {} })

    assert.equal(injected, true)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.recoveredFromFailure, true)
    assert.ok(Array.isArray(result.warnings))
    assert.ok(result.warnings.some((warning) => /left in place/.test(warning)), JSON.stringify(result.warnings))
    assert.notEqual(git(ctx.repo, ['rev-parse', 'HEAD']), baseTip, 'the merge commit must exist')
    assert.equal(fs.readFileSync(path.join(ctx.repo, 'src', 'a.txt'), 'utf8'), 'local after merge\n')
    assert.equal(git(ctx.repo, ['diff', '--name-only']), 'src/a.txt', 'the edit is unstaged and preserved')
    assert.match(git(ctx.repo, ['status', '--porcelain']), /src\/a\.txt/m)
    assert.equal(
      gitCalls.some((args) => args[0] === 'reset'),
      false,
      'post-merge cleanup must never reset the checkout',
    )
  } finally {
    removeTemp(ctx.root)
  }
})

test('merge: a timed-out merge leaves no staged debris but still never resets', async () => {
  const ctx = await reviewedMission('dsh-tower-merge-timeout-restore-')
  try {
    const baseTip = git(ctx.repo, ['rev-parse', 'HEAD'])
    const gitCalls = []
    const realGit = ctx.tower.git.bind(ctx.tower)
    let injected = false
    ctx.tower.git = async (cwd, args, options) => {
      gitCalls.push([...args])
      if (!injected && args[0] === 'merge' && args[1] === '--no-ff') {
        injected = true
        // The killed merge staged the integrated file, then died before the
        // commit: HEAD never moved and there is no MERGE_HEAD to abort.
        fs.writeFileSync(path.join(ctx.repo, 'src', 'a.txt'), 'branch\n')
        execFileSync('git', ['add', 'src/a.txt'], { cwd: ctx.repo, stdio: 'ignore' })
        const error = new Error('simulated merge timeout after staging')
        error.timedOut = true
        throw error
      }
      return realGit(cwd, args, options)
    }

    const result = await ctx.tower.merge({ missionId: 'M1', activity: {} })

    assert.equal(injected, true)
    assert.equal(result.ok, false)
    assert.equal(result.blockers[0].code, 'merge-hook-failed')
    assert.equal(result.blockers[0].timeout, true)
    assert.equal(result.blockers[0].cleanup, 'restored-merge-changes')
    assert.ok(result.warnings.some((warning) => /no reset was used/.test(warning)), JSON.stringify(result.warnings))
    assert.equal(git(ctx.repo, ['rev-parse', 'HEAD']), baseTip, 'HEAD must be unchanged')
    assert.equal(git(ctx.repo, ['status', '--porcelain']), '', 'merge-side debris must be gone')
    assert.equal(fs.readFileSync(path.join(ctx.repo, 'src', 'a.txt'), 'utf8'), 'base\n')
    assert.equal(
      gitCalls.some((args) => args[0] === 'reset'),
      false,
      'restoring merge-owned paths must not use reset',
    )
  } finally {
    removeTemp(ctx.root)
  }
})

test('merge: a concurrent edit to a merge-owned path is preserved, not restored', async () => {
  const ctx = await reviewedMission('dsh-tower-merge-concurrent-edit-')
  try {
    const baseTip = git(ctx.repo, ['rev-parse', 'HEAD'])
    const gitCalls = []
    const realGit = ctx.tower.git.bind(ctx.tower)
    let injected = false
    ctx.tower.git = async (cwd, args, options) => {
      gitCalls.push([...args])
      if (!injected && args[0] === 'merge' && args[1] === '--no-ff') {
        injected = true
        fs.writeFileSync(path.join(ctx.repo, 'src', 'a.txt'), 'branch\n')
        execFileSync('git', ['add', 'src/a.txt'], { cwd: ctx.repo, stdio: 'ignore' })
        // The operator edits the same path while the merge is in flight. The
        // staged content is merge-owned, but the worktree copy is not.
        fs.writeFileSync(path.join(ctx.repo, 'src', 'a.txt'), 'operator edit during merge\n')
        const error = new Error('simulated merge timeout after staging')
        error.timedOut = true
        throw error
      }
      return realGit(cwd, args, options)
    }

    const result = await ctx.tower.merge({ missionId: 'M1', activity: {} })

    assert.equal(result.ok, false)
    assert.equal(result.blockers[0].code, 'merge-hook-failed')
    assert.equal(result.blockers[0].cleanup, 'manual-required')
    assert.ok(
      result.warnings.some((warning) => /left changes for manual review/.test(warning)),
      JSON.stringify(result.warnings),
    )
    assert.equal(git(ctx.repo, ['rev-parse', 'HEAD']), baseTip)
    assert.equal(
      fs.readFileSync(path.join(ctx.repo, 'src', 'a.txt'), 'utf8'),
      'operator edit during merge\n',
      'the concurrent edit must survive',
    )
    assert.equal(
      gitCalls.some((args) => args[0] === 'reset'),
      false,
      'cleanup must not use reset',
    )
  } finally {
    removeTemp(ctx.root)
  }
})
