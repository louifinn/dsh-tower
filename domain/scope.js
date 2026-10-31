import { TowerToolError } from './errors.js'
// Pure scope helpers shared by planning and gates.
// @ts-check
const GLOB_META = /[*?[{]/

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new TowerToolError('invalid-argument', message)
}

/** @typedef {{ caseInsensitive?: boolean }} MatchOptions */

/**
 * Case folding is a comparison decision, not a normalisation: the stored scope
 * text keeps the operator's casing, and callers supply the checkout's detected
 * mode (#90).
 * @param {string} value
 * @param {boolean} caseInsensitive
 * @returns {string}
 */
function foldCase(value, caseInsensitive) {
  return caseInsensitive ? value.toLowerCase() : value
}

/**
 * @param {string} pattern
 * @param {MatchOptions} [options]
 * @returns {RegExp}
 */
function globToRegExp(pattern, { caseInsensitive = false } = {}) {
  const source = foldCase(pattern, caseInsensitive)
  let out = '^'
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '*') {
      if (source[index + 1] === '*') {
        out += '.*'
        index += 1
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`${out}$`)
}

/**
 * @param {string[] | null | undefined} scope
 * @param {string} file
 * @param {MatchOptions} [options]
 * @returns {boolean}
 */
export function fileInScope(scope, file, { caseInsensitive = false } = {}) {
  const target = foldCase(file, caseInsensitive)
  return (scope ?? []).some((pattern) => globToRegExp(pattern, { caseInsensitive }).test(target))
}

/**
 * The first scope entry that would match `file` if case were folded, or null.
 * Only used to explain a rejection on a case-sensitive checkout; it never
 * widens the acceptance test (#90).
 * @param {string[] | null | undefined} scope
 * @param {string} file
 * @returns {string | null}
 */
export function caseInsensitiveScopeMatch(scope, file) {
  const target = file.toLowerCase()
  return (scope ?? []).find((pattern) => globToRegExp(pattern, { caseInsensitive: true }).test(target)) ?? null
}

/**
 * The comparison the helpers use for a detected mode. `null`/`undefined` (a
 * legacy state that predates detection) keeps the safe, exact default.
 * @param {unknown} caseInsensitive
 * @returns {'case-insensitive' | 'case-sensitive'}
 */
export function comparisonMode(caseInsensitive) {
  return caseInsensitive === true ? 'case-insensitive' : 'case-sensitive'
}

// Mission titles are printable Unicode, not printable ASCII (#88). The hazards
// the old ASCII range stood in for are made explicit: control/format/surrogate
// code points, bidi overrides, zero-width characters, and unbounded length.
const TITLE_MAX_LENGTH = 120
// U+202A..U+202E (embedding/override) and U+2066..U+2069 (isolate/override).
const BIDI_OVERRIDE = /[\u202A-\u202E\u2066-\u2069]/
// U+200B..U+200D (zero-width space/non-joiner/joiner) and U+FEFF (BOM/ZWNBSP).
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/
// Unicode "Other": controls (Cc), format (Cf), unassigned (Cn), private use
// (Co) and surrogates (Cs). With the `u` flag a lone surrogate matches Cs,
// while a valid surrogate pair is one printable code point.
const CONTROL_OR_FORMAT = /\p{C}/u

/**
 * @param {unknown} title
 * @returns {string}
 */
export function validateTitle(title) {
  if (typeof title !== 'string' || title.trim().length === 0) fail('mission title is required')
  if (BIDI_OVERRIDE.test(title)) {
    fail(`mission title must not contain bidi override characters (U+202A-U+202E, U+2066-U+2069): ${JSON.stringify(title)}`)
  }
  if (ZERO_WIDTH.test(title)) {
    fail(`mission title must not contain zero-width characters (U+200B-U+200D, U+FEFF): ${JSON.stringify(title)}`)
  }
  if (CONTROL_OR_FORMAT.test(title)) {
    fail(`mission title must not contain control, format, or surrogate characters: ${JSON.stringify(title)}`)
  }
  const normalized = title.trim().normalize('NFC')
  // Count Unicode code points, not UTF-16 units, so astral characters (emoji)
  // count as one character and the bound is script-independent.
  const length = [...normalized].length
  if (length > TITLE_MAX_LENGTH) {
    fail(`mission title must be at most ${TITLE_MAX_LENGTH} characters after NFC normalization (got ${length})`)
  }
  return normalized
}

/**
 * @param {unknown} scope
 * @param {{ allowEmpty?: boolean }} [options]
 * @returns {string[]}
 */
export function normalizeScope(scope, { allowEmpty = false } = {}) {
  if (!Array.isArray(scope)) fail('mission scope must be an array of relative globs')
  if (scope.length === 0 && !allowEmpty) fail('mission scope must not be empty for a build mission')
  /** @type {string[]} */
  const out = []
  for (const raw of scope) {
    if (typeof raw !== 'string' || raw.trim().length === 0) fail('scope entries must be non-empty strings')
    const value = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim()
    if (value.length === 0) fail('scope entries must be non-empty strings')
    if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) fail(`scope must be relative: ${raw}`)
    if (value.split('/').some((part) => part === '..')) fail(`scope must not contain "..": ${raw}`)
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/**
 * @param {string} pattern
 * @returns {string}
 */
function scopePrefix(pattern) {
  const index = pattern.search(GLOB_META)
  const literal = index < 0 ? pattern : pattern.slice(0, index)
  return literal.replace(/\/+$/, '')
}

/**
 * The historical directory-prefix heuristic. Cheap, and deliberately wider
 * than the exact glob intersection: it serializes `a/**` with `a` and
 * `src/*.js` with `src/a/x.js`, and pairs anything with a leading wildcard.
 * It is only an over-approximation, so it misses inline prefixes such as
 * `a/b*` vs `a/bc*`; `globLanguagesIntersect` below covers those.
 * @param {string} pa folded pattern
 * @param {string} pb folded pattern
 * @returns {boolean}
 */
function prefixesOverlap(pa, pb) {
  const x = scopePrefix(pa)
  const y = scopePrefix(pb)
  if (!x || !y) return true
  if (x === y) return true
  return x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

// ---------------------------------------------------------------------------
// Exact glob-language intersection (F16, #130).
//
// Each pattern becomes an NFA over the documented grammar: a literal matches
// itself, `?` matches one non-`/` character, `*` matches zero or more non-`/`
// characters, and `**` matches zero or more of any character. Two patterns
// share a concrete path exactly when the product of their NFAs can reach the
// accepting states, so the check is complete for that grammar.

/** @typedef {{ kind: 'literal', char: string } | { kind: 'nonSlash' } | { kind: 'any' }} CharSet */
/** @typedef {{ charset: CharSet, to: number }} GlobTransition */
/** @typedef {{ kind: 'literal', char: string } | { kind: 'star' } | { kind: 'any' } | { kind: 'question' }} GlobToken */

/**
 * Split a pattern into glob tokens exactly like `globToRegExp` walks it: a
 * doubled `*` is one `**` token (anything, including `/`), every other `*` is
 * one non-`/` token, `?` is one non-`/` character, and everything else is a
 * literal (including `[`, `]`, `{` and `}` — they are not grammar, #130).
 * @param {string} pattern
 * @returns {GlobToken[]}
 */
function globTokens(pattern) {
  /** @type {GlobToken[]} */
  const tokens = []
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        tokens.push({ kind: 'any' })
        index += 1
      } else {
        tokens.push({ kind: 'star' })
      }
    } else if (char === '?') {
      tokens.push({ kind: 'question' })
    } else {
      tokens.push({ kind: 'literal', char })
    }
  }
  return tokens
}

/**
 * The characters one token can consume from `state`, and where they lead.
 * A `*`/`**` token loops on itself; skipping it (consuming nothing) is the
 * epsilon transition, handled by `epsilonClosure`.
 * @param {GlobToken | undefined} token
 * @param {number} state
 * @returns {GlobTransition[]}
 */
function tokenTransitions(token, state) {
  if (token === undefined) return []
  if (token.kind === 'literal') return [{ charset: { kind: 'literal', char: token.char }, to: state + 1 }]
  if (token.kind === 'question') return [{ charset: { kind: 'nonSlash' }, to: state + 1 }]
  if (token.kind === 'star') return [{ charset: { kind: 'nonSlash' }, to: state }]
  return [{ charset: { kind: 'any' }, to: state }]
}

/**
 * States reachable from `state` without consuming a character: a `*` or `**`
 * token may be skipped, and consecutive skippable tokens chain.
 * @param {GlobToken[]} tokens
 * @param {number} state
 * @returns {number[]}
 */
function epsilonClosure(tokens, state) {
  const out = [state]
  let cursor = state
  while (cursor < tokens.length) {
    const token = tokens[cursor]
    if (token === undefined || (token.kind !== 'star' && token.kind !== 'any')) break
    cursor += 1
    out.push(cursor)
  }
  return out
}

/**
 * Whether one character can satisfy both transitions' character sets.
 * `any` includes `/`, so it intersects every set.
 * @param {CharSet} left
 * @param {CharSet} right
 * @returns {boolean}
 */
function charsetsIntersect(left, right) {
  if (left.kind === 'literal' && right.kind === 'literal') return left.char === right.char
  if (left.kind === 'literal') return left.char !== '/' || right.kind === 'any'
  if (right.kind === 'literal') return right.char !== '/' || left.kind === 'any'
  return true
}

/**
 * Whether the two patterns match at least one common path.
 * @param {GlobToken[]} left
 * @param {GlobToken[]} right
 * @returns {boolean}
 */
function globLanguagesIntersect(left, right) {
  /** @type {number[][]} */
  const leftClosures = []
  for (let state = 0; state <= left.length; state += 1) leftClosures.push(epsilonClosure(left, state))
  /** @type {number[][]} */
  const rightClosures = []
  for (let state = 0; state <= right.length; state += 1) rightClosures.push(epsilonClosure(right, state))

  /** @type {[number, number][]} */
  const queue = [[0, 0]]
  const seen = new Set(['0:0'])
  while (queue.length > 0) {
    const pair = queue.pop()
    if (pair === undefined) break
    const [leftState, rightState] = pair
    const leftClosure = leftClosures[leftState] ?? [leftState]
    const rightClosure = rightClosures[rightState] ?? [rightState]
    if (leftClosure.includes(left.length) && rightClosure.includes(right.length)) return true
    for (const fromLeft of leftClosure) {
      for (const fromRight of rightClosure) {
        for (const leftMove of tokenTransitions(left[fromLeft], fromLeft)) {
          for (const rightMove of tokenTransitions(right[fromRight], fromRight)) {
            if (!charsetsIntersect(leftMove.charset, rightMove.charset)) continue
            const key = `${leftMove.to}:${rightMove.to}`
            if (seen.has(key)) continue
            seen.add(key)
            queue.push([leftMove.to, rightMove.to])
          }
        }
      }
    }
  }
  return false
}

/**
 * Whether two scopes may own the same path, i.e. whether the missions that
 * declare them must serialize. The contract is a *sound over-approximation*:
 *
 *   * if one concrete path is in both scopes, this returns true;
 *   * it may also return true for scopes that only look adjacent, because the
 *     directory-prefix heuristic is deliberately conservative (`a/**` vs `a`,
 *     `src/*.js` vs `src/a/x.js`, anything with a leading wildcard).
 *
 * `false` therefore means "provably disjoint within the documented grammar"
 * (`*` never crosses `/`, `**` does, `?` is one non-`/` character, everything
 * else is literal, and only `*`, `**` and `?` are special).
 *
 * Each pair of entries is checked twice, and either check may return true:
 *   1. the legacy directory-prefix heuristic (cheap, conservative);
 *   2. an exact intersection of the two glob languages, which catches the
 *      inline prefixes the heuristic misses: `a/b*` and `a/bc*` both match
 *      `a/bcd`, and `src/a*.mjs` and `src/ab*.mjs` both match `src/abx.mjs`.
 *
 * Known limits: `[...]` and `{...}` are not grammar (they match literally,
 * same as `fileInScope`); a leading wildcard is treated as a wildcard tree, so
 * a scope that starts with a glob token overlaps every scope.
 * `caseInsensitive` only decides the comparison — neither the stored scope
 * text nor the result is rewritten.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @param {MatchOptions} [options]
 * @returns {boolean}
 */
export function scopesOverlap(a, b, { caseInsensitive = false } = {}) {
  for (const rawA of a) {
    for (const rawB of b) {
      const pa = foldCase(rawA, caseInsensitive)
      const pb = foldCase(rawB, caseInsensitive)
      if (pa === pb) return true
      if (prefixesOverlap(pa, pb)) return true
      if (globLanguagesIntersect(globTokens(pa), globTokens(pb))) return true
    }
  }
  return false
}
