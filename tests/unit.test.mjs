// Static unit tests for the pure protocol helpers. No DSH runtime required.
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import { scopesOverlap, normalizeScope, validateTitle, fileInScope } from '../app/tower.js'

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

test('scopesOverlap: inline-prefix globs share a concrete path (#130 F16)', () => {
  // The literal heads are `a/b` and `a/bc`, so the directory-prefix check used
  // to miss this pair even though both match `a/bcd`.
  assert.equal(fileInScope(['a/b*'], 'a/bcd'), true)
  assert.equal(fileInScope(['a/bc*'], 'a/bcd'), true)
  assert.equal(scopesOverlap(['a/b*'], ['a/bc*']), true)
  // The same miss with file extensions inside one segment.
  assert.equal(fileInScope(['src/a*.mjs'], 'src/abx.mjs'), true)
  assert.equal(fileInScope(['src/ab*.mjs'], 'src/abx.mjs'), true)
  assert.equal(scopesOverlap(['src/a*.mjs'], ['src/ab*.mjs']), true)
  // A `?` inline wildcard overlaps the corresponding literal.
  assert.equal(scopesOverlap(['a/b?'], ['a/bc']), true)
  // Case folding still decides the pair, never rewrites it.
  assert.equal(scopesOverlap(['a/B*'], ['a/bc*']), false)
  assert.equal(scopesOverlap(['a/B*'], ['a/bc*'], { caseInsensitive: true }), true)
  // Cheaply provable disjoint trees stay disjoint (no new false positives).
  assert.equal(scopesOverlap(['a/*'], ['ab/*']), false)
  assert.equal(scopesOverlap(['a/b*'], ['a/c*']), false)
  assert.equal(scopesOverlap(['src/a*.mjs'], ['src/b*.mjs']), false)
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

function titleError(title) {
  try {
    validateTitle(title)
  } catch (error) {
    return error
  }
  assert.fail(`expected the title to be rejected: ${JSON.stringify(title)}`)
}

test('validateTitle: accepts printable Unicode and normalizes to NFC', () => {
  assert.equal(validateTitle('Feature A'), 'Feature A')
  assert.equal(validateTitle('修复登录态过期'), '修复登录态过期')
  assert.equal(validateTitle('Привет мир'), 'Привет мир')
  assert.equal(validateTitle('こんにちは'), 'こんにちは')
  assert.equal(validateTitle('안녕하세요'), '안녕하세요')
  assert.equal(validateTitle('🚀 launch'), '🚀 launch')
  // NFD input is stored as NFC.
  assert.equal(validateTitle('Cafe\u0301'), 'Café')
  // Surrounding whitespace is still trimmed, as before.
  assert.equal(validateTitle('  Build it  '), 'Build it')
  assert.throws(() => validateTitle('   '), /required/)
  assert.throws(() => validateTitle(42), /required/)
})

test('validateTitle: rejects bidi overrides with a distinct message', () => {
  for (const char of ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069']) {
    const error = titleError(`Fix ${char}login`)
    assert.equal(error.code, 'invalid-argument')
    assert.match(error.message, /bidi override/)
    assert.doesNotMatch(error.message, /printable ASCII/)
  }
})

test('validateTitle: rejects zero-width characters with a distinct message', () => {
  for (const char of ['\u200B', '\u200C', '\u200D', '\uFEFF']) {
    const error = titleError(`Fix ${char}login`)
    assert.equal(error.code, 'invalid-argument')
    assert.match(error.message, /zero-width/)
    assert.doesNotMatch(error.message, /bidi override/)
  }
})

test('validateTitle: rejects control, format and surrogate characters', () => {
  for (const title of ['line\nbreak', 'tab\there', 'nul\u0000here', 'del\u007Fhere', 'lone\uD800surrogate']) {
    const error = titleError(title)
    assert.equal(error.code, 'invalid-argument')
    assert.match(error.message, /control/)
    assert.doesNotMatch(error.message, /printable ASCII/)
  }
})

test('validateTitle: enforces 120 characters after NFC normalisation', () => {
  assert.equal(validateTitle('a'.repeat(120)), 'a'.repeat(120))
  assert.equal(validateTitle('中'.repeat(120)), '中'.repeat(120))
  // 120 astral characters are 120 code points, not 240 UTF-16 units.
  assert.equal(validateTitle('🚀'.repeat(120)), '🚀'.repeat(120))
  // The bound is counted after NFC, so decomposed input cannot bypass it.
  assert.equal(validateTitle('e\u0301'.repeat(120)), 'é'.repeat(120))
  for (const length of [121, 200]) {
    const error = titleError('a'.repeat(length))
    assert.equal(error.code, 'invalid-argument')
    assert.match(error.message, /120/)
    assert.doesNotMatch(error.message, /printable ASCII/)
  }
  assert.match(titleError('e\u0301'.repeat(121)).message, /120/)
})

test('fileInScope: glob matching', () => {
  assert.equal(fileInScope(['src/a/**'], 'src/a/x.js'), true)
  assert.equal(fileInScope(['src/a/*.js'], 'src/a/x.js'), true)
  assert.equal(fileInScope(['src/a/*.js'], 'src/a/nested/x.js'), false)
  assert.equal(fileInScope(['src/b/**'], 'src/a/x.js'), false)
})
