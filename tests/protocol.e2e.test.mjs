// Protocol end-to-end test through the Tower domain class: real git repository,
// real worktree, no DSH runtime and no model calls.
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Tower } from '../lib/tower.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

test('tower protocol: init → plan → complete → review → merge → teardown', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-protocol-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])

  try {
    const tower = await Tower.open(repo)
    const initialized = await tower.init({})
    assert.equal(initialized.created, true)
    assert.ok(initialized.base)

    const planned = await tower.plan({
      missions: [
        { title: 'Feature A', scope: ['src/a/**'], tasks: ['write a', 'commit a'] },
        { title: 'Feature B', scope: ['src/b/**'], tasks: ['write b'] },
      ],
    })
    assert.equal(planned.missions.length, 2)
    const mission = planned.missions[0]

    const provisioned = await tower.provision({ missionId: mission.id })
    const wt = provisioned.worktree.path
    assert.ok(fs.existsSync(wt))
    fs.mkdirSync(path.join(wt, 'src', 'a'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'src', 'a', 'out.txt'), 'a\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'M1 feature a'])

    await tower.mission({ id: mission.id, status: 'active' })
    await tower.mission({ id: mission.id, task_done: 'write a' })
    await tower.mission({ id: mission.id, task_done: 'commit a' })

    const fakeAgent = 'agent-e2e'
    await tower.recordSpawn({
      missionId: mission.id,
      name: 'worker-e2e',
      role: 'worker',
      agentId: fakeAgent,
      parentSessionId: 'session-e2e',
      cwd: wt,
      branch: provisioned.worktree.branch,
    })

    // Unread inbox messages block completion; reading them unblocks it.
    await tower.recordMessage({ from: 'tower', to: 'all', subject: 'gate', body: 'read me before completing' })
    await assert.rejects(
      () => tower.complete({ missionId: mission.id, agentId: fakeAgent, report: 'premature' }),
      /unread inbox/,
    )
    const page = await tower.inbox({ reader: 'worker-e2e' })
    assert.equal(page.unreadRemaining, 0)
    const completed = await tower.complete({ missionId: mission.id, agentId: fakeAgent, report: 'done' })
    assert.equal(completed.mission.status, 'completed')
    assert.equal(completed.commits, 1)

    const finding = await tower.addFinding({
      type: 'improve',
      title: 'trailing newline',
      summary: 'missing newline',
      details: 'cosmetic',
      suggested_fix: 'add one',
      reportedBy: 'reviewer-e2e',
      missionId: mission.id,
    })
    assert.equal(finding.id, 'F1')

    const review = await tower.submitReview({
      missionId: mission.id,
      agentId: 'not-in-roster',
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'single in-scope file',
      breakGlassReason: 'protocol e2e has no independent reviewer',
    })
    assert.equal(review.missionStatus, 'completed')
    assert.equal(review.review.reviewedCommit.length, 40)
    assert.equal(review.branchTip, review.review.reviewedCommit)

    const gate = await tower.evaluateGate({ missionId: mission.id, activity: {} })
    assert.equal(gate.ok, true, JSON.stringify(gate.blockers))

    const merged = await tower.merge({ missionId: mission.id, activity: {} })
    assert.equal(merged.ok, true, JSON.stringify(merged))
    assert.equal(merged.parents.length, 2)

    const torn = await tower.teardown({ activity: {} })
    assert.deepEqual(torn.removed, [mission.id])
    assert.equal(fs.existsSync(wt), false)

    const status = await tower.status()
    assert.equal(status.counts.merged, 1)
    assert.ok(status.reviews >= 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('tower plan: overlapping scopes auto-add a dependency and cycles are rejected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-plan-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])

  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    const planned = await tower.plan({
      missions: [
        { title: 'Overlap one', scope: ['src/shared/**'] },
        { title: 'Overlap two', scope: ['src/shared/deep/**'] },
      ],
    })
    assert.deepEqual(planned.missions[1].deps, [planned.missions[0].id])

    await assert.rejects(
      () =>
        tower.plan({
          missions: [{ title: 'Bad dependency', scope: ['c/**'], deps: ['M99'] }],
        }),
      /unknown mission/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/** Build a repository with one completed, clean-reviewed mission. */
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
    missions: [{ title: 'Merge case', scope: ['src/**'], tasks: ['write file', 'commit'] }],
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
  const agentId = 'agent-merge-e2e'
  await tower.recordSpawn({
    missionId: 'M1',
    name: 'worker-merge-e2e',
    role: 'worker',
    agentId,
    parentSessionId: 'session-e2e',
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
    breakGlassReason: 'protocol e2e has no independent reviewer',
  })
  return { root, repo, tower, wt, branch: provisioned.worktree.branch }
}

test('merge reconciles a merge commit that landed before the tool recorded it', async () => {
  const ctx = await reviewedMission('dsh-tower-reconcile-')
  try {
    git(ctx.repo, ['merge', '--no-ff', ctx.branch, '-m', 'manual merge'])
    const manualTip = git(ctx.repo, ['rev-parse', 'HEAD'])
    const result = await ctx.tower.merge({ missionId: 'M1', activity: {} })
    assert.equal(result.ok, true)
    assert.equal(result.reconciled, true)
    assert.equal(result.mergedCommit, manualTip)
    assert.equal(git(ctx.repo, ['rev-parse', 'HEAD']), manualTip, 'must not create a second merge commit')
    const status = await ctx.tower.status()
    assert.equal(status.counts.merged, 1)
    assert.equal(status.missions[0].status, 'merged')
    assert.equal(status.missions[0].mergedCommit, manualTip)
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true })
  }
})

test('rebase leaves an already-landed branch untouched and merge records it', async () => {
  const ctx = await reviewedMission('dsh-tower-rebase-landed-')
  try {
    git(ctx.repo, ['merge', '--no-ff', ctx.branch, '-m', 'manual merge'])
    const manualTip = git(ctx.repo, ['rev-parse', 'HEAD'])
    const reviewedTip = git(ctx.wt, ['rev-parse', 'HEAD'])

    const rebase = await ctx.tower.rebase({ missionId: 'M1', activity: {} })
    assert.equal(rebase.ok, true)
    assert.equal(rebase.alreadyMerged, true)
    assert.equal(rebase.skipped, true)
    assert.equal(rebase.newTip, reviewedTip)
    assert.equal(git(ctx.wt, ['rev-parse', 'HEAD']), reviewedTip, 'branch tip must not be fast-forwarded to base')

    // The exact shape from the report: the branch was fast-forwarded to the base tip.
    git(ctx.wt, ['reset', '--hard', manualTip])
    const result = await ctx.tower.merge({ missionId: 'M1', activity: {} })
    assert.equal(result.ok, true)
    assert.equal(result.reconciled, true)
    assert.equal(result.mergedCommit, manualTip)
    const status = await ctx.tower.status()
    assert.equal(status.missions[0].status, 'merged')
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true })
  }
})

test('merge hook failure aborts cleanly and leaves the mission retryable', async () => {
  const ctx = await reviewedMission('dsh-tower-hook-')
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
    const status = await ctx.tower.status()
    assert.equal(status.missions[0].status, 'completed', 'mission must stay retryable')
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true })
  }
})

test('merge hook timeout is reported as merge-hook-failed and leaves a clean repo', async () => {
  const ctx = await reviewedMission('dsh-tower-hook-timeout-')
  const stopFile = path.join(ctx.root, 'stop-hook')
  try {
    const hooks = path.join(ctx.repo, '.git', 'hooks')
    fs.mkdirSync(hooks, { recursive: true })
    const hook = path.join(hooks, 'pre-merge-commit')
    // The hook waits for a marker file so the killed git process does not leave
    // an unkillable `sleep` holding the temporary directory on Windows.
    fs.writeFileSync(
      hook,
      `#!/bin/sh\nwhile [ ! -f "${stopFile.replace(/\\/g, '/')}" ]; do sleep 1; done\nexit 0\n`,
    )
    try {
      fs.chmodSync(hook, 0o755)
    } catch {
      // Windows has no executable bit; Git for Windows still runs shell hooks.
    }

    const before = git(ctx.repo, ['rev-parse', 'HEAD'])
    const result = await ctx.tower.merge({ missionId: 'M1', activity: {}, timeoutMs: 1000 })
    assert.equal(result.ok, false)
    assert.equal(result.blockers[0].code, 'merge-hook-failed')
    assert.equal(result.blockers[0].timeout, true)
    assert.equal(git(ctx.repo, ['rev-parse', 'HEAD']), before, 'HEAD must be unchanged')
    assert.equal(git(ctx.repo, ['status', '--porcelain']), '', 'index/worktree must be restored')
    assert.equal(fs.existsSync(path.join(ctx.repo, '.git', 'MERGE_HEAD')), false, 'MERGE_HEAD must be gone')
    assert.equal(fs.existsSync(path.join(ctx.repo, '.git', 'index.lock')), false, 'stale index.lock must be gone')
    const status = await ctx.tower.status()
    assert.equal(status.missions[0].status, 'completed', 'mission must stay retryable')
  } finally {
    fs.writeFileSync(stopFile, 'stop\n')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    fs.rmSync(ctx.root, { recursive: true, force: true })
  }
})

test('mission transitions: blocked can be marked completed again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-transition-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Transition case', scope: ['src/**'] }] })
    await tower.mission({ id: 'M1', status: 'active' })
    await tower.mission({ id: 'M1', status: 'blocked', note: 'test block' })
    const completed = await tower.mission({ id: 'M1', status: 'completed' })
    assert.equal(completed.mission.status, 'completed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
