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
import { applyMissionUpdate, normalizeMissionBatch, normalizePauseCause } from '../domain/missions/lifecycle.js'
import {
  normalizeChecks,
  assertCompletionRequest,
  assertCompletionInbox,
  completionReport,
  applyCompletion,
} from '../domain/missions/completion.js'
import {
  assertReviewableMission,
  resolveReviewActor,
  normalizeReviewVerdict,
  reviewRound,
  reviewAdmission,
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
  }, { commit: 'read-commit', dirty: [] })
  assert.equal(prepared[0].title, 'Build it')
  assert.deepEqual(prepared[0].scope, ['src'])
  assert.deepEqual(prepared[0].tasks, [
    { text: 'a', status: 'open' },
    { text: 'b', status: 'open' },
  ])
  assert.deepEqual(prepared[0].deps, ['M2'])
  assert.equal(prepared[1].kind, 'survey')
  assert.equal(prepared[1].readCommit, 'read-commit')
  assert.deepEqual(prepared[1].readDirty, [])
  assert.deepEqual(prepared[1].scope, [])
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

test('task_add appends open tasks at the tail without reordering existing tasks', () => {
  const current = mission({
    status: 'planned',
    tasks: [
      { text: 'Done task', status: 'done' },
      { text: 'Dropped task', status: 'dropped', note: 'obsolete' },
    ],
  })
  const updated = applyMissionUpdate({
    mission: current,
    state: { missions: [current] },
    input: { task_add: [' first new ', 'second new'] },
    config: config(),
  })
  assert.deepEqual(updated.changes, ['task_add="first new"', 'task_add="second new"'])
  assert.deepEqual(current.tasks, [
    { text: 'Done task', status: 'done' },
    { text: 'Dropped task', status: 'dropped', note: 'obsolete' },
    { text: 'first new', status: 'open' },
    { text: 'second new', status: 'open' },
  ])
  assert.equal(current.status, 'planned')
})

test('task_add is allowed on paused and blocked missions', () => {
  const paused = mission({ status: 'paused', pauseCause: 'user' })
  applyMissionUpdate({
    mission: paused,
    state: { missions: [paused] },
    input: { task_add: ['resume work'] },
    config: config(),
  })
  assert.deepEqual(paused.tasks, [{ text: 'resume work', status: 'open' }])
  assert.equal(paused.status, 'paused')

  const blocked = mission({ status: 'blocked', blockers: ['waiting on review'] })
  applyMissionUpdate({
    mission: blocked,
    state: { missions: [blocked] },
    input: { task_add: ['after the blocker'] },
    config: config(),
  })
  assert.deepEqual(blocked.tasks, [{ text: 'after the blocker', status: 'open' }])
  assert.equal(blocked.status, 'blocked')
})

test('task_add refuses terminal missions and leaves the task list untouched', () => {
  for (const status of ['completed', 'merged', 'abandoned']) {
    const current = mission({ status, tasks: [{ text: 'already done', status: 'done' }] })
    assert.throws(
      () =>
        applyMissionUpdate({
          mission: current,
          state: { missions: [current] },
          input: { task_add: ['reopen'] },
          config: config(),
        }),
      (error) => error.code === 'invalid-transition' && new RegExp(`is ${status}; a terminal mission`).test(error.message),
    )
    assert.deepEqual(current.tasks, [{ text: 'already done', status: 'done' }])
  }

  // A patch that would move the mission to a terminal status is refused before
  // the status transition, so it cannot append and close in one step.
  const active = mission()
  assert.throws(
    () =>
      applyMissionUpdate({
        mission: active,
        state: { missions: [active] },
        input: { status: 'completed', task_add: ['after completion'] },
        config: config(),
      }),
    (error) => error.code === 'invalid-transition' && /is completed; a terminal mission/.test(error.message),
  )
  assert.deepEqual(active.tasks, [])
  assert.equal(active.status, 'active')
})

test('task_add validates its array shape and names each constraint', () => {
  const current = mission()
  const apply = (task_add) =>
    applyMissionUpdate({ mission: current, state: { missions: [current] }, input: { task_add }, config: config() })
  assert.throws(() => apply('one task'), (error) => error.code === 'invalid-argument' && /task_add must be an array/.test(error.message))
  assert.throws(() => apply([]), /task_add must contain at least one task/)
  assert.throws(() => apply(Array.from({ length: 21 }, (_, index) => `task ${index}`)), /at most 20 tasks/)
  assert.throws(() => apply(['ok', '   ']), /task_add\[1\] must be a non-empty string/)
  assert.throws(() => apply(['x'.repeat(201)]), /task_add\[0\] must be at most 200 characters/)
  assert.deepEqual(current.tasks, [])
})

test('appended open tasks keep tower_complete closed until they are handled', () => {
  const current = mission({
    owner: 'worker-1',
    worktree: { path: '/w', branch: 'b', baseCommit: 'c' },
    tasks: [{ text: 'existing', status: 'done' }],
  })
  applyMissionUpdate({
    mission: current,
    state: { missions: [current] },
    input: { task_add: ['new work'] },
    config: config(),
  })
  const worker = { name: 'worker-1', role: 'worker', state: 'active', agentId: 'a1', missionId: 'M1' }
  assert.throws(
    () => assertCompletionRequest({ mission: current, roster: [worker], input: { agentId: 'a1', report: 'done' } }),
    /still has 1 open task/,
  )
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

test('a planned mission edits its scope without starting', () => {
  const planned = mission({ status: 'planned', scope: ['src/**'] })
  const state = { missions: [planned, mission({ id: 'M2', status: 'active', scope: ['lib/**'] })] }
  const updated = applyMissionUpdate({
    mission: planned,
    state,
    input: { scope: ['src/lib/**'] },
    config: config(),
  })
  assert.deepEqual(updated.changes, ['scope edited'])
  assert.equal(planned.status, 'planned')
  assert.equal(planned.scopeGeneration, 2)
  assert.deepEqual(planned.scope, ['src/lib/**'])
})

test('a combined status and scope patch on a planned mission records a planned edit', () => {
  const planned = mission({ status: 'planned', scope: ['src/**'] })
  const state = { missions: [planned] }
  const updated = applyMissionUpdate({
    mission: planned,
    state,
    input: { status: 'active', scope: ['src/lib/**'] },
    config: config(),
  })
  assert.deepEqual(updated.changes, ['status=active', 'scope edited'])
  assert.equal(planned.status, 'active')
  assert.equal(planned.scopeGeneration, 2)
  assert.deepEqual(planned.scope, ['src/lib/**'])
})

test('a deferred mission is skipped by the widen overlap check', () => {
  const active = mission({ id: 'M1', status: 'active', scope: ['src/**'] })
  const wide = mission({ id: 'M2', status: 'planned', scope: ['**'] })
  const state = { missions: [active, wide] }

  assert.throws(
    () => applyMissionUpdate({ mission: active, state, input: { scope: ['docs/**'] }, config: config() }),
    (error) => /overlaps mission M2/.test(error.message) && /defer/.test(error.message),
  )

  const deferred = applyMissionUpdate({ mission: wide, state, input: { deferred: true }, config: config() })
  assert.deepEqual(deferred.changes, ['deferred=true'])
  assert.equal(wide.deferred, true)
  assert.equal(wide.status, 'planned')

  const widened = applyMissionUpdate({ mission: active, state, input: { scope: ['docs/**'] }, config: config() })
  assert.deepEqual(widened.changes, ['scope widened'])

  const undeferred = applyMissionUpdate({ mission: wide, state, input: { deferred: false }, config: config() })
  assert.deepEqual(undeferred.changes, ['deferred=false'])
  assert.equal(wide.deferred, undefined)
  assert.throws(
    () => applyMissionUpdate({ mission: active, state, input: { scope: ['docs/guide/**'] }, config: config() }),
    /overlaps mission M2; .*defer/,
  )

  const completed = mission({ id: 'M3', status: 'completed' })
  assert.throws(
    () =>
      applyMissionUpdate({
        mission: completed,
        state: { missions: [completed] },
        input: { deferred: true },
        config: config(),
      }),
    (error) =>
      error.code === 'invalid-argument' &&
      /deferred is only valid for planned or active missions, not completed/.test(error.message),
  )
  // A planned survey is refused because it owns no paths, not because `planned`
  // would be an invalid status: the message must name the real reason (F99).
  const survey = mission({ id: 'S1', kind: 'survey', status: 'planned', scope: [] })
  assert.throws(
    () =>
      applyMissionUpdate({
        mission: survey,
        state: { missions: [survey] },
        input: { deferred: true },
        config: config(),
      }),
    (error) =>
      error.code === 'invalid-argument' &&
      /a survey owns no paths and cannot be deferred/.test(error.message) &&
      !/planned or active missions/.test(error.message),
  )
})

test('a worker cannot defer its own mission', () => {
  // `deferred` takes a mission out of the widen overlap gate, so it stays a
  // tower-only ordering decision even on the worker's own mission (#205).
  const current = mission({ id: 'M1', status: 'active', owner: 'w', scope: ['src/**'] })
  const state = { missions: [current] }
  const deny = (deferred) =>
    assert.throws(
      () =>
        applyMissionUpdate({
          mission: current,
          state,
          input: { actor: { name: 'w', role: 'worker' }, deferred },
          config: config(),
        }),
      (error) => error.code === 'not-authorized' && /only the tower can defer a mission/.test(error.message),
    )
  deny(true)
  deny(false)
  assert.equal(current.deferred, undefined)
  assert.equal(current.status, 'active')
  assert.deepEqual(current.scope, ['src/**'])
  assert.equal(current.scopeGeneration, undefined)
})

test('a planned mission pauses with a cause and returns to planning without authorization', () => {
  const planned = mission({ id: 'M1', status: 'planned', scope: ['src/**'] })
  const state = { missions: [planned] }
  assert.throws(
    () => applyMissionUpdate({ mission: planned, state, input: { status: 'paused' }, config: config() }),
    (error) => error.code === 'invalid-argument' && /pause_cause/.test(error.message),
  )
  const paused = applyMissionUpdate({
    mission: planned,
    state,
    input: { status: 'paused', pause_cause: 'dependency' },
    config: config(),
  })
  assert.deepEqual(paused.changes, ['status=paused'])
  assert.equal(planned.status, 'paused')
  assert.equal(planned.pauseCause, 'dependency')

  // A paused mission no longer fences the widen path.
  const active = mission({ id: 'M2', status: 'active', scope: ['src/**'] })
  state.missions = [planned, active]
  const widened = applyMissionUpdate({ mission: active, state, input: { scope: ['src/lib/**'] }, config: config() })
  assert.deepEqual(widened.changes, ['scope widened'])

  // paused -> planned is a planning decision, not a resume: no authorization.
  const replanned = applyMissionUpdate({
    mission: planned,
    state,
    input: { status: 'planned' },
    config: config({ mode: { requireResumeAuthorization: true } }),
  })
  assert.deepEqual(replanned.changes, ['status=planned'])
  assert.equal(planned.status, 'planned')
  assert.equal(planned.pauseCause, undefined)

  // Only paused -> active needs the resume authorization.
  const pausedAgain = mission({ id: 'M3', status: 'paused', pauseCause: 'user', scope: ['other/**'] })
  state.missions = [planned, active, pausedAgain]
  assert.throws(
    () =>
      applyMissionUpdate({
        mission: pausedAgain,
        state,
        input: { status: 'active' },
        config: config({ mode: { requireResumeAuthorization: true } }),
      }),
    /authorization/,
  )
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
  // #232: refusing without a route left the only way forward in tower memory.
  // The refusal must name the bookkeeping-worker path AND warn that the status
  // is never hand-set.
  {
    let refusal = null
    try {
      assertCompletionRequest({ mission: target, roster: [{ ...worker, state: 'failed' }], input: { agentId: 'a1', report: 'done' } })
    } catch (error) {
      refusal = error
    }
    assert.ok(refusal, 'a stopped worker must be refused')
    assert.equal(refusal.code, 'invalid-transition', 'the stable code is unchanged')
    assert.match(refusal.message, /agent worker-1 is failed; a stopped worker cannot report completion/)
    assert.match(refusal.nextAction ?? '', /bookkeeping worker/)
    assert.match(refusal.nextAction ?? '', /tower_complete/)
    assert.match(refusal.nextAction ?? '', /never set the mission to "completed" by hand/)
    assert.match(refusal.message, /— next: .*bookkeeping worker/, 'the next action renders in the message')
    // The record a dead predecessor left behind is quoted when it exists.
    let withResidue = null
    try {
      assertCompletionRequest({
        mission: target,
        roster: [{ ...worker, state: 'stale', residue: { filesChanged: 3, branch: 'tower/m1-x' } }],
        input: { agentId: 'a1', report: 'done' },
      })
    } catch (error) {
      withResidue = error
    }
    assert.ok(withResidue)
    assert.match(withResidue.nextAction ?? '', /left 3 file\(s\) changed on tower\/m1-x/)
  }
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
    reportBytes: 4,
    by: 'worker-1',
    at: 7,
    checks: [{ name: 'c' }],
  })
})

// #231 R198: a recorded completion is the successor's own resolution of the
// death its briefing warned about, so the carry-over must not survive into a
// later fix worker's briefing. The completion transaction ends here (the app
// layer persists the returned state), so this is the last point that can clear it.
test('completion clears the predecessor residue carry-over', () => {
  const target = mission({
    status: 'active',
    worktree: { path: '/w', branch: 'b', baseCommit: 'c' },
    predecessorResidue: { name: 'worker-m1', filesChanged: 2 },
  })
  const applied = applyCompletion({ mission: target, report: 'done', now: 42 })
  assert.equal(applied.state.status, 'completed')
  assert.equal('predecessorResidue' in target, false, 'the carry-over does not outlive the completion')
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

  // #108: a later route appends to the round that returned the mission to
  // active, for the same reviewed tip only.
  const roundOne = [{ branch: 'b', reviewer: 'rev-1', round: 1, reviewedCommit: 'tip', status: 'p1-1items', seq: 1 }]
  assert.deepEqual(
    reviewAdmission({ mission: mission({ status: 'completed' }), reviews: roundOne, branch: 'b', tip: 'tip' }),
    { appended: false, round: null },
  )
  assert.deepEqual(
    reviewAdmission({ mission: mission({ status: 'active' }), reviews: roundOne, branch: 'b', tip: 'tip' }),
    { appended: true, round: 1 },
  )
  assert.throws(
    () => reviewAdmission({ mission: mission({ status: 'active' }), reviews: roundOne, branch: 'b', tip: 'moved' }),
    /reviewed tip moved/,
  )
  assert.throws(
    () => reviewAdmission({ mission: mission({ status: 'active' }), reviews: [], branch: 'b', tip: 'tip' }),
    /no review round to append to/,
  )
  assert.throws(
    () => reviewAdmission({ mission: mission({ status: 'blocked' }), reviews: roundOne, branch: 'b', tip: 'tip' }),
    /only a completed mission can be reviewed/,
  )
  assert.deepEqual(
    reviewOutcome({ status: 'clean', merge: 'merge', round: 1, reviewerName: 'rev-2', appended: true }),
    {
      returnToActive: false,
      note: 'review round 1 by rev-2: clean (merge) — appended to the same round; the mission stays active until it is re-completed',
    },
  )
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

// #216: bulk normalization is one pure gate in the lifecycle module. It keeps
// the forms mutually exclusive, keeps every bulk item inside the single-form
// field set, and refuses to smuggle human acceptance through a batch.
test('bulk mission normalization: one form, closed fields, atomic default', () => {
  assert.equal(normalizeMissionBatch({ id: 'M1', status: 'active' }), null)

  const batches = normalizeMissionBatch({ missions: [{ id: ' M1 ', note: ' x ' }] })
  assert.equal(batches.atomic, true)
  assert.deepEqual(batches.items, [{ id: 'M1', fields: { note: ' x ' } }])

  const perMission = normalizeMissionBatch({
    missions: [
      { id: 'M1', status: 'abandoned', note: 'cleanup' },
      { id: 'M2', deferred: true },
    ],
    atomic: false,
  })
  assert.equal(perMission.atomic, false)
  assert.deepEqual(perMission.items.map((item) => item.id), ['M1', 'M2'])
  assert.deepEqual(perMission.items[0].fields, { status: 'abandoned', note: 'cleanup' })
  assert.deepEqual(perMission.items[1].fields, { deferred: true })

  const shorthand = normalizeMissionBatch({ ids: ['M1', 'M2'], status: 'active', note: 'start' })
  assert.deepEqual(shorthand.items, [
    { id: 'M1', fields: { status: 'active', note: 'start' } },
    { id: 'M2', fields: { status: 'active', note: 'start' } },
  ])

  assert.throws(
    () => normalizeMissionBatch({ id: 'M1', missions: [{ id: 'M2' }] }),
    (error) => error.code === 'invalid-argument' && /not more than one/.test(error.message),
  )
  assert.throws(() => normalizeMissionBatch({ missions: [] }), /at least one/)
  assert.throws(() => normalizeMissionBatch({ ids: [] }), /at least one/)
  assert.throws(() => normalizeMissionBatch({ missions: [{ id: 'M1', note: 'x' }, { id: 'M1', note: 'y' }] }), /duplicate/)
  assert.throws(() => normalizeMissionBatch({ ids: ['M1', 'M1'], status: 'active' }), /duplicate/)
  assert.throws(() => normalizeMissionBatch({ missions: [{ id: 'M1', nope: true }] }), /unknown field/)
  assert.throws(() => normalizeMissionBatch({ missions: [{}] }), /requires id/)
  assert.throws(() => normalizeMissionBatch({ ids: ['M1'], task_done: 'write it' }), /missions/)
  assert.throws(() => normalizeMissionBatch({ missions: [{ id: 'M1', accept: true }] }), /accept/)
  assert.throws(() => normalizeMissionBatch({ atomic: false, id: 'M1' }), /atomic/)
  assert.throws(() => normalizeMissionBatch({ missions: [{ id: 'M1' }], ids: ['M2'] }), /not more than one/)
})
