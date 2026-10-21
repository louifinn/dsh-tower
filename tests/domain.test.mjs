import test from 'node:test'
import assert from 'node:assert/strict'
import { MISSION_STATUSES, canTransition, isTerminal, pauseCauseError } from '../lib/domain/mission.js'

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
