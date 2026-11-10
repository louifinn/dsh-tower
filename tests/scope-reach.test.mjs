// #149 W4: scope ownership is one shape declaration (`reach`) and one fence.
//
// The gate, planning and mission-input rules all derive from the same reach;
// none of them compares a kind literal or re-reads `mission.scope` to decide
// whether a path change is permitted.
import assert from 'node:assert/strict'
import test from 'node:test'

import { scopeFenceBlocker } from '../domain/scope.js'
import { outOfScopeBlocker } from '../domain/integration/gate.js'
import { normalizeMissionInput } from '../domain/missions/plan.js'
import { addAutoDeps } from '../domain/planning.js'
import { SHAPES } from '../domain/shapes/index.js'

test('a build fence accepts scope members and rejects everything else', () => {
  const mission = { id: 'M1', kind: 'build', scope: ['src/**', 'tests/**'] }
  const reach = SHAPES.build.reach
  assert.equal(scopeFenceBlocker({ mission, reach, changedFiles: ['src/a.js', 'tests/b.mjs'] }), null)
  const blocker = scopeFenceBlocker({ mission, reach, changedFiles: ['src/a.js', 'docs/x.md'] })
  assert.equal(blocker.code, 'out-of-scope')
  assert.match(blocker.detail, /docs\/x\.md/)
})

test('a read-only fence rejects any changed path and needs no scope', () => {
  const mission = { id: 'S1', kind: 'survey', scope: [] }
  const reach = SHAPES.survey.reach
  assert.equal(scopeFenceBlocker({ mission, reach, changedFiles: [] }), null)
  const blocker = scopeFenceBlocker({ mission, reach, changedFiles: ['src/a.js'] })
  assert.equal(blocker.code, 'out-of-scope')
  assert.match(blocker.detail, /read-only/)
  assert.match(blocker.detail, /src\/a\.js/)
})

test('the merge-gate enforcer derives reach from the mission kind, never from scope presence', () => {
  assert.equal(
    outOfScopeBlocker({ mission: { id: 'M1', kind: 'build', scope: ['src/**'] }, changedFiles: ['src/a.js'] }),
    null,
  )
  const survey = outOfScopeBlocker({ mission: { id: 'S1', kind: 'survey' }, changedFiles: ['src/a.js'] })
  assert.equal(survey.code, 'out-of-scope')
  assert.match(survey.detail, /read-only/)
})

test('mission input rejects a scope on a shape that does not own paths', () => {
  assert.throws(
    () => normalizeMissionInput({ title: 'Read it', kind: 'survey', scope: ['src/**'], readCommit: 'a'.repeat(40) }, 0, { commit: 'a'.repeat(40) }),
    /does not own/,
  )
  const survey = normalizeMissionInput({ title: 'Read it', kind: 'survey', readCommit: 'a'.repeat(40) }, 0, { commit: 'a'.repeat(40) })
  assert.deepEqual(survey.scope, [])
  const build = normalizeMissionInput({ title: 'Change it', kind: 'build', scope: ['src/**'] }, 0)
  assert.deepEqual(build.scope, ['src/**'])
})

test('auto-dependencies are added only between shapes that own paths', () => {
  const existing = [{ id: 'M1', kind: 'build', status: 'active', scope: ['src/**'], deps: [] }]
  const created = [
    { id: 'M2', kind: 'build', status: 'planned', scope: ['src/a.js'], deps: [] },
    { id: 'S1', kind: 'survey', status: 'planned', scope: [], deps: [] },
  ]
  addAutoDeps(created, existing)
  assert.deepEqual(created[0].deps, ['M1'])
  assert.deepEqual(created[1].deps, [])
})
