// Regression closure audit (#85): a closed `regression` issue must carry a
// `Regression test:` path that exists. The fixtures are local JSON exports, so
// the rule is proven offline without a live GitHub dependency.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'

import { auditRegressions, selectRegressionField } from '../scripts/regression-audit.mjs'
import { parseTracker } from '../scripts/issue-audit.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = (name) => path.join(root, 'tests', 'fixtures', 'regression-audit', name)
const readFixture = (name) => parseTracker(fs.readFileSync(fixture(name), 'utf8'))

function issue(overrides = {}) {
  return {
    number: 1,
    title: 'sample regression',
    state: 'CLOSED',
    labels: [{ name: 'regression' }],
    closedAt: '2026-10-23T10:00:00Z',
    body: '',
    comments: [],
    ...overrides,
  }
}

function runCli(args) {
  const result = spawnSync(process.execPath, ['scripts/regression-audit.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

test('selectRegressionField reads the newest Regression test line', () => {
  const value = selectRegressionField(
    issue({
      body: 'Regression test: tests/unit.test.mjs',
      comments: [{ body: 'Regression test: `tests/` \n' }],
    }),
  )
  assert.equal(value.pointer, 'tests/')
})

test('a closed regression naming an existing test file passes', () => {
  const result = auditRegressions(
    [issue({ body: 'Symptom: x\nRegression test: tests/unit.test.mjs' })],
    { root },
  )
  assert.equal(result.checked, 1)
  assert.deepEqual(result.findings, [])
  assert.equal(result.ok, true)
})

test('a closed regression naming a missing test file fails', () => {
  const result = auditRegressions(
    [issue({ number: 68, body: 'Regression test: tests/does-not-exist.test.mjs' })],
    { root },
  )
  assert.equal(result.ok, false)
  assert.equal(result.findings[0].code, 'missing-regression-test')
  assert.match(result.findings[0].message, /#68/)
  assert.match(result.findings[0].message, /tests\/does-not-exist\.test\.mjs/)
})

test('a closed regression with no Regression test field fails', () => {
  const result = auditRegressions([issue({ number: 69, body: 'Fixed it, trust me.' })], { root })
  assert.equal(result.ok, false)
  assert.equal(result.findings[0].code, 'missing-regression-test')
})

test('a path outside the test tree is not evidence', () => {
  const result = auditRegressions(
    [issue({ number: 70, body: 'Regression test: scripts/check-docs.mjs' })],
    { root },
  )
  assert.equal(result.ok, false)
  assert.equal(result.findings[0].code, 'not-a-test')
})

test('open regressions, non-regressions and non-regression labels are ignored', () => {
  const result = auditRegressions(
    [
      issue({ number: 1, state: 'OPEN', closedAt: null }),
      issue({ number: 2, labels: [{ name: 'bug' }] }),
      issue({ number: 3, labels: [{ name: 'regression' }], state: 'CLOSED', body: 'Regression test: tests/unit.test.mjs' }),
    ],
    { root },
  )
  assert.equal(result.checked, 1)
  assert.equal(result.ok, true)
})

test('the fixture export fails for the seeded missing pointer and passes the valid row', () => {
  const valid = auditRegressions(readFixture('valid.json'), { root })
  assert.equal(valid.ok, true)
  assert.equal(valid.checked, 1)

  const missing = readFixture('missing.json')
  const broken = auditRegressions(missing, { root })
  assert.equal(broken.ok, false)
  assert.equal(broken.checked, 1)
  assert.equal(broken.findings.filter((finding) => finding.code === 'missing-regression-test').length, 1)
})

test('the CLI exits 1 for the seeded fixture and 0 for a valid export', () => {
  const failed = runCli(['--tracker', fixture('missing.json'), '--root', root])
  assert.equal(failed.status, 1)
  assert.match(failed.output, /missing-regression-test/)

  const passed = runCli(['--tracker', fixture('valid.json'), '--root', root])
  assert.equal(passed.status, 0)
  assert.match(passed.output, /every closed regression names an existing test file/)
})

test('a malformed or missing export exits 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-regression-audit-'))
  try {
    const malformed = path.join(dir, 'bad.json')
    fs.writeFileSync(malformed, 'not json')
    const result = runCli(['--tracker', malformed, '--root', root])
    assert.equal(result.status, 2)
    assert.match(result.output, /not valid JSON/)
  } finally {
    removeTemp(dir)
  }
})
