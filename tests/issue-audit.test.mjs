// Offline tracker audit (#96).
//
// A closure is a pointer, not a prose assertion: every closed P0/P1 names
// `verified-by: <test file>` and `commit: <sha>` in its closing comment. This
// file is the fixture-tested half of the rule: the audit must fail for a
// missing pointer and pass for a valid one, over a local export, with no
// network and no tracker credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditIssues, parseTracker } from '../scripts/issue-audit.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = (name) => path.join(root, 'tests', 'fixtures', 'issue-audit', name)
const readFixture = (name) => parseTracker(fs.readFileSync(fixture(name), 'utf8'))

const issue = (overrides = {}) => ({
  number: 1,
  title: '[P1] sample issue',
  state: 'CLOSED',
  labels: [{ name: 'P1' }],
  closedAt: '2026-10-22T10:00:00Z',
  body: '',
  comments: [],
  ...overrides,
})
const evidence = (file, sha = 'f892bd0') => `verified-by: ${file}\ncommit: ${sha}`
const codes = (result) => result.findings.map((finding) => finding.code).sort()

function runCli(args) {
  const result = spawnSync(process.execPath, ['scripts/issue-audit.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function tempTracker(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-issue-audit-'))
  const file = path.join(dir, 'tracker.json')
  fs.writeFileSync(file, JSON.stringify(body))
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('parseTracker accepts both the export object and a bare issue array', () => {
  assert.equal(readFixture('valid.json').length, 3)
  assert.equal(parseTracker(JSON.stringify([issue()])).length, 1)
})

test('parseTracker rejects an export that is not an issue list', () => {
  assert.throws(() => parseTracker('{}'), /must be an array of issues or \{ "issues"/)
  assert.throws(() => parseTracker('not json'), /not valid JSON/)
  assert.throws(() => parseTracker(JSON.stringify({ issues: [{ title: 'no number' }] })), /number/)
})

test('a closed P1 naming an existing test file passes', () => {
  const result = auditIssues([{ ...issue(), comments: [{ body: evidence('tests/unit.test.mjs') }] }], { root })
  assert.deepEqual(result.findings, [])
  assert.equal(result.checked, 1)
  assert.equal(result.ok, true)
})

test('open issues and closures below P1 are not audited', () => {
  const issues = [
    issue({ number: 1, state: 'OPEN', closedAt: null }),
    issue({ number: 2, labels: [{ name: 'P2' }], title: '[P2] low' }),
    issue({ number: 3, labels: [], title: 'no priority at all' }),
  ]
  const result = auditIssues(issues, { root })
  assert.equal(result.checked, 0)
  assert.deepEqual(result.findings, [])
})

test('a historical [P0] title prefix still identifies priority without a label', () => {
  const result = auditIssues(
    [issue({ number: 4, labels: [], title: '[P0] unlabelled but critical', comments: [{ body: evidence('tests/unit.test.mjs') }] })],
    { root },
  )
  assert.equal(result.checked, 1)
  assert.deepEqual(result.findings, [])
})

test('a closed P0 with no verified-by field is an error', () => {
  const result = auditIssues([{ ...issue({ labels: [{ name: 'P0' }] }), comments: [{ body: 'Implemented on main: trust me' }] }], { root })
  assert.deepEqual(codes(result), ['missing-evidence'])
  assert.equal(result.findings[0].level, 'error')
  assert.match(result.findings[0].message, /#1 .*verified-by/)
  assert.equal(result.ok, false)
})

test('a verified-by file that does not exist is an error naming the issue and path', () => {
  const result = auditIssues([{ ...issue({ number: 77, labels: [{ name: 'P0' }] }), comments: [{ body: evidence('tests/does-not-exist.test.mjs') }] }], { root })
  assert.deepEqual(codes(result), ['missing-test'])
  assert.match(result.findings[0].message, /#77/)
  assert.match(result.findings[0].message, /tests\/does-not-exist\.test\.mjs/)
})

test('an existing file that is not a test is rejected', () => {
  const result = auditIssues([{ ...issue(), comments: [{ body: evidence('package.json') }] }], { root })
  assert.deepEqual(codes(result), ['not-a-test'])
})

test('absolute and repository-escaping pointers are rejected', () => {
  for (const pointer of ['/tmp/x.test.mjs', 'C:/x.test.mjs', '../x.test.mjs', 'tests/../../x.test.mjs']) {
    const result = auditIssues([{ ...issue(), comments: [{ body: evidence(pointer) }] }], { root })
    assert.deepEqual(codes(result), ['invalid-pointer'], pointer)
  }
})

test('backticks around the field values are accepted', () => {
  const result = auditIssues([{ ...issue(), comments: [{ body: 'verified-by: `tests/unit.test.mjs`\ncommit: `f892bd0`' }] }], { root })
  assert.deepEqual(result.findings, [])
})

test('every verified-by line in the closing comment is checked', () => {
  const result = auditIssues(
    [{ ...issue(), comments: [{ body: `${evidence('tests/unit.test.mjs')}\nverified-by: tests/gone.test.mjs` }] }],
    { root },
  )
  assert.deepEqual(codes(result), ['missing-test'])
})

test('the newest comment that carries the contract wins over an older one', () => {
  const result = auditIssues(
    [
      {
        ...issue(),
        comments: [
          { body: evidence('tests/gone.test.mjs'), createdAt: '2026-10-21T00:00:00Z' },
          { body: evidence('tests/unit.test.mjs'), createdAt: '2026-10-22T00:00:00Z' },
        ],
      },
    ],
    { root },
  )
  assert.deepEqual(result.findings, [])
})

test('a missing commit field is a warning by default and an error with strict', () => {
  const issues = [{ ...issue(), comments: [{ body: 'verified-by: tests/unit.test.mjs' }] }]
  const lenient = auditIssues(issues, { root })
  assert.deepEqual(codes(lenient), ['missing-commit'])
  assert.equal(lenient.findings[0].level, 'warning')
  assert.equal(lenient.ok, true)
  const strict = auditIssues(issues, { root, strict: true })
  assert.equal(strict.findings[0].level, 'error')
  assert.equal(strict.ok, false)
})

test('--since only audits closures on or after the convention date', () => {
  const issues = [
    issue({ number: 1, closedAt: '2026-01-01T00:00:00Z' }),
    issue({ number: 2, closedAt: '2026-10-22T00:00:00Z', comments: [{ body: evidence('tests/unit.test.mjs') }] }),
  ]
  const all = auditIssues(issues, { root })
  assert.equal(all.checked, 2)
  assert.deepEqual(codes(all), ['missing-evidence'])
  const filtered = auditIssues(issues, { root, since: '2026-10-22' })
  assert.equal(filtered.checked, 1)
  assert.deepEqual(filtered.findings, [])
})

test('the CLI passes the valid fixture and prints its summary', () => {
  const run = runCli(['--tracker', fixture('valid.json'), '--root', root])
  assert.equal(run.status, 0, run.output)
  assert.match(run.output, /1 closed P0\/P1 checked, 0 errors, 0 warnings/)
})

test('the CLI fails on the fixture with a missing pointer', () => {
  const run = runCli(['--tracker', fixture('missing-pointer.json'), '--root', root])
  assert.equal(run.status, 1, run.output)
  assert.match(run.output, /missing-test/)
  assert.match(run.output, /#77/)
  assert.match(run.output, /tests\/does-not-exist\.test\.mjs/)
})

test('the CLI prints machine-readable findings with --json', () => {
  const run = runCli(['--tracker', fixture('missing-pointer.json'), '--root', root, '--json'])
  assert.equal(run.status, 1)
  const report = JSON.parse(run.output)
  assert.equal(report.ok, false)
  assert.equal(report.checked, 1)
  assert.equal(report.findings[0].code, 'missing-test')
  assert.equal(report.findings[0].number, 77)
})

test('the CLI treats a missing or malformed export as a usage error', () => {
  const missing = runCli(['--tracker', path.join(root, 'tracker', 'no-such-export.json')])
  assert.equal(missing.status, 2, missing.output)
  assert.match(missing.output, /tracker export/)
  const temp = tempTracker({ nope: true })
  try {
    const malformed = runCli(['--tracker', temp.file, '--root', root])
    assert.equal(malformed.status, 2, malformed.output)
  } finally {
    temp.cleanup()
  }
})

test('the audit stays offline: it imports no network or process-spawning module', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'issue-audit.mjs'), 'utf8')
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'node:dns', 'node:child_process', 'fetch(']) {
    assert.ok(!source.includes(forbidden), `issue-audit.mjs must not use ${forbidden}`)
  }
})
