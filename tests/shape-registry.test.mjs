// Shape registry (#149): one module owns the per-kind status set, transition
// table, terminality, completion invariants and the merge/rebase capability.
// Generic layers resolve a shape once; these tests pin the interface itself.
// Run with: node --test tests/shape-registry.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SHAPES,
  SHAPE_KINDS,
  assertActionSupported,
  canMerge,
  canRebase,
  canTransition,
  defaultPresetFor,
  isShapeKind,
  isTerminal,
  provisioningFor,
  shapeFor,
} from '../domain/shapes/index.js'
import { MISSION_STATUSES } from '../domain/mission.js'
import { MISSION_KINDS } from '../domain/vocabulary.js'
import { addAutoDeps } from '../domain/planning.js'
import { dependencySatisfied } from '../domain/integration/gate.js'

const BUILD_STATUSES = ['planned', 'active', 'completed', 'blocked', 'paused', 'merged', 'abandoned']
const SURVEY_STATUSES = ['planned', 'active', 'completed', 'blocked', 'paused', 'abandoned']

test('the registry is the only kind source: build|survey is frozen and re-exported', () => {
  assert.deepEqual(SHAPE_KINDS, ['build', 'survey'])
  assert.ok(Object.isFrozen(SHAPES))
  assert.deepEqual(MISSION_KINDS, SHAPE_KINDS)
  assert.equal(isShapeKind('build'), true)
  assert.equal(isShapeKind('survey'), true)
  assert.equal(isShapeKind('review'), false)
  assert.equal(isShapeKind(undefined), false)
  assert.deepEqual(
    MISSION_STATUSES,
    [...new Set([...SHAPES.build.statuses, ...SHAPES.survey.statuses])],
    'the union vocabulary is derived from the registry, never hand-written',
  )
})

test('per-kind status sets: build can be merged, a survey can never reach merged', () => {
  assert.deepEqual(SHAPES.build.statuses, BUILD_STATUSES)
  assert.deepEqual(SHAPES.survey.statuses, SURVEY_STATUSES)
  assert.equal(SURVEY_STATUSES.includes('merged'), false)
  assert.equal(isTerminal('survey', 'merged'), false, 'merged is not even a survey status')
  assert.equal(canTransition('survey', 'completed', 'merged'), false)
  assert.equal(canTransition('build', 'completed', 'active'), true)
  assert.equal(canTransition('survey', 'completed', 'active'), false, 'a completed survey is terminal-success')
  assert.equal(isTerminal('survey', 'completed'), true)
  assert.equal(isTerminal('survey', 'abandoned'), true)
  assert.equal(isTerminal('build', 'merged'), true)
  assert.equal(isTerminal('build', 'abandoned'), true)
})

test('isTerminal agrees with the transition table for every kind and status', () => {
  for (const kind of SHAPE_KINDS) {
    const shape = shapeFor(kind)
    for (const status of shape.statuses) {
      assert.ok(Array.isArray(shape.transitions[status]), `${kind} ${status} has a transition row`)
      assert.equal(
        shape.isTerminal(status),
        shape.transitions[status].length === 0,
        `${kind} ${status}: terminal iff no outgoing transition`,
      )
      for (const target of shape.statuses) {
        assert.equal(
          shape.canTransition(status, target),
          shape.transitions[status].includes(target),
          `${kind} ${status} -> ${target} matches the table`,
        )
      }
    }
    // Terminal rows never list a successor, and every non-terminal row does.
    for (const status of shape.statuses) {
      if (shape.transitions[status].length === 0) assert.equal(shape.isTerminal(status), true)
    }
  }
})

test('the exported entry points are kind-first wrappers over the registry', () => {
  assert.equal(isTerminal('build', 'merged'), SHAPES.build.isTerminal('merged'))
  assert.equal(canTransition('survey', 'active', 'completed'), SHAPES.survey.canTransition('active', 'completed'))
  assert.equal(isTerminal(undefined, 'planned'), false, 'a partial snapshot resolves the build shape')
  assert.throws(() => shapeFor('review'), (error) => error.code === 'invalid-argument' && /unknown mission kind/.test(error.message))
})

test('capabilities are structural: a survey can not merge or rebase', () => {
  assert.equal(canMerge('build'), true)
  assert.equal(canRebase('build'), true)
  assert.equal(canMerge('survey'), false)
  assert.equal(canRebase('survey'), false)
  assert.equal(provisioningFor('build'), 'branch-worktree')
  assert.equal(provisioningFor('survey'), 'shared')
  // #148 W2: placement and preset resolve from tuning config, never from a
  // generic kind comparison. The default stays the shared read-only path.
  assert.equal(provisioningFor('survey', { survey: { sandbox: 'detached' } }), 'detached')
  assert.equal(provisioningFor('survey', { survey: { sandbox: 'none' } }), 'shared')
  // Build missions keep using config.spawn.workerPreset; only shapes that own a preset name one.
  assert.equal(defaultPresetFor('build'), null)
  assert.equal(defaultPresetFor('survey'), 'tower-survey')
  assert.equal(defaultPresetFor('survey', { survey: { sandbox: 'detached' } }), 'tower-survey-sandbox')
  assert.equal(defaultPresetFor('survey', { survey: { sandbox: 'none' } }), 'tower-survey')
  assert.equal(SHAPES.build.requiredComponent, null)
  assert.equal(SHAPES.survey.requiredComponent, 'tower-survey')
  assert.equal(SHAPES.build.acceptsResult, false)
  assert.equal(SHAPES.survey.acceptsResult, true)
  assert.equal(SHAPES.build.ownsScope, true)
  assert.equal(SHAPES.survey.ownsScope, false)
  assert.deepEqual(SHAPES.build.fields, { worktree: true, readCommit: false, merge: true, sandbox: false })
  assert.deepEqual(SHAPES.survey.fields, { worktree: false, readCommit: true, merge: false, sandbox: true })
})

test('assertActionSupported refuses every build-only action on a survey with an actionable message', () => {
  const survey = { id: 'M7', kind: 'survey', status: 'active', readCommit: 'abc123456789' }
  for (const action of ['merge', 'rebase', 'preflight', 'diff']) {
    assert.throws(
      () => assertActionSupported(survey, action),
      (error) =>
        error.code === 'invalid-transition' &&
        error.message.includes(`mission M7 is a survey`) &&
        typeof error.nextAction === 'string',
      `${action} must be refused`,
    )
  }
  assert.equal(assertActionSupported({ id: 'M1', kind: 'build' }, 'merge'), undefined)
  assert.equal(assertActionSupported({ id: 'M2', kind: 'build' }, 'rebase'), undefined)
})

test('completion invariants are data, not conditionals in the use case', () => {
  assert.deepEqual(
    {
      worktree: SHAPES.build.completion.requiresWorktree,
      commits: SHAPES.build.completion.requiresCommits,
      clean: SHAPES.build.completion.requiresClean,
      head: SHAPES.build.completion.requiresHeadMatch,
      tracked: SHAPES.build.completion.requiresTrackedStatus,
    },
    { worktree: true, commits: true, clean: true, head: false, tracked: false },
  )
  assert.deepEqual(
    {
      worktree: SHAPES.survey.completion.requiresWorktree,
      sandbox: SHAPES.survey.completion.requiresSandbox,
      commits: SHAPES.survey.completion.requiresCommits,
      clean: SHAPES.survey.completion.requiresClean,
      head: SHAPES.survey.completion.requiresHeadMatch,
      tracked: SHAPES.survey.completion.requiresTrackedStatus,
    },
    { worktree: false, sandbox: false, commits: false, clean: false, head: true, tracked: true },
  )
  // The resolved placement declares the sandbox invariant set instead.
  const detached = SHAPES.survey.resolveCompletion({ id: 'M7', kind: 'survey' }, { survey: { sandbox: 'detached' } })
  assert.deepEqual(
    {
      worktree: detached.requiresWorktree,
      sandbox: detached.requiresSandbox,
      commits: detached.requiresCommits,
      clean: detached.requiresClean,
      head: detached.requiresHeadMatch,
      tracked: detached.requiresTrackedStatus,
    },
    { worktree: false, sandbox: true, commits: true, clean: false, head: true, tracked: false },
  )
  assert.equal(
    SHAPES.survey.resolveCompletion({ id: 'M7', kind: 'survey' }, { survey: { sandbox: 'none' } }),
    SHAPES.survey.completion,
    'the shared placement keeps the static read-only invariant set',
  )
  assert.equal(
    SHAPES.survey.completion.check({
      mission: { id: 'M7' },
      head: 'read-1',
      readCommit: 'read-1',
      trackedChanged: [],
    }).commits,
    0,
    'a survey completes with zero commits',
  )
  assert.throws(
    () =>
      SHAPES.build.completion.check({
        mission: { id: 'M1', worktree: { baseCommit: 'base' } },
        commits: 0,
        clean: true,
        dirtyPaths: [],
      }),
    (error) => error.code === 'invalid-argument' && /no commits/.test(error.message),
  )
})

test('dependencySatisfied is per shape: merged for a build, completed for a survey', () => {
  assert.equal(dependencySatisfied({ kind: 'build', status: 'merged' }), true)
  assert.equal(dependencySatisfied({ kind: 'build', status: 'completed' }), false)
  assert.equal(dependencySatisfied({ kind: 'survey', status: 'completed' }), true)
  assert.equal(dependencySatisfied({ kind: 'survey', status: 'merged' }), false)
  assert.equal(dependencySatisfied({ kind: 'survey', status: 'abandoned' }), true)
  assert.equal(dependencySatisfied(null), false)
})

test('migrateLegacy is a fixed point once the shape is stamped', () => {
  const legacySurvey = {
    id: 'M9',
    kind: 'survey',
    status: 'merged',
    scope: [],
    worktree: { path: '/wt', branch: 'tower/m9', baseCommit: 'read-9' },
    mergedCommit: 'merged-9',
    mergedAt: 5,
  }
  const migrated = SHAPES.survey.migrateLegacy(legacySurvey)
  assert.equal(migrated.status, 'completed')
  assert.equal(migrated.readCommit, 'read-9')
  assert.equal(migrated.worktree, undefined)
  assert.equal(migrated.branch, undefined)
  assert.equal(migrated.baseCommit, undefined)
  assert.equal(migrated.mergedCommit, undefined)
  assert.equal(migrated.mergedAt, undefined)
  assert.deepEqual(SHAPES.survey.migrateLegacy(migrated), migrated, 're-running the conversion is a no-op')

  const legacyBuild = { id: 'M1', title: 'Build', status: 'active', scope: ['src/**'] }
  const stamped = SHAPES.build.migrateLegacy(legacyBuild)
  assert.equal(stamped.kind, 'build')
  assert.deepEqual(SHAPES.build.migrateLegacy(stamped), stamped)
})

test('auto-dependencies serialise build scopes only; a survey owns no scope', () => {
  const existing = [
    { id: 'M1', kind: 'build', status: 'completed', scope: ['src/**'], deps: [] },
    { id: 'M2', kind: 'survey', status: 'completed', scope: ['src/**'], deps: [] },
  ]
  const created = [{ id: 'M3', kind: 'build', status: 'planned', scope: ['src/**'], deps: [] }]
  addAutoDeps(created, existing)
  assert.deepEqual(created[0].deps, ['M1'], 'the open build serialises; the completed survey never does')
})
