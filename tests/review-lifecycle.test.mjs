// M63 W2-B: one review resolver. "Latest review" is defined exactly once
// (`latestReview` in domain/integration/review.js): the highest round wins, and
// inside one round the most recently recorded verdict (highest `seq`) wins. The
// same rule has to drive submission admission, the merge gate, the status
// projection and the briefing, so an appended clean verdict supersedes an
// earlier non-clean verdict of the same round and a stale same-round verdict can
// never decide a moved tip.
//
// Drives the real `Tower` domain class against a temporary git repository; no
// DSH runtime and no model calls.
// Run with: node --test tests/review-lifecycle.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { Tower } from '../host/tower.js'
import { latestReview, reviewsNewestFirst } from '../domain/integration/review.js'
import { reviewAdmission } from '../domain/missions/review.js'
import { validateState } from '../domain/state.js'

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
  // Deterministic fixture bytes on every platform (Windows defaults to CRLF).
  git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo }
}

/** Seed a repo whose merge gate is on, then a completed mission ready to review. */
async function completedMission(prefix) {
  const { root, repo } = seed(prefix)
  const configDir = path.join(repo, '.git', 'dsh-tower')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ review: { mode: 'required' } }))
  const tower = await Tower.open(repo)
  await tower.init({ towerAgentId: 'tower-agent' })
  await tower.plan({
    missions: [{ title: 'Review lifecycle', scope: ['src/**'], tasks: ['write file', 'commit'] }],
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
    reviewCommit: git(wt, ['rev-parse', 'HEAD']),
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

const BRANCH = 'tower/m1-review-lifecycle'
const TIP = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)

/** One review row, with the recency keys under test. */
function row(overrides = {}) {
  return {
    id: 'R1',
    missionId: 'M1',
    branch: BRANCH,
    round: 1,
    seq: 1,
    status: 'p1-1items',
    mergeVerdict: 'fix-then-merge',
    reviewedCommit: TIP,
    ...overrides,
  }
}

test('latest review: highest round wins, then the most recently recorded verdict of that round', () => {
  const p1 = row()
  const clean = row({ id: 'R2', seq: 2, status: 'clean', mergeVerdict: 'merge' })

  // Submission sequence decides inside a round regardless of storage order.
  assert.equal(latestReview([p1, clean]).id, 'R2')
  assert.equal(latestReview([clean, p1]).id, 'R2')
  // A later round always outranks a higher sequence in an earlier round.
  const nextRound = row({ id: 'R3', round: 2, seq: 1, status: 'clean', mergeVerdict: 'merge' })
  assert.equal(latestReview([nextRound, clean, p1]).id, 'R3')
  // Equal round and equal sequence are the same age: the first stored row stays.
  assert.equal(latestReview([p1, row({ id: 'R2', status: 'clean', mergeVerdict: 'merge' })]).id, 'R1')
  assert.equal(latestReview([p1]).id, 'R1')
  assert.equal(latestReview([]), null)

  // The newest-first projection reads the same comparison.
  assert.deepEqual(reviewsNewestFirst([p1, clean]).map((review) => review.id), ['R2', 'R1'])
  assert.deepEqual(reviewsNewestFirst([clean, p1]).map((review) => review.id), ['R2', 'R1'])
})

test('latest review: the resolver and admission do not mutate their inputs', () => {
  const reviews = Object.freeze([
    Object.freeze(row()),
    Object.freeze(row({ id: 'R2', seq: 2, status: 'clean', mergeVerdict: 'merge' })),
  ])
  const before = JSON.stringify(reviews)

  assert.equal(latestReview(reviews).id, 'R2')
  const newestFirst = reviewsNewestFirst(reviews)
  assert.deepEqual(newestFirst.map((review) => review.id), ['R2', 'R1'])
  assert.notEqual(newestFirst, reviews, 'the projection returns a new array')
  assert.equal(JSON.stringify(reviews), before, 'the stored ledger row order is untouched')

  // Admission shares the resolver: with a clean row as the newest verdict the
  // cause names a moved tip, not a non-clean verdict that returned the mission
  // to active. Both storage orders must say the same thing.
  const p1 = row()
  const clean = row({ id: 'R2', seq: 2, status: 'clean', mergeVerdict: 'merge' })
  const mission = { id: 'M1', status: 'active' }
  for (const ordered of [
    [p1, clean],
    [clean, p1],
  ]) {
    assert.deepEqual(reviewAdmission({ mission, reviews: ordered, branch: BRANCH, tip: TIP }), {
      appended: true,
      round: 1,
    })
    assert.throws(
      () => reviewAdmission({ mission, reviews: ordered, branch: BRANCH, tip: MOVED }),
      (error) => {
        assert.match(error.message, /the reviewed tip moved/)
        assert.doesNotMatch(error.message, /returned it to active/)
        assert.match(error.message, /round 1/)
        return true
      },
    )
  }
})

test('submission, gate, status and briefing agree on the newest same-round verdict', async () => {
  const { root, tower, wt, branch } = await completedMission('dsh-tower-review-lifecycle-agree-')
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
    assert.equal(first.appended, false)
    assert.equal(first.round, 1)
    assert.equal(first.missionStatus, 'active')

    // Route B was spawned against the same tip: it appends to round 1.
    const second = await tower.submitReview(routeInput('agent-review-b'))
    assert.equal(second.appended, true)
    assert.equal(second.round, 1)
    assert.equal(second.review.id, 'R2')
    assert.equal(second.review.seq, 2)
    assert.equal(second.review.reviewedCommit, tip)

    // The ledger keeps chronological append order; only the resolver reorders.
    const state = await tower.load()
    assert.deepEqual(state.reviews.map((review) => review.id), ['R1', 'R2'])
    assert.deepEqual(state.reviews.map((review) => review.seq), [1, 2])
    assert.deepEqual(state.reviews.map((review) => review.status), ['p1-1items', 'clean'])

    // The markdown board (tower_status format:"markdown" / MISSIONS.md artifact)
    // renders the shared latest verdict; a round-only reducer keeps the first
    // stored row of the round and would show the stale R1 here.
    const board = tower.boardMarkdown(state)
    // The board labels the row by round, not ledger id, so the status/verdict
    // text is what distinguishes the newest same-round verdict from the stale one.
    assert.ok(board.includes('R1 clean/merge'), 'board shows the newest same-round verdict')
    assert.doesNotMatch(board, /p1-1items/, 'board must not show the stale same-round verdict')
    assert.deepEqual(
      state.reviews.map((review) => review.id),
      ['R1', 'R2'],
      'projecting the board must not reorder the ledger',
    )

    // Status projection.
    const status = await tower.status({ missionIds: ['M1'] })
    assert.equal(status.missions[0].review.id, 'R2')
    assert.equal(status.missions[0].tipMoved, false)

    // Briefing projection: newest first means R2 before R1, not storage order.
    const context = await tower.missionContext('M1')
    assert.deepEqual(
      context.reviews.slice(0, 2).map((review) => review.id),
      ['R2', 'R1'],
    )

    // Re-completion re-arms the gate: the newest verdict is clean + merge, so the
    // stale p1 of the same round must not block.
    await tower.complete({ missionId: 'M1', agentId: 'agent-worker', report: 'addressed route A findings' })
    const gate = await tower.evaluateGate({ missionId: 'M1', action: 'preflight' })
    assert.equal(gate.review.id, 'R2')
    assert.equal(gate.review.reviewedCommit, tip)
    const codes = gate.blockers.map((blocker) => blocker.code)
    for (const stale of ['no-review', 'not-clean', 'review-hold', 'tip-moved']) {
      assert.equal(codes.includes(stale), false, `${stale} in ${JSON.stringify(gate.blockers)}`)
    }
    assert.equal(gate.ok, true, JSON.stringify(gate.blockers))

    // State semantics guard the two keys the resolver reads.
    const brokenRound = structuredClone(state)
    brokenRound.reviews[1].round = 0
    assert.throws(() => validateState(brokenRound, ''), /review R2 has invalid round 0/)
    const brokenSeq = structuredClone(state)
    brokenSeq.reviews[0].seq = -1
    assert.throws(() => validateState(brokenSeq, ''), /review R1 has invalid sequence -1/)
    // Legacy rows that never recorded the keys stay readable (schema v5).
    const missingKeys = structuredClone(state)
    delete missingKeys.reviews[0].seq
    delete missingKeys.reviews[0].round
    assert.doesNotThrow(() => validateState(missingKeys, ''))
  } finally {
    removeTemp(root)
  }
})

test('a moved tip is judged against the newest same-round verdict, never the stale one', async () => {
  const { root, tower, wt, branch } = await completedMission('dsh-tower-review-lifecycle-moved-')
  try {
    const reviewedTip = await tower.revParse(wt, 'HEAD')
    await recordReviewer(tower, wt, branch, 'reviewer-a', 'agent-review-a')
    await recordReviewer(tower, wt, branch, 'reviewer-b', 'agent-review-b')
    await tower.submitReview(
      routeInput('agent-review-a', {
        status: 'p2-1items',
        merge: 'fix-then-merge',
        findings: 'route A found a P2',
        decision: 'route A: fix then merge',
      }),
    )
    const appended = await tower.submitReview(routeInput('agent-review-b'))
    assert.equal(appended.appended, true)
    assert.equal(appended.round, 1)

    // The branch moves after the clean appended verdict. A resolver that kept
    // the first row of the round would name the stale p2 and say it "returned
    // it to active"; the newest row is clean, so the cause is a moved tip.
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'src', 'b.txt'), 'b\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'M1 b after review'])
    const movedTip = await tower.revParse(wt, 'HEAD')
    assert.notEqual(movedTip, reviewedTip)
    await recordReviewer(tower, wt, branch, 'reviewer-c', 'agent-review-c')

    await assert.rejects(
      () => tower.submitReview(routeInput('agent-review-c')),
      (error) => {
        assert.match(error.message, /the reviewed tip moved/)
        assert.doesNotMatch(error.message, /returned it to active/)
        assert.match(error.message, new RegExp(reviewedTip.slice(0, 7)))
        assert.match(error.message, new RegExp(movedTip.slice(0, 7)))
        assert.match(error.message, /completed/)
        return true
      },
    )

    const state = await tower.load()
    assert.deepEqual(state.reviews.map((review) => review.id), ['R1', 'R2'])
    assert.equal(state.missions[0].status, 'active')
  } finally {
    removeTemp(root)
  }
})
