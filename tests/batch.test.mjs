// Offline tests for the 2.1 batch admission module (domain/batch.js).
// Pure functions: no filesystem, git, network, or DSH runtime.
// Run with: node --test tests/batch.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'

import { validateCreate, validateClose, summarize, BatchError } from '../domain/batch.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const TREE = 'c'.repeat(40)

function makeState() {
  return {
    schemaVersion: 1,
    missions: [
      {
        id: 'M1',
        status: 'completed',
        mergedCommit: 'd'.repeat(40),
        tasks: [],
        deps: [],
        completionReport: {
          report: 'done',
          checks: [
            { name: 'check', exitCode: 0, command: 'npm test', evidence: 'pass' },
            { name: 'lint', exitCode: 0 },
          ],
        },
      },
      { id: 'M2', status: 'abandoned', tasks: [], deps: [] },
      { id: 'M3', status: 'active', tasks: [], deps: [] },
      {
        id: 'M4',
        status: 'completed',
        tasks: [],
        deps: [],
        testRuns: [{ ok: true, treeTip: TREE, commands: [{ id: 'unit' }], tests: [{ name: 'alpha', ok: true }] }],
      },
      {
        id: 'M5',
        status: 'completed',
        tasks: [],
        deps: [],
        completionReport: { checks: [{ name: 'check', status: 'failed', exitCode: 1 }] },
      },
    ],
    batches: [],
    legacySnapshots: [
      {
        hash: 'legacy-hash-1',
        format: 'tower-codex',
        missions: [
          { id: 'L-paused', status: 'paused' },
          { id: 'L-active', status: 'active' },
        ],
        pausedIds: ['L-paused-2'],
      },
    ],
    legacyMaps: [],
    ...{},
  }
}

function makeBatch(overrides = {}) {
  return {
    id: 'B1',
    status: 'open',
    missionIds: ['M1'],
    exclusions: [],
    requiredChecks: ['check'],
    receiptPaths: [],
    createdAt: '2026-10-18T00:00:00.000Z',
    ...overrides,
  }
}

function expectBatchError(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof BatchError, `expected BatchError, got ${error?.name}`)
    assert.equal(error.code, 'batch-invalid')
    assert.match(error.message, pattern)
    return true
  })
}

// ---------------------------------------------------------------------------
// validateCreate
// ---------------------------------------------------------------------------

test('validateCreate: normalizes defaults and camelCase input', () => {
  const state = makeState()
  const batch = validateCreate(state, { missionIds: ['M1', 'M4'] })
  assert.deepEqual(batch, {
    missionIds: ['M1', 'M4'],
    exclusions: [],
    requiredChecks: ['check'],
    receiptPaths: [],
  })
})

test('validateCreate: accepts snake_case aliases, exclusions, and safe relative paths', () => {
  const state = makeState()
  const batch = validateCreate(state, {
    mission_ids: ['M1'],
    exclusions: ['L-paused', 'L-paused-2'],
    required_checks: ['check', 'lint'],
    receipt_paths: ['reports/check.txt', './audit\\cards.json', 'a//b/./c.json'],
  })
  assert.deepEqual(batch, {
    missionIds: ['M1'],
    exclusions: ['L-paused', 'L-paused-2'],
    requiredChecks: ['check', 'lint'],
    receiptPaths: ['reports/check.txt', 'audit/cards.json', 'a/b/c.json'],
  })
})

test('validateCreate: unknown, duplicate, empty, or already-batched missions are rejected', () => {
  const state = makeState()
  expectBatchError(() => validateCreate(state, { missionIds: ['M1', 'missing'] }), /unknown/)
  expectBatchError(() => validateCreate(state, { missionIds: ['M1', 'M1'] }), /must not duplicate/)
  expectBatchError(() => validateCreate(state, { missionIds: [] }), /non-empty array/)
  expectBatchError(() => validateCreate(state, { missionIds: 'M1' }), /non-empty array/)
  expectBatchError(() => validateCreate(state, {}), /non-empty array/)
  expectBatchError(() => validateCreate(state, { missionIds: ['M1', 42] }), /non-empty string/)

  state.batches = [{ id: 'B-open', status: 'open', missionIds: ['M1'] }]
  expectBatchError(() => validateCreate(state, { missionIds: ['M1'] }), /open batch B-open/)
})

test('validateCreate: a mission in a closed batch may join a new batch', () => {
  const state = makeState()
  state.batches = [{ id: 'B-closed', status: 'closed', missionIds: ['M1'] }]
  const batch = validateCreate(state, { missionIds: ['M1'] })
  assert.deepEqual(batch.missionIds, ['M1'])
})

test('validateCreate: exclusions must be paused legacy mission ids', () => {
  const state = makeState()
  expectBatchError(() => validateCreate(state, { missionIds: ['M1'], exclusions: ['L-active'] }), /not a paused legacy/)
  expectBatchError(() => validateCreate(state, { missionIds: ['M1'], exclusions: ['unknown'] }), /not a paused legacy/)
  expectBatchError(() => validateCreate(state, { missionIds: ['M1'], exclusions: ['L-paused', 'L-paused'] }), /must not duplicate/)
  expectBatchError(() => validateCreate(state, { missionIds: ['M1'], exclusions: 'L-paused' }), /must be an array/)

  state.legacySnapshots = [
    { hash: 'h2', snapshot: { missions: [{ id: 'L-nested', status: 'paused' }] } },
    { hash: 'h3', pausedIds: ['L-direct'] },
    // adapters/legacy.js snapshot record shape: no missions array, only ids.
    { sourceHash: 'h4', pausedMissionIds: ['T0007'], missionIds: ['T0007', 'T0008'] },
  ]
  const batch = validateCreate(state, { missionIds: ['M1'], exclusions: ['L-nested', 'L-direct', 'T0007'] })
  assert.deepEqual(batch.exclusions, ['L-nested', 'L-direct', 'T0007'])
})

test('validateCreate: requiredChecks must be non-empty unique names', () => {
  const state = makeState()
  expectBatchError(() => validateCreate(state, { missionIds: ['M1'], requiredChecks: [] }), /non-empty array/)
  expectBatchError(() => validateCreate(state, { missionIds: ['M1'], requiredChecks: 'check' }), /must be an array/)
  expectBatchError(() => validateCreate(state, { missionIds: ['M1'], requiredChecks: ['check', ''] }), /non-empty string/)
  expectBatchError(
    () => validateCreate(state, { missionIds: ['M1'], requiredChecks: ['check', 'check'] }),
    /must not duplicate/,
  )
})

test('validateCreate: receiptPaths must be exact normalized relative files', () => {
  const state = makeState()
  const unsafe = [
    ['C:/receipts/a.json', /relative path/],
    ['/etc/passwd', /relative path/],
    ['\\\\server\\share\\a.json', /relative path/],
    ['../outside.json', /must not contain ".."/],
    ['reports/../a.json', /must not contain ".."/],
    ['reports/*.json', /wildcard/],
    ['reports/a?b.json', /wildcard/],
    ['reports/[a].json', /wildcard/],
    ['reports/', /file, not a directory/],
    ['', /non-empty string/],
  ]
  for (const [receiptPath, pattern] of unsafe) {
    expectBatchError(() => validateCreate(state, { missionIds: ['M1'], receiptPaths: [receiptPath] }), pattern)
  }
  expectBatchError(
    () => validateCreate(state, { missionIds: ['M1'], receiptPaths: ['a/b.json', 'a\\b.json'] }),
    /must not duplicate/,
  )
})

// ---------------------------------------------------------------------------
// validateClose
// ---------------------------------------------------------------------------

test('validateClose: passes when every required check is recorded and receipts hash', () => {
  const state = makeState()
  state.missions[0].testRuns = [{ ok: true, commands: [{ id: 'unit' }], tests: [{ name: 'alpha', ok: true }] }]
  const batch = makeBatch({
    requiredChecks: ['check', 'tests', 'tower_test'],
    receiptPaths: ['reports/check.txt', 'reports/tests.txt'],
  })
  const result = validateClose(state, batch, {
    receiptHashes: { 'reports/check.txt': HASH_A, 'reports/tests.txt': HASH_B },
  })
  assert.equal(result.ok, true, JSON.stringify(result.blockers))
  assert.deepEqual(result.blockers, [])
  assert.equal(result.checks.length, 3)
  assert.ok(result.checks.every((check) => check.ok && check.outcome === 'passed'))
  assert.equal(result.checks[0].source, 'completionReport')
  // A nameless runDiscovery receipt answers to both built-in test check names.
  assert.equal(result.checks[1].source, 'testRuns')
  assert.equal(result.checks[2].source, 'testRuns')
})

test('validateClose: completionReport check shape with status/exitCode is honored', () => {
  const state = makeState()
  const batch = makeBatch({ requiredChecks: ['lint'] })
  const result = validateClose(state, batch)
  assert.equal(result.ok, true)
  assert.deepEqual(result.checks, [{ missionId: 'M1', name: 'lint', ok: true, outcome: 'passed', source: 'completionReport' }])
})

test('validateClose: missing required checks block with tests-missing', () => {
  const state = makeState()
  const batch = makeBatch({ requiredChecks: ['check', 'integration'] })
  const result = validateClose(state, batch)
  assert.equal(result.ok, false)
  assert.deepEqual(
    result.blockers.map((entry) => entry.code),
    ['tests-missing'],
  )
  assert.match(result.blockers[0].message, /integration/)
  assert.equal(result.checks.find((check) => check.name === 'integration').outcome, 'missing')
})

test('validateClose: failed recorded checks block with tests-failed', () => {
  const state = makeState()
  const batch = makeBatch({ missionIds: ['M5'] })
  const result = validateClose(state, batch)
  assert.equal(result.ok, false)
  assert.deepEqual(
    result.blockers.map((entry) => entry.code),
    ['tests-failed'],
  )
  assert.match(result.blockers[0].message, /did not pass/)
})

test('validateClose: active or unknown batch members are rejected', () => {
  const state = makeState()
  expectBatchError(() => validateClose(state, makeBatch({ missionIds: [] })), /non-empty array/)

  const active = validateClose(state, makeBatch({ missionIds: ['M3'] }))
  assert.equal(active.ok, false)
  assert.match(active.blockers[0].message, /not completed, merged or abandoned/)

  const unknown = validateClose(state, makeBatch({ missionIds: ['missing'] }))
  assert.equal(unknown.ok, false)
  assert.match(unknown.blockers[0].message, /does not exist/)
})

test('validateClose: abandoned missions skip required checks', () => {
  const state = makeState()
  const result = validateClose(state, makeBatch({ missionIds: ['M2'], requiredChecks: ['check', 'lint'] }))
  assert.equal(result.ok, true)
  assert.deepEqual(
    result.checks.map((check) => check.outcome),
    ['skipped', 'skipped'],
  )
})

test('validateClose: already closed or abandoned batches cannot close again', () => {
  const state = makeState()
  for (const status of ['closed', 'abandoned']) {
    const result = validateClose(state, makeBatch({ status }))
    assert.equal(result.ok, false)
    assert.match(result.blockers[0].message, status === 'closed' ? /already closed/ : /is abandoned/)
  }
})

test('validateClose: receipt coverage, format, expected hash, and frozen-path drift', () => {
  const state = makeState()
  const batch = makeBatch({ receiptPaths: ['reports/check.txt'] })

  const missing = validateClose(state, batch, {})
  assert.equal(missing.ok, false)
  assert.ok(missing.blockers.some((entry) => /was not reported/.test(entry.message)))

  const invalid = validateClose(state, batch, { receiptHashes: { 'reports/check.txt': 'not-a-hash' } })
  assert.ok(invalid.blockers.some((entry) => /sha256 hex digest/.test(entry.message)))

  const drift = validateClose(state, batch, {
    receiptHashes: { 'reports/check.txt': HASH_A, 'elsewhere/list.json': HASH_B },
  })
  assert.ok(drift.blockers.some((entry) => /outside the frozen receiptPaths/.test(entry.message)))

  const expectedMismatch = validateClose(
    state,
    { ...batch, receiptHashes: { 'reports/check.txt': HASH_B } },
    { receiptHashes: { 'reports/check.txt': HASH_A } },
  )
  assert.ok(expectedMismatch.blockers.some((entry) => /does not match the recorded expected hash/.test(entry.message)))

  const receiptsForm = validateClose(state, batch, { receipts: [{ path: 'reports/check.txt', sha256: HASH_A }] })
  assert.equal(receiptsForm.ok, true, JSON.stringify(receiptsForm.blockers))
})

test('validateClose: malformed frozen batch fields throw batch-invalid', () => {
  const state = makeState()
  expectBatchError(() => validateClose(state, makeBatch({ receiptPaths: ['../escape.txt'] })), /must not contain ".."/)
  expectBatchError(() => validateClose(state, makeBatch({ requiredChecks: [] })), /non-empty array/)
  expectBatchError(() => validateClose(state, null), /batch must be an object/)
})

test('validateClose: caller-supplied checks and newest test run are used as evidence', () => {
  const state = makeState()
  const batch = makeBatch({ missionIds: ['M4'], requiredChecks: ['tower_test', 'staging'] })
  const scopedOut = validateClose(state, batch, {
    checks: [{ missionId: 'M1', name: 'staging', ok: true }],
  })
  assert.equal(scopedOut.ok, false)
  assert.deepEqual(
    scopedOut.blockers.map((entry) => entry.code),
    ['tests-missing'],
  )

  const globalCheck = validateClose(state, batch, { checks: [{ name: 'staging', ok: true }] })
  assert.equal(globalCheck.ok, true, JSON.stringify(globalCheck.blockers))
  assert.equal(globalCheck.checks[1].source, 'input')

  const stateWithHistory = makeState()
  stateWithHistory.missions[3].testRuns = [
    { name: 'tower_test', ok: false, error: 'old failure' },
    { name: 'tower_test', ok: true },
  ]
  const latestWins = validateClose(stateWithHistory, makeBatch({ missionIds: ['M4'], requiredChecks: ['tower_test'] }))
  assert.equal(latestWins.ok, true, JSON.stringify(latestWins.blockers))

  const stateWithNestedChecks = makeState()
  stateWithNestedChecks.missions[3].testRuns = [{ ok: false, checks: [{ name: 'tower_test', status: 'passed' }] }]
  const nested = validateClose(stateWithNestedChecks, makeBatch({ missionIds: ['M4'], requiredChecks: ['tower_test'] }))
  assert.equal(nested.ok, true, JSON.stringify(nested.blockers))
})

test('validateClose: check receiptRef/receiptHash bind to frozen paths and treeTip', () => {
  const state = makeState()
  state.missions[0].testRuns = [
    {
      name: 'tower_test',
      ok: true,
      treeTip: TREE,
      receiptRef: 'reports/test-receipt.json',
      receiptHash: HASH_A,
    },
  ]
  const batch = makeBatch({ requiredChecks: ['tower_test'], receiptPaths: ['reports/test-receipt.json'] })
  const bound = validateClose(state, batch, { treeTip: TREE })
  assert.equal(bound.ok, true, JSON.stringify(bound.blockers))
  assert.equal(bound.checks[0].receiptRef, 'reports/test-receipt.json')
  assert.equal(bound.checks[0].receiptHash, HASH_A)

  const drifted = validateClose(state, batch, { treeTip: 'e'.repeat(40) })
  assert.equal(drifted.ok, false)
  assert.match(drifted.blockers[0].message, /current HEAD/)

  const outside = validateClose(
    state,
    makeBatch({ requiredChecks: ['tower_test'], receiptPaths: ['other.json'] }),
    { receiptHashes: { 'other.json': HASH_A } },
  )
  assert.equal(outside.ok, false)
  assert.ok(outside.blockers.some((entry) => /outside the frozen receiptPaths/.test(entry.message)))

  const conflicting = validateClose(state, batch, { receiptHashes: { 'reports/test-receipt.json': HASH_B } })
  assert.equal(conflicting.ok, false)
  assert.ok(conflicting.blockers.some((entry) => /receiptHash does not match/.test(entry.message)))
})

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

test('summarize: reports members, pending/failed checks, and close readiness', () => {
  const state = makeState()
  state.missions[0].testRuns = [{ ok: true, commands: [{ id: 'unit' }], tests: [{ name: 'alpha', ok: true }] }]
  const batch = makeBatch({ requiredChecks: ['check', 'tower_test', 'integration'], receiptPaths: ['reports/a.json'] })
  const summary = summarize(state, batch)
  assert.equal(summary.batchId, 'B1')
  assert.equal(summary.status, 'open')
  assert.equal(summary.ok, false)
  assert.deepEqual(summary.pendingChecks, ['integration'])
  assert.deepEqual(summary.failedChecks, [])
  assert.equal(summary.receiptCount, 1)
  assert.deepEqual(summary.members, [
    { id: 'M1', found: true, status: 'completed', mergedCommit: 'd'.repeat(40), abandoned: false },
  ])
  assert.equal(summary.checks.length, 3)
  assert.deepEqual(
    summary.checks.map((entry) => entry.outcome),
    ['passed', 'passed', 'missing'],
  )
})

test('summarize: clean batch is ok, closed/abandoned batches report status, failed checks surface', () => {
  const state = makeState()
  const clean = summarize(state, makeBatch({ requiredChecks: ['check'] }))
  assert.equal(clean.ok, true)
  assert.equal(clean.closed, false)

  const closed = summarize(state, makeBatch({ status: 'closed', closedAt: '2026-10-18T01:00:00.000Z' }))
  assert.equal(closed.closed, true)
  assert.equal(closed.ok, false)
  assert.equal(closed.closedAt, '2026-10-18T01:00:00.000Z')

  const failed = summarize(state, makeBatch({ missionIds: ['M5'] }))
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.failedChecks, ['check'])

  const missingMember = summarize(state, makeBatch({ missionIds: ['missing'] }))
  assert.equal(missingMember.ok, false)
  assert.equal(missingMember.members[0].found, false)
  assert.match(missingMember.blockers[0].message, /does not exist/)

  const abandoned = summarize(state, makeBatch({ missionIds: ['M2'], requiredChecks: ['check'] }))
  assert.equal(abandoned.ok, true)
  assert.equal(abandoned.members[0].abandoned, true)
  assert.equal(abandoned.checks[0].outcome, 'skipped')
})

test('summarize: malformed batch records throw batch-invalid', () => {
  const state = makeState()
  expectBatchError(() => summarize(state, makeBatch({ missionIds: [] })), /non-empty array/)
  expectBatchError(() => summarize(state, makeBatch({ requiredChecks: [] })), /non-empty array/)
  expectBatchError(() => summarize(state, null), /batch must be an object/)
})
