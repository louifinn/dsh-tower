// Component-surface policy (#120). Principle 11 has three enforceable halves:
// locale coverage for every visible component, a denylist that keeps the host /
// health / recovery / review / merge contract out of reach of any switch, and a
// baselined component count. Each fixture below seeds exactly one failure, so
// the gate cannot quietly lose a tooth.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkForbidden,
  checkLocaleCoverage,
  parseComponentSurface,
  parseCordisPatch,
  parseOperationalRegistry,
  renderComponentSurface,
  validateComponentSurface,
} from '../domain/components.js'
import { PRESET_LOCALES } from '../scripts/generate-capability-locale.mjs'
import { configSurface } from '../domain/config/schema.js'
import { parseBaseline, validateSurfaceBaselineKey } from '../domain/surface.js'
import { readBaseline } from '../scripts/lib/surface.mjs'
import { checkComponents, checkRowLocaleCoverage } from '../scripts/check-components.mjs'
import { removeTemp } from './helpers/cleanup.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const fixture = (name) => JSON.parse(read(`tests/fixtures/component-surface/${name}`))
const realSurface = () => parseComponentSurface(read('scripts/component-surface.json'))

// The files `checkComponents` reads from a root, so the integration proofs below
// can tamper with a throwaway copy instead of the worktree.
const GATE_FILES = [
  'cordis.patch.yml',
  'scripts/component-surface.json',
  'scripts/surface-baseline.json',
  'docs/reference/component-surface.md',
  'docs/adr/0005-component-surface.md',
  'host/tool-registry.js',
  'locale/en.json',
  'locale/zh.json',
]

function gateRoot(transforms = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-components-'))
  for (const relative of GATE_FILES) {
    const target = path.join(dir, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const source = read(relative)
    fs.writeFileSync(target, transforms[relative] ? transforms[relative](source) : source)
  }
  return dir
}

test('the shipped component surface passes every rule and classifies all 55 keys', () => {
  const report = checkComponents(root)
  assert.deepEqual(report.findings.filter((entry) => entry.level === 'error'), [])
  assert.equal(report.surface.keys.length, configSurface().count)
  assert.equal(report.surface.keys.length, 55)
  assert.equal(new Set(report.surface.keys.map((key) => key.name)).size, 55)
  assert.deepEqual(report.live.patch.visible, [
    'tower',
    'tower-skills',
    'tower-batch',
    'tower-import',
    'tower-leases',
    'tower-tests',
    'tower-hmr',
    'preset-tower-reviewer',
  ])
  for (const className of ['core', 'optional-config', 'forbidden-to-disable']) {
    assert.ok(
      report.surface.keys.some((key) => key.class === className),
      `at least one key is classified ${className}`,
    )
  }
  // #136: no shipped key is `optional-component` any more. A config boolean that
  // only mirrors a row *is* the second switch the row model removed, so the class
  // stays available in the schema but must not claim a key.
  assert.deepEqual(
    report.surface.keys.filter((key) => key.class === 'optional-component').map((key) => key.name),
    [],
  )
  // #122: the shipped boolean-route table is empty — a review, merge or host
  // tool is never a switch.
  assert.deepEqual(report.live.registry, {})
  assert.deepEqual(report.surface.gateableTools, [])
})

test('the generated reference is a rendering of the source of truth, not prose', () => {
  const baseline = readBaseline(root)
  const expected = renderComponentSurface(realSurface(), { baselineDate: baseline.date })
  assert.equal(read('docs/reference/component-surface.md'), expected)
  for (const row of realSurface().keys) {
    assert.ok(expected.includes(`| \`${row.name}\` | \`${row.class}\` |`), `reference lists ${row.name}`)
  }
})

test('the component count is baselined next to the other surfaces', () => {
  const baseline = readBaseline(root)
  const patch = parseCordisPatch(read('cordis.patch.yml'))
  assert.equal(baseline.surfaces.components.value, patch.visible.length)
  assert.equal(baseline.surfaces.components.value, 8)
  // The seed keeps the 2.0.4 history: the 4 -> 1 contraction and the #121
  // growth back to individually switchable optional rows are recorded decisions.
  assert.equal(baseline.surfaces.components.seed, 4)
  const decisions = baseline.surfaces.components.decisions
  assert.equal(decisions.length, 2)
  assert.equal(decisions[0].from, 4)
  assert.equal(decisions[0].to, 1)
  assert.equal(decisions[1].from, 1)
  assert.equal(decisions[1].to, 8)
  for (const decision of decisions) {
    assert.match(decision.date, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(decision.adr, 'docs/adr/0005-component-surface.md')
  }
})

test('a component contraction without a decision fails, unlike the other surfaces', () => {
  const current = readBaseline(root)
  const ratcheted = parseBaseline({
    ...current,
    surfaces: {
      ...current.surfaces,
      components: { seed: 4, value: 1, decisions: [] },
    },
  })
  const findings = validateSurfaceBaselineKey(ratcheted, 'components', {
    components: 1,
    liveNames: { components: ['tower-bundle'] },
  })
  assert.ok(findings.some((entry) => entry.code === 'broken-chain'))
  assert.match(findings[0].message, /every count change needs a decision record/)

  // The config-key surface keeps the ADR 0004 rule: a pure shrink is cheap.
  const shrink = parseBaseline({
    ...current,
    surfaces: { ...current.surfaces, configKeys: { seed: 64, value: 63, decisions: [] } },
  })
  assert.deepEqual(
    validateSurfaceBaselineKey(shrink, 'configKeys', { configKeys: 63, liveNames: { configKeys: [] } }),
    [],
  )
})

test('parseCordisPatch separates visible rows, internal sections and plugin ids', () => {
  const patch = parseCordisPatch(read('cordis.patch.yml'))
  assert.deepEqual(patch.visible, [
    'tower',
    'tower-skills',
    'tower-batch',
    'tower-import',
    'tower-leases',
    'tower-tests',
    'tower-hmr',
    'preset-tower-reviewer',
  ])
  assert.deepEqual(
    patch.rows.map((row) => row.id),
    [
      'tower',
      'tower-host',
      'preset-tower-worker',
      'tower-skills',
      'tower-batch',
      'tower-import',
      'tower-leases',
      'tower-tests',
      'tower-hmr',
      'preset-tower-reviewer',
    ],
  )
  assert.equal(patch.rows.find((row) => row.id === 'tower').kind, 'group')
  assert.equal(patch.rows.find((row) => row.id === 'tower-host').scope, 'internal')
  assert.equal(patch.rows.find((row) => row.id === 'preset-tower-worker').scope, 'internal')
  assert.ok(!patch.rows.some((row) => row.id === 'tower-worker-policy'), 'plugin ids are not components')
})

test('a shipped row or a live config key without a classification fails', () => {
  const surface = realSurface()
  const live = { configKeys: configSurface().keys, patch: parseCordisPatch(read('cordis.patch.yml')) }
  assert.deepEqual(validateComponentSurface(surface, live), [])

  const missingRow = {
    ...surface,
    components: surface.components.filter((component) => component.id !== 'tower-skills'),
  }
  assert.ok(
    validateComponentSurface(missingRow, live).some((entry) => entry.code === 'component-unclassified'),
  )

  const missingKey = { ...surface, keys: surface.keys.filter((key) => key.name !== 'dev.reloadDelayMs') }
  assert.ok(validateComponentSurface(missingKey, live).some((entry) => entry.code === 'key-unclassified'))
})

test('fixture: a visible component without three locale strings fails (#120 check 1)', () => {
  const data = fixture('locale-missing.json')
  const surface = parseComponentSurface(data.surface)
  const findings = checkLocaleCoverage(surface, data.locales)
  const missing = findings.filter((entry) => entry.code === 'component-locale')
  assert.equal(missing.length, 1)
  assert.match(missing[0].message, /"disables"/)
  assert.match(missing[0].message, /locale\/zh\.json/)

  // The English entry is covered; adding the missing Chinese string clears it.
  const complete = {
    ...data.locales,
    'locale/zh.json': {
      components: {
        'tower-bundle': { ...data.locales['locale/zh.json'].components['tower-bundle'], disables: '关闭后整个 Tower 一起停用。' },
      },
    },
  }
  assert.deepEqual(checkLocaleCoverage(surface, complete), [])
})

test('fixture: a generated row label needs the three locale strings, even for an internal row (#121)', () => {
  const surface = realSurface()
  const locales = {
    'locale/en.json': JSON.parse(read('locale/en.json')),
    'locale/zh.json': JSON.parse(read('locale/zh.json')),
  }
  assert.deepEqual(checkRowLocaleCoverage(surface, locales, PRESET_LOCALES), [])

  // The worker preset is internal, so the visible-only rule does not cover it;
  // the row-label rule does. Dropping its English entry is a finding.
  const missing = {
    ...locales,
    'locale/en.json': {
      ...locales['locale/en.json'],
      components: { ...locales['locale/en.json'].components },
    },
  }
  delete missing['locale/en.json'].components['preset-tower-worker']
  const dropped = checkRowLocaleCoverage(surface, missing, PRESET_LOCALES)
  assert.ok(
    dropped.some(
      (entry) => entry.code === 'row-locale' && /preset-tower-worker/.test(entry.message) && /locale\/en\.json/.test(entry.message),
    ),
    JSON.stringify(dropped),
  )

  // The mandatory flag is a rendering of the component scope, so it cannot drift.
  const flipped = PRESET_LOCALES.map((row) =>
    row.component === 'preset-tower-worker' ? { ...row, mandatory: false } : row,
  )
  assert.ok(checkRowLocaleCoverage(surface, locales, flipped).some((entry) => entry.code === 'row-locale-scope'))

  // A row label that names no shipped component is refused.
  assert.ok(
    checkRowLocaleCoverage(surface, locales, [{ specifier: 'ghost', component: 'preset-ghost' }]).some(
      (entry) => entry.code === 'row-locale-unknown',
    ),
  )
})

test('fixture: a boolean key that disables a forbidden capability fails (#120 check 2)', () => {
  const data = fixture('forbidden-disabler.json')
  const surface = parseComponentSurface(data.surface)
  const errors = checkForbidden(surface, data.live).filter((entry) => entry.level === 'error')
  assert.ok(errors.some((entry) => entry.code === 'forbidden-disabler'))
  assert.ok(errors.some((entry) => entry.code === 'forbidden-disabler' && /tools\.exposeDoctor/.test(entry.message)))

  // A dated decision is the only way the gate accepts a recorded disabler.
  const recorded = parseComponentSurface({
    ...data.surface,
    forbidden: data.surface.forbidden.map((capability) =>
      capability.id === 'health'
        ? {
            ...capability,
            acceptedSwitches: {
              keys: ['tools.exposeDoctor', 'tools.exposeOperational'],
              decision: {
                date: '2026-10-23',
                ref: 'docs/adr/0005-component-surface.md',
                issue: '#122',
                reason: 'recorded debt until #122 deletes the keys',
              },
            },
          }
        : capability,
    ),
  })
  assert.deepEqual(checkForbidden(recorded, data.live).filter((entry) => entry.level === 'error'), [])

  // A new boolean that removes the same capability is still refused.
  const newSwitch = { ...data.live, registry: { tower_doctor: 'exposeDoctorV2' } }
  assert.ok(
    checkForbidden(recorded, newSwitch).some(
      (entry) => entry.code === 'forbidden-disabler' && /tools\.exposeDoctorV2/.test(entry.message),
    ),
  )

  // A component row may not switch a contract key off either.
  const overriding = {
    ...data.live,
    patch: {
      ...data.live.patch,
      rows: [{ ...data.live.patch.rows[0], overrides: ['requireReview'] }],
    },
  }
  assert.ok(checkForbidden(surface, overriding).some((entry) => entry.code === 'forbidden-override'))

  // Nor may a forbidden capability become its own visible row.
  const exposed = {
    ...data.live,
    patch: {
      ...data.live.patch,
      rows: [{ id: 'tower-doctor', scope: 'visible', kind: 'row', group: false, overrides: [] }],
      visible: ['tower-doctor'],
    },
  }
  assert.ok(checkForbidden(surface, exposed).some((entry) => entry.code === 'forbidden-component'))
})

test('fixture: a group row that defaults a forbidden boolean off fails (#120 check 2, row route)', () => {
  const data = fixture('forbidden-row-override.json')
  const surface = parseComponentSurface(data.surface)
  const errors = checkForbidden(surface, data.live).filter((entry) => entry.level === 'error')
  const overrides = errors.filter((entry) => entry.code === 'forbidden-override')
  assert.equal(overrides.length, 1)
  assert.match(overrides[0].message, /tower-bundle/)
  assert.match(overrides[0].message, /tools\.exposeDoctor:false/)
  assert.match(overrides[0].message, /forbidden-to-disable/)

  // A leaf that is not classified forbidden-to-disable is not an override.
  const tuning = {
    ...data.live,
    patch: {
      ...data.live.patch,
      rows: [{ ...data.live.patch.rows[0], overrides: ['exposeBatch'] }],
    },
  }
  assert.deepEqual(checkForbidden(surface, tuning).filter((entry) => entry.level === 'error'), [])
})

test('fixture: a new boolean route to a review or merge tool fails (#120 check 2, allowlist)', () => {
  const data = fixture('forbidden-tool-route.json')
  const surface = parseComponentSurface(data.surface)
  const errors = checkForbidden(surface, data.live).filter((entry) => entry.level === 'error')
  const routed = errors.filter((entry) => entry.code === 'forbidden-tool-gate' && /tower_merge/.test(entry.message))
  // The merge-gate capability lists no tools of its own; the allowlist is what
  // catches the route, so the finding cannot depend on `capability.tools`.
  assert.equal(routed.length, 1)
  assert.match(routed[0].message, /tools\.exposeBatch/)
  assert.match(routed[0].message, /not a recorded gateable tool/)
  assert.ok(!errors.some((entry) => entry.code === 'forbidden-tool-gate' && /tower_batch/.test(entry.message)))

  // Dropping the undeclared route clears the finding.
  const clean = { ...data.live, registry: { tower_batch: 'exposeBatch', tower_doctor: 'exposeDoctor' } }
  assert.deepEqual(checkForbidden(surface, clean).filter((entry) => entry.level === 'error'), [])
})

test('fixture: a component count that moved without a decision fails (#120 check 3)', () => {
  const data = fixture('count-moved.json')
  const live = { components: data.live.length, liveNames: { components: data.live } }
  const findings = validateSurfaceBaselineKey(parseBaseline(data.baseline), 'components', live)
  assert.ok(findings.some((entry) => entry.code === 'stale-baseline'))
  assert.match(findings[0].message, /components grew from the committed baseline 1 to 2/)

  // A decision record naming an ADR authorizes the growth.
  const withDecision = parseBaseline({
    ...data.baseline,
    surfaces: {
      ...data.baseline.surfaces,
      components: {
        seed: 1,
        value: 2,
        decisions: [{ from: 1, to: 2, date: '2026-10-23', adr: 'docs/adr/0005-component-surface.md' }],
      },
    },
  })
  assert.deepEqual(
    validateSurfaceBaselineKey(withDecision, 'components', live, {
      exists: (relative) => relative === 'docs/adr/0005-component-surface.md',
    }),
    [],
  )

  // Editing the value without any decision breaks the chain even when the live
  // count happens to match.
  const moved = parseBaseline({
    ...data.baseline,
    surfaces: {
      ...data.baseline.surfaces,
      components: { seed: 1, value: 2, decisions: [] },
    },
  })
  assert.ok(validateSurfaceBaselineKey(moved, 'components', live).some((entry) => entry.code === 'broken-chain'))
})

test('a baseline without a components entry is refused', () => {
  const baseline = readBaseline(root)
  const withoutComponents = {
    schema: baseline.schema,
    date: baseline.date,
    surfaces: {
      configKeys: baseline.surfaces.configKeys,
      sections: baseline.surfaces.sections,
      tools: baseline.surfaces.tools,
    },
  }
  assert.throws(() => parseBaseline(withoutComponents), /components/)
})

test('integration: a row that defaults review.requireReview off fails the gate', () => {
  const dir = gateRoot({
    'cordis.patch.yml': (text) =>
      text.replace(
        /^(\s*)spawn:\s*$/m,
        (line, indent) => `${indent}review:\n${indent}  requireReview: false\n${indent}spawn:`,
      ),
  })
  try {
    const report = checkComponents(dir)
    assert.equal(report.ok, false)
    assert.ok(
      report.findings.some(
        (entry) => entry.code === 'forbidden-override' && /review\.requireReview/.test(entry.message),
      ),
      JSON.stringify(report.findings, null, 2),
    )
  } finally {
    removeTemp(dir)
  }
})

test('integration: a new OPERATIONAL_TOOLS route to tower_merge fails the gate', () => {
  const dir = gateRoot({
    'host/tool-registry.js': (text) =>
      text.replace(
        /^const OPERATIONAL_TOOLS = new Map\(\)$/m,
        "const OPERATIONAL_TOOLS = new Map([['tower_merge', 'exposeBatch']])",
      ),
  })
  try {
    const report = checkComponents(dir)
    assert.equal(report.ok, false)
    assert.ok(
      report.findings.some((entry) => entry.code === 'forbidden-tool-gate' && /tower_merge/.test(entry.message)),
      JSON.stringify(report.findings, null, 2),
    )
  } finally {
    removeTemp(dir)
  }
})

// F11: the parser is the offline denylist's only view of the route table.
// A reformatted table (trailing comma, one entry per line) or a rewritten
// `Map.set(...)` route must still be detected, or a forbidden switch could be
// added without the gate noticing.
test('F11: the operational-registry parser accepts a trailing comma and Map.set routes', () => {
  // The fixture is a registry-shaped source with both route syntaxes; a
  // reformatted table must not fall out of the allowlist.
  assert.deepEqual(parseOperationalRegistry(read('tests/fixtures/component-surface/registry-routes.txt')), {
    tower_batch: 'exposeBatch',
    tower_test: 'exposeTests',
    tower_merge: 'exposeBatch',
    tower_doctor: 'exposeDoctor',
  })

  // A `.set(...)` route to a review/merge tool is caught by the same allowlist
  // as a tuple route.
  const surface = parseComponentSurface(read('scripts/component-surface.json'))
  const live = {
    booleans: [],
    registry: parseOperationalRegistry("OPERATIONAL_TOOLS.set('tower_merge', 'exposeBatch')"),
    patch: parseCordisPatch(read('cordis.patch.yml')),
  }
  const errors = checkForbidden(surface, live).filter((entry) => entry.level === 'error')
  assert.ok(errors.some((entry) => entry.code === 'forbidden-tool-gate' && /tower_merge/.test(entry.message)))
})
