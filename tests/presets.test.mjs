// Preset, skills and configuration surface tests (no DSH runtime required).
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'

import * as worker from '../worker.js'
import * as reviewer from '../reviewer.js'
import * as skills from '../skills.js'
import { Config, resolveTowerConfig } from '../host/config.js'

function mockCtx() {
  const state = { allow: null, section: null, providers: [] }
  const ctx = {
    // #139: skills.registerProvider is wrapped in ctx.effect, the same contract the
    // plugin host uses for every registration.
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    tools: {
      restrict(options) {
        state.allow = options.allow
      },
    },
    systemPrompt: {
      section(definition) {
        state.section = definition
      },
    },
    skills: {
      registerProvider(factory) {
        state.providers.push(factory())
        return () => {}
      },
    },
  }
  return { ctx, state }
}

test('worker preset: writable mission surface without review', () => {
  const { ctx, state } = mockCtx()
  worker.apply(ctx)
  for (const tool of ['read', 'write', 'edit', 'pwsh', 'tower_mission', 'tower_complete', 'tower_diff', 'skill']) {
    assert.ok(state.allow.includes(tool), `worker should allow ${tool}`)
  }
  assert.equal(state.allow.includes('tower_review'), false, 'workers must not review their own work')
  assert.match(state.section.text, /Tower worker/)
})

test('reviewer preset: read-only surface with diff and review', () => {
  const { ctx, state } = mockCtx()
  reviewer.apply(ctx)
  for (const denied of ['write', 'edit', 'pwsh', 'tower_mission', 'tower_complete']) {
    assert.equal(state.allow.includes(denied), false, `reviewer must not allow ${denied}`)
  }
  for (const allowed of ['read', 'glob', 'grep', 'tower_diff', 'tower_status', 'tower_review', 'skill']) {
    assert.ok(state.allow.includes(allowed), `reviewer should allow ${allowed}`)
  }
  assert.match(state.section.text, /read-only/i)
  assert.doesNotMatch(state.section.text, /Commit your work/)
})

test('bundled skills: three Tower skills are discoverable and loadable', async () => {
  const { ctx, state } = mockCtx()
  skills.apply(ctx)
  assert.equal(state.providers.length, 1)
  const provider = state.providers[0]
  const candidates = await provider.list()
  assert.deepEqual(
    candidates.map((candidate) => candidate.name).sort(),
    ['tower-recovery', 'tower-review', 'tower-worker-protocol'],
  )
  for (const candidate of candidates) {
    const definition = await provider.get(candidate)
    assert.equal(definition.name, candidate.name)
    assert.ok(definition.content.length > 100)
  }
})

test('config: defaults, legacy aliases and unknown-key rejection', () => {
  assert.ok(Config)
  const defaults = resolveTowerConfig({})
  assert.equal(defaults.mode.maxEntries, 200)
  assert.equal(defaults.review.maxRoundsPerReviewer, 5)
  assert.equal(defaults.merge.timeoutMs, 900000)
  assert.equal(defaults.spawn.workerPreset, 'tower-worker')
  assert.equal(defaults.spawn.reviewerPreset, 'tower-reviewer')

  const legacy = resolveTowerConfig({ section: 'custom', allowAgentControl: true })
  assert.equal(legacy.section, 'custom')
  assert.equal(legacy.mode.promptSection, 'custom')
  assert.equal(legacy.mode.allowAgentControl, true)

  const nested = resolveTowerConfig({ review: { maxRoundsPerReviewer: 2 }, spawn: { maxDepth: 2 } })
  assert.equal(nested.review.maxRoundsPerReviewer, 2)
  assert.equal(nested.spawn.maxDepth, 2)

  // Canonical keys win over the legacy aliases when both are present.
  const both = resolveTowerConfig({
    section: 'legacy text',
    allowAgentControl: true,
    mode: { promptSection: 'canonical text', allowAgentControl: false },
  })
  assert.equal(both.section, 'canonical text')
  assert.equal(both.mode.promptSection, 'canonical text')
  assert.equal(both.mode.allowAgentControl, false)

  assert.throws(() => resolveTowerConfig({ allowAgentToggle: true }), /unknown key/i)
})

test('#131: spawn.requireLease with the tower-leases row off is refused at runtime preconditions', async () => {
  const { assertRuntimePreconditions } = await import('../host/presets.js')
  const { __testResetComponentRegistry, registerComponent } = await import('../host/capability-registry.js')
  const ctx = { get: () => undefined }
  __testResetComponentRegistry()
  try {
    await assert.rejects(
      () => assertRuntimePreconditions(ctx, { spawn: { requireLease: 'heavy-ci' } }),
      (error) => {
        assert.equal(error.code, 'config-invalid')
        // The error must name the row *and* both ways out: the config side and the
        // component side are equally plausible mistakes.
        assert.match(error.message, /tower-leases/)
        assert.match(error.message, /tower_resource is not registered/)
        assert.match(error.message, /Re-enable the tower-leases component or clear spawn\.requireLease/)
        return true
      },
    )
    // Remedy 1: mount the row.
    registerComponent('tower-leases')
    await assertRuntimePreconditions(ctx, { spawn: { requireLease: 'heavy-ci' } })
    // Remedy 2: clear the key.
    __testResetComponentRegistry()
    await assertRuntimePreconditions(ctx, { spawn: { requireLease: '' } })
    await assertRuntimePreconditions(ctx, {})
    // The invariant is scoped to its own row: a different row off is irrelevant.
    registerComponent('tower-leases')
    registerComponent('tower-tests')
    await assertRuntimePreconditions(ctx, { spawn: { requireLease: 'heavy-ci' } })
  } finally {
    __testResetComponentRegistry()
  }
})

test('#131: a missing lease names the disabled row instead of advising an unregistered tool', async () => {
  const { precheckSpawnServices } = await import('../app/spawn-prechecks.js')
  const base = {
    tower: { commonDir: '.' },
    ctx: { get: (name) => (name === 'subagents' ? { list: () => ['spawn'] } : undefined) },
    config: { spawn: { requireLease: 'heavy-ci' } },
    preset: 'tower-worker',
    actor: { name: 'worker-m' },
    exec: { agent: { id: 'session-1' } },
    inspectLeases: async () => ({ leases: [] }),
  }
  // Row off: name the cause and both remedies, never "acquire it with tower_resource".
  await assert.rejects(
    () => precheckSpawnServices({ ...base, leaseComponent: () => ({ enabled: false, reason: 'disabled by component tower-leases' }) }),
    (error) => {
      assert.equal(error.code, 'lease-busy')
      assert.match(error.message, /disabled by component tower-leases/)
      assert.match(error.message, /re-enable the tower-leases row or clear spawn\.requireLease/)
      assert.doesNotMatch(error.message, /acquire it with tower_resource/)
      return true
    },
  )
  // Row on: the original advice is still correct and still offered.
  await assert.rejects(() => precheckSpawnServices({ ...base, leaseComponent: () => ({ enabled: true, reason: '' }) }), (error) => {
    assert.equal(error.code, 'lease-busy')
    assert.match(error.message, /acquire it with tower_resource before spawning/)
    return true
  })
  // Holder mismatch reports the holder; with the row off it also names the cause.
  await assert.rejects(
    () =>
      precheckSpawnServices({
        ...base,
        inspectLeases: async () => ({ leases: [{ name: 'heavy-ci', holder: 'someone-else', expired: false }] }),
        leaseComponent: () => ({ enabled: false, reason: 'disabled by component tower-leases' }),
      }),
    (error) => {
      assert.equal(error.code, 'lease-busy')
      assert.match(error.message, /held by "someone-else"/)
      assert.match(error.message, /disabled by component tower-leases/)
      return true
    },
  )
  // A held lease needs no component at all: the probe is not consulted.
  const held = await precheckSpawnServices({
    ...base,
    inspectLeases: async () => ({ leases: [{ name: 'heavy-ci', holder: 'worker-m', expired: false }] }),
  })
  assert.equal(held.provider, 'spawn')
})

test('preset validation fails closed before work starts (#64)', async () => {
  const { assertPresetsAvailable } = await import('../host/presets.js')
  const ctxWith = (ids) => ({ get: (name) => (name === 'agentPresets' ? { list: async () => ids.map((id) => ({ id })) } : undefined) })
  await assert.rejects(
    () => assertPresetsAvailable(ctxWith(['tower-worker']), { review: { requireReview: true } }),
    (error) => {
      assert.equal(error.code, 'preset-missing')
      assert.match(error.message, /tower-reviewer/)
      assert.match(error.message, /preset-tower-reviewer/)
      return true
    },
  )
  await assert.rejects(() => assertPresetsAvailable(ctxWith(['tower-reviewer']), {}), /preset-tower-worker/)
  assert.deepEqual(await assertPresetsAvailable(ctxWith(['tower-worker', 'tower-reviewer']), {}), { checked: true, missing: [] })
  assert.deepEqual(await assertPresetsAvailable({ get: () => undefined }, {}), { checked: false, missing: [] })
})
