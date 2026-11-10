// Schema v3 -> v4 (#149): a captured 2.4.x/2.6 branch-shaped state migrates to
// per-shape missions. A legacy survey keeps the commit it read, drops the
// branch/worktree/merge fields it never owned, and becomes terminal-success at
// `completed`. The step is pure, one-way and a fixed point once stamped.
// Run with: node --test tests/shape-migration.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspectStateVersion, prepareState, validateState } from '../domain/state.js'
import { STATE_MIGRATIONS, legacySurveyNeedsRead, migrateState } from '../domain/state/migrations.js'
import { assertStateSemantics } from '../domain/state/semantics.js'
import { SCHEMA_VERSION } from '../domain/mission.js'
import { canTransition, isTerminal, shapeFor } from '../domain/shapes/index.js'
import { resolveLegacySurveyRead } from '../app/sharedCheckout.js'
import * as store from '../adapters/store.js'
import { loadStateFile } from '../adapters/stateFile.js'
import { removeTemp } from './helpers/cleanup.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = () =>
  JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'state-v3-shape-migration.json'), 'utf8'))
const unprovisionedFixture = () =>
  JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'state-v3-shape-migration-unprovisioned.json'), 'utf8'))

function git(cwd, args) {
  // Mirror the vcs port: trim only the trailing newline, so porcelain's leading
  // status space survives.
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\r\n/g, '\n').trimEnd()
}

/** A git-backed fake of the two Tower methods the load-time resolver uses. */
function gitTower(repo) {
  return {
    root: repo,
    revParse: async (cwd, ref) => git(cwd, ['rev-parse', ref]),
    git: async (cwd, args) => git(cwd, args),
  }
}

function tempStatePaths() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-shape-migration-'))
  return { temp, paths: store.pathsFor(path.join(temp, 'repo', '.git')) }
}

test('a captured v3 document is migratable to v4', () => {
  const legacy = fixture()
  assert.equal(legacy.schemaVersion, 3)
  const info = inspectStateVersion(legacy, 'state.json')
  assert.equal(info.status, 'migratable')
  assert.equal(info.supportedVersion, SCHEMA_VERSION)
  assert.deepEqual(info.migrations.map((step) => [step.from, step.to]), [[3, 4], [4, 5]])
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
  assert.equal(prepared.to, 5)
  assert.deepEqual(prepared.migrated, [{ from: 3, to: 4 }, { from: 4, to: 5 }])

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
  assert.equal(migrated.to, 5)
  assert.equal(migrated.steps.length, 2)
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

test('legacySurveyNeedsRead identifies only an unanchored legacy survey', () => {
  assert.equal(legacySurveyNeedsRead(fixture()), false, 'every captured survey recorded a base')
  assert.equal(legacySurveyNeedsRead(unprovisionedFixture()), true)
  // A current document is never re-migrated, and a document with no missions
  // (or a build-only document) never asks for a read.
  assert.equal(legacySurveyNeedsRead({ ...unprovisionedFixture(), schemaVersion: 5 }), false)
  assert.equal(legacySurveyNeedsRead({ ...unprovisionedFixture(), missions: [] }), false)
  assert.equal(legacySurveyNeedsRead({ ...unprovisionedFixture(), missions: [fixture().missions[0]] }), false)
  assert.equal(legacySurveyNeedsRead(null), false)
})

test('an unprovisioned legacy survey migrates from the loader-resolved read', () => {
  const legacy = unprovisionedFixture()
  const snapshot = JSON.stringify(legacy)
  const read = { readCommit: 'resolved-base-commit', readDirty: ['README.md'] }
  const prepared = prepareState(legacy, 'state.json', { legacySurveyRead: read })
  assert.equal(prepared.changed, true)
  assert.equal(prepared.to, 5)

  const [build, survey, recorded] = prepared.state.missions
  // The build document is unchanged; only the kind discriminant is stamped.
  assert.deepEqual(build, { ...legacy.missions[0], kind: 'build' })
  // The unanchored survey is anchored at the resolved base and keeps the
  // tracked-status evidence resolved at the same moment — no empty fabrication.
  assert.equal(survey.kind, 'survey')
  assert.equal(survey.readCommit, 'resolved-base-commit')
  assert.deepEqual(survey.readDirty, ['README.md'])
  assert.equal(survey.status, 'planned')
  assert.deepEqual(survey.scope, [])
  for (const field of ['worktree', 'worktreeRemovedAt', 'branch', 'baseCommit', 'mergedCommit', 'mergedAt']) {
    assert.equal(field in survey, false, `survey must not carry ${field}`)
  }
  // A survey that recorded its own base never consumes the resolution.
  assert.equal(recorded.readCommit, 'read-commit-3')
  assert.deepEqual(recorded.readDirty, [])
  assert.equal(JSON.stringify(legacy), snapshot, 'the migration never mutates its input')
  assert.equal(validateState(prepared.state, 'state.json'), prepared.state)
})

test('the resolved migration is a fixed point and yields a normal survey', () => {
  const read = { readCommit: 'resolved-base-commit', readDirty: ['README.md'] }
  const once = prepareState(unprovisionedFixture(), 'state.json', { legacySurveyRead: read })
  const again = prepareState(once.state, 'state.json', {
    legacySurveyRead: { readCommit: 'a-different-commit', readDirty: [] },
  })
  assert.equal(again.changed, false)
  assert.equal(again.state, once.state, 'a v4 document is never rewritten by the resolver')

  const survey = once.state.missions[1]
  const shape = shapeFor('survey')
  assert.equal(shape.needsLegacyRead(survey), false)
  // Anchored, planned and therefore spawnable/completable exactly like a survey
  // planned in v4: no worktree, no branch, no special case.
  assert.ok(shape.spawn.missionStatuses.includes(survey.status))
  assert.equal(canTransition('survey', survey.status, 'active'), true)
  assert.equal(canTransition('survey', 'active', 'completed'), true)
  assert.equal(isTerminal('survey', 'completed'), true)

  // The v3 -> v4 step itself reaches the same fixed point.
  const step = STATE_MIGRATIONS.find((entry) => entry.from === 3)
  assert.ok(step)
  const migrated = step.migrate(unprovisionedFixture(), { legacySurveyRead: read })
  assert.deepEqual(step.migrate(migrated, { legacySurveyRead: read }), migrated)
})

test('without a resolved read the unanchored survey still fails clearly', () => {
  assert.throws(
    () => prepareState(unprovisionedFixture(), 'state.json'),
    (error) =>
      error.code === 'state-migration-failed' &&
      /survey M2 has no recorded base commit to read/.test(error.message) &&
      /state loader must resolve the base ref/.test(error.message),
  )
  const step = STATE_MIGRATIONS.find((entry) => entry.from === 3)
  assert.throws(() => step.migrate(unprovisionedFixture()), /survey M2 has no recorded base commit to read/)
})

test('loadStateFile anchors an unprovisioned survey at the resolved base and persists once', async () => {
  const { temp, paths } = tempStatePaths()
  try {
    const repo = path.join(temp, 'repo')
    fs.mkdirSync(repo)
    git(repo, ['init'])
    git(repo, ['config', 'user.email', 'tower@test'])
    git(repo, ['config', 'user.name', 'Tower Test'])
    fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-m', 'seed'])
    git(repo, ['branch', '-m', 'main'])
    // One tracked edit and one untracked artefact: only the tracked path is
    // survey evidence, so the resolver must not record a fabricated empty set.
    fs.appendFileSync(path.join(repo, 'README.md'), 'edit\n')
    fs.writeFileSync(path.join(repo, 'artifact.tmp'), 'scratch\n')
    const baseCommit = git(repo, ['rev-parse', 'HEAD'])

    await store.ensureDir(paths.dir)
    fs.writeFileSync(paths.state, JSON.stringify(unprovisionedFixture(), null, 2))
    const tower = gitTower(repo)
    let resolverCalls = 0
    const loaded = await loadStateFile({
      store,
      paths,
      persist: true,
      now: 123,
      resolveLegacySurvey: async (raw) => {
        resolverCalls += 1
        return resolveLegacySurveyRead(tower, raw)
      },
    })
    assert.equal(resolverCalls, 1, 'the loader resolves exactly once per migration')
    assert.equal(loaded.migration.from, 3)
    assert.equal(loaded.migration.persisted, true)
    assert.equal(loaded.state.schemaVersion, SCHEMA_VERSION)
    const survey = loaded.state.missions[1]
    assert.equal(survey.readCommit, baseCommit, 'anchored at the state base commit')
    assert.deepEqual(survey.readDirty, ['README.md'], 'fingerprints the checkout as it stands')

    // The persisted document is a usable v4 state: loading it again is a fixed
    // point and never calls the resolver.
    const again = await loadStateFile({
      store,
      paths,
      persist: false,
      resolveLegacySurvey: async () => {
        throw new Error('a current document must not resolve a legacy read')
      },
    })
    assert.equal(again.migration, null)
    assert.deepEqual(again.state, loaded.state)
    assert.equal(again.state.missions[1].readCommit, baseCommit)
  } finally {
    removeTemp(temp)
  }
})

test('loadStateFile does not ask for a resolution when every legacy survey recorded its base', async () => {
  const { temp, paths } = tempStatePaths()
  try {
    await store.ensureDir(paths.dir)
    fs.writeFileSync(paths.state, JSON.stringify(fixture(), null, 2))
    const loaded = await loadStateFile({
      store,
      paths,
      persist: false,
      resolveLegacySurvey: async () => {
        throw new Error('a fully anchored document must not resolve a legacy read')
      },
    })
    assert.equal(loaded.migration.from, 3)
    assert.equal(loaded.migration.persisted, false)
    assert.equal(loaded.state.missions[1].readCommit, 'read-commit-2')
    assert.equal(loaded.state.missions[2].readCommit, 'read-commit-3')
  } finally {
    removeTemp(temp)
  }
})
