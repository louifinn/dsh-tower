// Property coverage for the W5 split boundaries (#M76, W5-B).
//
// The invariants here are natural properties, not restatements of examples:
// the stable facade must re-export exactly the same bindings as the modules it
// fronts (one home each), the tool/component accounting must be a set
// regardless of registration order or duplicates, and the pure rotation plan
// must retain an ordered suffix of the log without ever keeping more segments
// than the configured retention.
//
// Run with: node --test tests/property/boundaries.prop.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { runProperty } from './helpers/harness.mjs'
import * as registry from '../../host/tool-registry.js'
import * as runtime from '../../host/tool-runtime.js'
import * as capabilities from '../../host/tool-capabilities.js'
import {
  COMPONENT_TOOLS,
  TOWER_COMPONENT_IDS,
  __testResetComponentRegistry,
  componentEnabled,
  disabledReason,
  registerComponent,
  unregisterComponent,
} from '../../host/capability-registry.js'
import {
  activityRotationPlan,
  activitySegmentPath,
  shouldRotateActivity,
} from '../../adapters/persistence.js'

const FACADE_NAMES = [
  '__testResetToolSurface',
  '__testSpawnBackoff',
  'authorizeSessionCall',
  'definedToolCount',
  'definedToolNames',
  'OPERATIONAL_TOOLS',
  'recordToolRegistration',
  'registerAllCapabilities',
  'registerBatchCapability',
  'registerCoreTowerTools',
  'registerHmrCapability',
  'registerImportCapability',
  'registerLeasesCapability',
  'registerTestsCapability',
  'registerTowerTools',
]

/** Parse the `.<n>` suffix a rotation plan uses. */
function planIndex(target) {
  return Number(target.slice(target.lastIndexOf('.') + 1))
}

runProperty({
  name: 'the tool registry facade re-exports each module binding from exactly one home',
  arbitrary: fc.constantFrom(...FACADE_NAMES),
  predicate: (name) => {
    const fromRuntime = runtime[name]
    const fromCapabilities = capabilities[name]
    assert.ok(
      (fromRuntime === undefined) !== (fromCapabilities === undefined),
      `${name} must be owned by exactly one split module`,
    )
    assert.equal(
      registry[name],
      fromRuntime === undefined ? fromCapabilities : fromRuntime,
      `${name} must be the same binding through the facade`,
    )
  },
  examples: FACADE_NAMES.map((name) => [name]),
})

runProperty({
  name: 'tool registration accounting is a sorted, idempotent set independent of order',
  arbitrary: fc.array(fc.string({ minLength: 1, maxLength: 24 }), { maxLength: 16 }),
  predicate: (names) => {
    runtime.__testResetToolSurface()
    try {
      const expected = new Set()
      for (const raw of names) {
        if (raw.trim().length === 0) {
          assert.throws(() => runtime.recordToolRegistration(raw), TypeError)
          continue
        }
        runtime.recordToolRegistration(raw)
        // A redelivery must not inflate the surface.
        runtime.recordToolRegistration(raw)
        expected.add(raw.trim())
      }
      assert.deepEqual(runtime.definedToolNames(), [...expected].sort())
      assert.equal(runtime.definedToolCount(), expected.size)
    } finally {
      runtime.__testResetToolSurface()
    }
  },
})

runProperty({
  name: 'component enablement is a reference count and the row order is frozen',
  arbitrary: fc.array(fc.constantFrom(...TOWER_COMPONENT_IDS), { maxLength: 20 }),
  predicate: (registrations) => {
    __testResetComponentRegistry()
    try {
      const counts = new Map()
      for (const id of registrations) {
        registerComponent(id)
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
      for (const id of TOWER_COMPONENT_IDS) {
        assert.equal(componentEnabled(id), (counts.get(id) ?? 0) > 0, `${id} enablement follows its count`)
      }
      for (let index = 0; index < registrations.length; index += 1) {
        unregisterComponent(registrations[index])
      }
      for (const id of TOWER_COMPONENT_IDS) assert.equal(componentEnabled(id), false)
      assert.equal(disabledReason('tower-batch'), 'disabled by component tower-batch')
    } finally {
      __testResetComponentRegistry()
    }
  },
})

test('the component registry contract is frozen in cordis order', () => {
  assert.deepEqual(Object.keys(COMPONENT_TOOLS), TOWER_COMPONENT_IDS)
  for (const id of TOWER_COMPONENT_IDS) {
    assert.ok(Array.isArray(COMPONENT_TOOLS[id]), `${id} owns a tool list`)
    assert.ok(Object.isFrozen(COMPONENT_TOOLS[id]), `${id}'s tool list is frozen`)
  }
  assert.throws(() => registerComponent('not-a-component'), TypeError)
  assert.throws(() => registerComponent(''), TypeError)
})

runProperty({
  name: 'rotation keeps an ordered suffix within the configured segment budget',
  arbitrary: fc.record({
    sizes: fc.array(fc.integer({ min: 1, max: 200 }), { maxLength: 30 }),
    maxBytes: fc.integer({ min: 1, max: 200 }),
    // One entry per rotation, then the last entry stays in force. A second
    // entry lower than the first models an operator lowering activity.retention
    // (4 -> 2) after segments already exist.
    retentions: fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 6 }),
  }),
  examples: [
    // Build `.1`..`.3` at retention 4, then lower to 2: the next rotation must
    // prune the higher segments instead of keeping them past the cap.
    [{ sizes: Array.from({ length: 12 }, () => 120), maxBytes: 100, retentions: [4, 4, 4, 2] }],
    // A wide window first, then the minimum retention: every stale index goes.
    [{ sizes: Array.from({ length: 12 }, () => 120), maxBytes: 100, retentions: [5, 5, 5, 5, 5, 1] }],
  ],
  predicate: ({ sizes, maxBytes, retentions }) => {
    const segments = new Map()
    let live = []
    let rotation = 0
    let retention = retentions[0]
    for (let index = 0; index < sizes.length; index += 1) {
      const line = { bytes: sizes[index], id: index }
      const liveBytes = live.reduce((total, entry) => total + entry.bytes, 0)
      if (shouldRotateActivity(liveBytes, line.bytes, maxBytes)) {
        retention = retentions[Math.min(rotation, retentions.length - 1)]
        rotation += 1
        const plan = activityRotationPlan('activity.jsonl', retention)
        for (const target of plan.remove) segments.delete(planIndex(target))
        for (const move of plan.moves) {
          const from = planIndex(move.from)
          const to = planIndex(move.to)
          segments.delete(to)
          if (segments.has(from)) {
            segments.set(to, segments.get(from))
            segments.delete(from)
          }
        }
        segments.set(planIndex(plan.liveTo), live)
        live = []
        // The plan prunes the whole window above retention, so even a lowered
        // retention leaves no segment outside the window after the rotation.
        for (const segmentIndex of segments.keys()) {
          assert.ok(
            segmentIndex >= 1 && segmentIndex <= retention,
            `rotation at retention ${retention} left segment ${segmentIndex} outside the window`,
          )
        }
      }
      live.push(line)
    }

    const ordered = []
    for (let index = retention; index >= 1; index -= 1) {
      if (segments.has(index)) ordered.push(...segments.get(index))
    }
    ordered.push(...live)
    const expected = sizes.slice(-ordered.length).map((bytes, offset) => ({
      bytes,
      id: sizes.length - ordered.length + offset,
    }))
    assert.deepEqual(ordered, expected, 'retained lines are the chronological suffix of the input')
    assert.ok(segments.size <= retention, 'never keep more segments than retention')
    for (const index of segments.keys()) {
      assert.ok(index >= 1 && index <= retention, `segment ${index} is inside the retention window`)
    }
    // Every segment is bounded by the cap unless it is a single oversized line,
    // which cannot be split without losing a line.
    const maxLine = sizes.length > 0 ? Math.max(...sizes) : 0
    for (const [index, lines] of segments) {
      const bytes = lines.reduce((total, entry) => total + entry.bytes, 0)
      assert.ok(
        bytes <= Math.max(maxBytes, maxLine),
        `segment ${index} (${bytes} B) exceeds the larger of maxBytes and the largest line`,
      )
    }
    // Read order is the order the pure plan exposes: highest segment index first.
    for (let index = retention; index > 1; index -= 1) {
      assert.equal(activitySegmentPath('activity.jsonl', index), `activity.jsonl.${index}`)
    }
  },
  classify: ({ sizes, maxBytes }) => (sizes.some((size) => size > maxBytes) ? 'oversized-line' : 'bounded-line'),
})
