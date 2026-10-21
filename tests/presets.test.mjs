// Preset, skills and configuration surface tests (no DSH runtime required).
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'

import * as worker from '../worker.js'
import * as reviewer from '../reviewer.js'
import * as skills from '../skills.js'
import { Config, resolveTowerConfig } from '../lib/config.js'

function mockCtx() {
  const state = { allow: null, section: null, providers: [] }
  const ctx = {
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

test('preset validation fails closed before work starts (#64)', async () => {
  const { assertPresetsAvailable } = await import('../lib/presets.js')
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
