// Focused unit tests for the pure mission policy modules extracted in P3a.
// No repository, store, Git, or adapters are involved.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeMissionInput,
  normalizePlanMissions,
  assignMissionIds,
  assertKnownDependencies,
  newMission,
} from '../domain/missions/plan.js'
import { applyMissionUpdate, normalizePauseCause } from '../domain/missions/lifecycle.js'
import {
  normalizeChecks,
  assertCompletionRequest,
  assertCompletionInbox,
  completionReport,
} from '../domain/missions/completion.js'
import {
  assertReviewableMission,
  resolveReviewActor,
  normalizeReviewVerdict,
  assertReviewerSpawnTip,
  reviewRound,
  reviewOutcome,
  reviewRecord,
  MAX_REVIEW_ROUNDS,
} from '../domain/missions/review.js'
import {
  normalizeFindingInput,
  newFinding,
  normalizeFindingActor,
  wantsFindingUpdate,
  readFindingsView,
  applyFindingUpdate,
  findingUpdateView,
} from '../domain/missions/findings.js'

const errorCode = (code) => (error) => error?.code === code

function mission(overrides = {}) {
  return {
    id: 'M1',
    title: 'Mission',
    kind: 'build',
    status: 'active',
    scope: ['src/**'],
    deps: [],
    tasks: [],
    blockers: [],
    notes: [],
    ...overrides,
  }
}

function config(overrides = {}) {
  return { mode: { requireResumeAuthorization: false }, ...overrides }
}

test('plan policy normalizes mission input and assigns contiguous ids', () => {
  const prepared = normalizePlanMissions({
    missions: [
      { title: ' Build it ', scope: ['./src//'], tasks: [' a ', 'b'], deps: ['M2', 'M2'] },
      { title: 'Survey', kind: 'survey', scope: [] },
    ],
  })
  assert.equal(prepared[0].title, 'Build it')
  assert.deepEqual(prepared[0].scope, ['src'])
  assert.deepEqual(prepared[0].tasks, [
    { text: 'a', status: 'open' },
    { text: 'b', status: 'open' },
  ])
  assert.deepEqual(prepared[0].deps, ['M2'])
  assert.equal(prepared[1].kind, 'survey')
  assert.deepEqual(assignMissionIds(prepared, 3).map((entry) => entry.id), ['M3', 'M4'])
  assert.doesNotThrow(() =>
    assertKnownDependencies(
      [{ id: 'M3', deps: ['M2'] }, { id: 'M4', deps: ['M3'] }],
      [{ id: 'M2' }],
    ),
  )
  assert.throws(
    () => assertKnownDependencies([{ id: 'M3', deps: ['M9'] }], []),
    /depends on unknown mission "M9"/,
  )
  const created = newMission('M5', { ...prepared[0], id: 'M5' }, 42)
  assert.equal(created.status, 'planned')
  assert.equal(created.createdAt, 42)
  assert.equal(created.reviewPolicy, 'required-clean')
})

test('plan policy keeps its stable invalid-argument messages', () => {
  assert.throws(() => normalizePlanMissions({ missions: [] }), /needs at least one mission/)
  assert.throws(() => normalizeMissionInput(null, 0), (error) => errorCode('invalid-argument')(error) && /missions\[0\]/.test(error.message))
  assert.throws(() => normalizeMissionInput({ title: 'x', kind: 'survey', reviewPolicy: 'none' }, 1), /requires a non-empty reviewExemptionReason/)
  assert.throws(() => normalizeMissionInput({ title: 'x', scope: ['src'], reviewPolicy: 'sometimes' }, 0), /reviewPolicy must be/)
  assert.throws(() => normalizeMissionInput({ title: 'x', scope: [] }, 0), /scope must not be empty/)
  assert.throws(
    () => normalizeMissionInput({ title: 'x', scope: ['src'], tasks: ['ok', ' '] }, 0),
    /tasks entries must be non-empty strings/,
  )
})

test('mission lifecycle applies status/task/note/scope transitions', () => {
  const current = mission({ tasks: [{ text: 'Write tests', status: 'open' }], notes: [] })
  const state = { missions: [current] }
  const paused = applyMissionUpdate({
    mission: current,
    state,
    input: { status: 'paused', pause_cause: 'user' },
    config: config(),
  })
  assert.deepEqual(paused.changes, ['status=paused'])
  assert.equal(current.status, 'paused')
  assert.equal(current.pauseCause, 'user')

  const dropped = applyMissionUpdate({
    mission: current,
    state,
    input: { task_drop: 'write', task_drop_reason: 'obsolete', note: 'dropped the stale task' },
    config: config(),
  })
  assert.deepEqual(dropped.changes, ['task_drop="Write tests"', 'note added'])
  assert.equal(current.tasks[0].status, 'dropped')
  assert.equal(current.tasks[0].note, 'obsolete')
  assert.ok(current.notes.some((note) => /task dropped: Write tests/.test(note)))

  const blocked = applyMissionUpdate({
    mission: current,
    state,
    input: { blocker: ' waiting ' },
    config: config(),
  })
  assert.deepEqual(blocked.changes, ['blocker added'])
  assert.equal(current.status, 'blocked')
  assert.deepEqual(current.blockers, ['waiting'])
})

test('mission lifecycle rejects invalid transitions, actor, and scope widening', () => {
  const current = mission()
  const state = { missions: [current, mission({ id: 'M2', status: 'active', scope: ['src/lib/**'] })] }
  assert.throws(
    () => applyMissionUpdate({ mission: current, state, input: { status: 'merged' }, config: config() }),
    (error) => error.code === 'invalid-transition' && /tower_merge/.test(error.message),
  )
  assert.throws(
    () => applyMissionUpdate({ mission: current, state, input: { status: 'planned' }, config: config() }),
    (error) => error.code === 'invalid-transition' && /cannot move from active to planned/.test(error.message),
  )
  assert.throws(
    () =>
      applyMissionUpdate({
        mission: current,
        state,
        input: { actor: { name: 'r', role: 'reviewer' }, note: 'x' },
        config: config(),
      }),
    (error) => error.code === 'not-authorized' && /reviewers submit tower_review/.test(error.message),
  )
  assert.throws(
    () =>
      applyMissionUpdate({
        mission: current,
        state,
        input: { actor: { name: 'w', role: 'worker' }, status: 'completed' },
        config: config(),
      }),
    (error) => error.code === 'not-authorized' && /workers report completion/.test(error.message),
  )
  assert.throws(
    () =>
      applyMissionUpdate({
        mission: current,
        state,
        input: { scope: ['src/lib/x/**'] },
        config: config(),
      }),
    /widened scope overlaps mission M2/,
  )
  assert.throws(
    () => applyMissionUpdate({ mission: current, state, input: {}, config: config() }),
    /requires at least one change/,
  )
  assert.equal(normalizePauseCause(undefined), 'user')
  assert.throws(() => normalizePauseCause('bogus'), /pause_cause must be one of/)
})

test('completion policy normalizes checks and validates the reporting worker', () => {
  assert.deepEqual(normalizeChecks(undefined), [])
  assert.deepEqual(
    normalizeChecks([{ name: ' test ', command: ' npm test ', exitCode: 0, evidence: ' ok ' }]),
    [{ name: 'test', command: 'npm test', exitCode: 0, evidence: 'ok' }],
  )
  assert.throws(() => normalizeChecks('check'), /checks must be an array/)
  assert.throws(() => normalizeChecks(Array.from({ length: 21 }, () => ({ name: 'x' }))), /at most 20 entries/)
  assert.throws(() => normalizeChecks([{ name: 'x', exitCode: 0.5 }]), /exitCode must be an integer/)

  const target = mission({ owner: 'worker-1', worktree: { path: '/w', branch: 'b', baseCommit: 'c' } })
  const worker = { name: 'worker-1', role: 'worker', state: 'active', agentId: 'a1', missionId: 'M1' }
  assert.equal(
    assertCompletionRequest({ mission: target, roster: [worker], input: { agentId: 'a1', report: 'done' } }),
    worker,
  )
  assert.throws(
    () => assertCompletionRequest({ mission: target, roster: [{ ...worker, state: 'failed' }], input: { agentId: 'a1', report: 'done' } }),
    /a stopped worker cannot report completion/,
  )
  assert.throws(
    () => assertCompletionRequest({ mission: target, roster: [worker], input: { agentId: 'a1', report: ' ' } }),
    /requires a non-empty report/,
  )
  assert.throws(
    () =>
      assertCompletionRequest({
        mission: mission({ owner: 'worker-1', tasks: [{ text: 'T', status: 'open' }], worktree: target.worktree }),
        roster: [worker],
        input: { agentId: 'a1', report: 'done' },
      }),
    /still has 1 open task/,
  )
  assert.throws(() => assertCompletionInbox({ mission: target, worker, unread: [{}] }), /unread inbox message/ )
  assert.deepEqual(completionReport({ report: ' done ', worker, checks: [{ name: 'c' }], now: 7 }), {
    report: 'done',
    by: 'worker-1',
    at: 7,
    checks: [{ name: 'c' }],
  })
})

test('review policy resolves actors, verdicts, rounds, and outcome', () => {
  const target = mission({ status: 'completed', worktree: { path: '/w', branch: 'b', baseCommit: 'c' }, owner: 'worker-1' })
  assert.throws(() => assertReviewableMission(mission({ worktree: null })), /has no worktree to review/)
  assert.deepEqual(
    resolveReviewActor({ mission: target, caller: undefined, actorRole: 'tower', agentId: 'a1', breakGlassReason: ' emergency ' }),
    { reviewerName: 'tower', reviewerRole: 'tower' },
  )
  assert.throws(
    () => resolveReviewActor({ mission: target, caller: undefined, actorRole: 'tower', agentId: 'a1', breakGlassReason: '' }),
    (error) => error.code === 'not-authorized' && /break-glass/.test(error.message),
  )
  assert.deepEqual(
    resolveReviewActor({
      mission: target,
      caller: { name: 'rev-1', role: 'reviewer', agentId: 'r1', missionId: 'M1', spawnTip: 'tip' },
      actorRole: undefined,
      agentId: 'r1',
      breakGlassReason: undefined,
    }),
    { reviewerName: 'rev-1', reviewerRole: 'reviewer' },
  )
  assert.throws(
    () =>
      resolveReviewActor({
        mission: target,
        caller: { name: 'worker-1', role: 'reviewer', agentId: 'r1', missionId: 'M1' },
        actorRole: undefined,
        agentId: 'r1',
        breakGlassReason: undefined,
      }),
    (error) => error.code === 'not-authorized' && /must differ from the worker/.test(error.message),
  )
  assert.throws(
    () => resolveReviewActor({ mission: target, caller: undefined, actorRole: undefined, agentId: 'ghost', breakGlassReason: undefined }),
    /not a registered reviewer/,
  )
  assert.throws(
    () => resolveReviewActor({ mission: target, caller: { name: 'w', role: 'worker', missionId: 'M1' }, actorRole: undefined, agentId: 'w', breakGlassReason: undefined }),
    /only an assigned reviewer/,
  )

  const verdict = normalizeReviewVerdict({ status: 'clean', merge: 'merge', findings: 'none', decision: 'verified', checks: ['c'] })
  assert.deepEqual(verdict, { status: 'clean', merge: 'merge', findings: 'none', decision: 'verified', checks: ['c'] })
  assert.throws(() => normalizeReviewVerdict({ status: 'nope', merge: 'merge', findings: 'x', decision: 'd' }), /status must be/)
  assert.throws(() => normalizeReviewVerdict({ status: 'clean', merge: 'merge', findings: 'x', decision: 'd' }), /findings text "none"/)
  assert.throws(() => normalizeReviewVerdict({ status: 'p1-1items', merge: 'merge', findings: 'none', decision: 'd' }), /must describe its findings/)
  assert.throws(() => normalizeReviewVerdict({ status: 'clean', merge: 'hold', findings: 'none', decision: '' }), /decision/)

  assert.throws(() => assertReviewerSpawnTip({ name: 'r', role: 'reviewer', spawnTip: 'old' }, 'new'), /modified the mission branch/)
  assert.throws(() => assertReviewerSpawnTip({ name: 'r', role: 'reviewer', spawnTip: '' }, 'new'), /no recorded spawn tip/)

  const rounds = reviewRound({
    reviews: [
      { branch: 'b', reviewer: 'rev-1', round: 1 },
      { branch: 'b', reviewer: 'rev-2', round: 2 },
      { branch: 'b', reviewer: 'rev-1', round: 3 },
    ],
    branch: 'b',
    reviewerName: 'rev-1',
    maxRoundsPerReviewer: 5,
  })
  assert.deepEqual(rounds, { reviewerRounds: 2, round: 4 })
  assert.throws(
    () =>
      reviewRound({
        reviews: Array.from({ length: MAX_REVIEW_ROUNDS }, (_, index) => ({ branch: 'b', reviewer: 'rev-1', round: index + 1 })),
        branch: 'b',
        reviewerName: 'rev-1',
        maxRoundsPerReviewer: undefined,
      }),
    /reached the 5-round cap/,
  )
  assert.deepEqual(reviewOutcome({ status: 'p1-2items', merge: 'hold', round: 4, reviewerName: 'rev-1' }), {
    returnToActive: true,
    note: 'review round 4 by rev-1: p1-2items (hold) — returned to active',
  })
  assert.equal(reviewOutcome({ status: 'clean', merge: 'merge', round: 4, reviewerName: 'rev-1' }).returnToActive, false)
})

test('review record projection keeps the persisted shape', () => {
  const record = reviewRecord({
    seq: 3,
    missionId: 'M1',
    branch: 'b',
    tip: 'abc',
    verdict: { status: 'clean', merge: 'merge', findings: 'none', checks: ['c'], decision: 'ok' },
    reviewerName: 'tower',
    reviewerRole: 'tower',
    round: 2,
    now: 9,
    breakGlassReason: 'emergency',
  })
  assert.equal(record.id, 'R3')
  assert.equal(record.mergeVerdict, 'merge')
  assert.equal(record.breakGlassReason, 'emergency')
  assert.equal(reviewRecord({
    seq: 4,
    missionId: 'M1',
    branch: 'b',
    tip: 'abc',
    verdict: { status: 'clean', merge: 'merge', findings: 'none', checks: [], decision: 'ok' },
    reviewerName: 'rev',
    reviewerRole: 'reviewer',
    round: 3,
    now: 10,
  }).breakGlassReason, undefined)
})

test('finding policy normalizes, filters, transitions, and projects', () => {
  const target = mission({ worktree: { path: '/w', branch: 'b', baseCommit: 'c' } })
  const fields = normalizeFindingInput(
    {
      type: 'bug',
      title: ' T ',
      summary: ' S ',
      details: ' D ',
      suggested_fix: ' F ',
      severity: 'high',
      location: ' src/a.js ',
      missionId: 'M1',
    },
    [target],
  )
  assert.deepEqual(fields, {
    type: 'bug',
    title: 'T',
    severity: 'high',
    summary: 'S',
    location: 'src/a.js',
    details: 'D',
    suggested_fix: 'F',
    missionId: 'M1',
    branch: 'b',
  })
  assert.throws(
    () => normalizeFindingInput({ type: 'bug', title: 'T', summary: 'S', details: 'D', suggested_fix: 'F', missionId: 'M9' }, [target]),
    (error) => error.code === 'mission-not-found',
  )
  assert.throws(
    () => normalizeFindingInput({ type: 'nope', title: 'T', summary: 'S', details: 'D', suggested_fix: 'F' }, []),
    /finding type must be one of/,
  )

  const finding = newFinding(fields, { seq: 2, now: 5, reportedBy: 'rev' })
  assert.equal(finding.id, 'F2')
  assert.equal(finding.status, 'open')
  assert.equal(finding.reportedBy, 'rev')

  const findings = [finding, { ...finding, id: 'F1', status: 'fixed', type: 'improve', severity: 'low', missionId: 'M2' }]
  const list = readFindingsView(findings, { status: 'open', limit: 1 })
  assert.equal(list.total, 2)
  assert.equal(list.filtered, 1)
  assert.equal(list.findings[0].id, 'F2')
  assert.equal(list.counts.fixed, 1)
  assert.equal(readFindingsView(findings, { id: 'F1' }).action, 'read')
  assert.throws(() => readFindingsView(findings, { id: 'missing' }), (error) => error.code === 'finding-not-found')
  assert.throws(() => readFindingsView(findings, { status: 'bogus' }), /finding status must be one of/)
  assert.equal(normalizeFindingActor(undefined).name, 'tower')
  assert.equal(wantsFindingUpdate({ id: 'F1', status: 'fixed' }), true)
  assert.equal(wantsFindingUpdate({ id: 'F1' }), false)

  const applied = applyFindingUpdate({ finding, input: { status: 'triaged', note: ' checking ' }, actor: { name: 'tower', role: 'tower' }, now: 6 })
  assert.equal(applied.noteAdded, true)
  assert.equal(finding.status, 'triaged')
  assert.equal(finding.closedAt, undefined)
  assert.deepEqual(finding.notes, [{ by: 'tower', at: 6, text: 'checking' }])
  assert.equal(finding.updatedAt, 6)
  applyFindingUpdate({ finding, input: { status: 'fixed' }, actor: { name: 'tower', role: 'tower' }, now: 7 })
  assert.equal(finding.closedAt, 7)
  applyFindingUpdate({ finding, input: { status: 'open' }, actor: { name: 'tower', role: 'tower' }, now: 8 })
  assert.equal(finding.closedAt, undefined)
  assert.throws(
    () => applyFindingUpdate({ finding, input: { status: 'triaged' }, actor: { name: 'rev', role: 'reviewer' }, now: 9 }),
    (error) => error.code === 'not-authorized',
  )
  assert.throws(
    () => applyFindingUpdate({ finding, input: { status: 'open' }, actor: { name: 'tower', role: 'tower' }, now: 9 }),
    (error) => error.code === 'invalid-transition',
  )
  assert.equal(findingUpdateView(finding, findings).action, 'updated')
})
