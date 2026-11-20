// Static unit tests for the pure protocol helpers. No DSH runtime required.
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import { scopesOverlap, normalizeScope, validateTitle, fileInScope, directoryScopeCandidate, expandScopeDirectories, scopePrefixDirectory, validateScopeEntries } from '../app/tower.js'

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

test('F18: a bare directory entry expands to its subtree glob before storage', () => {
  // Real repository paths: docs/guide/quickstart.md sits below docs/guide.
  // The matcher stays a pure glob, so the literal entry alone misses the file.
  assert.equal(fileInScope(['docs/guide'], 'docs/guide/quickstart.md'), false)
  const expanded = expandScopeDirectories(['docs/guide'], { directories: new Set(['docs/guide']) })
  assert.deepEqual(expanded, ['docs/guide/**'])
  assert.deepEqual(normalizeScope(expanded), ['docs/guide/**'], 'the stored plan is the explicit glob')
  assert.equal(fileInScope(expanded, 'docs/guide/quickstart.md'), true)
  assert.equal(fileInScope(expanded, 'docs/guide'), false, 'the directory itself is not a changed file')
  assert.equal(fileInScope(expanded, 'docs/guidebook.md'), false, 'the subtree glob must not match sibling names')
})

test('F18: a trailing separator always means directory, even before it exists', () => {
  assert.deepEqual(expandScopeDirectories(['reports/']), ['reports/**'])
  assert.deepEqual(expandScopeDirectories(['reports\\'], {}), ['reports/**'])
  assert.deepEqual(expandScopeDirectories(['./reports//']), ['reports/**'])
  assert.deepEqual(normalizeScope(expandScopeDirectories(['reports/'])), ['reports/**'])
})

test('F18: globs, files, unknown bare paths and invalid entries stay literal', () => {
  const directories = new Set(['docs/guide'])
  assert.deepEqual(expandScopeDirectories(['docs/guide/**'], { directories }), ['docs/guide/**'])
  assert.deepEqual(expandScopeDirectories(['docs/*.md'], { directories }), ['docs/*.md'])
  assert.deepEqual(expandScopeDirectories(['docs/guide/quickstart.md'], { directories }), ['docs/guide/quickstart.md'])
  assert.deepEqual(expandScopeDirectories(['no/such/dir'], { directories }), ['no/such/dir'])
  const invalid = ['/abs/', 'a/../b/', 'C:/x/', '', null, 7]
  assert.deepEqual(expandScopeDirectories(invalid, { directories }), invalid)
  // Invalid shapes keep failing through the normal normalizer with the same messages.
  assert.throws(() => normalizeScope(expandScopeDirectories(['a/../b/'])), /\.\./)
  assert.throws(() => normalizeScope(expandScopeDirectories(['/abs/'])), /relative/)
  assert.throws(() => normalizeScope(expandScopeDirectories(['C:/x/'])), /relative/)
  assert.throws(() => normalizeScope(expandScopeDirectories([null])), /non-empty strings/)
})

test('F18: the repository root "." becomes the whole-tree glob', () => {
  assert.deepEqual(expandScopeDirectories(['.']), ['**'])
  assert.equal(fileInScope(['**'], 'docs/guide/quickstart.md'), true)
  assert.deepEqual(normalizeScope(['.']), ['.'], 'normalizeScope itself is unchanged and still stores the literal dot')
})

test('F18: expansion is a fixed point and duplicate subtrees collapse', () => {
  const directories = new Set(['src'])
  assert.deepEqual(normalizeScope(expandScopeDirectories(['src', 'src/**'], { directories })), ['src/**'])
  assert.deepEqual(expandScopeDirectories(['src/**'], { directories }), ['src/**'], 'an explicit glob needs no second pass')
})

test('F18: directoryScopeCandidate recognises only bare relative paths', () => {
  assert.deepEqual(directoryScopeCandidate('docs/guide'), { value: 'docs/guide', trailing: false })
  assert.deepEqual(directoryScopeCandidate('docs\\guide\\'), { value: 'docs/guide', trailing: true })
  assert.deepEqual(directoryScopeCandidate('./docs/guide'), { value: 'docs/guide', trailing: false })
  assert.equal(directoryScopeCandidate('docs/*'), null)
  assert.equal(directoryScopeCandidate('/docs'), null)
  assert.equal(directoryScopeCandidate('C:/docs'), null)
  assert.equal(directoryScopeCandidate('a/../b'), null)
  assert.equal(directoryScopeCandidate('./'), null)
  assert.equal(directoryScopeCandidate('  '), null)
  assert.equal(directoryScopeCandidate(null), null)
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

// ---------------------------------------------------------------------------
// #200: planning rejects scope entries that name no tracked file
// ---------------------------------------------------------------------------

test('#200: scopePrefixDirectory anchors each entry at the directory it names', () => {
  // Root-level entries have no anchor directory; a mission may create them.
  assert.equal(scopePrefixDirectory('README.md'), '')
  assert.equal(scopePrefixDirectory('dep.txt'), '')
  assert.equal(scopePrefixDirectory('*.md'), '')
  assert.equal(scopePrefixDirectory('**'), '')
  assert.equal(scopePrefixDirectory('.'), '')
  // A literal entry is anchored at its parent directory.
  assert.equal(scopePrefixDirectory('scripts/check-deny.mjs'), 'scripts')
  assert.equal(scopePrefixDirectory('./scripts/generate-deny-surface.mjs'), 'scripts')
  // A glob before the last separator keeps the literal head, so a typo is
  // checked against the directory that actually exists.
  assert.equal(scopePrefixDirectory('tests/teardown*.test.mjs'), 'tests')
  assert.equal(scopePrefixDirectory('src/*.mjs'), 'src')
  // A subtree glob is anchored at the subtree itself.
  assert.equal(scopePrefixDirectory('docs/guide/**'), 'docs/guide')
  assert.equal(scopePrefixDirectory('docs/guide/quickstart.md'), 'docs/guide')
})

test('#200: validateScopeEntries reports every entry that names no tracked file', () => {
  const trackedPaths = [
    'README.md',
    'docs/guide/quickstart.md',
    'scripts/generate-deny-surface.mjs',
    'tests/cleanup.test.mjs',
  ]
  const directories = new Set(['docs/guide', 'scripts', 'tests'])
  const problems = validateScopeEntries(
    ['tests/teardown*.test.mjs', 'scripts/check-deny.mjs', 'docs/guide/missing.md', 'docs/guide/**'],
    { trackedPaths, directories },
  )
  assert.deepEqual(
    problems.map((problem) => problem.entry),
    ['tests/teardown*.test.mjs', 'scripts/check-deny.mjs', 'docs/guide/missing.md'],
    'an entry that matches a tracked file is not reported',
  )
  assert.deepEqual(problems[0], {
    entry: 'tests/teardown*.test.mjs',
    reason: 'no tracked file matches',
    closestPrefix: 'tests',
    candidates: ['tests/cleanup.test.mjs'],
  })
  assert.deepEqual(problems[1].candidates, ['scripts/generate-deny-surface.mjs'])
  assert.deepEqual(problems[2].candidates, ['docs/guide/quickstart.md'])
})

test('#200: validateScopeEntries keeps future paths, directories, ** and . legal', () => {
  const trackedPaths = ['README.md', 'tests/cleanup.test.mjs']
  const directories = new Set(['tests'])
  assert.deepEqual(
    validateScopeEntries(['**', '.', 'tests', 'tests/', 'tests/cleanup.test.mjs', 'tests/**', 'src/**', 'src/new.js', 'dep.txt'], {
      trackedPaths,
      directories,
    }),
    [],
    'a missing top-level tree, a root-level file and a directory are not errors',
  )
  // A checked-out but ignored tree is known territory: a glob that only matches
  // its ignored files names nothing a mission can own.
  const ignored = validateScopeEntries(['dist/*.js'], { trackedPaths, directories: new Set([...directories, 'dist']) })
  assert.equal(ignored.length, 1)
  assert.equal(ignored[0].closestPrefix, 'dist')
  // An empty tracked list proves nothing, so validation reports nothing.
  assert.deepEqual(validateScopeEntries(['tests/teardown*.test.mjs'], { trackedPaths: [], directories }), [])
})

test('#200: validateScopeEntries caps the candidate list at five tracked files', () => {
  const trackedPaths = ['pkg/a.mjs', 'pkg/b.mjs', 'pkg/c.mjs', 'pkg/d.mjs', 'pkg/e.mjs', 'pkg/f.mjs']
  const problems = validateScopeEntries(['pkg/missing*.mjs'], { trackedPaths, directories: new Set(['pkg']) })
  assert.equal(problems.length, 1)
  assert.deepEqual(problems[0].candidates, ['pkg/a.mjs', 'pkg/b.mjs', 'pkg/c.mjs', 'pkg/d.mjs', 'pkg/e.mjs'])
})
