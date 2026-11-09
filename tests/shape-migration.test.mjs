// Schema v3 -> v4 (#149): a captured 2.4.x/2.6 branch-shaped state migrates to
// per-shape missions. A legacy survey keeps the commit it read, drops the
// branch/worktree/merge fields it never owned, and becomes terminal-success at
// `completed`. The step is pure, one-way and a fixed point once stamped.
// Run with: node --test tests/shape-migration.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspectStateVersion, prepareState, validateState } from '../domain/state.js'
import { STATE_MIGRATIONS, migrateState } from '../domain/state/migrations.js'
import { assertStateSemantics } from '../domain/state/semantics.js'
import { SCHEMA_VERSION } from '../domain/mission.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = () =>
  JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'state-v3-shape-migration.json'), 'utf8'))

test('a captured v3 document is migratable to v4', () => {
  const legacy = fixture()
  assert.equal(legacy.schemaVersion, 3)
  const info = inspectStateVersion(legacy, 'state.json')
  assert.equal(info.status, 'migratable')
  assert.equal(info.supportedVersion, SCHEMA_VERSION)
  assert.deepEqual(info.migrations.map((step) => [step.from, step.to]), [[3, 4]])
  assert.throws(
    () => validateState(legacy, 'state.json'),
    (error) => error.code === 'state-version-unsupported',
    'a v3 document is never accepted as current',
  )
})

test('v3 -> v4 converts a branch-shaped survey and keeps the build document intact', () => {
  const legacy = fixture()
  const snapshot = JSON.stringify(legacy)
  const prepared = prepareState(legacy, 'state.json')
  assert.equal(prepared.changed, true)
  assert.equal(prepared.to, 4)
  assert.deepEqual(prepared.migrated, [{ from: 3, to: 4 }])

  const [build, survey, older] = prepared.state.missions
  // A build keeps every field; only the shape stamp is added.
  assert.deepEqual(build, { ...legacy.missions[0], kind: 'build' })
  // A survey reads its worktree's base commit and drops the branch fields.
  assert.equal(survey.kind, 'survey')
  assert.equal(survey.readCommit, 'read-commit-2')
  assert.deepEqual(survey.readDirty, [])
  assert.equal(survey.status, 'completed')
  assert.deepEqual(survey.scope, [])
  for (const field of ['worktree', 'worktreeRemovedAt', 'branch', 'baseCommit', 'mergedCommit', 'mergedAt']) {
    assert.equal(field in survey, false, `survey must not carry ${field}`)
  }
  // Older surveys without a worktree fall back to the recorded mission baseCommit,
  // and a legacy `merged` completion is accepted as terminal-success.
  assert.equal(older.readCommit, 'read-commit-3')
  assert.equal(older.status, 'completed')
  assert.equal('mergedCommit' in older, false)
  assert.equal('mergedAt' in older, false)
  assert.equal('baseCommit' in older, false)
  assert.equal(JSON.stringify(legacy), snapshot, 'the migration never mutates its input')

  // The migrated document passes both the structural schema and the semantics.
  assert.equal(validateState(prepared.state, 'state.json'), prepared.state)
})

test('v3 -> v4 is idempotent: a v4 document is a fixed point', () => {
  const prepared = prepareState(fixture(), 'state.json')
  const again = prepareState(prepared.state, 'state.json')
  assert.equal(again.changed, false)
  assert.equal(again.state, prepared.state)

  const step = STATE_MIGRATIONS.find((entry) => entry.from === 3)
  assert.ok(step)
  const once = step.migrate(fixture())
  assert.deepEqual(step.migrate(once), once, 'the step itself is a fixed point')
  const migrated = migrateState(fixture(), { statePath: 'state.json' })
  assert.equal(migrated.to, 4)
  assert.equal(migrated.steps.length, 1)
})

test('the shape document is one-way: v4 rejects a survey that still owns branch fields', () => {
  const prepared = prepareState(fixture(), 'state.json').state
  const withWorktree = structuredClone(prepared)
  withWorktree.missions[1].worktree = {
    path: '/wt/M2',
    branch: 'tower/m2',
    baseCommit: 'read-commit-2',
    createdAt: 1,
    realPath: '/wt/M2',
  }
  assert.throws(
    () => assertStateSemantics(withWorktree, 'state.json'),
    (error) => error.code === 'state-corrupt' && /is a survey and may not have a worktree record/.test(error.message),
  )

  const withMerged = structuredClone(prepared)
  withMerged.missions[1].status = 'merged'
  assert.throws(
    () => assertStateSemantics(withMerged, 'state.json'),
    (error) => error.code === 'state-corrupt' && /unknown status merged for a survey mission/.test(error.message),
  )
})
