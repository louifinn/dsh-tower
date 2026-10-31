// Property 8 (#130): scope normalization is idempotent, titles are normalized
// to NFC and bounded by code points (not UTF-16 units).
//
// WHAT THIS FILE CHECKS
// ---------------------
// `normalizeScope` promises a canonical, relative, duplicate-free scope array.
// Two properties follow from that: applying it to its own output changes
// nothing, and every spelling of the same entry (Windows separators, a `./`
// prefix, trailing separators) reaches the same entry. Invalid entries —
// absolute paths, drive letters and `..` traversal — are refused with
// `TowerToolError('invalid-argument')` rather than resolved.
//
// `validateTitle` promises printable Unicode: it trims, normalizes to NFC, and
// caps the result at 120 **code points**. The tests below deliberately mix
// astral characters (one UTF-16 surrogate pair each) with BMP text so a bound
// accidentally written against `String#length` fails here: 120 emoji are 240
// UTF-16 units and must be accepted, 121 must be refused with the documented
// message. A rejected title also stays rejected after normalization — bidi
// overrides, zero-width characters, controls and over-long text are not removed
// by NFC.
//
// No shrunk counterexample has been observed for these properties across the
// three PR seeds (131, 40961, 978217) or the 2000-run long tier.
import assert from 'node:assert/strict'
import fc from 'fast-check'

import { TowerToolError } from '../../domain/errors.js'
import { normalizeScope, validateTitle } from '../../domain/scope.js'
import {
  absoluteScopeEntryArb,
  parentTraversalScopeEntryArb,
  scopeArb,
  scopeEntryArb,
} from './arbitraries/index.mjs'
import { runProperty } from './helpers/harness.mjs'

/** The documented title bound: Unicode code points after NFC and trim. */
const TITLE_MAX_LENGTH = 120

/**
 * @param {() => unknown} callback
 * @returns {unknown | null}
 */
function rejectionOf(callback) {
  try {
    callback()
    return null
  } catch (error) {
    return error
  }
}

/**
 * @param {unknown} error
 * @param {string} label
 * @param {RegExp} [message]
 * @returns {TowerToolError}
 */
function assertInvalidArgument(error, label, message) {
  assert.ok(error instanceof TowerToolError, `${label}: expected a TowerToolError, got ${String(error)}`)
  assert.equal(error.code, 'invalid-argument', `${label}: expected invalid-argument, got ${error.code}`)
  if (message) assert.match(String(error.message), message, `${label}: unexpected message`)
  return error
}

// ---------------------------------------------------------------------------
// normalizeScope: idempotence, canonical spelling, refusal of invalid entries.
// ---------------------------------------------------------------------------

runProperty({
  name: 'scope normalization: normalizeScope is idempotent on generated scopes',
  arbitrary: scopeArb,
  classify: (scope) => `entries=${scope.length}`,
  predicate: (scope) => {
    const once = normalizeScope(scope, { allowEmpty: true })
    const twice = normalizeScope(once, { allowEmpty: true })
    assert.deepEqual(twice, once, 'normalizeScope(normalizeScope(x)) must equal normalizeScope(x)')
    for (const entry of once) {
      assert.deepEqual(
        normalizeScope([entry], { allowEmpty: true }),
        [entry],
        `a normalized entry must be a fixed point: ${JSON.stringify(entry)}`,
      )
      assert.ok(!entry.startsWith('/'), `an absolute entry survived normalization: ${entry}`)
      assert.ok(!/^[A-Za-z]:/.test(entry), `a drive-letter entry survived normalization: ${entry}`)
      assert.ok(!entry.split('/').includes('..'), `a traversal entry survived normalization: ${entry}`)
    }
    // Duplicates collapse, and the second copy never reappears on either pass.
    assert.deepEqual(normalizeScope([...scope, ...scope], { allowEmpty: true }), once)
    assert.deepEqual(normalizeScope([...once, ...once], { allowEmpty: true }), once)
  },
})

runProperty({
  name: 'scope normalization: every separator spelling of an entry reaches the same normalized entry',
  arbitrary: scopeEntryArb,
  predicate: (entry) => {
    const canonical = normalizeScope([entry])[0]
    for (const spelled of [entry, entry.replaceAll('/', '\\'), entry.replaceAll('\\', '/')]) {
      assert.deepEqual(
        normalizeScope([spelled]),
        [canonical],
        `separator spelling ${JSON.stringify(spelled)} normalized to a different entry than ${JSON.stringify(entry)}`,
      )
    }
    assert.equal(canonical, canonical.trim(), 'a normalized entry must not carry surrounding whitespace')
    assert.ok(!canonical.endsWith('/'), 'a normalized entry must not carry a trailing separator')
    assert.ok(!canonical.startsWith('./'), 'a normalized entry must not carry a "./" prefix')
  },
})

runProperty({
  name: 'scope normalization: absolute and parent-traversal entries are rejected, never resolved',
  arbitrary: fc.oneof(
    absoluteScopeEntryArb.map((entry) => ({ entry, message: /scope must be relative/ })),
    parentTraversalScopeEntryArb.map((entry) => ({ entry, message: /scope must not contain "\.\."/ })),
  ),
  predicate: ({ entry, message }) => {
    const error = assertInvalidArgument(rejectionOf(() => normalizeScope([entry])), `scope ${JSON.stringify(entry)}`, message)
    assert.ok(error instanceof TowerToolError)
  },
})

runProperty({
  name: 'scope normalization: hostile scope shapes and empty entries are rejected with invalid-argument',
  arbitrary: fc.constantFrom(
    { scope: null, message: /array/ },
    { scope: undefined, message: /array/ },
    { scope: 'src/**', message: /array/ },
    { scope: 42, message: /array/ },
    { scope: {}, message: /array/ },
    { scope: [], message: /must not be empty/ },
    { scope: [''], message: /non-empty strings/ },
    { scope: ['   '], message: /non-empty strings/ },
    { scope: ['/'], message: /non-empty strings/ },
    { scope: ['./'], message: /non-empty strings/ },
    { scope: ['\\'], message: /non-empty strings/ },
    { scope: ['C:/abs'], message: /relative/ },
    { scope: ['C:\\abs'], message: /relative/ },
    { scope: ['src/../escape'], message: /"\.\."/ },
    { scope: ['src\\..\\escape'], message: /"\.\."/ },
    { scope: [null], message: /non-empty strings/ },
    { scope: [7], message: /non-empty strings/ },
  ),
  predicate: ({ scope, message }) => {
    assertInvalidArgument(
      rejectionOf(() => normalizeScope(/** @type {any} */ (scope))),
      `hostile scope ${JSON.stringify(scope)}`,
      message ?? undefined,
    )
  },
})

runProperty({
  name: 'scope normalization: an empty scope is legal only when the caller allows it',
  arbitrary: fc.constant(null),
  predicate: () => {
    assert.equal(rejectionOf(() => normalizeScope([], { allowEmpty: true })), null)
    assert.deepEqual(normalizeScope([], { allowEmpty: true }), [])
    assertInvalidArgument(rejectionOf(() => normalizeScope([])), 'empty scope', /must not be empty/)
  },
})

// ---------------------------------------------------------------------------
// validateTitle: NFC normalization and the code-point bound.
// ---------------------------------------------------------------------------

const ASCII_TITLE_CHAR = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:_()/+-'.split('')

// Printable Unicode chunks. ZWJ sequences are deliberately absent: U+200D is a
// zero-width character and must be rejected, not accepted as a display glyph.
const UNICODE_TITLE_CHUNK = [
  '数据迁移',
  'Tower·属性测试',
  'Zürich',
  'café',
  'straße',
  'λόγος',
  '日本語',
  '한국어',
  '🚀',
  '🧪',
  '🛰️',
  '🇳🇴',
  '😀',
  '🦀',
  'e\u0301',
  'n\u0303',
  'Å',
  'ñ',
]

const titleChunkArb = fc.oneof(
  { weight: 4, arbitrary: fc.array(fc.constantFrom(...ASCII_TITLE_CHAR), { minLength: 1, maxLength: 12 }).map((chars) => chars.join('')) },
  { weight: 1, arbitrary: fc.constantFrom(...UNICODE_TITLE_CHUNK) },
)

const validTitleArb = fc
  .array(titleChunkArb, { minLength: 1, maxLength: 8 })
  .map((chunks) => chunks.join('').trim())
  .filter((title) => title.length > 0 && [...title].length <= TITLE_MAX_LENGTH)

runProperty({
  name: 'title normalization: a valid Unicode title is accepted, trimmed, normalized to NFC, and stable',
  arbitrary: validTitleArb,
  classify: (title) => `utf16=${title.length <= TITLE_MAX_LENGTH ? '<=120' : '>120'}`,
  predicate: (title) => {
    const normalized = validateTitle(title)
    assert.equal(typeof normalized, 'string')
    assert.equal(normalized, title.trim().normalize('NFC'), 'validateTitle must trim and normalize to NFC')
    assert.equal(normalized, normalized.normalize('NFC'), 'the returned title must already be NFC')
    assert.equal(validateTitle(normalized), normalized, 'validateTitle must be idempotent on its own output')
    assert.ok([...normalized].length <= TITLE_MAX_LENGTH, 'the returned title must fit the code-point bound')
  },
})

const NFD_BASE = ['a', 'e', 'i', 'o', 'u', 'n', 'c', 'y', 'A', 'E', 'U']
const NFD_MARK = ['\u0301', '\u0303', '\u0308', '\u0327']

const nfdTitleArb = fc
  .array(
    fc.tuple(
      fc.constantFrom(...NFD_BASE),
      fc.array(fc.constantFrom(...NFD_MARK), { minLength: 1, maxLength: 2 }).map((marks) => marks.join('')),
    ),
    { minLength: 1, maxLength: 8 },
  )
  .map((pairs) => pairs.map(([base, marks]) => `${base}${marks}`).join(' '))

runProperty({
  name: 'title normalization: decomposed (NFD) input is accepted and returned as NFC',
  arbitrary: nfdTitleArb,
  predicate: (title) => {
    const normalized = validateTitle(title)
    assert.equal(normalized, title.trim().normalize('NFC'), 'an NFD title must validate to its NFC form')
    assert.equal(normalized, normalized.normalize('NFC'))
    assert.ok(
      [...normalized].length <= [...title.trim()].length,
      'NFC composition must not increase the code-point count',
    )
  },
})

/** An accepted title with one rejected hazard injected at a generated position. */
const hazardousTitleArb = fc
  .tuple(
    validTitleArb,
    fc.integer({ min: 0, max: 40 }),
    fc.constantFrom(
      { hazard: '\u202E', message: /bidi/ },
      { hazard: '\u2066', message: /bidi/ },
      { hazard: '\u200B', message: /zero-width/ },
      { hazard: '\u200D', message: /zero-width/ },
      { hazard: '\uFEFF', message: /zero-width/ },
      { hazard: '\u0000', message: /control/ },
      { hazard: '\u001B', message: /control/ },
      { hazard: '\u007F', message: /control/ },
      { hazard: '\uD800', message: /control/ },
    ),
  )
  .map(([title, position, { hazard, message }]) => {
    const index = Math.min(position, title.length)
    const injected = `${title.slice(0, index)}${hazard}${title.slice(index)}`
    // Injecting after a code unit split could land inside a surrogate pair; keep
    // the fixture a well-formed string by injecting only at a code-point boundary.
    const safe = index > 0 && /[\uD800-\uDBFF]/.test(title[index - 1] ?? '') ? `${title}${hazard}` : injected
    return { title: safe, message }
  })

runProperty({
  name: 'title normalization: a rejected hazard is never accepted after NFC normalization',
  arbitrary: hazardousTitleArb,
  predicate: ({ title, message }) => {
    const error = assertInvalidArgument(rejectionOf(() => validateTitle(title)), `hazardous title ${JSON.stringify(title)}`, message)
    assert.ok(error instanceof TowerToolError)
    // NFC does not remove bidi/zero-width/control code points, so the normalized
    // spelling must be rejected for the same reason.
    assertInvalidArgument(
      rejectionOf(() => validateTitle(title.normalize('NFC'))),
      `hazardous NFC title ${JSON.stringify(title.normalize('NFC'))}`,
      message,
    )
  },
})

/** A title longer than the bound: printable text of a generated kind. */
const overlongTitleArb = fc
  .tuple(
    fc.integer({ min: TITLE_MAX_LENGTH + 1, max: TITLE_MAX_LENGTH + 120 }),
    fc.constantFrom({ unit: 'a', label: 'bmp' }, { unit: 'e\u0301', label: 'nfd' }, { unit: '🚀', label: 'astral' }),
  )
  .map(([length, { unit, label }]) => ({ title: unit.repeat(length), label }))

runProperty({
  name: 'title normalization: a title over 120 code points is rejected and stays rejected after NFC',
  arbitrary: overlongTitleArb,
  classify: ({ label }) => label,
  predicate: ({ title }) => {
    const error = assertInvalidArgument(
      rejectionOf(() => validateTitle(title)),
      `over-long title (${[...title].length} code points)`,
      /at most 120 characters after NFC normalization/,
    )
    assert.match(String(error.message), new RegExp(`\\(got ${[...title.normalize('NFC')].length}\\)`))
    assertInvalidArgument(
      rejectionOf(() => validateTitle(title.normalize('NFC'))),
      'over-long NFC title',
      /at most 120/,
    )
  },
})

runProperty({
  name: 'title normalization: the bound counts code points, not UTF-16 units',
  arbitrary: fc.constant(null),
  predicate: () => {
    const astral120 = '🚀'.repeat(120)
    assert.equal(astral120.length, 240, 'the fixture must exceed 120 UTF-16 units')
    assert.equal([...astral120].length, 120)
    assert.equal(validateTitle(astral120), astral120, '120 astral code points must be accepted')

    const astral121 = '🚀'.repeat(121)
    assertInvalidArgument(
      rejectionOf(() => validateTitle(astral121)),
      '121 astral code points',
      /\(got 121\)/,
    )

    // NFD text composes down: 121 decomposed `e`+acute pairs are 121 code points
    // before NFC and still 121 after (composition pairs one base with one mark),
    // so composition must not smuggle the title under the bound.
    assert.equal([...'e\u0301'.repeat(121)].length, 242)
    assert.equal(validateTitle('e\u0301'.repeat(120)), 'é'.repeat(120))
    assertInvalidArgument(
      rejectionOf(() => validateTitle('e\u0301'.repeat(121))),
      '121 decomposed code points',
      /\(got 121\)/,
    )

    assert.equal(validateTitle(` ${'a'.repeat(120)} `), 'a'.repeat(120), 'trim happens before the bound')
    assertInvalidArgument(rejectionOf(() => validateTitle('a'.repeat(121))), '121 BMP chars', /\(got 121\)/)
  },
})

runProperty({
  name: 'title normalization: blank and non-string titles are rejected',
  arbitrary: fc.constantFrom('', ' ', '\t\n', '   \r\n  ', null, undefined, 42, {}, [], ['Tower']),
  predicate: (title) => {
    assertInvalidArgument(
      rejectionOf(() => validateTitle(/** @type {any} */ (title))),
      `title ${JSON.stringify(title)}`,
      /mission title is required/,
    )
  },
})
