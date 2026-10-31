// Property 10 (#130): config resolution is total, strictly one-pass
// idempotent, and keeps exactly one cross-field rule (`gates.requireTests` ⇒
// `tests.enabled`).
//
// WHAT THIS FILE CHECKS
// ---------------------
// `resolveTowerConfig` (`domain/config/schema.js`) is the only entry point that
// turns a raw `tower.json` body into the runtime config. It:
//
//   * rejects non-objects and unknown keys with `TowerToolError`;
//   * fills schema defaults for every group;
//   * folds the legacy top-level `section`/`allowAgentControl` aliases into
//     `mode`, and materializes the resolved `mode.promptSection` so `section`
//     always mirrors it;
//   * rejects the one contradictory combination:
//     `gates.requireTests:true` with `tests.enabled:false` — a repository that
//     requires test evidence cannot also disable discovery.
//
// The properties below pin those promises:
//
//   * totality: every generated valid config resolves without throwing, and the
//     resolved object always carries all 15 documented surfaces with `section`
//     and `mode.promptSection` as strings and `gates`/`tests` as objects;
//   * fixed point: `resolve(resolve(raw))` deep-equals `resolve(raw)` for every
//     generated valid config. One pass materializes every resolved field,
//     including `mode.promptSection` (which mirrors `section`) and the legacy
//     aliases, so the output is a fixed point of its own resolver (F17). A raw
//     config that omits both `section` and `mode.promptSection` used to need a
//     second pass to back-fill `mode.promptSection`; it no longer does;
//   * the 16-way presence table for `gates.requireTests` × `tests.enabled`
//     (absent group, empty group, explicit `true`, explicit `false`): exactly
//     `requireTests:true` + `enabled:false` is rejected, everything else
//     resolves, and the resolved defaults agree with the schema;
//   * invalid inputs (non-objects, unknown keys, wrong types) are rejected with
//     `TowerToolError` and the documented code — resolution is total only over
//     configs that could actually be written.
//
// No shrunk counterexample has been observed across the three PR seeds
// (131, 40961, 978217) or the long tier.
import assert from 'node:assert/strict'
import fc from 'fast-check'

import { resolveTowerConfig } from '../../domain/config/schema.js'
import { TowerToolError } from '../../domain/errors.js'
import { configArb, legacyAliasConfigArb } from './arbitraries/index.mjs'
import { runProperty } from './helpers/harness.mjs'

const SURFACES = [
  'section',
  'init',
  'mode',
  'review',
  'merge',
  'git',
  'worktrees',
  'spawn',
  'send',
  'tests',
  'gates',
  'docs',
  'archive',
  'leases',
  'dev',
]

/**
 * @param {unknown} error
 * @param {string} code
 * @param {RegExp} [messageRe]
 */
function assertToolError(error, code, messageRe) {
  assert.ok(error instanceof TowerToolError, `expected a TowerToolError, got ${String(error)}`)
  assert.equal(error.code, code)
  if (messageRe) assert.match(error.message, messageRe)
}

/** @param {() => unknown} callback @param {string} code @param {RegExp} [messageRe] */
function assertRejects(callback, code, messageRe) {
  assert.throws(callback, (error) => {
    assertToolError(error, code, messageRe)
    return true
  })
}

/**
 * @param {Record<string, unknown>} config
 * @returns {Record<string, any>}
 */
function resolve(config) {
  return /** @type {Record<string, any>} */ (resolveTowerConfig(config))
}

// ---------------------------------------------------------------------------
// Totality and shape.
// ---------------------------------------------------------------------------

runProperty({
  name: 'config totality: every generated valid config resolves to all documented surfaces',
  arbitrary: configArb,
  predicate: (raw) => {
    const resolved = resolve(raw)
    assert.deepEqual(Object.keys(resolved).sort(), [...SURFACES].sort(), 'resolution must expose exactly the 15 surfaces')
    assert.equal(typeof resolved.section, 'string', 'section is always a string')
    assert.equal(typeof resolved.mode, 'object', 'mode is always an object')
    assert.ok(resolved.mode !== null && !Array.isArray(resolved.mode))
    assert.equal(typeof resolved.gates, 'object', 'gates is always an object')
    assert.ok(resolved.gates !== null && !Array.isArray(resolved.gates))
    assert.equal(typeof resolved.tests, 'object', 'tests is always an object')
    assert.ok(resolved.tests !== null && !Array.isArray(resolved.tests))
    assert.equal(typeof resolved.gates.requireTests, 'boolean', 'requireTests resolves to a boolean default')
    assert.equal(typeof resolved.tests.enabled, 'boolean', 'tests.enabled resolves to a boolean default')
    assert.ok(Array.isArray(resolved.mode.denyTools) && resolved.mode.denyTools.length > 0, 'denyTools is always populated')
    assert.equal(typeof resolved.mode.promptSection, 'string', 'mode.promptSection is always a string')
    assert.equal(resolved.section, resolved.mode.promptSection, 'section mirrors promptSection')
  },
})

runProperty({
  name: 'config totality: legacy alias-only configs resolve and fold into mode',
  arbitrary: legacyAliasConfigArb,
  predicate: (raw) => {
    const resolved = resolve(raw)
    if (raw.section !== undefined) assert.equal(resolved.section, raw.section)
    if (raw.allowAgentControl !== undefined) assert.equal(resolved.mode.allowAgentControl, raw.allowAgentControl)
    if (raw.section === undefined && raw.allowAgentControl === undefined) {
      assert.equal(resolved.section, '')
    }
  },
})

runProperty({
  name: 'config totality: empty objects and nullish configs take pure defaults',
  arbitrary: fc.constantFrom(undefined, null, {}),
  predicate: (raw) => {
    const resolved = resolve(/** @type {any} */ (raw))
    assert.equal(resolved.section, '')
    assert.equal(resolved.gates.requireTests, false)
    assert.equal(resolved.tests.enabled, true)
    assert.equal(resolved.review.requireReview, false)
  },
})

// ---------------------------------------------------------------------------
// Strict one-pass fixed point (F17).
// ---------------------------------------------------------------------------

runProperty({
  name: 'config fixed point: resolve(resolve(raw)) deep-equals resolve(raw) for every valid config',
  arbitrary: configArb,
  predicate: (raw) => {
    const once = resolve(raw)
    const twice = resolve(/** @type {any} */ (once))
    assert.deepEqual(twice, once, 'one pass must materialize every resolved field, including mode.promptSection')
    // A raw config that omits both `section` and `mode.promptSection` is the
    // F17 regression; one pass must already back-fill the empty prompt section.
    if (raw.section === undefined && raw.mode?.promptSection === undefined) {
      assert.equal(once.mode.promptSection, '', 'the first pass materializes the default promptSection')
      assert.equal(once.section, '', 'section mirrors the materialized promptSection')
    }
  },
})

runProperty({
  name: 'config fixed point: resolve is also stable from an empty config',
  arbitrary: fc.constant({}),
  predicate: (raw) => {
    const once = resolveTowerConfig(raw)
    assert.equal(once.section, '')
    assert.equal(once.mode.promptSection, '')
    assert.deepEqual(resolveTowerConfig(/** @type {any} */ (once)), once)
  },
})

// ---------------------------------------------------------------------------
// The 16-way `gates.requireTests` × `tests.enabled` presence table.
// ---------------------------------------------------------------------------

/** Build a config for one cell of the 16-way table. */
function combination(requireTests, enabled) {
  /** @type {Record<string, any>} */
  const config = {}
  if (requireTests !== 'absent') {
    config.gates = requireTests === 'empty' ? {} : { requireTests: requireTests === 'true' }
  }
  if (enabled !== 'absent') {
    config.tests = enabled === 'empty' ? {} : { enabled: enabled === 'true' }
  }
  return config
}

runProperty({
  name: 'config cross-field rule: exactly the 16 gates.requireTests × tests.enabled cells behave as documented',
  arbitrary: fc.constant(null),
  predicate: () => {
    const rejected = []
    const accepted = []
    for (const requireTests of /** @type {const} */ (['absent', 'empty', 'true', 'false'])) {
      for (const enabled of /** @type {const} */ (['absent', 'empty', 'true', 'false'])) {
        const config = combination(requireTests, enabled)
        const label = `requireTests=${requireTests}, tests.enabled=${enabled}`
        const shouldReject = requireTests === 'true' && enabled === 'false'
        if (shouldReject) {
          assertRejects(() => resolveTowerConfig(config), 'config-invalid', /gates\.requireTests is true/)
          rejected.push(label)
          continue
        }
        const resolved = resolve(config)
        accepted.push(label)
        assert.equal(resolved.gates.requireTests, requireTests === 'true', `${label}: requireTests default/value`)
        assert.equal(resolved.tests.enabled, enabled !== 'false', `${label}: tests.enabled default/value`)
      }
    }
    assert.equal(accepted.length, 15, '15 of the 16 presence cells must resolve')
    assert.deepEqual(rejected, ['requireTests=true, tests.enabled=false'])
  },
})

runProperty({
  name: 'config cross-field rule: the contradiction is rejected regardless of legacy aliases and other groups',
  arbitrary: fc.constant(null),
  predicate: () => {
    const base = {
      section: 'legacy prompt section',
      allowAgentControl: false,
      mode: { denyTools: ['bash'] },
      review: { requireReview: true },
    }
    assertRejects(
      () => resolveTowerConfig({ ...base, gates: { requireTests: true }, tests: { enabled: false } }),
      'config-invalid',
      /requireTests is true but test discovery is disabled/,
    )
    // Turning discovery back on satisfies the same gate requirement.
    const fixed = resolve({ ...base, gates: { requireTests: true }, tests: { enabled: true } })
    assert.equal(fixed.gates.requireTests, true)
    assert.equal(fixed.tests.enabled, true)
    // Explicit false on the gate is fine with discovery off.
    const discoveryOff = resolve({ ...base, gates: { requireTests: false }, tests: { enabled: false } })
    assert.equal(discoveryOff.tests.enabled, false)
  },
})

// ---------------------------------------------------------------------------
// Rejection totality: only non-config inputs are outside the total domain.
// ---------------------------------------------------------------------------

runProperty({
  name: 'config rejection: primitive and symbol configs are rejected with config-invalid',
  arbitrary: fc.constantFrom('config', 42, 0, true, Symbol('config')),
  predicate: (raw) => {
    assertRejects(() => resolveTowerConfig(/** @type {any} */ (raw)), 'config-invalid', /must be an object/)
  },
})

runProperty({
  name: 'config rejection: arrays are rejected (empty via config-invalid, non-empty via unknown index keys)',
  arbitrary: fc.constantFrom([], [1, 2], ['gates']),
  predicate: (raw) => {
    // `resolveTowerConfig` only type-checks `typeof raw === 'object'`, so an
    // array reaches `assertKnownKeys`: `[]` has no keys and falls through to the
    // schemastery validator (`config-invalid`), while `[1,2]` reports its index
    // keys as unknown (`config-unknown-key`). Either way the input is rejected
    // with an actionable TowerToolError; only the code varies.
    assert.throws(() => resolveTowerConfig(/** @type {any} */ (raw)), (error) => {
      assert.ok(error instanceof TowerToolError)
      assert.ok(
        error.code === 'config-invalid' || error.code === 'config-unknown-key',
        `unexpected array rejection code ${error.code}`,
      )
      return true
    })
  },
})

runProperty({
  name: 'config rejection: an unknown top-level key is rejected with config-unknown-key',
  arbitrary: fc.constantFrom('notARealKey', 'unknownGroup', 'gate', 'test', 'modes', 'sectionAlias'),
  predicate: (key) => {
    assertRejects(() => resolveTowerConfig({ [key]: {} }), 'config-unknown-key', new RegExp(key))
  },
})

runProperty({
  name: 'config rejection: an unknown nested group key is rejected with config-unknown-key',
  arbitrary: fc.constantFrom(
    ['gates', 'notAGate'],
    ['tests', 'notATest'],
    ['review', 'notAReviewOption'],
    ['spawn', 'notASpawnOption'],
    ['merge', 'notAMergeOption'],
  ),
  predicate: ([group, key]) => {
    assertRejects(() => resolveTowerConfig({ [group]: { [key]: true } }), 'config-unknown-key', new RegExp(key))
  },
})

runProperty({
  name: 'config rejection: wrong-typed known keys are rejected with config-invalid (never crash)',
  arbitrary: fc.constantFrom(
    { gates: { requireTests: 'yes' } },
    { tests: { enabled: 'no' } },
    { review: { maxRoundsPerReviewer: 'five' } },
    { spawn: { maxLiveWorkers: 0 } },
    { merge: { timeoutMs: -1 } },
    { section: 42 },
    { mode: { denyTools: 'bash' } },
  ),
  predicate: (raw) => {
    assertRejects(() => resolveTowerConfig(raw), 'config-invalid')
  },
})
