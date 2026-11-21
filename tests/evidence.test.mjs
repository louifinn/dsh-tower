// #149 W4: the evidence dimension has one shape-owned contract and one reader.
//
// These tests pin the reader's contract, not any one caller: completion checks,
// discovery receipts and caller-supplied close checks are normalized into the
// same record; the shape decides which sources appertain; a receipt is evidence
// only for the tip it ran on.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EVIDENCE_SOURCE,
  TEST_EVIDENCE_NAMES,
  evidenceEntries,
  findEvidence,
  hasCheckEvidence,
  normalizeEvidence,
  passingDiscovery,
} from '../domain/evidence.js'
import { buildShape, EVIDENCE as BUILD_EVIDENCE } from '../domain/shapes/build.js'
import { surveyShape, EVIDENCE as SURVEY_EVIDENCE } from '../domain/shapes/survey.js'
import { normalizeChecks } from '../domain/missions/completion.js'
import { unverifiedCheckWarnings } from '../domain/gate.js'

const TIP = '0123456789abcdef0123456789abcdef01234567'

function receipt(overrides = {}) {
  return {
    configured: true,
    ok: true,
    treeTip: TIP,
    commands: [{ id: 'smoke', command: 'node --test', exitCode: 0 }],
    tests: [{ name: 'works', ok: true }],
    receiptPath: '.git/dsh-tower/test-runs/M1-1/receipt.json',
    startedAt: '2026-11-10T00:00:00.000Z',
    finishedAt: '2026-11-10T00:00:01.000Z',
    ...overrides,
  }
}

test('every shape declares its evidence contract', () => {
  assert.deepEqual(
    { ...BUILD_EVIDENCE },
    { completionChecks: true, testReceipts: 'tip-bound' },
    'a build accepts completion checks and tip-bound discovery receipts',
  )
  assert.deepEqual(
    { ...SURVEY_EVIDENCE },
    { completionChecks: true, testReceipts: false },
    'a survey has no branch, so a receipt cannot appertain',
  )
  assert.equal(buildShape.evidence, BUILD_EVIDENCE)
  assert.equal(surveyShape.evidence, SURVEY_EVIDENCE)
})

test('a discovery receipt normalizes to both historical check names and a machine outcome', () => {
  const record = normalizeEvidence(receipt(), EVIDENCE_SOURCE.DISCOVERY)
  assert.deepEqual(record.names, [...TEST_EVIDENCE_NAMES])
  assert.deepEqual(record.names, ['tests', 'tower_test'])
  assert.equal(record.name, 'tests')
  assert.equal(record.source, 'testRuns')
  assert.equal(record.ok, true)
  assert.equal(record.command, 'smoke: node --test')
  assert.equal(record.exitCode, 0)
  assert.equal(record.treeTip, TIP)
  assert.match(record.evidence, /1 test\(s\) passed at 0123456789ab/)
  assert.match(record.evidence, /receipt \.git/)
  assert.equal(record.entry.ok, true)
})

test('normalization never invents evidence and keeps weak entries unranked', () => {
  assert.equal(normalizeEvidence(null, EVIDENCE_SOURCE.COMPLETION), null)
  assert.equal(normalizeEvidence({ command: 'npm test' }, EVIDENCE_SOURCE.COMPLETION), null)
  assert.equal(normalizeEvidence({ name: 'lint' }, EVIDENCE_SOURCE.COMPLETION).ok, null)
  assert.equal(normalizeEvidence({ name: 'lint', exitCode: 2 }, EVIDENCE_SOURCE.COMPLETION).ok, false)
  assert.equal(normalizeEvidence({ name: 'lint', error: 'boom' }, EVIDENCE_SOURCE.COMPLETION).ok, false)
  assert.equal(normalizeEvidence({ name: 'lint', status: 'clean' }, EVIDENCE_SOURCE.COMPLETION).ok, true)
  assert.equal(normalizeEvidence({ name: 'lint', status: 'not-clean' }, EVIDENCE_SOURCE.COMPLETION).ok, false)
})

test('evidence entries keep their source and are newest-first inside each one', () => {
  const mission = {
    id: 'M1',
    completionReport: {
      checks: [
        { name: 'check', exitCode: 0, command: 'npm test' },
        { name: 'lint', exitCode: 0 },
      ],
    },
    testRuns: [
      receipt({ treeTip: 'older', commands: [{ id: 'smoke', command: 'old', exitCode: 0 }] }),
      receipt({ treeTip: 'newer', commands: [{ id: 'smoke', command: 'new', exitCode: 0 }] }),
    ],
  }
  const records = evidenceEntries(buildShape.evidence, mission, {
    extraChecks: [{ missionId: 'M1', name: 'manual', exitCode: 0 }],
  })
  assert.deepEqual(
    records.map((record) => [record.source, record.name]),
    [
      ['completionReport', 'lint'],
      ['completionReport', 'check'],
      ['testRuns', 'tests'],
      ['testRuns', 'tests'],
      ['input', 'manual'],
    ],
  )
  assert.equal(records[2].treeTip, 'newer')
  assert.equal(records[3].treeTip, 'older')
})

test('the shape contract filters sources: a survey never reads receipts', () => {
  const mission = {
    id: 'S1',
    completionReport: { checks: [{ name: 'read-confirmed', exitCode: 0 }] },
    testRuns: [receipt()],
  }
  assert.equal(evidenceEntries(surveyShape.evidence, mission).length, 1)
  assert.equal(hasCheckEvidence(surveyShape.evidence, mission), true)

  const receiptOnly = { id: 'S2', testRuns: [receipt()] }
  assert.equal(evidenceEntries(surveyShape.evidence, receiptOnly).length, 0)
  assert.equal(hasCheckEvidence(surveyShape.evidence, receiptOnly), false)
  assert.equal(hasCheckEvidence(buildShape.evidence, receiptOnly), true)
})

test('findEvidence prefers completion checks and answers both receipt names', () => {
  const mission = {
    id: 'M1',
    completionReport: { checks: [{ name: 'tests', exitCode: 1 }] },
    testRuns: [receipt()],
  }
  const reported = findEvidence(buildShape.evidence, mission, 'tests')
  assert.equal(reported.source, 'completionReport')
  assert.equal(reported.ok, false, 'a recorded failure is evidence too')

  const aliased = findEvidence(buildShape.evidence, { id: 'M2', testRuns: [receipt()] }, 'tower_test')
  assert.equal(aliased.source, 'testRuns')
  assert.equal(aliased.ok, true)

  assert.equal(findEvidence(buildShape.evidence, { id: 'M3' }, 'tests'), null)
  assert.equal(findEvidence(buildShape.evidence, { id: 'M4', testRuns: [{ ok: true }] }, 'tests'), null)
})

test('caller-supplied checks are scoped to their mission and labeled input', () => {
  const extraChecks = [
    { missionId: 'M1', name: 'deploy', exitCode: 0 },
    { mission_id: 'M2', name: 'deploy', exitCode: 1 },
    { name: 'global', exitCode: 0 },
  ]
  const m1 = findEvidence(buildShape.evidence, { id: 'M1' }, 'deploy', { extraChecks })
  assert.equal(m1.source, 'input')
  assert.equal(m1.ok, true)
  const m2 = findEvidence(buildShape.evidence, { id: 'M2' }, 'deploy', { extraChecks })
  assert.equal(m2.ok, false)
  const global = findEvidence(buildShape.evidence, { id: 'M9' }, 'global', { extraChecks })
  assert.equal(global.source, 'input')
  assert.equal(global.ok, true)
})

test('passingDiscovery binds a receipt to the branch tip it ran on', () => {
  assert.equal(passingDiscovery(buildShape.evidence, { testRuns: [receipt()] }, TIP)?.ok, true)
  assert.equal(passingDiscovery(buildShape.evidence, { testRuns: [receipt()] }, 'deadbeef'), null)
  assert.equal(passingDiscovery(buildShape.evidence, { testRuns: [receipt()] }, null), null)
  assert.equal(passingDiscovery(buildShape.evidence, { testRuns: [receipt({ ok: false })] }, TIP), null)
  assert.equal(passingDiscovery(buildShape.evidence, { testRuns: [receipt({ treeTip: null })] }, TIP), null)
  assert.equal(passingDiscovery(surveyShape.evidence, { testRuns: [receipt()] }, TIP), null)
})

// #206: a completion check may cite one recorded run by its durable id instead
// of hand-filling the command/exit code. The id is resolved against the same
// mission's testRuns; another mission's id is a caller mistake, not evidence.
test('completion checks may cite a recorded test run of the same mission', () => {
  const run = (id) => receipt({ id, commands: [{ id: 'smoke', command: 'npm test', exitCode: 0 }] })
  const mission = { id: 'M1', testRuns: [run('run-1'), run('run-2')] }
  const scoped = { mission, missions: [mission, { id: 'M2', testRuns: [run('run-7')] }] }

  assert.deepEqual(normalizeChecks([{ name: 'unit', runId: ' run-1 ' }], scoped), [{ name: 'unit', runId: 'run-1' }])
  assert.throws(
    () => normalizeChecks([{ name: 'unit', runId: 'run-9' }], scoped),
    (error) => error.code === 'invalid-argument' && /run-9/.test(error.message) && /recorded test run/.test(error.message),
  )
  assert.throws(
    () => normalizeChecks([{ name: 'unit', runId: 'run-7' }], scoped),
    (error) => error.code === 'invalid-argument' && /M2/.test(error.message) && /belongs/.test(error.message),
  )
  assert.throws(() => normalizeChecks([{ name: 'unit', runId: 7 }], scoped), /runId must be a non-empty string/)
  // A runId is meaningless without the mission it must resolve against.
  assert.throws(() => normalizeChecks([{ name: 'unit', runId: 'run-1' }]), /mission/)
  // Legacy hand-filled checks are untouched by the new field.
  assert.deepEqual(
    normalizeChecks([{ name: ' manual ', command: ' npm test ', exitCode: 0, evidence: ' ok ' }], scoped),
    [{ name: 'manual', command: 'npm test', exitCode: 0, evidence: 'ok' }],
  )
})

// #206: a claimed command or exit code with no recorded run behind it is a
// preflight WARNING, never a blocker; the wording names the remedy. A legacy
// check that claims nothing (only a name) stays silent.
test('an unverified check claim warns and names the runId remedy', () => {
  const mission = {
    id: 'M1',
    completionReport: {
      checks: [
        { name: 'unit', command: 'npm test', exitCode: 0 },
        { name: 'lint', command: 'npm run lint' },
        { name: 'exit-only-ok', exitCode: 0 },
        { name: 'exit-only-bad', exitCode: 7 },
        { name: 'tests', runId: 'run-1' },
        { name: 'free-text' },
      ],
    },
    testRuns: [receipt({ id: 'run-1', commands: [{ id: 'smoke', command: 'npm test', exitCode: 0 }] })],
  }
  const warnings = unverifiedCheckWarnings(mission)
  assert.deepEqual(
    warnings.map((warning) => warning.check),
    ['lint', 'exit-only-bad'],
  )
  for (const warning of warnings) {
    assert.equal(warning.code, 'checks-unverified')
    assert.equal(warning.missionId, 'M1')
    assert.match(warning.message, /runId/)
    assert.match(warning.message, /tower_test/)
  }
  assert.match(warnings[0].message, /npm run lint/)
  assert.match(warnings[1].message, /exit code 7/)
  // No completion report (or no claims) means nothing to warn about.
  assert.deepEqual(unverifiedCheckWarnings({ id: 'M2' }), [])
  assert.deepEqual(unverifiedCheckWarnings({ id: 'M3', completionReport: { checks: [] } }), [])
})
