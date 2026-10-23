// #51 pilot: complete prepares outside the lock and commits only on the same
// state revision.
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

function seed(prefix = 'dsh-tower-two-phase-') {
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

test('complete rejects a state revision change prepared outside the lock', async () => {
  const { root, repo } = seed()
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-agent' })
    await tower.plan({ missions: [{ title: 'Two phase', scope: ['x/**'] }] })
    tower.checkCompletion = async () => ({
      state: { revision: 0 },
      mission: { id: 'M1' },
      worker: { name: 'worker-m1' },
      commits: 1,
    })
    await assert.rejects(
      () => tower.complete({ missionId: 'M1', agentId: 'worker-m1', report: 'done', checks: [] }),
      (error) => {
        assert.equal(error.code, 'stale-base')
        return true
      },
    )
  } finally {
    removeTemp(root)
  }
})

test('complete commits when the prepared revision is still current', async () => {
  const { root, repo } = seed()
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-agent' })
    await tower.plan({ missions: [{ title: 'Two phase ok', scope: ['x/**'] }] })
    const state = await tower.load()
    tower.checkCompletion = async () => ({
      state: { revision: state.revision },
      mission: { id: 'M1' },
      worker: { name: 'worker-m1' },
      commits: 1,
    })
    const result = await tower.complete({ missionId: 'M1', agentId: 'worker-m1', report: 'done', checks: [] })
    assert.equal(result.mission.status, 'completed')
    assert.equal((await tower.load()).missions[0].status, 'completed')
  } finally {
    removeTemp(root)
  }
})

test('recordSpawn captures the spawn tip outside the state lock', async () => {
  const { root, repo } = seed()
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-agent' })
    await tower.plan({ missions: [{ title: 'Spawn prepare', scope: ['x/**'] }] })
    let sawLock = null
    tower.tryGit = async () => {
      const fsmod = await import('node:fs')
      sawLock = fsmod.existsSync(tower.paths.lock)
      return 'abc123\n'
    }
    const entry = await tower.recordSpawn({
      missionId: 'M1', name: 'worker-m1', role: 'worker', agentId: 'agent-1',
      parentSessionId: 'parent-1', cwd: repo, branch: 'b',
    })
    assert.equal(sawLock, false)
    assert.equal(entry.spawnTip, 'abc123')
  } finally {
    removeTemp(root)
  }
})

/** Seed a completed mission whose worktree exists and is ready to review. */
async function completedMission(prefix) {
  const { root, repo } = seed(prefix)
  const tower = await Tower.open(repo)
  await tower.init({ towerAgentId: 'tower-agent' })
  await tower.plan({
    missions: [{ title: 'Review two phase', scope: ['src/**'], tasks: ['write file', 'commit'] }],
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
  return { root, tower, wt }
}

function reviewInput(overrides = {}) {
  return {
    missionId: 'M1',
    agentId: 'agent-not-in-roster',
    actor: { name: 'tower', role: 'tower' },
    status: 'clean',
    merge: 'merge',
    findings: 'none',
    decision: 'single in-scope file',
    breakGlassReason: 'two-phase test has no independent reviewer',
    ...overrides,
  }
}

test('submitReview runs prepare git calls without the state lock', async () => {
  const { root, tower } = await completedMission('dsh-tower-two-phase-review-lock-')
  try {
    let lockDuringAssertWorktree = null
    let lockDuringRevParse = null
    const assertWorktree = tower.assertWorktree.bind(tower)
    tower.assertWorktree = async (worktree) => {
      lockDuringAssertWorktree = fs.existsSync(tower.paths.lock)
      return assertWorktree(worktree)
    }
    const revParse = tower.revParse.bind(tower)
    tower.revParse = async (cwd, ref) => {
      lockDuringRevParse = fs.existsSync(tower.paths.lock)
      return revParse(cwd, ref)
    }
    const result = await tower.submitReview(reviewInput())
    assert.equal(lockDuringAssertWorktree, false)
    assert.equal(lockDuringRevParse, false)
    assert.equal(result.branchTip, result.review.reviewedCommit)
  } finally {
    removeTemp(root)
  }
})

test('submitReview rejects a state revision change prepared outside the lock', async () => {
  const { root, tower } = await completedMission('dsh-tower-two-phase-review-stale-')
  try {
    const revParse = tower.revParse.bind(tower)
    tower.revParse = async (cwd, ref) => {
      // Simulate another writer landing between prepare and the lock.
      await tower.mission({ id: 'M1', note: 'concurrent writer changed state during review preparation' })
      return revParse(cwd, ref)
    }
    await assert.rejects(
      () => tower.submitReview(reviewInput()),
      (error) => {
        assert.equal(error.code, 'stale-base')
        return true
      },
    )
    const state = await tower.load()
    assert.equal(state.reviews?.length ?? 0, 0)
    assert.equal(state.reviewSeq ?? 0, 0)
    assert.equal(state.missions[0].status, 'completed')
  } finally {
    removeTemp(root)
  }
})

test('submitReview commits when the prepared revision is still current', async () => {
  const { root, tower } = await completedMission('dsh-tower-two-phase-review-ok-')
  try {
    const result = await tower.submitReview(reviewInput())
    assert.equal(result.round, 1)
    assert.equal(result.reviewerRounds, 1)
    assert.equal(result.missionStatus, 'completed')
    assert.equal(result.review.id, 'R1')
    assert.equal(result.review.seq, 1)
    assert.equal(result.review.round, 1)
    assert.equal(result.review.status, 'clean')
    assert.equal(result.review.reviewer, 'tower')
    assert.equal(result.branchTip, result.review.reviewedCommit)

    const state = await tower.load()
    assert.equal(state.reviews.length, 1)
    assert.equal(state.reviewSeq, 1)
    assert.match(state.missions[0].notes.at(-1), /^review round 1 by tower: clean \(merge\)$/)
  } finally {
    removeTemp(root)
  }
})
