// Static unit tests for the pure protocol helpers. No DSH runtime required.
// Run with: node --test tower/tests
import test from 'node:test'
import assert from 'node:assert/strict'
import { scopesOverlap, normalizeScope, validateTitle, fileInScope } from '../bundle/lib/tower.js'

test('scopesOverlap: identical and nested prefixes overlap', () => {
  assert.equal(scopesOverlap(['src/a/**'], ['src/a/**']), true)
  assert.equal(scopesOverlap(['src/a/**'], ['src/a/file.js']), true)
  assert.equal(scopesOverlap(['src/a/**'], ['src/b/**']), false)
})

test('scopesOverlap: leading wildcards are conservative', () => {
  assert.equal(scopesOverlap(['**/*.ts'], ['docs/**']), true)
  // `src/*.js` does not match nested files, but the conservative prefix check
  // still treats it as overlapping `src/a/x.js`; unrelated trees stay disjoint.
  assert.equal(scopesOverlap(['src/*.js'], ['src/a/x.js']), true)
  assert.equal(scopesOverlap(['src/*.js'], ['lib/a/x.js']), false)
})

test('normalizeScope: rejects absolute paths and parent traversal', () => {
  assert.throws(() => normalizeScope(['D:/x']), /relative/)
  assert.throws(() => normalizeScope(['/x']), /relative/)
  assert.throws(() => normalizeScope(['a/../b']), /\.\./)
  assert.deepEqual(normalizeScope(['src\\a\\', './b']), ['src/a', 'b'])
})

test('normalizeScope: build missions need a scope, surveys may be empty', () => {
  assert.throws(() => normalizeScope([]), /must not be empty/)
  assert.deepEqual(normalizeScope([], { allowEmpty: true }), [])
})

test('validateTitle: printable ASCII only', () => {
  assert.equal(validateTitle('Feature A'), 'Feature A')
  assert.throws(() => validateTitle('中文标题'), /printable ASCII/)
  assert.throws(() => validateTitle('   '), /required/)
})

test('fileInScope: glob matching', () => {
  assert.equal(fileInScope(['src/a/**'], 'src/a/x.js'), true)
  assert.equal(fileInScope(['src/a/*.js'], 'src/a/x.js'), true)
  assert.equal(fileInScope(['src/a/*.js'], 'src/a/nested/x.js'), false)
  assert.equal(fileInScope(['src/b/**'], 'src/a/x.js'), false)
})
