// State schema and semantic validation (#56 P4).
//
// The declarative schema in domain/state/schema.js must accept every shape the
// pure domain and legacy snapshots produce, reject the historical corrupt
// variants, and keep the operator-facing [tower:state-corrupt] diagnostics.
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateState } from '../domain/state.js'
import { ERROR_CODES } from '../domain/errors.js'
import { SCHEMA_VERSION } from '../domain/mission.js'
import { StateSchema, stateShapeError } from '../domain/state/schema.js'

/** A state exercising every declared collection and legacy extra field. */
function validState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 2,
    repoRoot: '/repo',
    commonDir: '/repo/.git',
    base: 'main',
    createdAt: 1,
    updatedAt: 2,
    dirtyBase: false,
    caseInsensitive: true,
    towerAgentId: null,
    missions: [
      {
        id: 'M1',
        title: 'Schema fixture',
        kind: 'build',
        status: 'active',
        scope: ['src/**'],
        deps: [],
        tasks: [{ text: 'a', status: 'open' }],
        blockers: [],
        notes: [],
        references: ['src/a.js'],
        reviewPolicy: 'required-clean',
        reviewExemptionReason: '',
        owner: null,
        worktree: { path: '/wt', branch: 'tower/m1', baseCommit: 'abc', createdAt: 1, realPath: '/wt' },
        reviews: [],
        extraLegacyField: 'kept',
      },
    ],
    roster: [
      { name: 'worker-m1', role: 'worker', state: 'active', agentId: 'a1', missionId: 'M1', spawnTip: 'abc' },
    ],
    reviews: [
      {
        id: 'R1',
        seq: 1,
        missionId: 'M1',
        branch: 'tower/m1',
        round: 1,
        status: 'clean',
        mergeVerdict: 'merge',
        reviewedCommit: 'abc',
        at: 2,
        findings: 'none',
        checks: [],
        decision: 'ok',
        reviewer: 'reviewer-m1',
        reviewerRole: 'reviewer',
      },
    ],
    findings: [
      { id: 'F1', seq: 1, type: 'bug', title: 'x', status: 'open', severity: 'low', summary: 's', details: 'd', suggestedFix: 'f' },
    ],
    messages: [
      { id: 'msg-1', seq: 1, from: 'tower', to: 'worker-m1', subject: 's', body: 'b', at: 2, readBy: [], delivery: [], readAt: {} },
    ],
    batches: [{ id: 'B1', status: 'open' }],
    legacySnapshots: [{ sourceHash: 'h' }],
    legacyMaps: [{ sourceHash: 'h', oldId: 'T1' }],
    deliveries: [{}],
    mergeIntent: null,
    messageSeq: 1,
    reviewSeq: 1,
    findingSeq: 1,
    batchSeq: 1,
    deliverySeq: 0,
    untouchedExtraRoot: true,
  }
}

/**
 * @param {unknown} state
 * @returns {{ code: string, message: string }}
 */
function stateError(state) {
  try {
    validateState(state, 'state.json')
  } catch (error) {
    return { code: String(error.code), message: String(error.message) }
  }
  assert.fail('expected the state to be rejected')
}

test('declarative StateSchema accepts a full valid state and returns it unchanged', () => {
  const state = validState()
  assert.equal(stateShapeError(state), null)
  assert.equal(validateState(state, 'state.json'), state)
  assert.equal(StateSchema.type, 'object')
})

test('schema tolerance: minimal legacy rows, reserved roster rows and extra fields stay valid', () => {
  const minimal = {
    schemaVersion: SCHEMA_VERSION,
    missions: [{ id: 'M1', status: 'planned', tasks: [], deps: [] }],
    roster: [{ name: 'reviewer-m1', role: 'reviewer', state: 'reserved' }],
    futureField: { anything: true },
  }
  assert.equal(stateShapeError(minimal), null)
  assert.equal(validateState(minimal), minimal)

  const e2e = validState()
  e2e.missions[0].legacy = { nested: ['kept'] }
  e2e.roster[0].future = true
  e2e.reviews[0].future = 'kept'
  assert.equal(stateShapeError(e2e, ' at state.json'), null)
  assert.equal(validateState(e2e, 'state.json'), e2e)
})

test('key structural and semantic failures keep historical state-corrupt messages', () => {
  const base = validState()
  const cases = [
    ['missing missions', { ...base, missions: 'nope' }, 'tower state has no missions array at state.json'],
    [
      'duplicate mission id',
      { ...base, missions: [base.missions[0], { ...base.missions[0] }] },
      'duplicate mission id M1 at state.json',
    ],
    [
      'unknown mission status',
      { ...base, missions: [{ ...base.missions[0], status: 'launched' }] },
      'mission M1 has unknown status launched at state.json',
    ],
    [
      'unknown review status',
      { ...base, reviews: [{ ...base.reviews[0], status: 'ok' }] },
      'review R1 has unknown status ok at state.json',
    ],
    [
      'unknown merge verdict',
      { ...base, reviews: [{ ...base.reviews[0], mergeVerdict: 'approve' }] },
      'review R1 has unknown merge verdict approve at state.json',
    ],
    [
      'invalid roster entry',
      { ...base, roster: [{ name: 'worker-m1', role: 'worker', state: 'active' }] },
      'invalid roster entry at state.json',
    ],
    [
      'duplicate roster name',
      { ...base, roster: [{ ...base.roster[0] }, { ...base.roster[0], agentId: 'a2' }] },
      'duplicate roster name worker-m1 at state.json',
    ],
    [
      'duplicate roster agent',
      { ...base, roster: [{ ...base.roster[0] }, { ...base.roster[0], name: 'worker-m2' }] },
      'duplicate roster agent a1 at state.json',
    ],
    [
      'message readBy array',
      { ...base, messages: [{ ...base.messages[0], readBy: undefined }] },
      'message msg-1 has no readBy array at state.json',
    ],
    [
      'duplicate message id',
      { ...base, messages: [{ ...base.messages[0] }, { ...base.messages[0] }] },
      'duplicate message id msg-1 at state.json',
    ],
    [
      'unknown finding status',
      { ...base, findings: [{ ...base.findings[0], status: 'closed' }] },
      'finding F1 has unknown status closed at state.json',
    ],
    ['negative revision', { ...base, revision: -1 }, 'tower state revision is not a non-negative integer at state.json'],
    ['fractional revision', { ...base, revision: 1.5 }, 'tower state revision is not a non-negative integer at state.json'],
    [
      'caseInsensitive shape',
      { ...base, caseInsensitive: 'yes' },
      'tower state caseInsensitive is not a boolean at state.json',
    ],
    [
      'worktree record shape',
      { ...base, missions: [{ ...base.missions[0], worktree: { path: 7, branch: 'b', baseCommit: 'c' } }] },
      'mission M1 has an invalid worktree record at state.json',
    ],
    ['mergeIntent shape', { ...base, mergeIntent: [] }, 'tower state mergeIntent is not an object at state.json'],
    ['rebaseIntent shape', { ...base, rebaseIntent: 'x' }, 'tower state rebaseIntent is not an object at state.json'],
    ['batches array', { ...base, batches: {} }, 'tower state batches is not an array at state.json'],
    ['reviewSeq integer', { ...base, reviewSeq: -1 }, 'tower state reviewSeq is not a non-negative integer at state.json'],
  ]
  for (const [label, state, expected] of cases) {
    const result = stateError(state)
    assert.equal(result.code, 'state-corrupt', label)
    // #74: the historical prose is preserved; the catalog recovery step is the
    // only allowed addition, rendered exactly once.
    assert.equal(
      result.message,
      `[tower:state-corrupt] ${expected} — next: ${ERROR_CODES['state-corrupt'].nextAction}`,
      label,
    )
  }
})

test('collection and entry shape failures are rejected as state-corrupt', () => {
  const base = validState()
  const cases = [
    ['not an object', null],
    ['schemaVersion not an integer', { ...base, schemaVersion: 'v2' }],
    ['missions entries', { ...base, missions: [{ status: 'active', tasks: [], deps: [] }] }],
    ['tasks array', { ...base, missions: [{ ...base.missions[0], tasks: {} }] }],
    ['deps array', { ...base, missions: [{ ...base.missions[0], deps: 'M2' }] }],
    ['references array', { ...base, missions: [{ ...base.missions[0], references: 'src/a.js' }] }],
    ['reviewPolicy string', { ...base, missions: [{ ...base.missions[0], reviewPolicy: 7 }] }],
    ['testRuns array', { ...base, missions: [{ ...base.missions[0], testRuns: 'npm test' }] }],
    ['roster array', { ...base, roster: {} }],
    ['roster entry shape', { ...base, roster: [null] }],
    ['messages array', { ...base, messages: {} }],
    ['message entry shape', { ...base, messages: [{ id: 'msg-1' }] }],
    ['findings array', { ...base, findings: {} }],
    ['finding entry shape', { ...base, findings: [{ status: 'open' }] }],
    ['reviews array', { ...base, reviews: {} }],
    ['review entry shape', { ...base, reviews: [{ status: 'clean' }] }],
    ['legacySnapshots array', { ...base, legacySnapshots: {} }],
    ['legacyMaps array', { ...base, legacyMaps: {} }],
    ['deliveries array', { ...base, deliveries: {} }],
  ]
  for (const [label, state] of cases) {
    assert.equal(stateError(state).code, 'state-corrupt', label)
  }
})

test('stateShapeError is pure and reports the first structural problem', () => {
  const invalid = { ...validState(), schemaVersion: SCHEMA_VERSION + 1 }
  const before = JSON.stringify(invalid)
  assert.match(
    String(stateShapeError(invalid, ' at x.json')),
    new RegExp(`schemaVersion ${SCHEMA_VERSION + 1} at x\\.json`),
  )
  assert.equal(JSON.stringify(invalid), before, 'shape validation must not mutate the state')
  assert.equal(stateShapeError(null, ' at x.json'), 'tower state is not an object at x.json')
})

test('a newer schemaVersion is version-unsupported, not corrupt, and carries a nextAction', () => {
  const newer = { ...validState(), schemaVersion: SCHEMA_VERSION + 1 }
  let error
  try {
    validateState(newer, 'state.json')
  } catch (thrown) {
    error = thrown
  }
  assert.equal(error.code, 'state-version-unsupported')
  assert.equal(error.nextAction === null, false)
  assert.match(error.message, /newer/)
})
