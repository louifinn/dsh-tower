// Review modes A (#M39): the tri-state review policy.
//
// WHAT THIS FILE PINS
// -------------------
// `review.mode` has exactly three independent values and `review.requireReview`
// is a one-release normalized alias:
//
//   off       review is intentionally unavailable (no tower_review, reviewer
//             spawn refused, merge gate ignores review);
//   optional  review is available but never blocks a merge (default);
//   required  a clean review bound to the branch tip is a merge blocker.
//
// The matrix is exercised per mode at every seam the policy touches: config
// resolution (including the repository layer), reviewer-preset validation,
// reviewer spawn, review submission, the pure merge gate, tool registration, and
// the `tower_status` / `tower_doctor` reports. The policy must never be a
// component row; `preset-tower-reviewer` stays a capability the mode may leave
// unused.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import {
  DEFAULT_REVIEW_MODE,
  REVIEW_MODES,
  resolveReviewPolicy,
  reviewModeOf,
  reviewPolicyView,
  reviewRequired,
  reviewUnavailable,
} from '../domain/integration/review.js'
import { mergeGateBlockers } from '../domain/gate.js'
import { Config, resolveTowerConfig } from '../domain/config/schema.js'
import { configureRuntime, resolveRepoConfig } from '../host/config.js'
import { submitReview } from '../app/review.js'
import { assertSpawnableMission } from '../app/spawn-prechecks.js'
import { assertPresetsAvailable } from '../host/presets.js'
import { definedToolNames, registerTowerTools, __testResetToolSurface } from '../host/tool-registry.js'
import { __testResetComponentRegistry } from '../host/capability-registry.js'

const TIP = 'a'.repeat(40)
const OTHER_TIP = 'b'.repeat(40)

afterEach(() => {
  __testResetComponentRegistry()
  __testResetToolSurface()
  configureRuntime({})
})

// ---------------------------------------------------------------------------
// Policy resolution: default, alias, precedence, conflict.
// ---------------------------------------------------------------------------

test('review mode: the default, the alias and the deterministic precedence', () => {
  assert.deepEqual(REVIEW_MODES, ['off', 'optional', 'required'])
  assert.equal(DEFAULT_REVIEW_MODE, 'optional')

  assert.deepEqual(resolveReviewPolicy(undefined), { mode: 'optional', explicit: false, legacy: false })
  assert.deepEqual(resolveReviewPolicy({}), { mode: 'optional', explicit: false, legacy: false })
  assert.deepEqual(resolveReviewPolicy({ mode: 'off' }), { mode: 'off', explicit: true, legacy: false })
  assert.deepEqual(resolveReviewPolicy({ requireReview: true }), { mode: 'required', explicit: true, legacy: true })
  assert.deepEqual(resolveReviewPolicy({ requireReview: false }), { mode: 'optional', explicit: true, legacy: true })
  // `false` is compatible with a more specific `off`: both mean "review never
  // blocks a merge". This is what makes the resolved shape a fixed point.
  assert.equal(resolveReviewPolicy({ mode: 'off', requireReview: false }).mode, 'off')
  assert.equal(resolveReviewPolicy({ mode: 'required', requireReview: true }).mode, 'required')

  assert.equal(reviewModeOf({}), 'optional')
  assert.equal(reviewModeOf({ review: { mode: 'off' } }), 'off')
  assert.equal(reviewModeOf({ review: { requireReview: true } }), 'required')
  assert.equal(reviewModeOf({ review: { requireReview: false } }), 'optional')
  assert.equal(reviewRequired({ review: { mode: 'required' } }), true)
  assert.equal(reviewRequired({ review: { mode: 'optional' } }), false)
  assert.equal(reviewUnavailable({ review: { mode: 'off' } }), true)
  assert.equal(reviewUnavailable({ review: { mode: 'required' } }), false)
})

test('review mode: contradictory explicit values are rejected naming both keys', () => {
  for (const mode of ['off', 'optional']) {
    assert.throws(
      () => resolveReviewPolicy({ mode, requireReview: true }),
      (error) => {
        assert.equal(error.code, 'config-invalid')
        assert.match(error.message, /review\.mode/)
        assert.match(error.message, /review\.requireReview/)
        assert.match(error.message, /deprecated alias/)
        return true
      },
    )
    assert.throws(
      () => resolveTowerConfig({ review: { mode, requireReview: true } }),
      /review\.mode.*review\.requireReview/,
    )
  }
  assert.throws(() => resolveReviewPolicy({ mode: 'sometimes' }), /review\.mode must be one of off\|optional\|required/)
  assert.throws(() => resolveTowerConfig({ review: { mode: 'sometimes' } }), (error) => {
    assert.equal(error.code, 'config-invalid')
    return true
  })
  assert.throws(() => resolveReviewPolicy({ requireReview: 'yes' }), /review\.requireReview must be a boolean/)
})

// ---------------------------------------------------------------------------
// Resolved config: the mirror invariant and the fixed point.
// ---------------------------------------------------------------------------

test('review config: resolution materializes the mode and a consistent alias fixed point', () => {
  const cases = [
    [{}, 'optional', false],
    [{ review: {} }, 'optional', false],
    [{ review: { mode: 'off' } }, 'off', false],
    [{ review: { mode: 'optional' } }, 'optional', false],
    [{ review: { mode: 'required' } }, 'required', true],
    [{ review: { requireReview: true } }, 'required', true],
    [{ review: { requireReview: false } }, 'optional', false],
    [{ review: { mode: 'off', requireReview: false } }, 'off', false],
  ]
  for (const [raw, mode, alias] of cases) {
    const resolved = resolveTowerConfig(raw)
    assert.equal(resolved.review.mode, mode, JSON.stringify(raw))
    assert.equal(resolved.review.requireReview, alias, JSON.stringify(raw))
    assert.deepEqual(resolveTowerConfig(resolved), resolved, `one pass is a fixed point: ${JSON.stringify(raw)}`)
  }
  // The schema accepts the canonical key. It deliberately does not materialize a
  // default `mode`: Cordis may resolve the schema before `apply()`, and a
  // materialized `mode:'optional'` would look like a user contradiction next to
  // a legacy `requireReview:true`. The resolver applies the default instead.
  assert.equal(Config({ review: { mode: 'off' } }).review.mode, 'off')
  assert.equal(Config({}).review.mode, undefined)
  assert.equal(Config({}).review.requireReview, false)
  assert.equal(resolveTowerConfig(Config({})).review.mode, 'optional')
  // Legacy upgrade through a schema-materialized config: `Config()` fills the
  // deprecated boolean's default, but the alias must still decide the mode.
  assert.equal(resolveTowerConfig(Config({ review: { requireReview: true } })).review.mode, 'required')
  assert.equal(resolveTowerConfig(Config({ review: { requireReview: false } })).review.mode, 'optional')
  // A key one level down is still checked against the review group.
  assert.throws(() => resolveTowerConfig({ review: { require_review: true } }), /config-unknown-key|review\.require_review/)
})

test('review config: Cordis-materialized shapes resolve without a false contradiction', () => {
  // #M39 review R44: Cordis resolves the schema before `apply()`, so a profile
  // that wrote only `review.mode:'required'` reaches the resolver as
  // `required` + the deprecated boolean's materialized default `false`. That
  // mirrored `false` is not a user contradiction: the mode is the specific
  // policy and `false` never overrides it.
  const cordisRequired = Config({ review: { mode: 'required' } })
  assert.equal(cordisRequired.review.mode, 'required')
  assert.equal(cordisRequired.review.requireReview, false, 'Config materializes the deprecated default')
  const resolvedRequired = resolveTowerConfig(cordisRequired)
  assert.equal(resolvedRequired.review.mode, 'required', 'mode wins over the materialized false')
  assert.equal(resolvedRequired.review.requireReview, true, 'the resolved alias mirrors the mode')
  assert.deepEqual(resolveTowerConfig(resolvedRequired), resolvedRequired)

  // The same holds for `off`: the materialized false is compatible, not a
  // conflict, and the fixed point keeps the more specific mode.
  const cordisOff = Config({ review: { mode: 'off' } })
  assert.equal(cordisOff.review.requireReview, false)
  assert.equal(resolveTowerConfig(cordisOff).review.mode, 'off')

  // An explicit `false` next to `required` is accepted too, with `required`
  // winning; the mode is the specific policy, not the boolean.
  const explicit = Config({ review: { mode: 'required', requireReview: false } })
  assert.equal(explicit.review.requireReview, false, 'explicit false is preserved by the schema')
  const resolvedExplicit = resolveTowerConfig(explicit)
  assert.equal(resolvedExplicit.review.mode, 'required')
  assert.equal(resolvedExplicit.review.requireReview, true)
  assert.equal(resolveTowerConfig({ review: { mode: 'required', requireReview: false } }).review.mode, 'required')
})

// ---------------------------------------------------------------------------
// Repository layer: resolved per layer, never by merging two resolved shapes.
// ---------------------------------------------------------------------------

function makeCommonDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-review-modes-'))
  const commonDir = path.join(root, '.git')
  fs.mkdirSync(commonDir, { recursive: true })
  return { root, commonDir }
}

function writeRepoConfig(commonDir, value) {
  const file = path.join(commonDir, 'dsh-tower', 'config.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

test('review config: a repository layer overrides as a whole and cannot re-enable a profile-off tool', async () => {
  const { root, commonDir } = makeCommonDir()
  try {
    configureRuntime({})
    writeRepoConfig(commonDir, { review: { requireReview: true } })
    assert.equal((await resolveRepoConfig({ commonDir })).review.mode, 'required')

    configureRuntime({ review: { mode: 'required' } })
    writeRepoConfig(commonDir, { review: { mode: 'off' } })
    const relaxed = await resolveRepoConfig({ commonDir })
    assert.equal(relaxed.review.mode, 'off')
    assert.equal(relaxed.review.requireReview, false)

    // The profile owns the mounted tool surface: a repository may relax review
    // but cannot raise a mode whose tool was never registered.
    configureRuntime({ review: { mode: 'off' } })
    writeRepoConfig(commonDir, { review: { mode: 'required' } })
    await assert.rejects(
      () => resolveRepoConfig({ commonDir }),
      (error) => {
        assert.equal(error.code, 'config-invalid')
        assert.match(error.message, /tower_review is not registered/)
        assert.match(error.message, /review\.mode/)
        return true
      },
    )

    // A contradictory layer is rejected at read time, before any merge.
    configureRuntime({})
    writeRepoConfig(commonDir, { review: { mode: 'off', requireReview: true } })
    await assert.rejects(() => resolveRepoConfig({ commonDir }), /review\.mode.*review\.requireReview/)
  } finally {
    removeTemp(root)
  }
})

// ---------------------------------------------------------------------------
// The pure merge gate matrix.
// ---------------------------------------------------------------------------

const MISSION = { id: 'M1', reviewPolicy: 'required-clean', status: 'completed', tasks: [], blockers: [] }

function mergeCodes(config, overrides = {}) {
  return mergeGateBlockers({
    mission: MISSION,
    branch: 'tower/m1',
    branchTip: TIP,
    config,
    ...overrides,
  }).map((blocker) => blocker.code)
}

const CLEAN_REVIEW = {
  missionId: 'M1',
  branch: 'tower/m1',
  round: 1,
  status: 'clean',
  mergeVerdict: 'merge',
  reviewedCommit: TIP,
}

test('review gate: only required produces review blockers; off and optional skip them', () => {
  const configs = {
    off: { review: { mode: 'off' } },
    optional: { review: { mode: 'optional' } },
    required: { review: { mode: 'required' } },
  }
  // No review at all.
  assert.deepEqual(mergeCodes(configs.required), ['no-review'])
  assert.deepEqual(mergeCodes(configs.optional), [])
  assert.deepEqual(mergeCodes(configs.off), [])
  // A clean review bound to the tip is green in every mode.
  for (const mode of REVIEW_MODES) assert.deepEqual(mergeCodes(configs[mode], { review: CLEAN_REVIEW }), [])
  // A moved tip only blocks when required.
  assert.deepEqual(mergeCodes(configs.required, { review: { ...CLEAN_REVIEW, reviewedCommit: OTHER_TIP } }), ['tip-moved'])
  assert.deepEqual(mergeCodes(configs.optional, { review: { ...CLEAN_REVIEW, reviewedCommit: OTHER_TIP } }), [])
  assert.deepEqual(mergeCodes(configs.off, { review: { ...CLEAN_REVIEW, reviewedCommit: OTHER_TIP } }), [])
  // A non-clean review only blocks when required.
  const p1 = { ...CLEAN_REVIEW, status: 'p1-1items', mergeVerdict: 'fix-then-merge' }
  assert.deepEqual(mergeCodes(configs.required, { review: p1 }), ['not-clean'])
  assert.deepEqual(mergeCodes(configs.optional, { review: p1 }), [])
  assert.deepEqual(mergeCodes(configs.off, { review: p1 }), [])
})

test('review gate: review-exemption-invalid exists only in required and names the review target', () => {
  const exempt = { ...MISSION, reviewPolicy: 'none', reviewExemptionReason: 'docs only' }
  const required = { review: { mode: 'required' } }
  const codes = mergeGateBlockers({ mission: exempt, branch: 'b', branchTip: TIP, config: required }).map((b) => b.code)
  assert.deepEqual(codes, ['review-exemption-invalid', 'no-review'])
  for (const config of [{ review: { mode: 'optional' } }, { review: { mode: 'off' } }]) {
    assert.deepEqual(mergeGateBlockers({ mission: exempt, branch: 'b', branchTip: TIP, config }), [])
  }
  const allowed = mergeGateBlockers({
    mission: exempt,
    branch: 'b',
    branchTip: TIP,
    config: { review: { mode: 'required' }, gates: { allowReviewExemption: true } },
  })
  assert.deepEqual(allowed, [])
})

// ---------------------------------------------------------------------------
// Review submission, reviewer spawn, preset validation.
// ---------------------------------------------------------------------------

test('review submission: off refuses before any state read', async () => {
  await assert.rejects(
    () => submitReview({ config: { review: { mode: 'off' } } }, { missionId: 'M1' }),
    (error) => {
      assert.equal(error.code, 'review-disabled')
      assert.match(error.message, /review\.mode is off/)
      assert.match(String(error.nextAction), /review\.mode/)
      return true
    },
  )
})

test('reviewer spawn and preset validation: off refuses, optional/required allow', async () => {
  const context = { mission: { id: 'M1', status: 'completed', worktree: { path: 'x', branch: 'b' } } }
  assert.throws(
    () => assertSpawnableMission({ role: 'reviewer', context, config: { review: { mode: 'off' } } }),
    (error) => {
      assert.equal(error.code, 'review-disabled')
      assert.match(error.message, /review\.mode is off/)
      assert.match(String(error.nextAction), /review\.mode/)
      return true
    },
  )
  for (const mode of ['optional', 'required']) {
    assert.doesNotThrow(() => assertSpawnableMission({ role: 'reviewer', context, config: { review: { mode } } }))
  }
  assert.doesNotThrow(() => assertSpawnableMission({ role: 'worker', context, config: { review: { mode: 'off' } } }))

  const ctxWith = (ids) => ({ get: (name) => (name === 'agentPresets' ? { list: async () => ids.map((id) => ({ id })) } : undefined) })
  assert.deepEqual(
    await assertPresetsAvailable(ctxWith(['tower-worker']), { review: { mode: 'off' } }),
    { checked: true, missing: [] },
  )
  assert.deepEqual(
    await assertPresetsAvailable(ctxWith(['tower-worker']), { review: { mode: 'optional' } }),
    { checked: true, missing: [] },
  )
  await assert.rejects(
    () => assertPresetsAvailable(ctxWith(['tower-worker']), { review: { mode: 'required' } }),
    /review\.mode is required/,
  )
})

// ---------------------------------------------------------------------------
// Tool surface registration.
// ---------------------------------------------------------------------------

function surfaceCtx() {
  const tools = new Map()
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get() {
      return undefined
    },
    emit() {},
    provide() {},
    inject(_deps, callback) {
      callback(ctx)
    },
    on() {
      return () => {}
    },
    tools: { register: (definition) => (tools.set(definition.name, definition), () => {}), guard: () => () => {}, restrict() {} },
    systemPrompt: { section() {} },
  }
  return { ctx, tools }
}

test('review tool surface: off unregisters tower_review but the build surface still counts it', () => {
  configureRuntime({ review: { mode: 'off' } })
  __testResetToolSurface()
  const off = surfaceCtx()
  registerTowerTools(off.ctx)
  assert.equal(off.tools.has('tower_review'), false, 'review.mode:off must not register tower_review')
  assert.ok(definedToolNames().includes('tower_review'), 'the build surface still counts tower_review')

  configureRuntime({ review: { mode: 'optional' } })
  __testResetToolSurface()
  const optional = surfaceCtx()
  registerTowerTools(optional.ctx)
  assert.equal(optional.tools.has('tower_review'), true, 'review.mode:optional keeps tower_review')

  configureRuntime({ review: { mode: 'required' } })
  __testResetToolSurface()
  const required = surfaceCtx()
  registerTowerTools(required.ctx)
  assert.equal(required.tools.has('tower_review'), true, 'review.mode:required keeps tower_review')
})

// ---------------------------------------------------------------------------
// End-to-end status/doctor/preflight/merge on a real repository.
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-review-modes-e2e-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo }
}

function makeCtx() {
  const tools = new Map()
  let seq = 0
  const subagents = {
    list: () => ['spawn'],
    startActivation: async () => {
      seq += 1
      const childId = `child-${seq}`
      return {
        childId,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }], diagnostic: null }),
      }
    },
    sendMessage: async () => {},
    listDescendants: async () => [],
    interrupt: () => {},
  }
  const agentPresets = { list: async () => [{ id: 'tower-worker' }, { id: 'tower-reviewer' }] }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'subagents') return subagents
      if (name === 'agentPresets') return agentPresets
      return undefined
    },
    emit() {},
    tools: { register: (definition) => (tools.set(definition.name, definition), () => {}), guard: () => () => {}, restrict() {} },
    systemPrompt: { section() {} },
    inject(_deps, callback) {
      callback(ctx)
    },
  }
  return { ctx, tools }
}

const towerExec = { agent: { id: 'tower-agent' } }
const call = (tools, name, args, exec = towerExec) => tools.get(name).execute(args, exec)

test('review modes end to end: status, doctor, reviewer spawn, preflight and merge', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  configureRuntime({})
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', { repoRoot: repo, missions: [{ title: 'M one', scope: ['src/**'] }] })
    const missionId = planned.missions[0].id
    const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    fs.mkdirSync(path.join(spawned.worktree.path, 'src'), { recursive: true })
    fs.writeFileSync(path.join(spawned.worktree.path, 'src', 'a.txt'), 'a\n')
    git(spawned.worktree.path, ['add', '-A'])
    git(spawned.worktree.path, ['commit', '-m', 'work'])
    const workerExec = { agent: { id: spawned.agentId } }
    await call(tools, 'tower_complete', { repoRoot: repo, missionId, report: 'done' }, workerExec)

    // required: the review gate is on, and status/doctor say so.
    writeRepoConfig(path.join(repo, '.git'), { review: { mode: 'required' } })
    const requiredStatus = await call(tools, 'tower_status', { repoRoot: repo })
    assert.equal(requiredStatus.review.mode, 'required')
    assert.equal(requiredStatus.review.required, true)
    assert.equal(requiredStatus.review.available, true)
    const requiredDoctor = await call(tools, 'tower_doctor', { repoRoot: repo })
    assert.equal(requiredDoctor.review.mode, 'required')
    const reviewCheck = requiredDoctor.checks.find((check) => check.id === 'review')
    assert.equal(reviewCheck.status, 'pass')
    assert.match(reviewCheck.detail, /review\.mode:required/)
    assert.match(reviewCheck.detail, /merge blocker/)
    const requiredPreflight = await call(tools, 'tower_preflight', { repoRoot: repo, missionId })
    assert.ok(requiredPreflight.blockers.some((blocker) => blocker.code === 'no-review'), JSON.stringify(requiredPreflight.blockers))

    // optional: review is recorded but never blocks.
    writeRepoConfig(path.join(repo, '.git'), { review: { mode: 'optional' } })
    const optionalStatus = await call(tools, 'tower_status', { repoRoot: repo })
    assert.equal(optionalStatus.review.mode, 'optional')
    assert.equal(optionalStatus.review.required, false)
    const optionalDoctor = await call(tools, 'tower_doctor', { repoRoot: repo })
    assert.match(optionalDoctor.checks.find((check) => check.id === 'review').detail, /review\.mode:optional/)
    const optionalPreflight = await call(tools, 'tower_preflight', { repoRoot: repo, missionId })
    assert.equal(optionalPreflight.blockers.some((blocker) => blocker.code === 'no-review'), false)

    // off: review is intentionally unavailable — no reviewer spawn, no blocker,
    // and the merge itself succeeds without a review. The profile here is
    // default/optional, so `tower_review` IS registered: a repository-level off
    // refuses the submission instead of unregistering the profile-owned tool.
    writeRepoConfig(path.join(repo, '.git'), { review: { mode: 'off' } })
    const offStatus = await call(tools, 'tower_status', { repoRoot: repo })
    assert.equal(offStatus.review.mode, 'off')
    assert.equal(offStatus.review.available, false)
    assert.match(offStatus.review.detail, /intentionally unavailable/)
    assert.match(offStatus.review.detail, /recording a review is refused/)
    assert.match(offStatus.review.detail, /a profile-level off does not register tower_review/)
    assert.equal(tools.has('tower_review'), true, 'a repository-level off cannot unregister the profile-owned tool')
    await assert.rejects(
      () =>
        call(tools, 'tower_review', {
          repoRoot: repo,
          missionId,
          status: 'clean',
          merge: 'merge',
          findings: 'none',
          decision: 'ok',
          breakGlassReason: 'repo-level off e2e',
        }),
      (error) => {
        assert.equal(error.code, 'review-disabled')
        assert.match(String(error.message), /review\.mode is off/)
        return true
      },
    )
    const offDoctor = await call(tools, 'tower_doctor', { repoRoot: repo })
    assert.equal(offDoctor.review.mode, 'off')
    const offCheck = offDoctor.checks.find((check) => check.id === 'review')
    assert.equal(offCheck.status, 'pass', 'off is a supported posture, not a degradation')
    assert.match(offCheck.detail, /intentionally unavailable/)
    await assert.rejects(
      () => call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'reviewer' }),
      (error) => {
        assert.equal(error.code, 'review-disabled')
        assert.match(String(error.nextAction), /review\.mode/)
        return true
      },
    )
    const offPreflight = await call(tools, 'tower_preflight', { repoRoot: repo, missionId })
    assert.equal(offPreflight.blockers.some((blocker) => blocker.code === 'no-review'), false)
    const merged = await call(tools, 'tower_merge', { repoRoot: repo, missionId })
    assert.equal(merged.ok, true, JSON.stringify(merged.blockers))
    assert.ok(merged.mergedCommit)

    // Profile-level off is the other registration state: a fresh mount has no
    // tower_review at all, and the shared detail sentence is still accurate.
    configureRuntime({ review: { mode: 'off' } })
    __testResetToolSurface()
    const profileOff = makeCtx()
    registerTowerTools(profileOff.ctx)
    assert.equal(profileOff.tools.has('tower_review'), false, 'a profile-level off never registers tower_review')
    const profileOffStatus = await call(profileOff.tools, 'tower_status', { repoRoot: repo })
    assert.equal(profileOffStatus.review.mode, 'off')
    assert.match(profileOffStatus.review.detail, /a profile-level off does not register tower_review/)
  } finally {
    removeTemp(root)
  }
})
