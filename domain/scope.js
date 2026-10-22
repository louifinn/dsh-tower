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
      const x = scopePrefix(pa)
      const y = scopePrefix(pb)
      if (!x || !y) return true
      if (x === y) return true
      if (x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true
    }
  }
  return false
}
