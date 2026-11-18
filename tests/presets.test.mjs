// Preset, skills and configuration surface tests (no DSH runtime required).
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'

import * as worker from '../worker.js'
import * as reviewer from '../reviewer.js'
import * as survey from '../survey.js'
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
  for (const tool of ['read', 'write', 'edit', 'pwsh', 'tower_mission', 'tower_complete', 'tower_inspect', 'skill']) {
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
  for (const allowed of ['read', 'glob', 'grep', 'tower_inspect', 'tower_inspect', 'tower_review', 'skill']) {
    assert.ok(state.allow.includes(allowed), `reviewer should allow ${allowed}`)
  }
  assert.match(state.section.text, /read-only/i)
  assert.doesNotMatch(state.section.text, /Commit your work/)
})

test('survey preset: read-only surface that can still acknowledge the inbox (#148)', () => {
  const { ctx, state } = mockCtx()
  survey.apply(ctx)
  for (const denied of ['write', 'edit', 'pwsh', 'tower_spawn', 'tower_merge', 'tower_rebase', 'tower_review']) {
    assert.equal(state.allow.includes(denied), false, `survey must not allow ${denied}`)
  }
  for (const allowed of [
    'read',
    'glob',
    'grep',
    'skill',
    'tower_mission',
    'tower_inspect',
    'tower_finding',
      'tower_inbox',
    'tower_complete',
  ]) {
    assert.ok(state.allow.includes(allowed), `survey should allow ${allowed}`)
  }
  // tower_inbox acknowledges Tower state, not a repository file, so exposing it
  // preserves the structural read-only guarantee while unblocking completion.
  assert.match(state.section.text, /tower_inbox/)
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
        // The error must name the row *and* both ways out by their user-visible
        // names: the config side and the component side are equally plausible
        // mistakes, and neither may be spelled as an internal id.
        assert.match(error.message, /Lease coordination/)
        assert.match(error.message, /plugin page/)
        assert.match(error.message, /clear the lease requirement/)
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
  // Row off: name the cause and both remedies in the plugin page's vocabulary,
  // never the internal row id or the unregistered tool (#F69).
  await assert.rejects(
    () => precheckSpawnServices({ ...base, leaseComponent: () => ({ enabled: false, reason: 'disabled by component tower-leases' }) }),
    (error) => {
      assert.equal(error.code, 'lease-busy')
      assert.match(error.message, /cannot be satisfied/)
      assert.match(error.message, /Lease coordination is switched off in the plugin page/)
      assert.match(error.message, /clear the lease requirement on the plugin configuration form/)
      assert.doesNotMatch(error.message, /spawn\.requireLease|tower_resource|tower-leases|disabled by component/)
      return true
    },
  )
  // Row on: the remedy is the lease action, still without the tool id.
  await assert.rejects(() => precheckSpawnServices({ ...base, leaseComponent: () => ({ enabled: true, reason: '' }) }), (error) => {
    assert.equal(error.code, 'lease-busy')
    assert.match(error.message, /no live lease "heavy-ci" is held/)
    assert.match(error.message, /lease action before starting an agent/)
    assert.doesNotMatch(error.message, /tower_resource|spawn\.requireLease/)
    return true
  })
  // Row off: a lease left over from when the row was on must not let the spawn
  // through — the check refuses before consulting the ledger and names the cause.
  await assert.rejects(
    () =>
      precheckSpawnServices({
        ...base,
        inspectLeases: async () => ({ leases: [{ name: 'heavy-ci', holder: 'worker-m', expired: false }] }),
        leaseComponent: () => ({ enabled: false, reason: 'disabled by component tower-leases' }),
      }),
    (error) => {
      assert.equal(error.code, 'lease-busy')
      assert.match(error.message, /cannot be satisfied/)
      assert.match(error.message, /Lease coordination is switched off in the plugin page/)
      assert.match(error.message, /clear the lease requirement on the plugin configuration form/)
      assert.doesNotMatch(error.message, /spawn\.requireLease|tower_resource|tower-leases|disabled by component/)
      return true
    },
  )
  // Row on: the ledger path is unchanged — a held lease by this actor passes.
  const held = await precheckSpawnServices({
    ...base,
    inspectLeases: async () => ({ leases: [{ name: 'heavy-ci', holder: 'worker-m', expired: false }] }),
    leaseComponent: () => ({ enabled: true, reason: '' }),
  })
  assert.equal(held.provider, 'spawn')
  // Row on, foreign holder: the holder is still named, without component noise.
  await assert.rejects(
    () =>
      precheckSpawnServices({
        ...base,
        inspectLeases: async () => ({ leases: [{ name: 'heavy-ci', holder: 'someone-else', expired: false }] }),
        leaseComponent: () => ({ enabled: true, reason: '' }),
      }),
    (error) => {
      assert.equal(error.code, 'lease-busy')
      assert.match(error.message, /held by "someone-else", not by this tower/)
      assert.doesNotMatch(error.message, /disabled by component|tower-leases/)
      return true
    },
  )
})

test('#F69: a missing preset names the visible preset row and offers both preset remedies', async () => {
  const { precheckSpawnServices } = await import('../app/spawn-prechecks.js')
  const ctxWith = (ids) => ({
    get: (name) =>
      name === 'subagents'
        ? { list: () => ['spawn'] }
        : name === 'agentPresets'
          ? { list: async () => ids.map((id) => ({ id })) }
          : undefined,
  })
  const base = {
    tower: { commonDir: '.' },
    config: { spawn: {} },
    actor: { name: 'worker-m' },
    exec: { agent: { id: 'session-1' } },
    inspectLeases: async () => ({ leases: [] }),
  }
  // The preset registry is reachable but does not list the requested preset, so
  // the precheck throw itself is what these cases exercise (#F69). The visible
  // row title must render, and the internal preset id must not.
  for (const [preset, label, available] of [
    ['tower-worker', 'Tower Worker preset', ['tower-reviewer']],
    ['tower-reviewer', 'Tower Reviewer preset', ['tower-worker']],
    ['tower-survey', 'Tower Survey preset', ['tower-worker']],
    ['tower-survey-sandbox', 'Tower Survey Sandbox preset', ['tower-worker']],
  ]) {
    await assert.rejects(
      () => precheckSpawnServices({ ...base, ctx: ctxWith(available), preset }),
      (error) => {
        assert.equal(error.code, 'preset-missing')
        assert.match(error.message, new RegExp(`the ${label} is not registered`))
        assert.match(error.nextAction, new RegExp(`switch the ${label} row back on in the plugin page and restart DSH`))
        assert.match(error.nextAction, /choose a registered preset on the plugin configuration form/)
        assert.doesNotMatch(
          `${error.message} ${error.nextAction}`,
          /tower-worker|tower-reviewer|tower-survey/,
          'a built-in preset id must never reach the operator',
        )
        return true
      },
    )
  }
  // The requested preset is registered: the branch passes and spawn continues.
  const ok = await precheckSpawnServices({ ...base, ctx: ctxWith(['tower-worker']), preset: 'tower-worker' })
  assert.equal(ok.provider, 'spawn')
})

test('#F69: a missing custom preset names the configured value and the remedy that exists', async () => {
  const { precheckSpawnServices } = await import('../app/spawn-prechecks.js')
  // A custom preset is any configured id that is not a built-in row: there is no
  // plugin-page row to switch back on, so only the configuration-form remedy is
  // truthful (#F69 review P2).
  await assert.rejects(
    () =>
      precheckSpawnServices({
        tower: { commonDir: '.' },
        ctx: {
          get: (name) =>
            name === 'subagents' ? { list: () => ['spawn'] } : name === 'agentPresets' ? { list: async () => [] } : undefined,
        },
        config: { spawn: {} },
        preset: 'my-custom-worker',
        actor: { name: 'worker-m' },
        exec: { agent: { id: 'session-1' } },
        inspectLeases: async () => ({ leases: [] }),
      }),
    (error) => {
      assert.equal(error.code, 'preset-missing')
      assert.match(error.message, /the configured preset "my-custom-worker" is not registered/)
      assert.match(error.nextAction, /choose a registered preset on the plugin configuration form/)
      assert.doesNotMatch(error.nextAction, /switch the .* row back on/, 'a custom preset has no plugin-page row')
      return true
    },
  )
})

test('preset validation fails closed before work starts (#64)', async () => {
  const { assertPresetsAvailable } = await import('../host/presets.js')
  const ctxWith = (ids) => ({ get: (name) => (name === 'agentPresets' ? { list: async () => ids.map((id) => ({ id })) } : undefined) })
  await assert.rejects(
    () => assertPresetsAvailable(ctxWith(['tower-worker']), { review: { mode: 'required' } }),
    (error) => {
      assert.equal(error.code, 'preset-missing')
      assert.match(error.message, /Tower Reviewer preset/)
      assert.match(error.message, /plugin page/)
      assert.match(error.message, /review before merging is set to required/)
      // #F79: the planning/mode-entry path passes the visible row as the next
      // step; the registry fallback never names the registered preset ids.
      assert.match(error.nextAction, /switch the Tower Reviewer preset row back on in the plugin page/)
      assert.doesNotMatch(`${error.message} ${error.nextAction}`, /tower-worker|tower-reviewer/)
      return true
    },
  )
  // #M39/#M66: the reviewer preset is required only by `review.mode:required`.
  // The 2.6 boolean alias was physically removed in 2.8.0 and is rejected by
  // config resolution before preset validation, so it is not normalized here.
  assert.deepEqual(
    await assertPresetsAvailable(ctxWith(['tower-worker']), { review: { mode: 'off' } }),
    { checked: true, missing: [] },
  )
  assert.deepEqual(
    await assertPresetsAvailable(ctxWith(['tower-worker']), { review: { mode: 'optional' } }),
    { checked: true, missing: [] },
  )
  await assert.rejects(
    () => assertPresetsAvailable(ctxWith(['tower-reviewer']), {}),
    (error) => {
      assert.match(error.message, /Tower Worker preset/)
      assert.match(error.nextAction, /switch the Tower Worker preset row back on in the plugin page/)
      assert.doesNotMatch(`${error.message} ${error.nextAction}`, /tower-worker|tower-reviewer/)
      return true
    },
  )
  assert.deepEqual(await assertPresetsAvailable(ctxWith(['tower-worker', 'tower-reviewer']), {}), { checked: true, missing: [] })
  assert.deepEqual(await assertPresetsAvailable({ get: () => undefined }, {}), { checked: false, missing: [] })
})
