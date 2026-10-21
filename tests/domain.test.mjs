import test from 'node:test'
import assert from 'node:assert/strict'
import { MISSION_STATUSES, canTransition, isTerminal, pauseCauseError } from '../lib/domain/mission.js'
import { completionBlockers } from '../lib/domain/gate.js'

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
  const { mergeGateBlockers } = await import('../lib/domain/gate.js')
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
