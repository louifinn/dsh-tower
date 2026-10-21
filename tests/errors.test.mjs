// Error-code classification: stable codes for the conditions documented in
// docs/reference/errors.md. Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyError } from '../lib/errors.js'
import { GitError } from '../lib/git.js'

test('classifyError: state validation failures are state-corrupt', () => {
  const messages = [
    'tower state is not an object at x/state.json',
    'tower state has no missions array at x/state.json',
    'tower state findings is not an array at x/state.json',
    'unsupported tower state schemaVersion 9 at x/state.json',
    'duplicate mission id M1 at x/state.json',
    'mission M1 has unknown status bogus at x/state.json',
    'invalid roster entry at x/state.json',
    'review R1 has unknown merge verdict later at x/state.json',
  ]
  for (const message of messages) assert.equal(classifyError(new Error(message)).code, 'state-corrupt', message)
})

test('classifyError: tower_complete preconditions are invalid transitions', () => {
  const messages = [
    'mission M1 still has 2 open task(s): a; b',
    'mission M1 has unresolved blockers: waiting',
    'mission M1 has no worktree',
    'mission branch has no commits since abc123',
    'mission M1 cannot complete with 1 unread inbox message(s) for worker-1; call tower_inbox',
    'agent agent-x is not assigned to mission M1',
    'agent worker-1 is a reviewer, not a worker',
    'reviewers may list and read findings, but only the tower or a worker may change finding status',
  ]
  for (const message of messages) {
    const code = classifyError(new Error(message)).code
    assert.ok(code === 'invalid-transition' || code === 'not-authorized', `${message} -> ${code}`)
  }
})

test('classifyError: locks, config, git and argument failures keep their codes', () => {
  assert.equal(classifyError(new Error('tower state is locked by another writer (pid 1); retry')).code, 'state-locked')
  assert.equal(classifyError(new Error('repo config at x is not valid JSON: bad')).code, 'config-invalid')
  assert.equal(classifyError(new Error('repo config at x has unknown key(s) nope')).code, 'config-unknown-key')
  assert.equal(classifyError(new Error('mission title must be printable ASCII: "x"')).code, 'invalid-argument')
  assert.equal(classifyError(new Error('finding status "all" is only a list filter')).code, 'invalid-argument')
  assert.equal(classifyError(new Error('agent preset "tower-worker" is not registered')).code, 'preset-missing')
  assert.equal(classifyError(new Error('reviewer requires a completed mission')).code, 'reviewer-prerequisite')
  assert.equal(classifyError(new Error('no subagent provider is registered')).code, 'provider-missing')
  assert.equal(classifyError(new Error('subagents service is unavailable; cannot spawn')).code, 'spawn-unavailable')

  assert.equal(classifyError(new GitError(['x'], 'fatal: not a git repository', 128)).code, 'repo-invalid')
  assert.equal(classifyError(new GitError(['x'], 'boom', 1)).code, 'git-failed')
  assert.equal(classifyError(new GitError(['x'], 'timed out', 1, { timedOut: true })).code, 'git-timeout')
})

test('classifyError: every thrown value becomes a [tower:<code>] message', () => {
  const wrapped = classifyError(new Error('unknown mission "M9"'))
  assert.equal(wrapped.code, 'mission-not-found')
  assert.match(wrapped.message, /^\[tower:mission-not-found\] unknown mission "M9"$/)

  const internal = classifyError(new Error('something unexpected'))
  assert.equal(internal.code, 'tool-internal')
  assert.match(internal.message, /^\[tower:tool-internal\] /)

  // Re-classification keeps the original object (and therefore the code).
  assert.equal(classifyError(wrapped), wrapped)
})

test('spawn backoff: three retryable failures trigger cooldown and success restores budget', async () => {
  const { __testSpawnBackoff: backoff } = await import('../lib/tools.js')
  const key = 'C:/tmp/backoff-test'
  backoff.spawnBackoffState(key, 4)
  for (let i = 0; i < 3; i += 1) backoff.recordSpawnThrottle(key, 4)
  const view = backoff.spawnBackoffView(key, 4, 1)
  assert.ok(view.blockedUntil > Date.now(), 'cooldown must be in the future')
  assert.equal(view.budget, 3)
  backoff.recordSpawnSuccess(key, 4)
  const after = backoff.spawnBackoffView(key, 4, 0)
  assert.equal(after.blockedUntil, 0)
  assert.equal(after.budget, 4)
})

test('error codes expose a frozen structural catalog', async () => {
  const { ERROR_CODE_VALUES, isErrorCode } = await import('../lib/errors.js')
  assert.equal(Object.isFrozen(ERROR_CODE_VALUES), true)
  assert.ok(ERROR_CODE_VALUES.includes('tool-internal'))
  assert.equal(isErrorCode('tool-internal'), true)
  assert.equal(isErrorCode('made-up'), false)
})
