// Property 11 (#130): the error catalogue is total, reachable, and renders its
// recovery step exactly once.
//
// WHAT THIS FILE CHECKS
// ---------------------
// `domain/errors.js` is the model-visible error contract:
//
//   * every `ERROR_CODES` entry carries `description`, `trigger`, `retryable`
//     and `nextAction` (string or null);
//   * every catalogue code can be produced by `classifyError` from a thrown
//     object carrying that `code`, so no code is dead documentation;
//   * `renderErrorMessage` appends at most one trailing ` — next: …` segment:
//     exactly one when there is a recovery step, never a second one when the
//     message already contains the action or already carries a suffix;
//   * `classifyError` maps the documented error shapes: a `TowerToolError` is
//     returned unchanged, a plain `{code}` inside the catalogue is wrapped, a
//     `GitError` (real or `name`-shaped) maps by timeout/buffer flag, and
//     anything else becomes `tool-internal`.
//
// The ` — next:` count (not a regex) is the oracle: the bug this guards against
// is a duplicated suffix, which `includes`-style assertions would miss.
//
// A static scan of the production sources complements the catalogue properties:
// every literal `new TowerToolError('<code>', …)` must name a catalogue entry,
// so a typo cannot ship a code the model cannot look up. The scan also resolves
// a module-local `const X = '<code>'` used as the first argument, because F91
// showed a literal-only scan lets a code shipped through a constant escape the
// catalogue unnoticed. A first argument that is a genuine runtime value (the
// error-classification `code` parameter) cannot be resolved statically and
// stays exempt by design.
//
// No shrunk counterexample has been observed across the three PR seeds
// (131, 40961, 978217) or the long tier.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'

import {
  ERROR_CODES,
  ERROR_CODE_VALUES,
  GitError,
  TowerToolError,
  classifyError,
  errorDescription,
  errorEntry,
  errorNextAction,
  errorRetryable,
  isErrorCode,
  renderErrorMessage,
} from '../../domain/errors.js'
import { removeTemp } from '../helpers/cleanup.mjs'
import { runProperty } from './helpers/harness.mjs'

const CODES = [...ERROR_CODE_VALUES]
const codeArb = fc.constantFrom(...CODES)
const nextActionArb = fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 60 }))

/** Count the literal suffix marker; the bug is a *second* occurrence. */
function suffixCount(text) {
  return text.split('— next:').length - 1
}

/** @param {string} code */
function entryOf(code) {
  const entry = ERROR_CODES[code]
  assert.ok(entry, `catalogue is missing ${code}`)
  return entry
}

// ---------------------------------------------------------------------------
// Catalogue totality and accessor agreement.
// ---------------------------------------------------------------------------

runProperty({
  name: 'catalogue totality: every code has description, trigger, boolean retryable and string-or-null nextAction',
  arbitrary: fc.constant(null),
  predicate: () => {
    assert.ok(CODES.length > 0, 'the catalogue must not be empty')
    for (const code of CODES) {
      const entry = entryOf(code)
      assert.equal(typeof entry.description, 'string', `${code}.description must be a string`)
      assert.ok(entry.description.trim().length > 0, `${code}.description must be non-empty`)
      assert.equal(typeof entry.trigger, 'string', `${code}.trigger must be a string`)
      assert.ok(entry.trigger.trim().length > 0, `${code}.trigger must be non-empty`)
      assert.equal(typeof entry.retryable, 'boolean', `${code}.retryable must be a boolean`)
      assert.ok(
        entry.nextAction === null || (typeof entry.nextAction === 'string' && entry.nextAction.trim().length > 0),
        `${code}.nextAction must be a non-empty string or null`,
      )
    }
  },
})

runProperty({
  name: 'catalogue accessors: isErrorCode/errorEntry/errorDescription/errorRetryable/errorNextAction agree with the table',
  arbitrary: codeArb,
  predicate: (code) => {
    const entry = entryOf(code)
    assert.equal(isErrorCode(code), true)
    assert.equal(errorEntry(code), entry)
    assert.equal(errorDescription(code), entry.description)
    assert.equal(errorRetryable(code), entry.retryable)
    assert.equal(errorNextAction(code), entry.nextAction ?? null)
    // Unknown codes take the documented neutral defaults, never throw.
    assert.equal(isErrorCode(`${code}-nope`), false)
    assert.equal(errorEntry(`${code}-nope`), null)
    assert.equal(errorDescription(`${code}-nope`), '')
    assert.equal(errorRetryable(`${code}-nope`), false)
    assert.equal(errorNextAction(`${code}-nope`), null)
  },
})

runProperty({
  name: 'catalogue reachability: classifyError({code}) produces every catalogued code',
  arbitrary: codeArb,
  predicate: (code) => {
    const classified = classifyError({ code, message: 'generated failure' })
    assert.ok(classified instanceof TowerToolError, `${code} must classify to a TowerToolError`)
    assert.equal(classified.name, 'TowerToolError')
    assert.equal(classified.code, code)
    assert.equal(classified.retryable, entryOf(code).retryable)
    assert.equal(classified.nextAction, entryOf(code).nextAction)
    assert.match(classified.message, /^\[tower:[a-z-]+\] /)
    assert.ok(suffixCount(classified.message) <= 1, 'classification must never double the suffix')
  },
})

// ---------------------------------------------------------------------------
// `renderErrorMessage`: exactly one suffix, or none.
// ---------------------------------------------------------------------------

runProperty({
  name: 'render: a catalogue code appends its recovery step exactly once, and nothing when nextAction is null',
  arbitrary: codeArb,
  predicate: (code) => {
    const entry = entryOf(code)
    const rendered = renderErrorMessage(code, 'boom')
    assert.ok(rendered.startsWith(`[tower:${code}] boom`), 'the rendered message must start with the bracketed code')
    if (entry.nextAction === null) {
      assert.equal(rendered, `[tower:${code}] boom`, 'a code without a recovery step renders byte-identically')
      assert.equal(suffixCount(rendered), 0)
      return
    }
    assert.equal(suffixCount(rendered), 1, `${code} must append exactly one suffix`)
    assert.ok(
      rendered.endsWith(`— next: ${entry.nextAction}${entry.retryable ? ' (retryable)' : ''}`),
      `${code} must end with the documented suffix and retryable marker`,
    )
    assert.equal(rendered.includes(' (retryable)'), entry.retryable, 'the retryable marker follows the catalogue flag')
  },
})

runProperty({
  name: 'render: a message already carrying the action (or a suffix) is never suffixed twice',
  arbitrary: fc.tuple(codeArb, fc.string({ maxLength: 80 })),
  predicate: ([code, filler]) => {
    const entry = entryOf(code)
    if (entry.nextAction === null) {
      const rendered = renderErrorMessage(code, `${filler} — next: already there`)
      assert.equal(rendered, `[tower:${code}] ${filler} — next: already there`)
      assert.equal(suffixCount(rendered), 1)
      return
    }
    // The action already appears in the body: no extra suffix.
    const withAction = renderErrorMessage(code, `${filler} ${entry.nextAction} ${filler}`)
    assert.equal(withAction, `[tower:${code}] ${filler} ${entry.nextAction} ${filler}`)
    assert.equal(suffixCount(withAction), 0)
    // A prior suffix marker suppresses a second segment.
    const withSuffix = renderErrorMessage(code, `${filler} — next: earlier step`)
    assert.equal(suffixCount(withSuffix), 1)
    assert.ok(!withSuffix.endsWith(entry.nextAction), 'no second suffix may be appended')
  },
})

runProperty({
  name: 'render: an explicit nextAction override is honored, and null/undefined fall back to the catalogue',
  arbitrary: fc.tuple(codeArb, fc.string({ minLength: 1, maxLength: 40 }), fc.string({ maxLength: 40 })),
  predicate: ([code, action, filler]) => {
    // Strip the marker from the filler so this property isolates the explicit
    // action override rather than the pre-existing-suffix rule tested above.
    const body = filler.replaceAll('— next:', 'next:')
    const explicit = renderErrorMessage(code, body, { nextAction: action })
    if (body.includes(action)) {
      assert.equal(suffixCount(explicit), 0, 'an action already in the body must not be appended')
    } else {
      assert.equal(suffixCount(explicit), 1, 'an explicit action must be appended exactly once')
      const marker = entryOf(code).retryable ? ' (retryable)' : ''
      assert.ok(
        explicit.endsWith(`— next: ${action}${marker}`),
        'the explicit action is the one rendered, with the catalogue retryable marker',
      )
    }
    // `null` is not "no recovery step": it coalesces to the catalogue default,
    // exactly like omitting the option (`options.nextAction ?? errorNextAction`).
    assert.equal(renderErrorMessage(code, body, { nextAction: null }), renderErrorMessage(code, body))
    assert.equal(renderErrorMessage(code, body, { nextAction: undefined }), renderErrorMessage(code, body))
  },
})

runProperty({
  name: 'render: TowerToolError renders exactly one suffix and preserves retryable/nextAction metadata',
  arbitrary: codeArb,
  predicate: (code) => {
    const entry = entryOf(code)
    const error = new TowerToolError(code, 'constructing failure')
    assert.ok(error.message.startsWith(`[tower:${code}] constructing failure`))
    assert.equal(error.name, 'TowerToolError')
    assert.equal(error.code, code)
    assert.equal(error.retryable, entry.retryable)
    assert.equal(error.nextAction, entry.nextAction)
    assert.equal(error.details, null)
    assert.equal(suffixCount(error.message), entry.nextAction === null ? 0 : 1)
    // The same error classified again must be the very same object (no re-render).
    assert.equal(classifyError(error), error)
  },
})

runProperty({
  name: 'render: generated messages and next actions never produce two suffixes',
  arbitrary: fc.tuple(codeArb, fc.string({ maxLength: 120 }), nextActionArb, fc.boolean()),
  predicate: ([code, message, nextAction, retryableOverride]) => {
    const rendered = renderErrorMessage(code, message, { nextAction, retryable: retryableOverride })
    assert.ok(suffixCount(rendered) <= 1, `duplicated suffix in ${JSON.stringify(rendered)}`)
    assert.ok(rendered.startsWith(`[tower:${code}] ${message}`), 'the base message is preserved verbatim')
    const tail = rendered.slice(`[tower:${code}] ${message}`.length)
    if (tail) {
      assert.match(tail, /^ — next: /, 'the only permitted suffix is the documented one')
      assert.equal(tail.split(' — next: ').length - 1, 1)
    }
  },
})

// ---------------------------------------------------------------------------
// `classifyError` shape mapping.
// ---------------------------------------------------------------------------

runProperty({
  name: 'classify: a plain {code} object is wrapped with the original message and explicit metadata',
  arbitrary: fc.tuple(codeArb, fc.string({ maxLength: 80 }), fc.option(fc.boolean(), { nil: undefined }), nextActionArb),
  predicate: ([code, message, retryable, nextAction]) => {
    const entry = entryOf(code)
    /** @type {Record<string, unknown>} */
    const raw = { code, message }
    if (retryable !== undefined) raw.retryable = retryable
    if (nextAction !== null) raw.nextAction = nextAction
    const classified = classifyError(raw)
    assert.equal(classified.code, code)
    // `originalMessage` prefers `.message`, so the body is exactly the message.
    assert.ok(classified.message.startsWith(`[tower:${code}] ${message}`), 'the original message is preserved')
    assert.equal(classified.retryable, retryable ?? entry.retryable)
    assert.equal(classified.nextAction, nextAction ?? entry.nextAction)
    assert.equal(classified.details, null)
    assert.equal(classified.cause, raw)
  },
})

runProperty({
  name: 'classify: GitError maps to git-failed, and timeout/buffer overflow map to git-timeout',
  arbitrary: fc.constantFrom(
    [false, false, 'git-failed'],
    [true, false, 'git-timeout'],
    [false, true, 'git-timeout'],
    [true, true, 'git-timeout'],
  ),
  predicate: ([timedOut, bufferOverflow, expectedCode]) => {
    const real = new GitError(['status', '--short'], 'boom', 128, { timedOut, bufferOverflow })
    assert.equal(real.name, 'GitError')
    const classified = classifyError(real)
    assert.ok(classified instanceof TowerToolError)
    assert.equal(classified.code, expectedCode)
    assert.ok(classified.message.startsWith(`[tower:${expectedCode}] git status --short failed: boom`))
    assert.equal(classified.cause, real)
    // The `name`-shaped variant (a plain Error renamed by a wrapper) follows the
    // same branch without needing the real class.
    const shaped = Object.assign(new Error('shaped git failure'), { name: 'GitError', timedOut, bufferOverflow })
    assert.equal(classifyError(shaped).code, expectedCode)
    assert.equal(classifyError(shaped).message.startsWith(`[tower:${expectedCode}] shaped git failure`), true)
  },
})

runProperty({
  name: 'classify: everything else becomes tool-internal without throwing',
  arbitrary: fc.oneof(
    fc.string({ minLength: 1, maxLength: 40 }),
    fc.integer(),
    fc.constant(null),
    fc.constant(undefined),
    fc.constant({ code: 'not-a-code' }),
    fc.constant({ code: 42 }),
    fc.constant(new Error('plain runtime failure')),
    fc.constant({ message: 'object without code' }),
  ),
  predicate: (value) => {
    const classified = classifyError(value)
    assert.ok(classified instanceof TowerToolError)
    assert.equal(classified.code, 'tool-internal')
    assert.equal(suffixCount(classified.message), 0, 'tool-internal carries no recovery suffix')
    assert.match(classified.message, /^\[tower:tool-internal\] /)
  },
})

// ---------------------------------------------------------------------------
// Static completeness: literal production codes must be catalogue entries.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The six layered production roots; root-level entry modules are added below. */
const SOURCE_DIRS = ['domain', 'app', 'host', 'adapters', 'ports', 'tools']

/** @param {string} dir @returns {string[]} */
function sourceFiles(dir) {
  /** @type {string[]} */
  const files = []
  if (!fs.existsSync(dir)) return files
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:m?js)$/.test(entry.name)) continue
    files.push(path.join(entry.parentPath, entry.name))
  }
  return files
}

/**
 * Every production module the static scan covers under `root`: the six layered
 * roots plus the root-level entry modules (`index.js` is the `dsh` entry; its
 * siblings are the `bin` shims). Scanning root files by directory listing keeps
 * a code added to an entry point covered without another list to remember to
 * update.
 *
 * @param {string} root repository root
 * @returns {string[]}
 */
function productionFiles(root) {
  /** @type {string[]} */
  const files = []
  for (const dir of SOURCE_DIRS) files.push(...sourceFiles(path.join(root, dir)))
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:m?js)$/.test(entry.name)) continue
    files.push(path.join(root, entry.name))
  }
  return files
}

// Non-vacuity floor for the literal half of the static scan. Measured on this
// tree: 144 total `new TowerToolError(` calls, 125 of them with a literal first
// argument (19 take a runtime code and are exempt by design). A line-scoped scan
// — the bug this floor guards against — sees only 90 of those 125, because 35
// calls put the literal code on the line after `new TowerToolError(`. 120
// therefore fails loudly on a regression to per-line matching while still
// tolerating a handful of legitimate call sites being removed. The current
// measurement is recorded here; this is not an exact-count assertion.
const MIN_LITERAL_CALL_SITES = 120

/** Escape one identifier for use inside a RegExp. @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Resolve a module-local `const NAME = '<code>'` from the same file text. Only a
 * plain single-line string literal is resolved; a template, a concatenation, an
 * import or a function parameter is a genuine runtime value and stays exempt
 * (the dynamic-code exemption the catalogue always had).
 *
 * @param {string} text the whole file
 * @param {string} name the first-argument identifier
 * @returns {string | null} the resolved string, or null when not statically known
 */
function resolveLocalCode(text, name) {
  const pattern = new RegExp(`\\bconst\\s+${escapeRegExp(name)}\\s*=\\s*(['"])([^'"\\n]*)\\1`)
  const match = pattern.exec(text)
  return match ? match[2] : null
}

/**
 * Every `new TowerToolError(...)` call site the static scan can attribute to a
 * code: the literal first argument, and an identifier that a module-local
 * `const` in the same file resolves to a string (F91: a code shipped through a
 * constant must be checked too). A first argument that cannot be resolved is
 * recorded as dynamic and exempt.
 *
 * @param {string} root repository root
 * @returns {{
 *   sites: Array<{ file: string, line: number, code: string, via: string | null }>,
 *   dynamic: Array<{ file: string, line: number, ident: string }>,
 * }}
 */
function scanTowerToolErrorCodes(root) {
  /** @type {Array<{ file: string, line: number, code: string, via: string | null }>} */
  const sites = []
  /** @type {Array<{ file: string, line: number, ident: string }>} */
  const dynamic = []
  // Match the WHOLE file text, not each line: `\s*` spans newlines, so a code on
  // the line after `new TowerToolError(` is captured.
  const literal = /new\s+TowerToolError\(\s*(['"])([^'"]+)\1/g
  const identifier = /new\s+TowerToolError\(\s*([A-Za-z_$][\w$]*)/g
  for (const file of productionFiles(root)) {
    const text = fs.readFileSync(file, 'utf8')
    const relative = path.relative(root, file)
    const lineOf = (index) => text.slice(0, index).split('\n').length
    for (const match of text.matchAll(literal)) {
      sites.push({ file: relative, line: lineOf(match.index), code: match[2], via: null })
    }
    for (const match of text.matchAll(identifier)) {
      const resolved = resolveLocalCode(text, match[1])
      const site = { file: relative, line: lineOf(match.index) }
      if (resolved === null) dynamic.push({ ...site, ident: match[1] })
      else sites.push({ ...site, code: resolved, via: match[1] })
    }
  }
  return { sites, dynamic }
}

test('error catalogue, static: every literal or module-local-constant TowerToolError code in production sources is catalogued', () => {
  const { sites } = scanTowerToolErrorCodes(REPO_ROOT)
  const literalCount = sites.filter((site) => site.via === null).length
  assert.ok(
    literalCount >= MIN_LITERAL_CALL_SITES,
    `the whole-file static scan found ${literalCount} literal call sites, expected >= ${MIN_LITERAL_CALL_SITES}; ` +
      'a per-line scan cannot see a code on the line after `new TowerToolError(`',
  )
  const unknown = sites.filter(({ code }) => !isErrorCode(code))
  assert.deepEqual(
    unknown,
    [],
    `uncatalogued codes at ${unknown
      .map(({ file, line, code, via }) => `${file}:${line} (${via === null ? code : `${via} = ${code}`})`)
      .join(', ')}`,
  )
})

test('error catalogue, static: a module-local constant changed to an uncatalogued code reddens (fixture)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-error-catalogue-'))
  t.after(() => removeTemp(dir))
  const file = path.join(dir, 'tools', 'fixture.js')
  const source = (resumable) =>
    [
      "const CATALOGUED = 'invalid-argument'",
      `const NOT_CATALOGUED = '${resumable}'`,
      'new TowerToolError(CATALOGUED, "clean call")',
      'new TowerToolError(NOT_CATALOGUED, "dirty call")',
      '',
    ].join('\n')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, source('not-a-catalogue-code'))

  const { sites } = scanTowerToolErrorCodes(dir)
  // Both halves are proven at once: the catalogued constant stays clean while
  // the dirty one is reported by file, line and the constant that carried it.
  assert.deepEqual(
    sites.map(({ code, via }) => ({ code, via })),
    [
      { code: 'invalid-argument', via: 'CATALOGUED' },
      { code: 'not-a-catalogue-code', via: 'NOT_CATALOGUED' },
    ],
  )
  const unknown = sites.filter(({ code }) => !isErrorCode(code))
  assert.deepEqual(
    unknown.map(({ file, line, code, via }) => `${file}:${line} (${via} = ${code})`),
    [`${path.join('tools', 'fixture.js')}:4 (NOT_CATALOGUED = not-a-catalogue-code)`],
  )

  // And it fails for the right reason: cataloguing the constant silences it.
  fs.writeFileSync(file, source('invalid-argument'))
  assert.deepEqual(
    scanTowerToolErrorCodes(dir).sites.filter(({ code }) => !isErrorCode(code)),
    [],
  )
})
