// Load-bearing tests for the single blocker registry (#M62 W2-A).
//
// These fail when a code exists in the implementation without a registry entry,
// when a registry entry is never emitted, when the generated reference drifts,
// or when `scripts/check-docs.mjs` starts carrying a second blocker list again.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BLOCKER_CODES,
  BLOCKER_CODE_VALUES,
  BLOCKER_COUNT,
  BLOCKER_DEFINITIONS,
  BLOCKER_KINDS,
  REVIEW_BLOCKER_CODES,
  WARNING_BLOCKER_CODES,
  assertBlockerCode,
  blocker,
  blockerEntry,
  blockersOfKind,
  isBlockerCode,
} from '../domain/shapes/blockers.js'
import { analyze, evaluate, scanSource } from '../scripts/check-blockers.mjs'
import { renderBlockersReference } from '../scripts/generate-blockers-reference.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

test('blocker registry: codes are unique, lowercase, and carry both locales', () => {
  assert.equal(BLOCKER_COUNT, BLOCKER_DEFINITIONS.length)
  assert.equal(new Set(BLOCKER_CODE_VALUES).size, BLOCKER_COUNT)
  for (const entry of BLOCKER_DEFINITIONS) {
    assert.match(entry.code, /^[a-z][a-z0-9-]+$/)
    assert.ok(BLOCKER_KINDS.some((kind) => entry.kinds.includes(kind)), entry.code)
    assert.ok(entry.summary.en.trim().length > 0, `${entry.code} en`)
    assert.ok(entry.summary.zh.trim().length > 0, `${entry.code} zh`)
    assert.equal(BLOCKER_CODES[entry.code], entry)
    assert.equal(blockerEntry(entry.code), entry)
    assert.equal(isBlockerCode(entry.code), true)
  }
  assert.equal(blockerEntry('not-a-blocker'), undefined)
  assert.equal(isBlockerCode('not-a-blocker'), false)
})

test('blocker registry: section counts and derived lists match the reference', () => {
  assert.deepEqual(
    {
      gate: blockersOfKind('gate').length,
      merge: blockersOfKind('merge').length,
      rebase: blockersOfKind('rebase').length,
    },
    // #159 adds the two acceptance blockers to the gate section; #248 adds
    // `landed-unrecorded` to the merge section.
    { gate: 29, merge: 6, rebase: 3 },
  )
  // `worker-busy` is shared, so the three sections sum to one more than unique.
  assert.equal(blockersOfKind('gate').length + blockersOfKind('merge').length + blockersOfKind('rebase').length, BLOCKER_COUNT + 1)
  assert.deepEqual(REVIEW_BLOCKER_CODES, [
    'no-review',
    'review-mission-mismatch',
    'not-clean',
    'review-hold',
    'review-not-approved',
    'tip-moved',
    'review-exemption-invalid',
  ])
  assert.deepEqual(WARNING_BLOCKER_CODES, ['survey-stale', 'broad-scope'])
  assert.ok(BLOCKER_CODE_VALUES.includes('review-stale'), 'review-stale must be documented')
})

test('blocker(): valid codes pass, unknown codes fail closed', () => {
  assert.deepEqual(blocker('tasks-open', 'one task'), { code: 'tasks-open', detail: 'one task' })
  assert.equal(assertBlockerCode('merge-shape'), 'merge-shape')
  assert.throws(
    () => blocker('not-a-blocker', 'x'),
    (error) => error?.code === 'invalid-argument' && /unknown blocker code/.test(error.message),
  )
  assert.throws(
    () => assertBlockerCode('not-a-blocker'),
    (error) => error?.code === 'invalid-argument' && /domain\/shapes\/blockers\.js/.test(error.nextAction),
  )
})

test('broad-scope is a registered warning emitted as a literal', () => {
  assert.ok(BLOCKER_CODES['broad-scope'])
  assert.ok(WARNING_BLOCKER_CODES.includes('broad-scope'))
  // The static scan only sees a literal or a recognized emission form; a code
  // imported as an opaque constant elsewhere would make the registry entry
  // look unemitted and fail the checkout-wide scan below.
  assert.match(read('app/plan.js'), /blocker\('broad-scope'/)
  const result = evaluate(ROOT)
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.unknown, [])
})

test('generated blocker references are exactly the registry rendering', () => {
  const expected = renderBlockersReference()
  assert.equal(read('docs/reference/blockers.md'), expected.en)
  assert.equal(read('docs/zh/reference/blockers.md'), expected.zh)
  for (const code of BLOCKER_CODE_VALUES) {
    assert.ok(expected.en.includes(`\`${code}\``), `en docs missing ${code}`)
    assert.ok(expected.zh.includes(`\`${code}\``), `zh docs missing ${code}`)
  }
  assert.match(expected.en, new RegExp(`${BLOCKER_COUNT} stable blocker/failure codes`))
  assert.match(expected.zh, new RegExp(`${BLOCKER_COUNT} 个稳定 blocker/failure code`))
})

test('warning rows get their own generated paragraph, not the survey-stale one', () => {
  // F96: `warningByDefault` is a family, not one behaviour. The generated
  // narrative must describe each row: `broad-scope` is plan-only, so the
  // survey-stale merge-blocker paragraph (and its payload keys) would be false.
  const en = read('docs/reference/blockers.md')
  const zh = read('docs/zh/reference/blockers.md')
  const paragraph = (text, code) => text.split(/\n\n+/).find((block) => block.startsWith(`\`${code}\``))
  const broadEn = paragraph(en, 'broad-scope')
  const broadZh = paragraph(zh, 'broad-scope')
  assert.ok(broadEn, 'en docs: broad-scope needs its own warning paragraph')
  assert.ok(broadZh, 'zh docs: broad-scope needs its own warning paragraph')
  for (const [locale, block] of [
    ['en', broadEn],
    ['zh', broadZh],
  ]) {
    assert.doesNotMatch(block, /gates\.requireFreshSurvey/, `${locale} broad-scope paragraph`)
    assert.doesNotMatch(block, /\bdepId\b/, `${locale} broad-scope paragraph`)
    assert.doesNotMatch(block, /\breadCommit\b/, `${locale} broad-scope paragraph`)
  }
  assert.match(broadEn, /plan-only/)
  assert.match(broadEn, /never becomes a merge blocker/)
  assert.match(broadZh, /只出现在 `tower_plan`/)
  assert.match(broadZh, /永远不会成为合并 blocker/)
  // The survey-stale paragraph itself stays as it was: it is the only warning
  // that a gate can promote, and its payload names the freshness evidence.
  const surveyEn = paragraph(en, 'survey-stale')
  const surveyZh = paragraph(zh, 'survey-stale')
  assert.match(surveyEn, /gates\.requireFreshSurvey/)
  assert.match(surveyEn, /depId, readCommit, baseCommit/)
  assert.match(surveyZh, /gates\.requireFreshSurvey/)
})

test('generator follows a mutated registry, not just today’s list', () => {
  const probe = {
    code: 'mutation-probe',
    kinds: ['gate'],
    summary: { en: 'Probe only.', zh: '仅用于测试。' },
  }
  const added = renderBlockersReference([...BLOCKER_DEFINITIONS, probe])
  assert.match(added.en, /mutation-probe/)
  assert.match(added.en, new RegExp(`${BLOCKER_COUNT + 1} stable blocker/failure codes`))
  assert.match(added.zh, /mutation-probe/)
  assert.match(added.zh, new RegExp(`${BLOCKER_COUNT + 1} 个稳定`))

  const removed = renderBlockersReference(BLOCKER_DEFINITIONS.filter((entry) => entry.code !== 'review-stale'))
  assert.ok(!removed.en.includes('`review-stale`'))
  assert.ok(!removed.zh.includes('`review-stale`'))
  assert.match(removed.en, new RegExp(`${BLOCKER_COUNT - 1} stable blocker/failure codes`))
})

test('generate-blockers-reference --check fails on a stale fixture and writes deterministically', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-blockers-'))
  try {
    const script = path.join(ROOT, 'scripts', 'generate-blockers-reference.mjs')
    const stale = spawnSync(process.execPath, [script, '--check', '--root', tmp], { encoding: 'utf8' })
    assert.equal(stale.status, 1)
    assert.match(stale.stderr, /blocker references are stale/)

    const written = spawnSync(process.execPath, [script, '--root', tmp], { encoding: 'utf8' })
    assert.equal(written.status, 0, written.stderr)
    assert.equal(fs.readFileSync(path.join(tmp, 'docs', 'reference', 'blockers.md'), 'utf8'), renderBlockersReference().en)
    assert.equal(
      fs.readFileSync(path.join(tmp, 'docs', 'zh', 'reference', 'blockers.md'), 'utf8'),
      renderBlockersReference().zh,
    )
    const fresh = spawnSync(process.execPath, [script, '--check', '--root', tmp], { encoding: 'utf8' })
    assert.equal(fresh.status, 0, fresh.stderr)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('static emission scan: a new literal without a registry entry fails', () => {
  const result = analyze({
    sources: [
      {
        path: 'app/fixture.js',
        text: "export function f() {\n  return { ok: false, blockers: [{ code: 'brand-new-blocker', detail: 'x' }] }\n}\n",
      },
    ],
    registered: ['tasks-open'],
    errorCodes: [],
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.unknown.map((entry) => entry.code), ['brand-new-blocker'])
  assert.deepEqual(result.missing, ['tasks-open'])
})

test('static emission scan: error codes are allowed, registered codes must be emitted', () => {
  const result = analyze({
    sources: [
      {
        path: 'app/fixture.js',
        text: "export function f() {\n  const b = { code: 'invalid-argument', detail: 'x' }\n  return b\n}\n",
      },
    ],
    registered: ['tasks-open', 'never-emitted'],
    errorCodes: ['invalid-argument'],
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.unknown, [])
  assert.deepEqual(result.missing, ['tasks-open', 'never-emitted'])
})

test('static emission scan: every registry code is emitted by the checkout', () => {
  const result = evaluate(ROOT)
  assert.deepEqual(result.unknown, [])
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.emitted, [...BLOCKER_CODE_VALUES].sort())
})

test('static emission scan: helper forms and multi-line push are seen', () => {
  const hits = scanSource(
    'domain/shapes/fixture.js',
    "blockers.push(\n  blocker('tasks-open', 'x'),\n)\npush('stale-base', 'y')\n",
  )
  assert.deepEqual(
    hits.map((hit) => hit.code).sort(),
    ['stale-base', 'tasks-open'],
  )
  assert.equal(hits.find((hit) => hit.code === 'tasks-open').line, 2)
  assert.equal(hits.find((hit) => hit.code === 'stale-base').line, 4)
})

test('check-docs consumes the registry instead of keeping a second blocker list', () => {
  const source = read('scripts/check-docs.mjs')
  assert.match(source, /BLOCKER_CODE_VALUES/)
  assert.doesNotMatch(source, /'mission-missing'/)
  assert.doesNotMatch(source, /'merge-intent-pending'/)
  assert.match(source, /ERROR_CODES/)
})
