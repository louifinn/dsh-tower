// Properties 6 and 12 (#130): semantic validation has no false accepts (and no
// false rejects), and the persisted state roundtrip/migration is a fixed point.
//
// Property 6 mutates schema-valid generated states into each semantic violation
// the domain declares. The mutation must stay accepted by the *shape* check
// (`stateShapeError` returns null) and then be rejected by the semantic check
// (`validateState` throws `state-corrupt`): that is exactly the gap between "the
// JSON parses" and "the domain can use it". Every valid generated state must
// also be accepted, so a tightened rule cannot silently start rejecting legal
// state.
//
// The semantic surface is the one domain/state/semantics.js declares:
//   * revision is a non-negative integer;
//   * mission ids and roster names/agent ids are unique;
//   * mission status, review policy, finding status, review status and merge
//     verdict are vocabulary values, and `reviewPolicy: 'none'` carries a
//     non-empty exemption reason;
//   * a worktree record's string/number fields have the right types;
//   * message, finding and review ids are unique.
// It deliberately does not invent cross-collection invariants (for example a
// review's missionId need not reference a mission) because the state contract
// does not require them; those are app-level coherence, and this property only
// pins what the domain actually validates.
//
// Property 12 uses the persistence convention from adapters/persistence.js:
// `JSON.stringify(value, null, 2)` on write, `JSON.parse` on read. JSON drops
// keys whose value is `undefined`, so the fixed point is expressed over the
// serialized form rather than the live object. `migrateState` refuses to run
// when the document is already at the target version (empty chain), so the
// migration fixed point is asserted through `prepareState` idempotence plus a
// frozen check that `migrateState` on a current document refuses.
//
// No shrunk counterexample has been observed for either property across the three
// PR seeds (131, 40961, 978217) or the 2000-run long tier; the frozen v1/v2/v3
// fixtures under ./fixtures are the permanent record, not a replay of a failure.
import assert from 'node:assert/strict'
import fc from 'fast-check'

import { TowerToolError } from '../../domain/errors.js'
import { SCHEMA_VERSION } from '../../domain/mission.js'
import { prepareState, stateShapeError, validateState } from '../../domain/state.js'
import { migrateState } from '../../domain/state/migrations.js'
import { assertStateSemantics } from '../../domain/state/semantics.js'
import {
  stateArb,
  stateWithFindingsArb,
  stateWithMessagesArb,
  stateWithMissionsArb,
  stateWithReviewsArb,
  stateWithRosterArb,
  stateWithRosterPairArb,
} from './arbitraries/index.mjs'
import { MIGRATION_FIXTURES, V1_FIXTURE, V3_FIXTURE } from './fixtures/state-versions.mjs'
import { runProperty } from './helpers/harness.mjs'

/**
 * @param {() => void} callback
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
 * The mutation must be schema-valid and semantically rejected.
 * @param {any} state
 * @param {string} label
 * @returns {void}
 */
function assertSemanticRejection(state, label) {
  const shapeProblem = stateShapeError(state, label)
  assert.equal(
    shapeProblem,
    null,
    `${label}: the mutation must stay schema-valid, but the shape check rejected it: ${shapeProblem}`,
  )
  const error = rejectionOf(() => validateState(state, label))
  assert.ok(error instanceof TowerToolError, `${label}: expected the semantic check to throw, got ${error}`)
  assert.equal(error.code, 'state-corrupt', `${label}: expected state-corrupt, got ${error.code}`)
}

/**
 * A worktree record whose other fields are valid, so the mutation targets one
 * field type at a time.
 * @param {Record<string, any>} overrides
 * @returns {Record<string, any>}
 */
function worktreeWith(overrides) {
  return {
    path: '/worktrees/M1',
    branch: 'tower/M1-property',
    baseCommit: 'a'.repeat(40),
    realPath: '/worktrees/M1',
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

/**
 * @param {string} field
 * @param {unknown} value
 * @returns {(state: any) => any}
 */
function breakWorktreeField(field, value) {
  return (state) => {
    state.missions[0].worktree = worktreeWith({ [field]: value })
    return state
  }
}

const semanticMutations = [
  {
    name: 'a negative revision',
    arbitrary: stateArb,
    mutate: (state) => {
      state.revision = -1
      return state
    },
  },
  {
    name: 'a fractional revision',
    arbitrary: stateArb,
    mutate: (state) => {
      state.revision = 0.5
      return state
    },
  },
  {
    name: 'a duplicate mission id',
    arbitrary: stateWithMissionsArb,
    mutate: (state) => {
      state.missions.push(structuredClone(state.missions[0]))
      return state
    },
  },
  {
    name: 'an unknown mission status',
    arbitrary: stateWithMissionsArb,
    mutate: (state) => {
      state.missions[0].status = 'launched'
      return state
    },
  },
  {
    name: 'an unknown review policy',
    arbitrary: stateWithMissionsArb,
    mutate: (state) => {
      state.missions[0].reviewPolicy = 'optional'
      return state
    },
  },
  {
    name: 'reviewPolicy none without an exemption reason',
    arbitrary: stateWithMissionsArb,
    mutate: (state) => {
      state.missions[0].reviewPolicy = 'none'
      state.missions[0].reviewExemptionReason = '   '
      return state
    },
  },
  {
    name: 'reviewPolicy none with the exemption reason missing',
    arbitrary: stateWithMissionsArb,
    mutate: (state) => {
      state.missions[0].reviewPolicy = 'none'
      delete state.missions[0].reviewExemptionReason
      return state
    },
  },
  {
    name: 'a worktree path that is not a string',
    arbitrary: stateWithMissionsArb,
    mutate: breakWorktreeField('path', 7),
  },
  {
    name: 'a worktree branch that is not a string',
    arbitrary: stateWithMissionsArb,
    mutate: breakWorktreeField('branch', null),
  },
  {
    name: 'a worktree baseCommit that is not a string',
    arbitrary: stateWithMissionsArb,
    mutate: breakWorktreeField('baseCommit', 42),
  },
  {
    name: 'a worktree realPath that is not a string',
    arbitrary: stateWithMissionsArb,
    mutate: breakWorktreeField('realPath', []),
  },
  {
    name: 'a worktree createdAt that is not a number',
    arbitrary: stateWithMissionsArb,
    mutate: breakWorktreeField('createdAt', '2020-01-01'),
  },
  {
    name: 'a duplicate roster name',
    arbitrary: stateWithRosterArb,
    mutate: (state) => {
      const row = state.roster[0]
      state.roster.push({ ...structuredClone(row), state: 'reserved', agentId: null })
      return state
    },
  },
  {
    name: 'a duplicate roster agent id',
    arbitrary: stateWithRosterPairArb.filter((state) =>
      state.roster.some((entry) => typeof entry.agentId === 'string'),
    ),
    mutate: (state) => {
      const row = state.roster.find((entry) => typeof entry.agentId === 'string')
      state.roster.push({ ...structuredClone(row), name: `${row.name}-copy` })
      return state
    },
  },
  {
    name: 'a non-reserved roster entry without an agent id',
    arbitrary: stateWithRosterArb.filter((state) =>
      state.roster.some((entry) => typeof entry.agentId === 'string'),
    ),
    mutate: (state) => {
      delete state.roster.find((entry) => typeof entry.agentId === 'string').agentId
      return state
    },
  },
  {
    name: 'a duplicate message id',
    arbitrary: stateWithMessagesArb,
    mutate: (state) => {
      state.messages.push(structuredClone(state.messages[0]))
      return state
    },
  },
  {
    name: 'a duplicate finding id',
    arbitrary: stateWithFindingsArb,
    mutate: (state) => {
      state.findings.push(structuredClone(state.findings[0]))
      return state
    },
  },
  {
    name: 'an unknown finding status',
    arbitrary: stateWithFindingsArb,
    mutate: (state) => {
      state.findings[0].status = 'reopened'
      return state
    },
  },
  {
    name: 'a duplicate review id',
    arbitrary: stateWithReviewsArb,
    mutate: (state) => {
      state.reviews.push(structuredClone(state.reviews[0]))
      return state
    },
  },
  {
    name: 'an unknown review status',
    arbitrary: stateWithReviewsArb,
    mutate: (state) => {
      state.reviews[0].status = 'ok'
      return state
    },
  },
  {
    name: 'an unknown merge verdict',
    arbitrary: stateWithReviewsArb,
    mutate: (state) => {
      state.reviews[0].mergeVerdict = 'approve'
      return state
    },
  },
]

runProperty({
  name: 'state semantics: a schema-valid generated state is accepted (no false rejects)',
  arbitrary: stateArb,
  predicate: (state) => {
    assert.equal(stateShapeError(state, 'acceptance'), null, 'a generated state must pass the shape check')
    assert.equal(assertStateSemantics(state, 'acceptance'), state, 'assertStateSemantics must accept the record')
    assert.equal(validateState(state, 'acceptance'), state, 'validateState must return the accepted record')
  },
})

for (const mutation of semanticMutations) {
  runProperty({
    name: `state semantics: the validator rejects ${mutation.name}`,
    arbitrary: mutation.arbitrary.map((state) => mutation.mutate(structuredClone(state))),
    predicate: (state) => {
      assertSemanticRejection(state, mutation.name)
    },
  })
}

/** The persistence convention: write pretty JSON, read it back. */
function writeState(state) {
  return JSON.stringify(state, null, 2)
}

/** @param {string} text */
function readState(text) {
  return JSON.parse(text)
}

runProperty({
  name: 'state roundtrip: parse(serialize(state)) revalidates and serialization is a fixed point',
  arbitrary: stateArb,
  predicate: (state) => {
    const validated = validateState(state, 'roundtrip')
    const written = writeState(validated)
    const read = readState(written)
    assert.deepEqual(read, readState(writeState(validated)), 'parse(serialize(state)) must be stable')
    assert.deepEqual(readState(writeState(read)), read, 'parse(serialize(parse(serialize(state)))) must be a fixed point')
    assert.equal(validateState(read, 'roundtrip read'), read, 'the read state must validate')
    assert.equal(writeState(validateState(read, 'roundtrip read')), written, 'serializing the validated state must be a fixed point')
  },
})

runProperty({
  name: 'state preparation: the current version is a fixed point',
  arbitrary: stateArb,
  predicate: (state) => {
    const prepared = prepareState(state, 'current')
    assert.equal(prepared.from, SCHEMA_VERSION)
    assert.equal(prepared.to, SCHEMA_VERSION)
    assert.equal(prepared.changed, false, 'preparing a current state must not report a migration')
    assert.deepEqual(prepared.migrated, [], 'preparing a current state must not run migration steps')
    assert.equal(prepared.state, state, 'preparing a current state must return the validated record')
    assert.deepEqual(prepareState(prepared.state, 'current again').state, prepared.state)
  },
})

runProperty({
  name: 'state migration: targeting the current version is a fixed point for v1, v2 and v3 fixtures',
  arbitrary: fc.constantFrom(...MIGRATION_FIXTURES),
  predicate: (fixture) => {
    const before = structuredClone(fixture)
    const prepared = prepareState(fixture, 'fixture')
    assert.deepEqual(fixture, before, 'prepareState must not mutate its input')
    assert.equal(prepared.from, fixture.schemaVersion)
    assert.equal(prepared.to, SCHEMA_VERSION)
    if (fixture.schemaVersion === SCHEMA_VERSION) {
      assert.equal(prepared.changed, false, 'a current fixture must not be migrated')
      assert.deepEqual(prepared.migrated, [])
    } else {
      assert.equal(prepared.changed, true, 'an old fixture must be migrated')
      assert.ok(prepared.migrated.length > 0, 'an old fixture must report its migration steps')
      assert.equal(prepared.migrated[prepared.migrated.length - 1].to, SCHEMA_VERSION)
    }

    const migrated = prepared.state
    assert.equal(migrated.schemaVersion, SCHEMA_VERSION)
    validateState(migrated, 'migrated fixture')

    // The migrated document is a fixed point: preparing it again changes nothing.
    const again = prepareState(structuredClone(migrated), 'migrated fixture again')
    assert.equal(again.changed, false, 'the migrated document must already be current')
    assert.deepEqual(again.state, migrated, 'preparing the migrated document must be a fixed point')

    // And it survives the persistence roundtrip unchanged.
    const written = writeState(migrated)
    const read = readState(written)
    assert.deepEqual(validateState(read, 'migrated roundtrip'), read)
    assert.equal(writeState(validateState(read, 'migrated roundtrip')), written)

    // prepareState and migrateState agree on the resulting document for old
    // fixtures (for a current fixture migrateState refuses, see below).
    if (fixture.schemaVersion < SCHEMA_VERSION) {
      const direct = migrateState(structuredClone(fixture))
      assert.equal(direct.to, SCHEMA_VERSION)
      assert.deepEqual(direct.state, migrated, 'migrateState and prepareState must agree')
    }
  },
})

// Frozen v1 detail: the legacy document backfills revision 0 and empty tasks/deps.
runProperty({
  name: 'state migration: the v1 fixture backfills revision, tasks and deps (frozen example)',
  arbitrary: fc.constant(null),
  predicate: () => {
    const prepared = prepareState(structuredClone(V1_FIXTURE), 'v1 frozen')
    assert.equal(prepared.changed, true)
    assert.equal(prepared.state.revision, 0)
    assert.deepEqual(prepared.state.missions[0].tasks, [])
    assert.deepEqual(prepared.state.missions[0].deps, [])
    assert.equal(prepared.state.caseInsensitive, null)
  },
})

// Frozen current-version detail: migrateState refuses a document that is already
// at the target version, so the fixed point must go through prepareState.
runProperty({
  name: 'state migration: migrateState on an already-current document refuses (frozen example)',
  arbitrary: fc.constant(null),
  predicate: () => {
    const error = rejectionOf(() => migrateState(structuredClone(V3_FIXTURE)))
    assert.ok(error instanceof TowerToolError, 'migrateState on a current document must throw')
    assert.equal(error.code, 'state-version-unsupported')
  },
})
