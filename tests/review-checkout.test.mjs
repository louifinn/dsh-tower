// #149 W3: a review is a read of a commit, not of a mutable worktree.
//
// A reviewer is spawned into a disposable detached checkout at the mission
// branch tip, the roster row records that commit, and the verdict is stamped
// with it. The checkout is removed when the verdict lands; a checkout that moved
// after it was recorded is refused instead of silently reviewed.
//
// Run with: node --test tests/review-checkout.test.mjs
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

function seed(prefix = 'dsh-tower-review-checkout-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  // Deterministic fixture bytes on every platform (Windows defaults to CRLF).
  git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo }
}

/** A completed mission with a real branch and one commit. */
async function completedMission(prefix, config = null) {
  const { root, repo } = seed(prefix)
  if (config) {
    const file = path.join(repo, '.git', 'dsh-tower', 'config.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(config))
  }
  const tower = await Tower.open(repo)
  await tower.init({ towerAgentId: 'tower-agent' })
  await tower.plan({ missions: [{ title: 'Review evidence', scope: ['src/**'], tasks: ['write file'] }] })
  const provisioned = await tower.provision({ missionId: 'M1' })
  const wt = provisioned.worktree.path
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
  fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'a\n')
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-m', 'M1 a'])
  await tower.mission({ id: 'M1', status: 'active' })
  await tower.mission({ id: 'M1', task_done: 'write file' })
  await tower.recordSpawn({
    missionId: 'M1',
    name: 'worker-m1',
    role: 'worker',
    agentId: 'agent-worker',
    parentSessionId: 'parent-1',
    cwd: wt,
    branch: provisioned.worktree.branch,
  })
  await tower.complete({ missionId: 'M1', agentId: 'agent-worker', report: 'done' })
  return { root, tower, wt, branch: provisioned.worktree.branch }
}

function reviewerInput(overrides = {}) {
  return {
    missionId: 'M1',
    agentId: 'agent-review',
    status: 'clean',
    merge: 'merge',
    findings: 'none',
    decision: 'reviewed the recorded commit',
    ...overrides,
  }
}

test('a reviewer verdict is stamped with the recorded commit and the checkout is disposable', async () => {
  const { root, tower, wt, branch } = await completedMission('dsh-tower-review-checkout-stamp-', {
    review: { mode: 'required' },
  })
  try {
    const tip = await tower.branchTip(await tower.load().then((state) => state.missions[0]))
    const review = await tower.provisionReviewCheckout({ missionId: 'M1', name: 'reviewer-a' })
    assert.equal(review.commit, tip)
    assert.equal(git(review.path, ['rev-parse', 'HEAD']), tip)
    assert.equal(git(review.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'the checkout is detached')

    await tower.recordSpawn({
      missionId: 'M1',
      name: 'reviewer-a',
      role: 'reviewer',
      agentId: 'agent-review',
      parentSessionId: 'parent-review',
      cwd: review.path,
      branch,
      reviewCommit: tip,
      reviewCheckout: review.path,
    })

    // The reviewer's diff surface shows the recorded commit even after the
    // branch moves underneath it.
    fs.writeFileSync(path.join(wt, 'src', 'b.txt'), 'b\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'M1 b after the reviewer was spawned'])
    const movedTip = await tower.branchTip((await tower.load()).missions[0])
    assert.notEqual(movedTip, tip)
    const diff = await tower.diff({ missionId: 'M1', actor: { role: 'reviewer', agentId: 'agent-review' } })
    assert.equal(diff.branchTip, tip)
    assert.equal(diff.reviewedCommit, tip)
    assert.ok(diff.files.some((entry) => entry.includes('src/a.txt')))
    assert.ok(!diff.files.some((entry) => entry.includes('src/b.txt')))

    const verdict = await tower.submitReview(reviewerInput())
    assert.equal(verdict.review.reviewedCommit, tip, 'the verdict is stamped with the recorded commit, not the moved tip')

    const state = await tower.load()
    const row = state.roster.find((entry) => entry.name === 'reviewer-a')
    assert.equal(row.reviewCommit, tip, 'the commit stamp is evidence and stays')
    assert.equal(row.reviewCheckout, undefined, 'the checkout path is cleared once it is removed')
    assert.equal(fs.existsSync(review.path), false, 'the checkout is removed after the verdict')
    assert.ok(
      !git(tower.root, ['worktree', 'list', '--porcelain']).includes(review.path),
      'the checkout is no longer a registered worktree',
    )

    // The existing tip-moved blocker reports the drift at merge time.
    const gate = await tower.evaluateGate({ missionId: 'M1' })
    assert.ok(gate.blockers.some((blocker) => blocker.code === 'tip-moved'), JSON.stringify(gate.blockers))
  } finally {
    removeTemp(root)
  }
})

test('a checkout that moved after it was recorded is refused', async () => {
  const { root, tower, wt, branch } = await completedMission('dsh-tower-review-checkout-moved-')
  try {
    const review = await tower.provisionReviewCheckout({ missionId: 'M1', name: 'reviewer-a' })
    await tower.recordSpawn({
      missionId: 'M1',
      name: 'reviewer-a',
      role: 'reviewer',
      agentId: 'agent-review',
      parentSessionId: 'parent-review',
      cwd: review.path,
      branch,
      reviewCommit: review.commit,
      reviewCheckout: review.path,
    })
    git(review.path, ['commit', '--allow-empty', '-m', 'drifted checkout'])
    await assert.rejects(
      () => tower.submitReview(reviewerInput()),
      (error) => {
        assert.match(error.message, /checkout is at/)
        assert.match(error.message, /recorded review commit/)
        assert.match(error.message, /spawn a fresh reviewer/)
        return true
      },
    )
    assert.equal((await tower.load()).reviews?.length ?? 0, 0)
  } finally {
    removeTemp(root)
  }
})

test('a reviewer row without a recorded commit is refused, and teardown retries a leftover checkout', async () => {
  const { root, tower, branch } = await completedMission('dsh-tower-review-checkout-teardown-')
  try {
    await assert.rejects(
      () =>
        tower.recordSpawn({
          missionId: 'M1',
          name: 'reviewer-a',
          role: 'reviewer',
          agentId: 'agent-review',
          parentSessionId: 'parent-review',
          cwd: null,
          branch,
        }),
      (error) => {
        assert.equal(error.code, 'invalid-argument')
        assert.match(error.message, /has no recorded review commit/)
        assert.match(error.message, /spawn reviewers through tower_spawn/)
        return true
      },
    )

    const review = await tower.provisionReviewCheckout({ missionId: 'M1', name: 'reviewer-a' })
    await tower.recordSpawn({
      missionId: 'M1',
      name: 'reviewer-a',
      role: 'reviewer',
      agentId: 'agent-review',
      parentSessionId: 'parent-review',
      cwd: review.path,
      branch,
      reviewCommit: review.commit,
      reviewCheckout: review.path,
    })
    await tower.recordInterrupt({ name: 'reviewer-a' })

    const dry = await tower.teardown({ dryRun: true })
    assert.ok(
      dry.decisions.some(
        (decision) => decision.name === 'reviewer-a' && decision.action === 'remove' && decision.checkout === review.path,
      ),
      JSON.stringify(dry.decisions),
    )
    assert.equal(fs.existsSync(review.path), true, 'a dry run removes nothing')

    const done = await tower.teardown({})
    assert.ok(done.reviewCheckoutsRemoved.includes('reviewer-a'))
    assert.equal(fs.existsSync(review.path), false)
    const row = (await tower.load()).roster.find((entry) => entry.name === 'reviewer-a')
    assert.equal(row.reviewCheckout, undefined)
    assert.equal(row.reviewCommit, review.commit, 'the commit stamp survives teardown')
  } finally {
    removeTemp(root)
  }
})
