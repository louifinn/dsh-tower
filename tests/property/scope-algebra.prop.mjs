// Property 7 (#130): scope algebra is sound.
//
// WHAT THIS FILE CHECKS
// ---------------------
// `domain/scope.js` declares the glob grammar (only `*`, `**` and `?` are
// special; `/` is the only separator) and two decisions built on it:
//
//   * `fileInScope(scope, file)` answers "does this scope own that path?";
//   * `scopesOverlap(a, b)` answers "must these two missions serialize?".
//
// The oracle here is an independently written matcher (`naiveMatch` below): a
// dynamic-programming walk over the pattern and the path that is not derived
// from `globToRegExp`. When the two disagree, either the matcher or the property
// grammar is wrong, and the counterexample names the pair. The documented
// grammar is implemented exactly as written:
//
//   `*`  — zero or more characters other than `/`
//   `**` — zero or more characters, including `/`
//   `?`  — exactly one character other than `/`
//
// Everything else is literal. POSIX bracket classes (`[a-z]`) and brace
// alternation (`{a,b}`) are deliberately NOT implemented: `domain/scope.js`
// escapes both, so the issue's illustrative `{a,b}` / `[a-z]` examples are not
// part of the grammar. The frozen examples at the bottom pin that reading.
//
// OVERLAP IS A ONE-DIRECTIONAL CLAIM
// ---------------------------------
// `scopesOverlap` compares the *literal head* of each pattern (the text before
// the first glob metacharacter). That heuristic is exact enough for the
// grammar the mission planner generates — one glob token per path segment — and
// it is deliberately allowed to over-approximate: `['a']` and `['a/**']` report
// overlap even though no single path satisfies both, which is the safe
// direction for a merge serializer. It must, however, never under-approximate
// for that grammar: if one concrete path is in both scopes, overlap must be
// true. That is the property asserted here.
//
// KNOWN LIMITATION (recorded as a tower finding, not fixed by this mission)
// -------------------------------------------------------------------------
// Because only the literal head is compared, an *inline* prefix before a glob
// inside one segment (for example `a/b*` versus `a/bc*`) shares the concrete
// path `a/bcd` while `scopesOverlap` reports false. The mission planner's
// scope grammar (`tests/property/arbitraries/path.mjs`) puts a glob token in a
// whole segment, so the never-under-approximate property holds over generated
// scopes; inline-prefix patterns are not generated for the overlap assertion and
// no test pins the unsound answer, so fixing the heuristic later needs no test
// change. `fileInScope` itself handles inline prefixes correctly and is covered
// by the matcher-agreement property through `inlineGlobArb`.
//
// No shrunk counterexample has been observed for these properties across the
// three PR seeds (131, 40961, 978217) or the 2000-run long tier.
import assert from 'node:assert/strict'
import fc from 'fast-check'

import { caseInsensitiveScopeMatch, fileInScope, normalizeScope, scopesOverlap } from '../../domain/scope.js'
import { filePathArb, scopeArb, scopeEntryArb } from './arbitraries/index.mjs'
import { runProperty } from './helpers/harness.mjs'

/**
 * The reference matcher: dynamic programming over code units, never a RegExp.
 *
 * `*` consumes code units other than `/`, `**` consumes anything (including
 * `/`), `?` consumes exactly one non-`/` code unit, everything else is literal.
 * `pattern` and `file` are expected to be already normalized and posix-like;
 * `caseInsensitive` folds both sides exactly like the implementation does.
 *
 * @param {string} pattern
 * @param {string} file
 * @param {{ caseInsensitive?: boolean }} [options]
 * @returns {boolean}
 */
function naiveMatch(pattern, file, { caseInsensitive = false } = {}) {
  const source = caseInsensitive ? pattern.toLowerCase() : pattern
  const target = caseInsensitive ? file.toLowerCase() : file
  /** @type {Map<string, boolean>} */
  const memo = new Map()
  /**
   * @param {number} patternIndex
   * @param {number} fileIndex
   * @returns {boolean}
   */
  function walk(patternIndex, fileIndex) {
    const key = `${patternIndex}:${fileIndex}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    let result
    if (patternIndex === source.length) {
      result = fileIndex === target.length
    } else if (source[patternIndex] === '*') {
      if (source[patternIndex + 1] === '*') {
        result = false
        for (let cursor = fileIndex; cursor <= target.length; cursor += 1) {
          if (walk(patternIndex + 2, cursor)) {
            result = true
            break
          }
        }
      } else {
        result = false
        for (let cursor = fileIndex; cursor <= target.length; cursor += 1) {
          if (walk(patternIndex + 1, cursor)) {
            result = true
            break
          }
          // A single `*` stops at the first separator: it never consumes it.
          if (cursor === target.length || target[cursor] === '/') break
        }
      }
    } else if (source[patternIndex] === '?') {
      result = fileIndex < target.length && target[fileIndex] !== '/' && walk(patternIndex + 1, fileIndex + 1)
    } else {
      result =
        fileIndex < target.length && target[fileIndex] === source[patternIndex] && walk(patternIndex + 1, fileIndex + 1)
    }
    memo.set(key, result)
    return result
  }
  return walk(0, 0)
}

/**
 * @param {string[]} scope
 * @param {string} file
 * @param {{ caseInsensitive?: boolean }} [options]
 * @returns {boolean}
 */
function naiveInScope(scope, file, options = {}) {
  return scope.some((pattern) => naiveMatch(pattern, file, options))
}

/**
 * Normalize a generated scope array into the form the matcher consumes.
 * @param {string[]} scope
 * @returns {string[]}
 */
function normalized(scope) {
  return normalizeScope(scope, { allowEmpty: true })
}

// An inline-prefix glob (`src/ab*.mjs`) is valid documented grammar even though
// the mission planner never generates it. `fileInScope` must still agree with
// the reference matcher on it.
const inlineGlobArb = fc
  .tuple(
    fc.option(fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,8}$/), { nil: undefined }),
    fc.stringMatching(/^[a-z0-9]{1,8}$/),
    fc.constantFrom('*', '?', '**', '*.mjs', '?b', '**/x'),
    fc.constantFrom('', '.mjs', '/x'),
  )
  .map(([directory, head, glob, tail]) => `${directory === undefined ? '' : `${directory}/`}${head}${glob}${tail}`)

/** One normalized scope pattern: a planner-shaped entry, or an inline-prefix glob. */
const patternArb = fc
  .oneof({ weight: 3, arbitrary: scopeEntryArb }, { weight: 2, arbitrary: inlineGlobArb })
  .map((entry) => normalized([entry])[0])

runProperty({
  name: 'scope algebra: fileInScope agrees with an independent matcher for *, ** and ?',
  arbitrary: fc.tuple(patternArb, filePathArb),
  classify: ([pattern]) => (pattern.includes('**') ? '**' : pattern.includes('*') ? '*' : pattern.includes('?') ? '?' : 'literal'),
  predicate: ([pattern, file]) => {
    assert.equal(
      fileInScope([pattern], file),
      naiveMatch(pattern, file),
      `fileInScope disagrees with the reference matcher for scope ${JSON.stringify(pattern)} and file ${JSON.stringify(file)}`,
    )
  },
})

runProperty({
  name: 'scope algebra: case-insensitive matching folds the pattern and the file, and never widens the case-sensitive answer differently from the reference',
  arbitrary: fc.tuple(patternArb, filePathArb),
  predicate: ([pattern, file]) => {
    const caseInsensitive = fileInScope([pattern], file, { caseInsensitive: true })
    assert.equal(
      caseInsensitive,
      naiveMatch(pattern, file, { caseInsensitive: true }),
      `case-insensitive fileInScope disagrees with the reference matcher for ${JSON.stringify(pattern)} / ${JSON.stringify(file)}`,
    )
    assert.equal(
      caseInsensitive,
      naiveMatch(pattern.toUpperCase(), file.toUpperCase(), { caseInsensitive: true }),
      'case-insensitive matching must fold both the pattern and the file',
    )
    const explained = caseInsensitiveScopeMatch([pattern], file)
    assert.equal(
      explained,
      caseInsensitive ? pattern : null,
      'caseInsensitiveScopeMatch must return the first entry that matches under folding, or null',
    )
  },
})

runProperty({
  name: 'scope algebra: normalizeScope makes scope forms comparable and fileInScope keeps matching the normalized entry',
  arbitrary: fc.tuple(scopeEntryArb, filePathArb),
  predicate: ([entry, file]) => {
    const once = normalized([entry])[0]
    assert.deepEqual(normalized([once]), [once], 'a normalized entry must be a normalizeScope fixed point')
    // `normalizeScope` folds `\` to `/`, so the Windows-separator spelling of the
    // same entry must normalize to the same pattern and match the same path.
    const windowsSpelling = entry.replaceAll('/', '\\')
    assert.deepEqual(normalized([windowsSpelling]), normalized([entry]))
    assert.equal(
      fileInScope(normalized([windowsSpelling]), file),
      fileInScope([once], file),
      'a win32-separator spelling must match exactly like its posix spelling after normalization',
    )
    assert.equal(
      fileInScope([once], file),
      naiveMatch(once, file),
      `the normalized entry must keep the matcher agreement: ${JSON.stringify(once)} / ${JSON.stringify(file)}`,
    )
  },
})

runProperty({
  name: 'scope algebra: scopesOverlap is symmetric, folds case symmetrically, and never misses a shared concrete path',
  arbitrary: fc.tuple(scopeArb, scopeArb, filePathArb),
  predicate: ([leftScope, rightScope, file]) => {
    const left = normalized(leftScope)
    const right = normalized(rightScope)
    assert.equal(
      scopesOverlap(left, right),
      scopesOverlap(right, left),
      'scopesOverlap must be symmetric',
    )
    assert.equal(
      scopesOverlap(left, right, { caseInsensitive: true }),
      scopesOverlap(right, left, { caseInsensitive: true }),
      'case-insensitive scopesOverlap must be symmetric',
    )
    // The generated vocabulary is lower-case, so folding must not change the
    // decision (it only compares, it never rewrites the stored scope).
    assert.equal(
      scopesOverlap(left, right, { caseInsensitive: true }),
      scopesOverlap(left, right),
      'case folding must not change the overlap decision for an all-lower-case generated scope',
    )
    const inLeft = naiveInScope(left, file)
    const inRight = naiveInScope(right, file)
    if (inLeft && inRight) {
      assert.equal(
        scopesOverlap(left, right),
        true,
        `scopesOverlap reported no overlap for a shared concrete path ${JSON.stringify(file)}: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`,
      )
      assert.equal(
        scopesOverlap(left, right, { caseInsensitive: true }),
        true,
        `case-insensitive scopesOverlap missed the shared concrete path ${JSON.stringify(file)}`,
      )
    }
  },
})

runProperty({
  name: 'scope algebra: frozen grammar examples pin separator and metacharacter semantics',
  arbitrary: fc.constant(null),
  predicate: () => {
    // `**` crosses separators; `*` never does; `?` is exactly one non-separator.
    assert.equal(fileInScope(['src/**'], 'src/a/b.mjs'), true)
    assert.equal(fileInScope(['src/*'], 'src/a/b.mjs'), false)
    assert.equal(fileInScope(['src/*'], 'src/a.mjs'), true)
    assert.equal(fileInScope(['src/*.mjs'], 'src/a.mjs'), true)
    assert.equal(fileInScope(['src/*.mjs'], 'src/a/b.mjs'), false)
    assert.equal(fileInScope(['src/?'], 'src/a'), true)
    assert.equal(fileInScope(['src/?'], 'src/ab'), false)
    assert.equal(fileInScope(['src/?'], 'src/'), false)

    // `{a,b}` and `[a-z]` are not POSIX constructs in this grammar: they are
    // escaped and therefore match themselves literally.
    assert.equal(fileInScope(['src/{a,b}.mjs'], 'src/a.mjs'), false)
    assert.equal(fileInScope(['src/{a,b}.mjs'], 'src/{a,b}.mjs'), true)
    assert.equal(fileInScope(['src/[ab].mjs'], 'src/a.mjs'), false)
    assert.equal(fileInScope(['src/[ab].mjs'], 'src/[ab].mjs'), true)
    assert.equal(naiveMatch('src/{a,b}.mjs', 'src/a.mjs'), false)

    // Windows separators live on the scope side only: normalization folds them.
    assert.deepEqual(normalizeScope(['src\\**', './lib\\*.mjs', 'docs//']), ['src/**', 'lib/*.mjs', 'docs'])
    assert.equal(fileInScope(normalizeScope(['src\\**']), 'src/a/b.mjs'), true)

    // A boundary case the reference matcher and the regex translation must share:
    // `**` after a slash can match the empty remainder, `*` can match zero chars.
    assert.equal(fileInScope(['a/**'], 'a/'), true)
    assert.equal(fileInScope(['a/**'], 'a'), false)
    assert.equal(naiveMatch('a/**', 'a/'), true)
    assert.equal(naiveMatch('a/**', 'a'), false)
    assert.equal(fileInScope(['a*'], 'a'), true)
    assert.equal(naiveMatch('a*', 'a'), true)

    // Segment-aligned overlap: every shared path implies overlap.
    assert.equal(scopesOverlap(['src/**'], ['src/deep/**']), true)
    assert.equal(scopesOverlap(['src/**'], ['lib/**']), false)
    assert.equal(scopesOverlap(['a/**'], ['a']), true, 'the heuristic over-approximates rather than under-approximates')
  },
})
