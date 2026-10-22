// Error-code classification: stable codes for the conditions documented in
// docs/reference/errors.md. Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyError } from '../domain/errors.js'
import { GitError } from '../lib/git.js'

test('classifyError: structured TowerToolError is passed through', async () => {
  const { TowerToolError } = await import('../domain/errors.js')
  for (const code of ['state-corrupt', 'invalid-transition', 'not-authorized', 'invalid-argument']) {
    const error = new TowerToolError(code, 'x')
    assert.equal(classifyError(error), error)
    assert.equal(error.message, `[tower:${code}] x`)
  }
})

test('classifyError: external objects carrying a known code are promoted', async () => {
  const { TowerToolError } = await import('../domain/errors.js')
  const external = Object.assign(new Error('old style'), { code: 'state-locked', retryable: true })
  const classified = classifyError(external)
  assert.equal(classified.code, 'state-locked')
  assert.equal(classified.retryable, true)
  assert.ok(classified instanceof TowerToolError)
})

test('classifyError: GitError keeps repo/git/timing codes', async () => {
  assert.equal(classifyError(new GitError(['x'], 'fatal: not a git repository', 128)).code, 'git-failed')
  assert.equal(classifyError(new GitError(['x'], 'boom', 1)).code, 'git-failed')
  assert.equal(classifyError(new GitError(['x'], 'timed out', 1, { timedOut: true })).code, 'git-timeout')
})

test('classifyError: prose alone no longer classifies', () => {
  for (const message of ['unknown mission "M9"', 'mission title must be printable ASCII', 'state is locked']) {
    const error = classifyError(new Error(message))
    assert.equal(error.code, 'tool-internal')
    assert.ok(error.message.startsWith('[tower:tool-internal] '))
  }
})

test('spawn backoff: three retryable failures trigger cooldown and success restores budget', async () => {
  const { __testSpawnBackoff: backoff } = await import('../lib/tool-registry.js')
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
  const { ERROR_CODE_VALUES, isErrorCode } = await import('../domain/errors.js')
  assert.equal(Object.isFrozen(ERROR_CODE_VALUES), true)
  assert.ok(ERROR_CODE_VALUES.includes('tool-internal'))
  assert.equal(isErrorCode('tool-internal'), true)
  assert.equal(isErrorCode('made-up'), false)
})

test('every TowerToolError literal uses a catalog code', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { isErrorCode } = await import('../domain/errors.js')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const files = ['index.js', ...fs.readdirSync(path.join(root, 'lib')).filter((name) => name.endsWith('.js')).map((name) => `lib/${name}`)]
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    for (const match of text.matchAll(/new TowerToolError\('([^']+)'/g)) {
      assert.equal(isErrorCode(match[1]), true, `${file}: ${match[1]}`)
    }
  }
})

test('structured TowerToolError derives retryable from the catalog', async () => {
  const { TowerToolError } = await import('../domain/errors.js')
  assert.equal(new TowerToolError('state-locked', 'x').retryable, true)
  assert.equal(new TowerToolError('stale-base', 'x').retryable, true)
  assert.equal(new TowerToolError('invalid-argument', 'x').retryable, false)
  assert.equal(new TowerToolError('invalid-argument', 'x', { retryable: true }).retryable, true)
})

test('pure domain validation throws structured errors', async () => {
  const { validateState } = await import('../domain/state.js')
  const { SCHEMA_VERSION } = await import('../domain/mission.js')
  const { normalizeScope } = await import('../domain/scope.js')
  let stateError
  try { validateState({ schemaVersion: SCHEMA_VERSION + 1 }, 'state.json') } catch (error) { stateError = error }
  assert.equal(stateError.code, 'state-version-unsupported')
  let corruptError
  try { validateState({ schemaVersion: 'nope' }, 'state.json') } catch (error) { corruptError = error }
  assert.equal(corruptError.code, 'state-corrupt')
  let scopeError
  try { normalizeScope(['../x']) } catch (error) { scopeError = error }
  assert.equal(scopeError.code, 'invalid-argument')
})

test('classifyError has no prose rule table', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const source = fs.readFileSync(path.join(root, 'domain/errors.js'), 'utf8')
  assert.doesNotMatch(source, /const RULES/)
  assert.doesNotMatch(source, /for \(const \[code, pattern\] of RULES\)/)
})
