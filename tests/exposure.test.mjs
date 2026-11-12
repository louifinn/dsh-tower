// Exposure gates (#164 stage 5): the four properties (subtraction, liveness,
// monotonicity, stability), the "no implicit all" table check and the gate's
// own behavior, checked exhaustively over the shape registry's transition
// tables and the shipped tool surface rather than by sampling.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPOSURE_TABLE,
  PRESET_ALLOWS,
  SESSION_PHASES,
  TOWER_PRESET_IDS,
  TRANSITION_TOOLS,
  exposedNames,
  exposes,
  phaseOfFacts,
} from '../domain/exposure.js'
import { SHAPES, SHAPE_KINDS } from '../domain/shapes/index.js'
import { createExposureGate, installExposureGate } from '../host/exposure.js'
import { loadShippedToolSurface } from '../scripts/lib/tool-surface.mjs'
import { collectProfileSurface, profileToolNames, toolBytes, validateProfileBytes } from '../scripts/lib/profile-surface.mjs'
import { __testResetToolSurface, define } from '../host/tool-runtime.js'

// #163 Phase 4 merged tower_control into tower_mode, so the mode-off
// affordance is one tool (read, enter/leave and takeover in one schema).
const ENTRY_TOOLS = ['tower_mode']
const IDLE_TOOLS = ['tower_init', 'tower_mode']

function shippedSurface() {
  const surface = loadShippedToolSurface()
  try {
    return { names: [...surface.names], definitions: surface.definitions }
  } finally {
    surface.dispose()
  }
}

test('exposure table classifies every shipped tool and nothing else (no implicit all)', () => {
  const { names } = shippedSurface()
  const tableNames = Object.keys(EXPOSURE_TABLE).sort()
  assert.deepEqual(tableNames, [...names].sort())
  for (const [name, row] of Object.entries(EXPOSURE_TABLE)) {
    for (const phase of SESSION_PHASES) {
      assert.equal(typeof row[phase], 'boolean', `${name}.${phase} must be an explicit boolean`)
    }
  }
})

test('subtraction: every phase exposes a subset of the registered surface', () => {
  const { names } = shippedSurface()
  for (const phase of SESSION_PHASES) {
    const exposed = exposedNames(phase, names)
    for (const name of exposed) assert.ok(names.includes(name), `${phase} exposes unregistered ${name}`)
  }
  assert.deepEqual(exposedNames('off', names).sort(), [...ENTRY_TOOLS].sort())
  assert.deepEqual(exposedNames('idle', names).sort(), [...IDLE_TOOLS].sort())
  assert.deepEqual(exposedNames('active', names).sort(), [...names].sort())
})

test('monotonicity: off ⊆ idle ⊆ active per tool, and the only shrinks are mode exit and teardown', () => {
  for (const [name, row] of Object.entries(EXPOSURE_TABLE)) {
    assert.ok(!row.off || row.idle, `${name} is exposed off but not idle`)
    assert.ok(!row.idle || row.active, `${name} is exposed idle but not active`)
  }
  // The phase of a snapshot is a pure function; enumerate every fact-pair
  // transition and assert the exposed set only shrinks on mode exit or state
  // teardown (#164 principle 3).
  const facts = [
    { mode: 'off', stateExists: false },
    { mode: 'off', stateExists: true },
    { mode: 'on', stateExists: false },
    { mode: 'on', stateExists: true },
  ]
  const allowedShrinks = new Set([
    'on|true->off|false', // mode exit
    'on|true->off|true', // mode exit
    'on|true->on|false', // state teardown
    'on|false->off|false', // mode exit before init
    'on|false->off|true', // mode exit (state appeared elsewhere)
  ])
  for (const from of facts) {
    for (const to of facts) {
      const fromPhase = phaseOfFacts(from)
      const toPhase = phaseOfFacts(to)
      if (fromPhase === toPhase) continue
      const grows = (a, b) =>
        SESSION_PHASES.indexOf(b) >= SESSION_PHASES.indexOf(a)
      const key = `${from.mode}|${from.stateExists}->${to.mode}|${to.stateExists}`
      if (!grows(fromPhase, toPhase)) {
        assert.ok(
          allowedShrinks.has(key),
          `${key} shrinks ${fromPhase} -> ${toPhase} but is neither mode exit nor teardown`,
        )
      }
    }
  }
})

test('stability: identical snapshots produce byte-identical exposed lists', () => {
  const { names } = shippedSurface()
  for (const phase of SESSION_PHASES) {
    const first = JSON.stringify(exposedNames(phase, names))
    const reordered = [...names].reverse().map((n, i) => names[(i + 7) % names.length])
    const second = JSON.stringify(exposedNames(phase, reordered))
    assert.equal(first, second, `${phase} projection depends on input order`)
    assert.equal(first, JSON.stringify(exposedNames(phase, names)), `${phase} projection is not deterministic`)
  }
})

test('liveness: every legal shape transition is driven by an exposed tool (exhaustive over the registry)', () => {
  const { names } = shippedSurface()
  const activeSet = new Set(exposedNames('active', names))
  const workerSet = new Set(PRESET_ALLOWS['tower-worker'])
  const surveySet = new Set([...PRESET_ALLOWS['tower-survey'], ...PRESET_ALLOWS['tower-survey-sandbox']])
  const reviewerSet = new Set(PRESET_ALLOWS['tower-reviewer'])
  // The driver side that owns each tool: tower-side drivers are exposed by the
  // active phase (a mission at any status implies state exists); worker-side
  // and reviewer-side drivers are exposed by their preset allow-lists.
  const ownersOf = (tool) => {
    if (tool === 'tower_complete') return [workerSet, surveySet]
    if (tool === 'tower_review') return [reviewerSet]
    return [activeSet]
  }
  for (const kind of SHAPE_KINDS) {
    const shape = SHAPES[kind]
    const mapped = TRANSITION_TOOLS[kind] ?? {}
    const legalEdges = new Set()
    for (const from of shape.statuses) {
      for (const to of shape.transitions[from] ?? []) legalEdges.add(`${from}>${to}`)
    }
    // No invented edges, no missing drivers.
    for (const edge of Object.keys(mapped)) {
      assert.ok(legalEdges.has(edge), `${kind} transition map invents the illegal edge ${edge}`)
      assert.ok(mapped[edge].length > 0, `${kind} ${edge} has no driving tool`)
    }
    for (const edge of legalEdges) {
      assert.ok(mapped[edge], `${kind} legal edge ${edge} has no exposure-table driver (dead end)`)
    }
    // Every driver is exposed to the profile that may call it.
    for (const [edge, drivers] of Object.entries(mapped)) {
      for (const tool of drivers) {
        assert.ok(names.includes(tool), `${kind} ${edge} names unregistered tool ${tool}`)
        for (const owner of ownersOf(tool)) {
          assert.ok(owner.has(tool), `${kind} ${edge} driver ${tool} is not exposed to its owning profile`)
        }
      }
    }
  }
  // Idle liveness: the only way out of idle is creating state.
  for (const tool of ['tower_init', ...ENTRY_TOOLS]) {
    assert.ok(exposes('idle', tool), `idle hides ${tool}, the rung's only exit`)
  }
  // Mode-off liveness: the agent-side entry exists (the /tower command is the
  // user-side entry and needs no tool). #163 Phase 4 merged the former
  // tower_control into tower_mode: one schema carries the read and the writes.
  assert.ok(exposes('off', 'tower_mode'), 'mode off hides tower_mode, the agent-side entry')
})

test('preset allow-lists are the role contracts the gate defers to', () => {
  for (const preset of TOWER_PRESET_IDS) {
    const allow = PRESET_ALLOWS[preset]
    assert.ok(Array.isArray(allow) && allow.length > 0, `${preset} has no explicit allow-list (no implicit all)`)
    for (const name of allow) {
      if (name.startsWith('tower_')) {
        assert.ok(EXPOSURE_TABLE[name] !== undefined, `${preset} allows unknown tower tool ${name}`)
      }
    }
  }
})

test('gate subtracts only for host sessions and fails open', async () => {
  const agent = { id: 'session-a' }
  let stateExists = false
  let preset = null
  const stateProbes = []
  const gate = createExposureGate({
    modeOn: (key) => key === 'session-a',
    presetOf: () => preset,
    stateExists: async (a) => {
      stateProbes.push(a)
      return stateExists
    },
  })
  const admits = async (name) => gate(name, { agent })
  // mode on, idle
  assert.equal(await admits('tower_init'), true)
  assert.equal(await admits('tower_plan'), false)
  assert.equal(await admits('tower_mode'), true)
  // mode on, active (state created) — memoized: one probe per step
  stateExists = true
  assert.equal(await admits('tower_plan'), false, 'the memoized idle fact must survive within the step')
  gate.reset()
  assert.equal(await admits('tower_plan'), true)
  assert.equal(stateProbes.length, 2, 'state existence is probed once per step, not per tool')
  // role presets bypass the ladder (a worker has mode off)
  stateExists = false
  preset = 'tower-worker'
  gate.reset()
  assert.equal(await admits('tower_mission'), true)
  // failures fail open
  preset = null
  const throwing = createExposureGate({
    modeOn: () => true,
    presetOf: () => {
      throw new Error('presets service unavailable')
    },
    stateExists: async () => {
      throw new Error('state unreadable')
    },
  })
  assert.equal(await throwing('tower_plan', { agent }), true, 'a throwing probe must expose, not hide')
  assert.equal(await throwing('tower_plan', {}), true, 'a missing agent must expose, not hide')
})

test('define() carries the step-time condition only while a gate is installed', async () => {
  __testResetToolSurface()
  const registrations = []
  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    tools: {
      register(definition, options) {
        registrations.push({ definition, options })
        return () => {}
      },
    },
  }
  const dispose = installExposureGate({
    modeOn: () => false,
    presetOf: () => null,
    stateExists: async () => false,
  })
  try {
    define(ctx, {
      name: 'tower_probe',
      description: 'probe',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [] },
      async execute() {
        return {}
      },
    })
    assert.equal(typeof registrations[0].options?.when, 'function', 'an installed gate attaches a step condition')
    assert.equal(await registrations[0].options.when({ agent: { id: 's' } }), false, 'mode off hides an orchestration tool')
  } finally {
    dispose()
  }
  // After the gate is uninstalled (an HMR unload edge) the live condition
  // fails open rather than throwing or hiding.
  assert.equal(await registrations[0].options.when({ agent: { id: 's' } }), true)
  define(ctx, {
    name: 'tower_probe2',
    description: 'probe',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [] },
    async execute() {
      return {}
    },
  })
  assert.deepEqual(registrations[1].options, {}, 'without a gate the registration stays unconditional')
  __testResetToolSurface()
})

test('define() composes the exposure gate with the role contract (#163 × #164)', async () => {
  __testResetToolSurface()
  const registrations = []
  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    tools: {
      register(definition, options) {
        registrations.push({ definition, options })
        return () => {}
      },
    },
  }
  const dispose = installExposureGate({
    modeOn: () => false,
    presetOf: (agent) => agent?.session?.header?.agentPreset ?? null,
    stateExists: async () => false,
  })
  try {
    define(ctx, {
      name: 'tower_complete',
      description: 'role probe',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      roles: ['worker', 'survey'],
      async execute() {
        return {}
      },
    })
    const when = registrations[0].options.when
    assert.equal(
      await when({ agent: { id: 'w', session: { header: { agentPreset: 'tower-worker' } } } }),
      true,
      'the owning role is admitted even with the host ladder off',
    )
    assert.equal(
      await when({ agent: { id: 'r', session: { header: { agentPreset: 'tower-reviewer' } } } }),
      false,
      'a role preset never inherits another role-owned tool',
    )
    assert.equal(await when({ agent: { id: 'host' } }), false, 'both conditions must admit')
  } finally {
    dispose()
    __testResetToolSurface()
  }
})

test('define() keeps the wrapper contract: aliases normalize and requiresMissionId still validates', async () => {
  // Regression: the shared execute wrapper must read the definition fields
  // destructured OUT of `rest` (aliases, requiresMissionId, board) from the
  // second parameter, not from `rest` — reading `rest.aliases` silently
  // disabled alias normalization and the missionId gate for every tool.
  __testResetToolSurface()
  const registrations = []
  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    tools: {
      register(definition) {
        registrations.push({ definition })
        return () => {}
      },
    },
  }
  const seen = []
  define(ctx, {
    // tower_reload is the one repository-optional matrix row, so a repo-less
    // probe call authorizes anonymously and reaches execute().
    name: 'tower_reload',
    description: 'probe',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    aliases: { missionId: ['id'] },
    requiresMissionId: true,
    async execute(args) {
      seen.push(args)
      return { ok: true }
    },
  })
  const exec = { agent: { id: 'probe-session' } }
  // The alias copies `id` into `missionId` and the gate trims it.
  const value = await registrations[0].definition.execute({ id: '  M1  ' }, exec)
  assert.equal(value.ok, true)
  assert.equal(seen[0].missionId, 'M1', 'aliases must normalize before execute')
  // A missing missionId is refused by the wrapper, before authorization.
  await assert.rejects(registrations[0].definition.execute({}, exec), /requires missionId/)
  __testResetToolSurface()
})

test('preset policy modules apply the shared allow-lists', async () => {
  const cases = [
    ['../worker.js', 'tower-worker'],
    ['../reviewer.js', 'tower-reviewer'],
    ['../survey.js', 'tower-survey'],
    ['../survey-sandbox.js', 'tower-survey-sandbox'],
  ]
  for (const [file, preset] of cases) {
    const mod = await import(file)
    const seen = []
    mod.apply({
      tools: { restrict: (filter) => seen.push(filter) },
      systemPrompt: { section: () => {} },
    })
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].allow, PRESET_ALLOWS[preset], `${file} no longer applies the shared table`)
  }
})

test('per-profile byte baseline: measurement is deterministic and the gate catches drift', () => {
  const surface = shippedSurface()
  const first = collectProfileSurface({ names: surface.names, definitions: surface.definitions })
  const second = collectProfileSurface({
    names: [...surface.names].reverse(),
    definitions: new Map([...surface.definitions].reverse()),
  })
  assert.deepEqual(first, second, 'profile bytes depend on iteration order')
  assert.ok(first['host:mode-off'].bytes < first['host:active'].bytes)
  // Drift and growth findings.
  const stale = validateProfileBytes(
    { date: '2026-11-12', profiles: { 'host:mode-off': { tools: 1, bytes: first['host:mode-off'].bytes + 1 } }, decisions: [] },
    first,
  )
  assert.ok(stale.some((f) => f.code === 'profile-bytes-stale'))
  const grown = validateProfileBytes(
    {
      date: '2026-11-12',
      profiles: { 'host:active': { tools: 21, bytes: 1 } },
      decisions: [{ date: '2026-11-12', adr: 'docs/adr/0009-role-phase-exposure.md' }],
    },
    first,
  )
  assert.ok(grown.some((f) => f.code === 'profile-bytes-stale'), 'drift is a finding even before the ADR check')
  assert.ok(
    grown.some((f) => f.code === 'profile-bytes-growth'),
    'growth without an existing ADR decision is refused',
  )
  const adrOk = validateProfileBytes(
    {
      date: '2026-11-12',
      profiles: { 'host:active': { tools: 21, bytes: 1 } },
      decisions: [{ date: '2026-11-12', adr: 'docs/adr/0009-role-phase-exposure.md' }],
    },
    first,
    { exists: () => true },
  )
  assert.ok(!adrOk.some((f) => f.code === 'profile-bytes-growth'), 'growth with an existing ADR decision passes the growth check')
  const clean = validateProfileBytes(
    { date: '2026-11-12', profiles: first, decisions: [{ date: '2026-11-12', adr: 'docs/adr/0009-role-phase-exposure.md' }] },
    first,
  )
  assert.deepEqual(clean, [])
})

test('toolBytes serializes the three advertised fields in a fixed key order', () => {
  const bytes = toolBytes({ name: 't', description: 'd', parameters: { type: 'object' } })
  assert.equal(bytes, Buffer.byteLength('{"name":"t","description":"d","parameters":{"type":"object"}}'))
  assert.equal(profileToolNames('host:mode-off', ['tower_mode', 'tower_init']).includes('tower_init'), false)
})
