import test from 'node:test'
import assert from 'node:assert/strict'
import { MISSION_STATUSES, canTransition, isTerminal, pauseCauseError } from '../domain/mission.js'
import { completionBlockers } from '../domain/gate.js'

test('pure mission domain owns transitions and terminal states', () => {
  assert.deepEqual(MISSION_STATUSES, ['planned', 'active', 'completed', 'blocked', 'paused', 'merged', 'abandoned'])
  assert.equal(canTransition('planned', 'active'), true)
  assert.equal(canTransition('planned', 'completed'), false)
  assert.equal(canTransition('paused', 'active'), true)
  assert.equal(canTransition('merged', 'active'), false)
  assert.equal(isTerminal('merged'), true)
  assert.equal(isTerminal('abandoned'), true)
  assert.equal(isTerminal('active'), false)
  assert.equal(pauseCauseError('user'), null)
  assert.match(pauseCauseError('bogus'), /pause_cause must be one of/)
})

test('pure completion gate returns stable codes without repository I/O', () => {
  const mission = { id: 'M1', status: 'active', tasks: [{ text: 'open', status: 'open' }], blockers: ['x'] }
  const codes = completionBlockers(mission, { gates: { requireChecks: true } }).map((blocker) => blocker.code)
  assert.deepEqual(codes, ['mission-not-completed', 'tasks-open', 'blockers-present', 'no-check-evidence'])
  assert.deepEqual(completionBlockers({ id: 'M2', status: 'completed', tasks: [], blockers: [] }, {}), [])
})

test('pure merge gate returns review/worker/test blockers from snapshots', async () => {
  const { mergeGateBlockers } = await import('../domain/gate.js')
  const mission = { id: 'M1', reviewPolicy: 'required', status: 'completed' }
  const blockers = mergeGateBlockers({
    mission,
    roster: [{ missionId: 'M1', name: 'w', agentId: 'a1', state: 'running' }],
    branch: 'b',
    branchTip: 'tip',
    review: { missionId: 'M1', round: 1, status: 'clean', mergeVerdict: 'merge', reviewedCommit: 'old' },
    config: { review: { requireReview: true }, gates: { requireTests: true } },
    activity: { a1: 'running' },
    inactiveStates: ['inactive'],
  }).map((blocker) => blocker.code)
  assert.deepEqual(blockers, ['tip-moved', 'worker-busy', 'tests-missing'])
  assert.deepEqual(mergeGateBlockers({ mission, roster: [], config: { review: { requireReview: false } } }), [])
})

test('pure scope and planning helpers are testable without a repository', async () => {
  const { fileInScope, normalizeScope, scopesOverlap } = await import('../domain/scope.js')
  const { addAutoDeps, assertAcyclic, nextMissionNumber } = await import('../domain/planning.js')
  assert.equal(fileInScope(['src/**'], 'src/a/b.js'), true)
  assert.equal(fileInScope(['src/*.js'], 'src/a/b.js'), false)
  assert.deepEqual(normalizeScope(['./src//']), ['src'])
  assert.equal(scopesOverlap(['src/a/**'], ['src/a/b/**']), true)
  assert.equal(nextMissionNumber([{ id: 'M2' }, { id: 'M7' }]), 8)
  const missions = [
    { id: 'M1', kind: 'build', status: 'active', scope: ['src/a/**'], deps: [] },
    { id: 'M2', kind: 'build', status: 'planned', scope: ['src/a/b/**'], deps: [] },
  ]
  addAutoDeps([missions[1]], [missions[0]])
  assert.deepEqual(missions[1].deps, ['M1'])
  assert.doesNotThrow(() => assertAcyclic(missions))
})

test('pure mission summaries expose counts and full detail', async () => {
  const { missionSummary, fullMission } = await import('../domain/summary.js')
  const mission = {
    id: 'M1', title: 'T', kind: 'build', status: 'active', scope: ['x/**'], deps: [],
    tasks: [{ text: 'a', status: 'done' }, { text: 'b', status: 'open' }, { text: 'c', status: 'dropped' }],
  }
  assert.deepEqual(missionSummary(mission).tasks, { total: 3, done: 1, open: 1, dropped: 1 })
  assert.equal(fullMission(mission).tasks.length, 3)
})

test('pure board renderer and state validator are repository-independent', async () => {
  const { boardMarkdown } = await import('../domain/report.js')
  const { validateState } = await import('../domain/state.js')
  const { SCHEMA_VERSION } = await import('../domain/mission.js')
  const state = {
    schemaVersion: SCHEMA_VERSION, revision: 2, repoRoot: '/repo', base: 'main', updatedAt: 1,
    missions: [{ id: 'M1', title: 'T', kind: 'build', status: 'active', scope: ['x/**'], deps: [], tasks: [], blockers: [] }],
    roster: [], messages: [], findings: [], reviews: [],
  }
  const board = boardMarkdown(state)
  assert.match(board, /Tower missions/)
  assert.match(board, /\| M1 \| active \|/)
  assert.equal(validateState(state, 'state.json'), state)
  assert.throws(() => validateState({ ...state, schemaVersion: SCHEMA_VERSION + 1 }, 'state.json'), /schemaVersion/)
})

test('rebase waiver is a pure predicate', async () => {
  const { rebaseWaived } = await import('../domain/gate.js')
  assert.equal(rebaseWaived({}, { at: 1, reviewedCommit: 'x' }), false)
  assert.equal(rebaseWaived({ rebase: { at: 5, oldTip: 'old' } }, { at: 3, reviewedCommit: 'old' }), true)
  assert.equal(rebaseWaived({ rebase: { at: 5, oldTip: 'old' } }, { at: 6, reviewedCommit: 'old' }), false)
})
