// Pure read-model projections extracted from app/read.js, app/missionContext.js,
// and app/enrichedMissions.js (P3b).
import test from 'node:test'
import assert from 'node:assert/strict'
import { missionContextView } from '../domain/read/missionContext.js'
import {
  enrichedMissionView,
  latestReviewForMission,
  missionsToEnrich,
} from '../domain/read/enrichedMissions.js'
import { diffView, missionDetailView, patchLimit, statusView } from '../domain/read/views.js'

function mission(overrides = {}) {
  return {
    id: 'M1',
    title: 'Mission',
    kind: 'build',
    status: 'active',
    scope: ['src/**'],
    deps: [],
    tasks: [],
    ...overrides,
  }
}

function review(overrides = {}) {
  return {
    id: 'R1',
    missionId: 'M1',
    branch: 'tower/m1',
    round: 1,
    status: 'clean',
    mergeVerdict: 'merge',
    reviewedCommit: 'abc',
    at: 1,
    ...overrides,
  }
}

test('mission-context projection sorts/slices reviews, findings and deps', () => {
  const target = mission({
    worktree: { path: '/wt', branch: 'tower/m1', baseCommit: 'b' },
    deps: ['M2', 'M9'],
    completionReport: { report: 'done' },
  })
  const state = {
    base: 'main',
    snapshotCommit: 'snap',
    missions: [target, mission({ id: 'M2', title: 'Dep', status: 'merged' })],
    reviews: [
      review({ id: 'R1', round: 1 }),
      review({ id: 'R4', round: 4 }),
      review({ id: 'R2', round: 2 }),
      review({ id: 'R3', round: 3 }),
      review({ id: 'RX', branch: 'other', round: 9 }),
    ],
    findings: [
      { id: 'F1', seq: 1, type: 'bug', title: 'one', missionId: 'M1' },
      { id: 'F3', seq: 3, type: 'bug', title: 'three', missionId: 'M1' },
      { id: 'F2', seq: 2, type: 'bug', title: 'two', missionId: 'M1' },
      { id: 'FX', seq: 9, type: 'bug', title: 'other', missionId: 'M2' },
    ],
  }
  const view = missionContextView({ state, mission: target })
  assert.equal(view.base, 'main')
  assert.equal(view.snapshotCommit, 'snap')
  assert.equal(view.completionReport.report, 'done')
  assert.deepEqual(view.reviews.map((entry) => entry.id), ['R4', 'R3', 'R2'])
  assert.deepEqual(view.reviews[0], {
    id: 'R4',
    round: 4,
    status: 'clean',
    mergeVerdict: 'merge',
    reviewer: undefined,
    findings: undefined,
    checks: [],
    decision: undefined,
    reviewedCommit: 'abc',
    at: 1,
  })
  assert.deepEqual(view.findings.map((entry) => entry.id), ['F3', 'F2', 'F1'])
  assert.deepEqual(view.deps, [
    { id: 'M2', title: 'Dep', status: 'merged' },
    { id: 'M9', title: null, status: 'unknown' },
  ])
  assert.equal(missionContextView({ state: { ...state, reviews: [] }, mission: { ...target, worktree: null } }).reviews.length, 0)
})

test('dashboard enrichment selects the latest branch review and projects it', () => {
  const target = mission({
    worktree: { path: '/wt', branch: 'tower/m1', baseCommit: 'b' },
  })
  const state = {
    missions: [target, mission({ id: 'M2' })],
    reviews: [
      review({ id: 'R1', round: 1, reviewerRole: 'reviewer' }),
      review({ id: 'R2', round: 2, reviewerRole: 'tower', reviewedCommit: 'tip' }),
      review({ id: 'RX', missionId: 'M2', branch: 'other', round: 9 }),
    ],
  }
  assert.equal(latestReviewForMission(state, target).id, 'R2')
  assert.equal(latestReviewForMission(state, mission({ id: 'M3' })), null)
  assert.deepEqual(missionsToEnrich(state.missions, null).map((entry) => entry.id), ['M1', 'M2'])
  assert.deepEqual(missionsToEnrich(state.missions, ['M2']).map((entry) => entry.id), ['M2'])
  assert.deepEqual(missionsToEnrich(state.missions, []), [])
  const view = enrichedMissionView({ mission: target, latest: latestReviewForMission(state, target), tipMoved: true })
  assert.equal(view.id, 'M1')
  assert.equal(view.tipMoved, true)
  assert.deepEqual(view.review, {
    id: 'R2',
    round: 2,
    status: 'clean',
    mergeVerdict: 'merge',
    reviewer: undefined,
    reviewerRole: 'tower',
    reviewedCommit: 'tip',
    at: 1,
  })
  assert.equal(enrichedMissionView({ mission: target, latest: null, tipMoved: false }).review, null)
})

test('status view counts missions, tasks, findings and recent entries', () => {
  const state = {
    repoRoot: '/repo',
    commonDir: '/repo/.git',
    base: 'main',
    revision: 4,
    towerAgentId: null,
    missions: [
      mission({ id: 'M1', status: 'active', tasks: [{ text: 'a', status: 'open' }, { text: 'b', status: 'done' }] }),
      mission({ id: 'M2', status: 'merged', tasks: [] }),
      mission({ id: 'M3', status: 'active', tasks: [{ text: 'c', status: 'dropped' }, { text: 'd', status: 'open' }] }),
    ],
    roster: [{ name: 'w' }],
    messages: [{ id: 'm1' }, { id: 'm2' }],
    findings: [
      { id: 'F1', status: 'open' },
      { id: 'F2', status: 'triaged' },
      { id: 'F3', status: 'fixed' },
      { id: 'F4', status: 'open' },
      { id: 'F5', status: 'wontfix' },
      { id: 'F6', status: undefined },
      { id: 'F7', status: 'open' },
    ],
    reviews: [{ id: 'R1' }],
  }
  const view = statusView({
    state,
    statePath: '/repo/.git/dsh-tower/state.json',
    activity: [{ at: 1, type: 'init', text: 'x' }],
    unreadTower: 2,
    config: { configPath: '/cfg', repoConfigPresent: true, spawn: { workerPreset: 'w', reviewerPreset: null } },
    missions: [{ id: 'M1' }],
  })
  assert.equal(view.repoRoot, '/repo')
  assert.equal(view.ownerMissing, true)
  assert.deepEqual(view.counts, { planned: 0, active: 2, completed: 0, blocked: 0, paused: 0, merged: 1, abandoned: 0 })
  assert.equal(view.openTasks, 2)
  assert.equal(view.roster, 1)
  assert.equal(view.messages, 2)
  assert.equal(view.unreadTower, 2)
  assert.equal(view.findings, 7)
  assert.deepEqual(view.findingsByStatus, { open: 4, triaged: 1, fixed: 1, wontfix: 1 })
  assert.equal(view.reviews, 1)
  assert.deepEqual(view.config, {
    path: '/cfg',
    repoConfigPresent: true,
    spawn: { workerPreset: 'w', reviewerPreset: null },
  })
  assert.deepEqual(view.recentFindings.map((entry) => entry.id), ['F3', 'F4', 'F5', 'F6', 'F7'])
  assert.deepEqual(view.missions, [{ id: 'M1' }])
  assert.deepEqual(view.activity, [{ at: 1, type: 'init', text: 'x' }])
})

test('mission-detail projection filters findings/activity and sorts reviews', () => {
  const target = mission({ id: 'M1', worktree: { path: '/wt', branch: 'tower/m1', baseCommit: 'b' } })
  const state = {
    reviews: [
      review({ id: 'byMission', missionId: 'M1', branch: 'old', round: 2 }),
      review({ id: 'byBranch', missionId: 'other', branch: 'tower/m1', round: 1 }),
      review({ id: 'unrelated', missionId: 'M2', branch: 'other', round: 9 }),
    ],
    findings: [
      { id: 'F1', seq: 1, missionId: 'M1', type: 'bug', title: 'one' },
      { id: 'F2', seq: 2, missionId: 'M2', type: 'bug', title: 'two' },
      { id: 'F3', seq: 3, missionId: 'M1', type: 'bug', title: 'three' },
    ],
  }
  const activity = [
    { missionId: 'M1', text: 'a' },
    { missionId: 'M2', text: 'b' },
    { text: 'global' },
    { missionId: 'M1', text: 'c' },
  ]
  const view = missionDetailView({ state, mission: target, activity })
  assert.deepEqual(view.reviews.map((entry) => entry.id), ['byMission', 'byBranch'])
  assert.deepEqual(view.findings.map((entry) => entry.id), ['F1', 'F3'])
  assert.deepEqual(view.activity.map((entry) => entry.text), ['a', 'c'])
  assert.equal(view.mission.id, 'M1')
})

test('diff projection applies the byte limit and truncation flag', () => {
  const patch = 'x'.repeat(70 * 1024)
  const base = {
    mission: mission({ worktree: { path: '/wt', branch: 'tower/m1', baseCommit: 'b' } }),
    baseTip: 'base',
    branchTip: 'tip',
    mergeBase: 'merge',
    files: ['a'],
    commits: ['c1'],
    fullPatch: patch,
  }
  assert.equal(patchLimit(undefined), 64 * 1024)
  assert.equal(patchLimit(10), 10)
  assert.equal(patchLimit(0), 64 * 1024)
  const view = diffView(base)
  assert.equal(view.branch, 'tower/m1')
  assert.equal(view.truncated, true)
  assert.equal(view.patch.length, 64 * 1024)
  const limited = diffView({ ...base, maxBytes: 5 })
  assert.equal(limited.truncated, true)
  assert.equal(limited.patch.length, 5)
  const full = diffView({ ...base, fullPatch: 'short' })
  assert.equal(full.truncated, false)
})
