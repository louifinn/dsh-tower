// Smoke properties for the harness.
//
// These are not the real property suite (#130 adds it in follow-ups): they only
// prove the plumbing works end to end - arbitraries produce schema-shaped
// values, the harness registers `node:test` cases, tiers/seeds are resolved, and
// failure artifacts have a home. They also pin the domain contract that the
// rest of the property suite will rely on.
//
// Everything here is pure: the only side effect is the harness writing a
// failure artifact when a property actually fails.
import assert from 'node:assert/strict'

import { normalizeScope } from '../../domain/scope.js'
import { resolveTowerConfig, assertKnownKeys } from '../../domain/config/schema.js'
import { stateShapeError } from '../../domain/state/schema.js'
import { assertStateSemantics } from '../../domain/state/semantics.js'
import {
  absoluteScopeEntryArb,
  commitShaArb,
  configArb,
  parentTraversalScopeEntryArb,
  scopeArb,
  stateArb,
} from './arbitraries/index.mjs'
import { runProperty } from './helpers/harness.mjs'

/** Group a count into a stable bucket for the long-tier distribution report. */
function countBucket(count) {
  if (count === 0) return '0'
  if (count === 1) return '1'
  return '2+'
}

runProperty({
  name: 'generated state satisfies the state schema and semantics',
  arbitrary: stateArb,
  classify: (state) => `missions=${countBucket(state.missions.length)} roster=${countBucket(state.roster.length)}`,
  predicate: (state) => {
    assert.equal(stateShapeError(state), null)
    assert.equal(assertStateSemantics(state, '').schemaVersion, 3)
  },
})

runProperty({
  name: 'generated raw config resolves with no unknown keys',
  arbitrary: configArb,
  classify: (raw) => `groups=${Object.keys(raw).length}`,
  predicate: (raw) => {
    assert.doesNotThrow(() => assertKnownKeys(raw, 'Tower config'))
    const resolved = resolveTowerConfig(raw)
    for (const group of ['init', 'mode', 'review', 'merge', 'git', 'worktrees', 'spawn', 'send', 'tests', 'gates', 'docs', 'archive', 'leases', 'dev']) {
      assert.equal(typeof resolved[group], 'object')
    }
    assert.ok(resolved.mode.denyTools.length > 0)
    assert.equal(typeof resolved.section, 'string')
  },
})

runProperty({
  name: 'normalized scope entries stay relative',
  arbitrary: scopeArb,
  predicate: (scope) => {
    const normalized = normalizeScope(scope, { allowEmpty: true })
    for (const entry of normalized) {
      assert.equal(typeof entry, 'string')
      assert.ok(!entry.startsWith('/'), `absolute entry survived normalization: ${entry}`)
      assert.ok(!/^[A-Za-z]:[\\/]/.test(entry), `drive entry survived normalization: ${entry}`)
      assert.ok(!entry.split(/[\\/]/).includes('..'), `parent traversal survived normalization: ${entry}`)
    }
  },
})

runProperty({
  name: 'normalizeScope rejects traversal and absolute entries',
  arbitrary: absoluteScopeEntryArb,
  predicate: (absoluteEntry) => {
    assert.throws(() => normalizeScope([absoluteEntry]))
  },
})

runProperty({
  name: 'traversal scope entry is rejected',
  arbitrary: parentTraversalScopeEntryArb,
  predicate: (entry) => {
    assert.throws(() => normalizeScope([entry]))
  },
})

runProperty({
  name: 'commit shas are 40 lowercase hex characters',
  arbitrary: commitShaArb,
  predicate: (sha) => {
    assert.match(sha, /^[0-9a-f]{40}$/)
  },
})
