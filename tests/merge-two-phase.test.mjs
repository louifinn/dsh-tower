// #51 two-phase merge: prepare/reconcile outside the state lock, git under the
// repo-scoped git mutex, and a short state-lock commit that revalidates the
// recorded intent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'
import { Tower } from '../app/tower.js'
import { validateState } from '../domain/state.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function readState(tower) {
  return JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
}

/** Number of state-lock acquisitions recorded so far (git-lock holds excluded). */
function stateLockHolds(tower) {
  const file = path.join(tower.paths.dir, 'lock-holds.jsonl')
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((hold) => hold.kind !== 'git').length
}

/**
 * Instrument every git call the merge use case makes through the Tower port.
 * Each record captures whether `tower.paths.lock` (the state lock) existed at
 * the moment of the call: #51 requires that it never does, reconciliation
 * included. `onTryGit` may run a concurrent writer while a call is observed.
 */
function instrumentGitCalls(tower, onTryGit) {
  const calls = []
  const realGit = tower.git.bind(tower)
  const realTryGit = tower.tryGit.bind(tower)
  const record = (port, args) => {
    let intentStartedAt = null
    try {
      intentStartedAt = JSON.parse(fs.readFileSync(tower.paths.state, 'utf8')).mergeIntent?.startedAt ?? null
    } catch {
      intentStartedAt = null
    }
    calls.push({ port, args: [...args], stateLock: fs.existsSync(tower.paths.lock), intentStartedAt })
  }
  tower.git = async (cwd, args, options) => {
    record('git', args)
    return realGit(cwd, args, options)
  }
  tower.tryGit = async (cwd, args, options) => {
    record('tryGit', args)
    if (onTryGit) await onTryGit(args, calls)
    return realTryGit(cwd, args, options)
  }
  return calls
}

/** Build a repository with one completed, clean-reviewed mission ready to merge. */
async function reviewedMission(prefix) {
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
  await tower.init({})
  await tower.plan({
    missions: [{ title: 'Merge two phase', scope: ['src/**'], tasks: ['write file', 'commit'] }],
  })
  const provisioned = await tower.provision({ missionId: 'M1' })
  const wt = provisioned.worktree.path
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
  fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'a\n')
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-m', 'M1 a'])

  await tower.mission({ id: 'M1', status: 'active' })
  await tower.mission({ id: 'M1', task_done: 'write file' })
  await tower.mission({ id: 'M1', task_done: 'commit' })
  const agentId = 'agent-merge-two-phase'
  await tower.recordSpawn({
    missionId: 'M1',
    name: 'worker-merge-two-phase',
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
    breakGlassReason: 'merge two-phase test has no independent reviewer',
  })
  return { root, repo, tower, wt, branch: provisioned.worktree.branch }
}

test('merge runs git outside the state lock with the intent already recorded', async () => {
  const ctx = await reviewedMission('dsh-tower-merge-two-phase-lock-')
  try {
    const realGit = ctx.tower.git.bind(ctx.tower)
    const atMerge = []
    ctx.tower.git = async (cwd, args, options) => {
      if (args[0] === 'merge' && args[1] === '--no-ff') {
        const state = readState(ctx.tower)
        atMerge.push({
          stateLock: fs.existsSync(ctx.tower.paths.lock),
          gitLock: fs.existsSync(ctx.tower.paths.gitLock),
          intent: state.mergeIntent,
          baseTip: git(ctx.repo, ['rev-parse', 'HEAD']),
          branchTip: git(ctx.wt, ['rev-parse', 'HEAD']),
        })
      }
      return realGit(cwd, args, options)
    }

    const result = await ctx.tower.merge({ missionId: 'M1', activity: {} })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.parents.length, 2)
    assert.equal(result.baseTip, result.parents[0])
    assert.equal(result.branchTip, result.parents[1])

    assert.equal(atMerge.length, 1)
    assert.equal(atMerge[0].stateLock, false, 'state.lock must not be held while git merge runs')
    assert.equal(atMerge[0].gitLock, true, 'git merge must run under withGitLock')
    assert.equal(atMerge[0].intent.missionId, 'M1', 'the merge intent is recorded before git runs')
    assert.equal(atMerge[0].intent.baseTip, atMerge[0].baseTip)
    assert.equal(atMerge[0].intent.branchTip, atMerge[0].branchTip)

    const state = readState(ctx.tower)
    validateState(state, ctx.tower.paths.state)
    assert.equal(state.mergeIntent ?? null, null)
    assert.equal(state.missions[0].status, 'merged')
    assert.equal(state.missions[0].mergedCommit, result.mergedCommit)
  } finally {
    removeTemp(ctx.root)
  }
})

test('a concurrent state bump during the merge does not corrupt state', async () => {
  const ctx = await reviewedMission('dsh-tower-merge-two-phase-concurrent-')
  try {
    const before = readState(ctx.tower)
    const baseTip = git(ctx.repo, ['rev-parse', 'HEAD'])
    const branchTip = git(ctx.wt, ['rev-parse', 'HEAD'])
    // Slow the merge down with a successful pre-merge hook so the concurrent
    // writer really runs while the git subprocess is in flight.
    const hooks = path.join(ctx.repo, '.git', 'hooks')
    fs.mkdirSync(hooks, { recursive: true })
    const hook = path.join(hooks, 'pre-merge-commit')
    fs.writeFileSync(hook, '#!/bin/sh\nsleep 1\n')
    try {
      fs.chmodSync(hook, 0o755)
    } catch {
      // Windows has no executable bit; Git for Windows still runs shell hooks.
    }

    const realGit = ctx.tower.git.bind(ctx.tower)
    let bumped = false
    ctx.tower.git = async (cwd, args, options) => {
      if (args[0] === 'merge' && args[1] === '--no-ff' && !bumped) {
        bumped = true
        const bump = (async () => {
          await new Promise((resolve) => setTimeout(resolve, 250))
          // The merge call holds no state lock here, so an unrelated writer can
          // commit a state change while git is working.
          assert.equal(fs.existsSync(ctx.tower.paths.lock), false, 'no state lock while bumping state')
          const other = await Tower.open(ctx.repo)
          await other.mission({ id: 'M1', note: 'concurrent state bump' })
        })()
        try {
          return await realGit(cwd, args, options)
        } finally {
          await bump
        }
      }
      return realGit(cwd, args, options)
    }

    const result = await ctx.tower.merge({ missionId: 'M1', activity: {} })
    assert.equal(bumped, true)
    assert.equal(result.ok, false)
    assert.equal(result.blockers[0].code, 'stale-base')

    // The landed commit must be preserved as a pending intent, not lost, and the
    // concurrent writer's update must survive.
    const after = readState(ctx.tower)
    validateState(after, ctx.tower.paths.state)
    assert.equal(after.missions[0].status, 'completed')
    assert.ok(after.missions[0].notes.includes('concurrent state bump'))
    assert.equal(after.mergeIntent.missionId, 'M1')
    assert.equal(after.mergeIntent.baseTip, baseTip)
    assert.equal(after.mergeIntent.branchTip, branchTip)
    assert.ok(after.revision > before.revision)
    const landedTip = git(ctx.repo, ['rev-parse', 'HEAD'])
    assert.notEqual(landedTip, baseTip, 'the merge commit did land')

    // Retrying reconciles the retained intent instead of merging a second time.
    const retried = await ctx.tower.merge({ missionId: 'M1', activity: {} })
    assert.equal(retried.ok, true, JSON.stringify(retried))
    assert.equal(retried.reconciled, true)
    assert.equal(git(ctx.repo, ['rev-parse', 'HEAD']), landedTip, 'retry must not create another merge commit')

    const final = readState(ctx.tower)
    validateState(final, ctx.tower.paths.state)
    assert.equal(final.mergeIntent ?? null, null)
    assert.equal(final.missions[0].status, 'merged')
    assert.equal(final.missions[0].mergedCommit, landedTip)
    assert.ok(final.missions[0].notes.includes('concurrent state bump'))
  } finally {
    removeTemp(ctx.root)
  }
})

test('pre-merge hook failure still classifies merge-hook-failed and leaves no intent', async () => {
  const ctx = await reviewedMission('dsh-tower-merge-two-phase-hook-')
  try {
    const hooks = path.join(ctx.repo, '.git', 'hooks')
    fs.mkdirSync(hooks, { recursive: true })
    const hook = path.join(hooks, 'pre-merge-commit')
    fs.writeFileSync(hook, '#!/bin/sh\necho "pre-merge hook failure" >&2\nexit 1\n')
    try {
      fs.chmodSync(hook, 0o755)
    } catch {
      // Windows has no executable bit; Git for Windows still runs shell hooks.
    }

    const before = git(ctx.repo, ['rev-parse', 'HEAD'])
    const result = await ctx.tower.merge({ missionId: 'M1', activity: {} })
    assert.equal(result.ok, false)
    assert.equal(result.blockers[0].code, 'merge-hook-failed')
    assert.equal(['aborted', 'aborted-after-lock-cleanup', 'none'].includes(result.blockers[0].cleanup), true)
    assert.equal(git(ctx.repo, ['rev-parse', 'HEAD']), before, 'HEAD must be unchanged')
    assert.equal(git(ctx.repo, ['status', '--porcelain']), '', 'index/worktree must be restored')
    assert.equal(fs.existsSync(path.join(ctx.repo, '.git', 'MERGE_HEAD')), false, 'MERGE_HEAD must be gone')

    const state = readState(ctx.tower)
    validateState(state, ctx.tower.paths.state)
    assert.equal(state.mergeIntent ?? null, null, 'a failed-before-commit merge must not leave an intent')
    assert.equal(state.missions[0].status, 'completed', 'mission must stay retryable')
  } finally {
    removeTemp(ctx.root)
  }
})

test('reconciliation runs every git read without the state lock held', async () => {
  const ctx = await reviewedMission('dsh-tower-merge-two-phase-reconcile-lock-')
  try {
    // A merge that landed outside Tower must be reconciled before anything else
    // is decided; the instrumentation proves those reads are lock-free too.
    git(ctx.repo, ['merge', '--no-ff', ctx.branch, '-m', 'manual merge'])
    const manualTip = git(ctx.repo, ['rev-parse', 'HEAD'])

    const calls = instrumentGitCalls(ctx.tower)
    const result = await ctx.tower.merge({ missionId: 'M1', activity: {} })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.reconciled, true)
    assert.equal(result.alreadyLanded, true)
    assert.equal(result.mergedCommit, manualTip)
    assert.equal(result.parents.length, 2)
    assert.equal(result.review.status, 'clean')
    assert.equal(git(ctx.repo, ['rev-parse', 'HEAD']), manualTip, 'must not create a second merge commit')

    assert.ok(calls.length > 0, 'the merge must go through the Tower git port')
    const underLock = calls.filter((call) => call.stateLock)
    assert.deepEqual(underLock, [], `no git call may see tower.paths.lock: ${JSON.stringify(underLock)}`)
    // Prove the reconciliation itself was exercised through the instrumented port.
    assert.ok(
      calls.some((call) => call.args[0] === 'rev-list' && call.args[1] === '--merges'),
      'landed-merge reconciliation reads merge commits',
    )
    assert.ok(
      calls.some((call) => call.args[0] === 'merge-base' && call.args[1] === '--is-ancestor'),
      'landed-merge reconciliation checks ancestry',
    )

    const state = readState(ctx.tower)
    validateState(state, ctx.tower.paths.state)
    assert.equal(state.mergeIntent ?? null, null)
    assert.equal(state.missions[0].status, 'merged')
    assert.equal(state.missions[0].mergedCommit, manualTip)
  } finally {
    removeTemp(ctx.root)
  }
})

test('a stale merge intent is reconciled without any git call under the state lock', async () => {
  const ctx = await reviewedMission('dsh-tower-merge-two-phase-intent-lock-')
  try {
    // Simulate a crash after the intent was recorded but before any merge
    // commit existed: tower_merge must clear the intent and then merge.
    const statePath = ctx.tower.paths.state
    const crashed = readState(ctx.tower)
    crashed.mergeIntent = {
      missionId: 'M1',
      baseTip: git(ctx.repo, ['rev-parse', 'HEAD']),
      branchTip: git(ctx.wt, ['rev-parse', 'HEAD']),
      // Marker: lets the test prove the stale intent itself was observed before
      // it was cleared, not the fresh intent recorded for the merge that follows.
      startedAt: 1,
    }
    crashed.revision += 1
    fs.writeFileSync(statePath, JSON.stringify(crashed, null, 2))
    const locksBefore = stateLockHolds(ctx.tower)

    const calls = instrumentGitCalls(ctx.tower)
    const result = await ctx.tower.merge({ missionId: 'M1', activity: {} })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.parents.length, 2)
    assert.equal(result.baseTip, result.parents[0])
    assert.equal(result.branchTip, result.parents[1])

    const underLock = calls.filter((call) => call.stateLock)
    assert.deepEqual(underLock, [], `no git call may see tower.paths.lock: ${JSON.stringify(underLock)}`)
    assert.ok(
      calls.some((call) => call.args[0] === 'rev-parse' && call.args[1] === 'HEAD'),
      'intent reconciliation reads HEAD',
    )
    assert.ok(
      calls.some((call) => call.intentStartedAt === 1),
      'the stale intent must be observed through the Tower git port before it is cleared under the lock',
    )

    const state = readState(ctx.tower)
    validateState(state, statePath)
    assert.equal(state.mergeIntent ?? null, null, 'the stale intent must be cleared')
    assert.equal(state.missions[0].status, 'merged')
    assert.ok(
      stateLockHolds(ctx.tower) - locksBefore >= 2,
      'state mutations must still be serialized by withLock even though git is not',
    )
  } finally {
    removeTemp(ctx.root)
  }
})

test('a state bump during reconciliation makes the prepare retry without losing the update', async () => {
  const ctx = await reviewedMission('dsh-tower-merge-two-phase-reconcile-cas-')
  try {
    git(ctx.repo, ['merge', '--no-ff', ctx.branch, '-m', 'manual merge'])
    const manualTip = git(ctx.repo, ['rev-parse', 'HEAD'])
    const before = readState(ctx.tower)
    let bumped = false

    const calls = instrumentGitCalls(ctx.tower, async (args) => {
      if (bumped || args[0] !== 'rev-list' || args[1] !== '--merges') return
      bumped = true
      // The observation phase holds no lock, so an unrelated writer can commit
      // a state change between the git read and the CAS write that follows it.
      assert.equal(fs.existsSync(ctx.tower.paths.lock), false, 'reconciliation observation must not hold the state lock')
      const other = await Tower.open(ctx.repo)
      await other.mission({ id: 'M1', note: 'concurrent reconcile bump' })
    })

    const result = await ctx.tower.merge({ missionId: 'M1', activity: {} })
    assert.equal(bumped, true)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.reconciled, true)
    assert.equal(result.mergedCommit, manualTip)
    const underLock = calls.filter((call) => call.stateLock)
    assert.deepEqual(underLock, [], `no git call may see tower.paths.lock: ${JSON.stringify(underLock)}`)

    const after = readState(ctx.tower)
    validateState(after, ctx.tower.paths.state)
    assert.equal(after.mergeIntent ?? null, null)
    assert.equal(after.missions[0].status, 'merged')
    assert.equal(after.missions[0].mergedCommit, manualTip)
    assert.ok(
      after.missions[0].notes.includes('concurrent reconcile bump'),
      'the concurrent writer update must survive the reconciliation CAS',
    )
    assert.ok(after.revision >= before.revision + 2, 'both the bump and the reconcile must be reflected in the revision')
    assert.equal(git(ctx.repo, ['rev-parse', 'HEAD']), manualTip, 'retry must not create a second merge commit')
  } finally {
    removeTemp(ctx.root)
  }
})
