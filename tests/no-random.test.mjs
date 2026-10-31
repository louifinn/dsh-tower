// Regression guard: test inputs are generated, not hand-rolled with a PRNG.
//
// Issue #130 replaced the one hand-written generative test (a mulberry32 loop in
// tests/state-machine.test.mjs) with fast-check properties. This guard keeps the
// replacement honest: if a future test inlines its own PRNG again, the seed
// becomes an unexplained constant, failures cannot shrink, and the suite drifts
// back to the state the issue documented. fast-check owns seed selection and
// shrinking; the property harness exposes `FC_SEED`/`FC_PATH` for replay.
//
// WHAT IS FORBIDDEN (outside the exemptions below)
//   * `Math.random`
//   * named inlined PRNGs: mulberry32, xorshift, sfc32, splitmix, seedrandom,
//     LCG / "linear congruential"
//   * `Math.imul` (the 32-bit mixing primitive those PRNGs are built from)
//   * `randomUUID`/`randomBytes`/`randomInt`/`randomFill` used as a *test input
//     source* (e.g. deriving ids or payloads that a test then asserts on)
//
// WHAT IS ALLOWED, AND WHY (the explicit exemption list)
//   * `tests/live/**` — end-to-end scripts that copy real session ids and
//     allocate temporary directories; the randomness is runtime plumbing, not
//     test input generation.
//   * `tests/helpers/cleanup.mjs` — `crypto.randomUUID()` names quarantine
//     directories so two concurrent runs cannot collide.
//   * `tests/property/helpers/harness.mjs` — the long tier draws one
//     `randomInt` seed from `node:crypto` and hands it to fast-check. That is
//     deliberately *non-deterministic* so nightly runs explore new inputs; the
//     PR tier uses the fixed `PR_SEEDS`, and failures replay through
//     `FC_SEED`/`FC_PATH`, never through a local PRNG.
//   * a line carrying `prng-guard: allow <reason>` — for a future justified
//     exception; the reason is required and should also be added here.
//   * this file (it would otherwise match its own scanner patterns).
//
// Everything else under tests/**/*.mjs and tests/**/*.cjs must stay clean.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const TESTS_ROOT = path.dirname(fileURLToPath(import.meta.url))

/** @type {Array<{ id: string, pattern: RegExp, why: string }>} */
const RULES = [
  { id: 'Math.random', pattern: /\bMath\s*\.\s*random\b/, why: 'Math.random is not seeded or replayable' },
  { id: 'mulberry32', pattern: /mulberry32/i, why: 'mulberry32 was the hand-rolled fuzz PRNG removed by #130' },
  { id: 'xorshift', pattern: /xorshift/i, why: 'an inlined xorshift seed is an unexplained constant' },
  { id: 'sfc32', pattern: /sfc32/i, why: 'an inlined sfc32 seed is an unexplained constant' },
  { id: 'splitmix', pattern: /splitmix/i, why: 'an inlined splitmix seed is an unexplained constant' },
  { id: 'seedrandom', pattern: /seedrandom/i, why: 'seedrandom hides the seed outside FC_SEED replay' },
  { id: 'LCG', pattern: /\bLCG\b|linear\s+congruential/i, why: 'an inlined LCG seed is an unexplained constant' },
  { id: 'Math.imul', pattern: /\bMath\s*\.\s*imul\b/, why: 'Math.imul is the 32-bit mixing step of an inlined PRNG' },
  {
    id: 'node:crypto input randomness',
    pattern: /\brandom(?:UUID|Bytes|Int|Fill)\s*\(/,
    why: 'cryptographic randomness used as a test input makes failures unreplayable',
  },
]

/** @type {string[]} */
const EXEMPT_FILES = [
  // Runtime plumbing: live scripts copy session ids / allocate temp resources.
  'tests/live/',
  // Quarantine temp-directory names must not collide between concurrent runs.
  'tests/helpers/cleanup.mjs',
  // Long-tier seed for fast-check: non-determinism on purpose, replay via FC_SEED.
  'tests/property/helpers/harness.mjs',
]

const EXEMPT_ANNOTATION = 'prng-guard: allow'

/** @param {string} relative @returns {boolean} */
function exemptFile(relative) {
  const unix = relative.replaceAll('\\', '/')
  if (unix === 'tests/no-random.test.mjs') return true
  return EXEMPT_FILES.some((entry) => (entry.endsWith('/') ? unix.startsWith(entry) : unix === entry))
}

/**
 * Scan one file's text and return its violations. Exported as a plain function
 * so the meta-test below can prove the scanner actually catches a planted PRNG.
 * @param {string} text
 * @param {string} relative
 * @returns {Array<{ file: string, line: number, rule: string, source: string, why: string }>}
 */
export function scanSource(text, relative) {
  /** @type {Array<{ file: string, line: number, rule: string, source: string, why: string }>} */
  const violations = []
  text.split('\n').forEach((line, index) => {
    if (line.includes(EXEMPT_ANNOTATION)) return
    // Skip pure comment lines: documentation may name a forbidden PRNG.
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        violations.push({ file: relative, line: index + 1, rule: rule.id, source: line.trim(), why: rule.why })
      }
    }
  })
  return violations
}

/** @param {string} dir @returns {string[]} */
function testSources(dir) {
  /** @type {string[]} */
  const files = []
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:m?js|cjs)$/.test(entry.name)) continue
    const absolute = path.join(entry.parentPath, entry.name)
    const relative = path.relative(path.dirname(TESTS_ROOT), absolute).replaceAll('\\', '/')
    if (exemptFile(relative)) continue
    files.push(absolute)
  }
  return files
}

test('test inputs contain no hand-rolled PRNG or Math.random', (t) => {
  const files = testSources(TESTS_ROOT)
  // A vacuous pass (zero files scanned) would hide a broken walker.
  assert.ok(files.length > 50, `expected to scan the test suite, scanned ${files.length} files`)
  /** @type {Array<{ file: string, line: number, rule: string, source: string, why: string }>} */
  const violations = []
  for (const absolute of files) {
    const relative = path.relative(path.dirname(TESTS_ROOT), absolute).replaceAll('\\', '/')
    violations.push(...scanSource(fs.readFileSync(absolute, 'utf8'), relative))
  }
  t.diagnostic(`scanned ${files.length} test files`)
  t.diagnostic(`exemptions: ${EXEMPT_FILES.join(', ')}, ${EXEMPT_ANNOTATION} <reason>`)
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.source}`),
    [],
    'hand-rolled randomness in test inputs is banned; use fast-check (tests/property) or add a documented exemption',
  )
})

test('the PRNG guard is not vacuous: it flags each documented pattern', () => {
  /** @type {Array<[string, string]>} */
  const planted = [
    ['const value = Math.random()', 'Math.random'],
    ['function mulberry32(seed) {', 'mulberry32'],
    ['seed ^= seed << 13 // xorshift', 'xorshift'],
    ['const rng = sfc32(a, b, c, d)', 'sfc32'],
    ['const mix = splitmix32(seed)', 'splitmix'],
    ['import seedrandom from "seedrandom"', 'seedrandom'],
    ['let state = (a * 1664525 + 1013904223) >>> 0 // LCG', 'LCG'],
    ['const mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)', 'Math.imul'],
    ['const id = crypto.randomUUID()', 'node:crypto input randomness'],
  ]
  for (const [line, expectedRule] of planted) {
    const found = scanSource(line, 'tests/planted.test.mjs').map((v) => v.rule)
    assert.ok(found.includes(expectedRule), `expected ${expectedRule} to be flagged in: ${line}`)
  }
  // A line opting out with a reason is exempt.
  assert.deepEqual(scanSource('const x = Math.random() // prng-guard: allow port allocation', 'tests/x.test.mjs'), [])
  // Comment-only lines may discuss a PRNG without failing the guard.
  assert.deepEqual(scanSource('// mulberry32 is banned by #130', 'tests/x.test.mjs'), [])
})
