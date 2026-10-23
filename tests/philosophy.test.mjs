// Engineering philosophy (#83): a principle's enforcement pointer must resolve,
// ADRs must stay dated and structured, and every docs/ "Non-goals" heading must
// be enforceable or explicitly unowned.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'

import {
  checkAdrs,
  checkNonGoals,
  checkPhilosophy,
  checkPrinciplesText,
} from '../scripts/check-philosophy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function withFixture(files, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-philosophy-'))
  try {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      fs.writeFileSync(path.join(dir, file), text)
    }
    return run(dir)
  } finally {
    removeTemp(dir)
  }
}

function principles(count, enforcement = '`scripts/check-philosophy.mjs`; tests in `tests/philosophy.test.mjs`; gate: `npm run docs:check:philosophy`') {
  return [
    '# Engineering principles',
    '',
    ...Array.from({ length: count }, (_, index) =>
      [
        `## ${index + 1}. Principle ${index + 1}`,
        '',
        'We do not do the thing.',
        '',
        `Refused because of this: the thing.`,
        '',
        `Enforced by: ${enforcement}`,
        '',
      ].join('\n'),
    ),
  ].join('\n')
}

test('the repository principles, ADRs and non-goal registry all check clean', () => {
  const report = checkPhilosophy(root)
  assert.deepEqual(report.findings, [])
  assert.ok(report.principles.length >= 8)
  assert.ok(report.adrs.length >= 3)
  assert.ok(report.nonGoals.headings >= 1)
})

test('a principle whose enforcement path does not exist fails', () => {
  const result = checkPrinciplesText(principles(8), (relative) => fs.existsSync(path.join(root, relative)))
  assert.deepEqual(result.principles.length, 8)
  assert.equal(result.findings.length, 0)

  const missing = checkPrinciplesText(
    principles(8, '`tests/does-not-exist.test.mjs`; gate: `npm run docs:check`'),
    (relative) => fs.existsSync(path.join(root, relative)),
  )
  assert.ok(missing.findings.some((finding) => finding.code === 'principle-pointer-missing'))
  assert.match(missing.findings[0].message, /tests\/does-not-exist\.test\.mjs/)
})

test('a principle with no refusal is not a principle', () => {
  const text = principles(8).replace('Refused because of this: the thing.', '')
  const result = checkPrinciplesText(text, () => true)
  assert.ok(result.findings.some((finding) => finding.code === 'principle-refusal'))
})

test('fewer than eight principles fails', () => {
  const result = checkPrinciplesText(principles(3), () => true)
  assert.ok(result.findings.some((finding) => finding.code === 'principles-count'))
})

test('an ADR without Rejected alternatives or a date fails', () => {
  withFixture(
    {
      'docs/adr/0001-one.md': '# 0001 — One\n\n## Context\n\nx\n\n## Decision\n\ny\n\n## Consequences\n\nz\n',
    },
    (fixture) => {
      const report = checkAdrs(fixture)
      const codes = report.findings.map((finding) => finding.code)
      assert.ok(codes.includes('adr-section'))
      assert.ok(codes.includes('adr-date'))
      assert.ok(codes.includes('adr-status'))
      assert.ok(codes.includes('adr-count'))
    },
  )
})

test('a docs Non-goals heading needs a resolving pointer or the unowned label', () => {
  withFixture(
    {
      'docs/page.md': '## Non-goals\n\nNo promises here.\n',
    },
    (fixture) => {
      const report = checkNonGoals(fixture)
      assert.equal(report.findings.length, 1)
      assert.equal(report.findings[0].code, 'non-goal-unowned')
    },
  )
  withFixture(
    {
      'docs/page.md': '## Non-goals\n\nUnowned. A writing habit.\n',
    },
    (fixture) => {
      assert.deepEqual(checkNonGoals(fixture).findings, [])
    },
  )
  withFixture(
    {
      'docs/page.md': '## Non-goals\n\nEnforced by: `scripts/check-philosophy.mjs`; gate: `npm run docs:check:philosophy`.\n',
      'scripts/check-philosophy.mjs': '// present\n',
    },
    (fixture) => {
      assert.deepEqual(checkNonGoals(fixture).findings, [])
    },
  )
})
