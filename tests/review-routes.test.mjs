// #108: multi-route review. When the first route submits a non-clean verdict it
// returns the mission to `active`; the remaining routes of the same round must
// still be able to record their verdicts for the same reviewed tip. A verdict
// for a tip that moved after the round was reviewed is rejected with an
// explanation instead of a generic status error.
//
// Drives the real `Tower` domain class against a temporary git repository; no
// DSH runtime and no model calls.
// Run with: node --test tests/review-routes.test.mjs
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

function seed(prefix = 'dsh-tower-review-routes-') {
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

/** Seed a completed mission whose worktree exists and is ready to review. */
async function completedMission(prefix) {
  const { root, repo } = seed(prefix)
  const tower = await Tower.open(repo)
  await tower.init({ towerAgentId: 'tower-agent' })
  await tower.plan({
    missions: [{ title: 'Multi-route review', scope: ['src/**'], tasks: ['write file', 'commit'] }],
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

async function recordReviewer(tower, wt, branch, name, agentId) {
  return tower.recordSpawn({
    missionId: 'M1',
    name,
    role: 'reviewer',
    agentId,
    parentSessionId: 'parent-review',
    cwd: wt,
    branch,
  })
}

function routeInput(agentId, overrides = {}) {
  return {
    missionId: 'M1',
    agentId,
    status: 'clean',
    merge: 'merge',
    findings: 'none',
    decision: 'reviewed the diff',
    ...overrides,
  }
}

test('a later review route records its verdict in the same round while the mission is active', async () => {
  const { root, tower, wt, branch } = await completedMission('dsh-tower-review-routes-same-tip-')
  try {
    const tip = await tower.revParse(wt, 'HEAD')
    await recordReviewer(tower, wt, branch, 'reviewer-a', 'agent-review-a')
    await recordReviewer(tower, wt, branch, 'reviewer-b', 'agent-review-b')

    const first = await tower.submitReview(
      routeInput('agent-review-a', {
        status: 'p1-1items',
        merge: 'hold',
        findings: 'route A found a P1 in src/a.txt',
        decision: 'route A: hold until fixed',
      }),
    )
    assert.equal(first.missionStatus, 'active')
    assert.equal(first.round, 1)
    assert.equal(first.review.round, 1)
    assert.equal(first.appended, false)

    // The first non-clean verdict returned the mission to `active`; route B was
    // spawned against the same tip and must still be recorded in round 1.
    const second = await tower.submitReview(routeInput('agent-review-b'))
    assert.equal(second.missionStatus, 'active')
    assert.equal(second.round, 1)
    assert.equal(second.appended, true)
    assert.equal(second.review.round, 1)
    assert.equal(second.review.reviewedCommit, tip)
    assert.equal(second.review.id, 'R2')
    assert.equal(second.review.seq, 2)

    const state = await tower.load()
    assert.equal(state.missions[0].status, 'active')
    assert.equal(state.reviews.length, 2)
    assert.deepEqual(state.reviews.map((review) => review.round), [1, 1])
    assert.deepEqual(state.reviews.map((review) => review.reviewedCommit), [tip, tip])
    assert.deepEqual(state.reviews.map((review) => review.status), ['p1-1items', 'clean'])
    assert.match(state.missions[0].notes.at(-1), /appended to the same round/)
    // A clean appended route never flips the mission back to completed.
    assert.equal(state.missions[0].status, 'active')
  } finally {
    removeTemp(root)
  }
})

test('a verdict for a tip that moved after the round was reviewed is rejected with an explanation', async () => {
  const { root, tower, wt, branch } = await completedMission('dsh-tower-review-routes-moved-tip-')
  try {
    const reviewedTip = await tower.revParse(wt, 'HEAD')
    await recordReviewer(tower, wt, branch, 'reviewer-a', 'agent-review-a')
    await tower.submitReview(
      routeInput('agent-review-a', {
        status: 'p2-1items',
        merge: 'fix-then-merge',
        findings: 'route A found a P2',
        decision: 'route A: fix then merge',
      }),
    )
    assert.equal((await tower.load()).missions[0].status, 'active')

    // The branch moves after the round was reviewed, so appending is illegal:
    // the next verdict must come from a fresh round after re-completion.
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'src', 'b.txt'), 'b\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'M1 b after review'])
    const movedTip = await tower.revParse(wt, 'HEAD')
    assert.notEqual(movedTip, reviewedTip)
    await recordReviewer(tower, wt, branch, 'reviewer-b', 'agent-review-b')

    await assert.rejects(
      () => tower.submitReview(routeInput('agent-review-b')),
      (error) => {
        assert.match(error.message, /returned it to active/)
        assert.match(error.message, /reviewed tip moved/)
        assert.match(error.message, new RegExp(reviewedTip.slice(0, 7)))
        assert.match(error.message, new RegExp(movedTip.slice(0, 7)))
        assert.match(error.message, /completed/)
        return true
      },
    )

    const state = await tower.load()
    assert.equal(state.reviews.length, 1)
    assert.equal(state.missions[0].status, 'active')
  } finally {
    removeTemp(root)
  }
})
