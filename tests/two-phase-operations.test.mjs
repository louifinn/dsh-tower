// #51 two-phase coverage for tower_rebase and tower_teardown: long git work
// must run outside the state lock, mutations must run under the git lock, and
// a stale prepared revision must be rejected before anything irreversible.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Tower } from '../app/tower.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seed(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
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

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

/** One completed, clean-reviewed mission whose branch has one commit. */
async function reviewedMission(prefix) {
  const { root, repo } = seed(prefix)
  const tower = await Tower.open(repo)
  await tower.init({})
  await tower.plan({ missions: [{ title: 'Two phase op', scope: ['src/**'], tasks: ['write file', 'commit'] }] })
  const provisioned = await tower.provision({ missionId: 'M1' })
  const wt = provisioned.worktree.path
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
  fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'a\n')
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-m', 'M1 a'])
  await tower.mission({ id: 'M1', status: 'active' })
  await tower.mission({ id: 'M1', task_done: 'write file' })
  await tower.mission({ id: 'M1', task_done: 'commit' })
  const agentId = 'agent-worker-two-phase'
  await tower.recordSpawn({
    missionId: 'M1',
    name: 'worker-m1',
    role: 'worker',
    agentId,
    parentSessionId: 'session-two-phase',
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
    breakGlassReason: 'two-phase test has no independent reviewer',
  })
  return { root, repo, tower, wt, branch: provisioned.worktree.branch, agentId }
}

async function mergedMission(prefix) {
  const ctx = await reviewedMission(prefix)
  const merged = await ctx.tower.merge({ missionId: 'M1', activity: {} })
  assert.equal(merged.ok, true, JSON.stringify(merged.blockers))
  return ctx
}

/** Advance the base so the reviewed branch needs a rebase. */
function advanceBase(repo) {
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'src', 'base-only.txt'), 'base\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'advance base'])
}

/** Record which locks are held for each git call; restore with unwatchGit. */
function watchGit(tower) {
  const calls = []
  const realGit = tower.git.bind(tower)
  tower.git = async (cwd, args, options) => {
    calls.push({
      command: args.join(' '),
      stateLock: fs.existsSync(tower.paths.lock),
      gitLock: fs.existsSync(tower.paths.gitLock),
    })
    return realGit(cwd, args, options)
  }
  return { calls, restore: () => { tower.git = realGit } }
}

test('rebase runs git outside the state lock and mutates under the git lock', async () => {
  const ctx = await reviewedMission('dsh-tower-rebase-lock-')
  try {
    advanceBase(ctx.repo)
    const oldTip = git(ctx.wt, ['rev-parse', 'HEAD'])
    const baseTip = git(ctx.repo, ['rev-parse', 'HEAD'])

    const spy = watchGit(ctx.tower)
    let lockDuringAssertWorktree = null
    const realAssertWorktree = ctx.tower.assertWorktree.bind(ctx.tower)
    ctx.tower.assertWorktree = async (worktree) => {
      lockDuringAssertWorktree = fs.existsSync(ctx.tower.paths.lock)
      return realAssertWorktree(worktree)
    }

    const result = await ctx.tower.rebase({ missionId: 'M1', activity: {} })

    assert.equal(result.ok, true)
    assert.ok(spy.calls.some((call) => call.command.startsWith('rebase ')), 'the rebase command must run')
    for (const call of spy.calls) {
      assert.equal(call.stateLock, false, `state.lock must not be held during git ${call.command}`)
    }
    const mutation = spy.calls.find((call) => call.command === `rebase ${baseTip}`)
    assert.ok(mutation, 'the rebase subprocess must be recorded')
    assert.equal(mutation.gitLock, true, 'the git mutation must run under withGitLock')
    assert.equal(lockDuringAssertWorktree, false, 'worktree diagnostics run outside the state lock')

    assert.equal(result.oldTip, oldTip)
    assert.equal(result.baseTip, baseTip)
    assert.notEqual(result.newTip, oldTip)
    assert.equal(result.reviewWaived, true)
    assert.equal(git(ctx.wt, ['rev-parse', 'HEAD']), result.newTip)

    const state = await ctx.tower.load()
    assert.equal(state.rebaseIntent ?? null, null, 'a successful rebase clears the intent')
    assert.equal(state.missions[0].rebase.oldTip, oldTip)
    assert.equal(state.missions[0].rebase.newTip, result.newTip)
    assert.equal(state.missions[0].rebase.baseTip, baseTip)
    // The clean rebase still waives re-review for the previously reviewed tip.
    assert.equal(ctx.tower.rebaseWaived(state.missions[0], state.reviews.at(-1)), true)
  } finally {
    cleanup(ctx.root)
  }
})

test('rebase rejects a state revision change prepared outside the lock', async () => {
  const ctx = await reviewedMission('dsh-tower-rebase-stale-')
  try {
    advanceBase(ctx.repo)
    const oldTip = git(ctx.wt, ['rev-parse', 'HEAD'])
    let injected = false
    const realRevParse = ctx.tower.revParse.bind(ctx.tower)
    ctx.tower.revParse = async (cwd, ref) => {
      if (!injected) {
        injected = true
        await ctx.tower.mission({ id: 'M1', note: 'concurrent writer during rebase preparation' })
      }
      return realRevParse(cwd, ref)
    }

    await assert.rejects(
      () => ctx.tower.rebase({ missionId: 'M1', activity: {} }),
      (error) => {
        assert.equal(error.code, 'stale-base')
        return true
      },
    )
    const state = await ctx.tower.load()
    assert.equal(state.rebaseIntent ?? null, null, 'no intent may be recorded on a stale prepare')
    assert.equal(state.missions[0].rebase ?? null, null, 'no rebase record may be written')
    assert.equal(git(ctx.wt, ['rev-parse', 'HEAD']), oldTip, 'the branch must not be rewritten')
  } finally {
    cleanup(ctx.root)
  }
})

test('rebase keeps a durable intent when the commit is stale and reconciles it next time', async () => {
  const ctx = await reviewedMission('dsh-tower-rebase-reconcile-')
  try {
    advanceBase(ctx.repo)
    const oldTip = git(ctx.wt, ['rev-parse', 'HEAD'])
    const baseTip = git(ctx.repo, ['rev-parse', 'HEAD'])
    let injected = false
    const realGit = ctx.tower.git.bind(ctx.tower)
    ctx.tower.git = async (cwd, args, options) => {
      const result = await realGit(cwd, args, options)
      if (!injected && args[0] === 'rebase') {
        // Land a competing state write while the rebase subprocess's result is
        // already on disk, so the commit phase sees a stale revision.
        injected = true
        await ctx.tower.mission({ id: 'M1', note: 'concurrent writer during the rebase act' })
      }
      return result
    }

    await assert.rejects(
      () => ctx.tower.rebase({ missionId: 'M1', activity: {} }),
      (error) => {
        assert.equal(error.code, 'stale-base')
        return true
      },
    )
    ctx.tower.git = realGit

    const rebasedTip = git(ctx.wt, ['rev-parse', 'HEAD'])
    assert.notEqual(rebasedTip, oldTip, 'git did rewrite the branch before the stale commit')
    let state = await ctx.tower.load()
    assert.ok(state.rebaseIntent, 'a durable intent must survive a failed commit')
    assert.equal(state.rebaseIntent.missionId, 'M1')
    assert.equal(state.rebaseIntent.oldTip, oldTip)
    assert.equal(state.missions[0].rebase ?? null, null)

    const second = await ctx.tower.rebase({ missionId: 'M1', activity: {} })
    assert.equal(second.ok, true)
    assert.equal(second.alreadyUpToDate, true)

    state = await ctx.tower.load()
    assert.equal(state.rebaseIntent ?? null, null, 'reconciliation must clear the intent')
    assert.equal(state.missions[0].rebase.oldTip, oldTip)
    assert.equal(state.missions[0].rebase.newTip, rebasedTip)
    assert.equal(state.missions[0].rebase.baseTip, baseTip)
    assert.equal(ctx.tower.rebaseWaived(state.missions[0], state.reviews.at(-1)), true)
  } finally {
    cleanup(ctx.root)
  }
})

test('rebase conflict still aborts, blocks the mission and clears the intent', async () => {
  const ctx = await reviewedMission('dsh-tower-rebase-conflict-')
  try {
    // Advance the base with a conflicting change to the mission's file.
    fs.mkdirSync(path.join(ctx.repo, 'src'), { recursive: true })
    fs.writeFileSync(path.join(ctx.repo, 'src', 'a.txt'), 'conflicting\n')
    git(ctx.repo, ['add', '-A'])
    git(ctx.repo, ['commit', '-m', 'conflicting base change'])

    const result = await ctx.tower.rebase({ missionId: 'M1', activity: {} })
    assert.equal(result.ok, false)
    assert.equal(result.blockers[0].code, 'rebase-conflict')
    const state = await ctx.tower.load()
    assert.equal(state.rebaseIntent ?? null, null)
    assert.equal(state.missions[0].status, 'blocked')
    assert.match(state.missions[0].blockers.at(-1), /rebase conflict onto/)
    assert.equal(git(ctx.wt, ['status', '--porcelain']), '', 'the conflict must be aborted cleanly')
  } finally {
    cleanup(ctx.root)
  }
})

test('rebase refuses a running worker and a dirty worktree before locking', async () => {
  const ctx = await reviewedMission('dsh-tower-rebase-guards-')
  try {
    advanceBase(ctx.repo)
    const dirtyFile = path.join(ctx.wt, 'scratch.txt')
    fs.writeFileSync(dirtyFile, 'scratch\n')
    const dirty = await ctx.tower.rebase({ missionId: 'M1', activity: {} })
    assert.equal(dirty.ok, false)
    assert.equal(dirty.blockers[0].code, 'worktree-dirty')
    fs.rmSync(dirtyFile)
    const busy = await ctx.tower.rebase({ missionId: 'M1', activity: { [ctx.agentId]: 'running' } })
    assert.equal(busy.ok, false)
    assert.equal(busy.blockers[0].code, 'worker-busy')
    assert.equal((await ctx.tower.load()).rebaseIntent ?? null, null)
  } finally {
    cleanup(ctx.root)
  }
})

test('teardown removes worktrees under the git lock and commits one revision bump', async () => {
  const ctx = await mergedMission('dsh-tower-teardown-lock-')
  try {
    const before = await ctx.tower.load()
    const spy = watchGit(ctx.tower)
    let lockDuringAssertWorktree = null
    const realAssertWorktree = ctx.tower.assertWorktree.bind(ctx.tower)
    ctx.tower.assertWorktree = async (worktree) => {
      lockDuringAssertWorktree = fs.existsSync(ctx.tower.paths.lock)
      return realAssertWorktree(worktree)
    }

    const result = await ctx.tower.teardown({ activity: {} })

    assert.equal(result.ok, true)
    assert.equal(result.dryRun, false)
    assert.deepEqual(result.removed, ['M1'])
    for (const call of spy.calls) {
      assert.equal(call.stateLock, false, `state.lock must not be held during git ${call.command}`)
    }
    const remove = spy.calls.find((call) => call.command.startsWith('worktree remove'))
    const branch = spy.calls.find((call) => call.command.startsWith('branch -d'))
    assert.ok(remove, 'worktree remove must run')
    assert.ok(branch, 'branch delete must run')
    assert.equal(remove.gitLock, true, 'worktree remove must run under withGitLock')
    assert.equal(branch.gitLock, true, 'branch delete must run under withGitLock')
    assert.equal(lockDuringAssertWorktree, false, 'ownership diagnostics run outside the state lock')

    assert.equal(fs.existsSync(ctx.wt), false)
    const state = await ctx.tower.load()
    assert.equal(state.revision, before.revision + 1, 'one removal bumps the revision exactly once')
    assert.ok(state.missions[0].worktreeRemovedAt)
    const decision = result.decisions.find((entry) => entry.missionId === 'M1')
    assert.equal(decision.action, 'removed')
    assert.equal(decision.branch, ctx.branch)
  } finally {
    cleanup(ctx.root)
  }
})

test('teardown rejects a stale decision before removing anything', async () => {
  const ctx = await mergedMission('dsh-tower-teardown-stale-')
  try {
    let injected = false
    const realIsClean = ctx.tower.isClean.bind(ctx.tower)
    ctx.tower.isClean = async (cwd) => {
      const value = await realIsClean(cwd)
      if (!injected) {
        injected = true
        await ctx.tower.mission({ id: 'M1', note: 'concurrent writer during teardown decision' })
      }
      return value
    }

    await assert.rejects(
      () => ctx.tower.teardown({ activity: {} }),
      (error) => {
        assert.equal(error.code, 'stale-base')
        return true
      },
    )
    assert.equal(fs.existsSync(ctx.wt), true, 'no worktree may be removed on a stale decision')
    const state = await ctx.tower.load()
    assert.equal(state.missions[0].worktreeRemovedAt ?? null, null)
  } finally {
    cleanup(ctx.root)
  }
})

test('teardown preserves live-agent, dirty/force and dry-run behaviour', async () => {
  const ctx = await mergedMission('dsh-tower-teardown-guards-')
  try {
    const live = await ctx.tower.teardown({ activity: { [ctx.agentId]: 'running' } })
    assert.deepEqual(live.removed, [])
    assert.equal(live.decisions.find((entry) => entry.missionId === 'M1').reason, 'live agent')
    assert.equal(fs.existsSync(ctx.wt), true)

    fs.writeFileSync(path.join(ctx.wt, 'leftover.txt'), 'leftover\n')
    const dirty = await ctx.tower.teardown({ activity: {} })
    assert.deepEqual(dirty.removed, [])
    assert.equal(dirty.decisions.find((entry) => entry.missionId === 'M1').reason, 'uncommitted changes')

    const preview = await ctx.tower.teardown({ activity: {}, force: true, dryRun: true })
    assert.equal(preview.ok, true)
    assert.equal(preview.dryRun, true)
    assert.deepEqual(preview.removed, [])
    const previewDecision = preview.decisions.find((entry) => entry.missionId === 'M1')
    assert.equal(previewDecision.action, 'remove')
    assert.equal(previewDecision.forced, true)
    assert.equal(fs.existsSync(ctx.wt), true, 'dry run must not touch disk')

    const forced = await ctx.tower.teardown({ activity: {}, force: true })
    assert.deepEqual(forced.removed, ['M1'])
    assert.equal(fs.existsSync(ctx.wt), false)
  } finally {
    cleanup(ctx.root)
  }
})

test('teardown still records a retained branch when branch deletion fails', async () => {
  const ctx = await mergedMission('dsh-tower-teardown-branch-')
  try {
    // An extra commit on the mission branch makes `git branch -d` refuse.
    git(ctx.wt, ['commit', '--allow-empty', '-m', 'extra unmerged commit'])
    const result = await ctx.tower.teardown({ activity: {} })
    assert.deepEqual(result.removed, ['M1'])
    const decision = result.decisions.find((entry) => entry.missionId === 'M1')
    assert.equal(decision.action, 'removed')
    assert.equal(decision.branchRetained, true)
    assert.equal(typeof decision.branchDeleteError, 'string')
    const state = await ctx.tower.load()
    assert.ok(state.missions[0].worktreeRemovedAt)
    assert.equal(typeof state.missions[0].branchDeleteError, 'string')
    assert.match(git(ctx.repo, ['branch', '--list', ctx.branch]), new RegExp(ctx.branch.split('/')[1]))
  } finally {
    cleanup(ctx.root)
  }
})
