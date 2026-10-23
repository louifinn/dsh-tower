// Component-surface policy (#120). Principle 11 has three enforceable halves:
// locale coverage for every visible component, a denylist that keeps the host /
// health / recovery / review / merge contract out of reach of any switch, and a
// baselined component count. Each fixture below seeds exactly one failure, so
// the gate cannot quietly lose a tooth.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkForbidden,
  checkLocaleCoverage,
  parseComponentSurface,
  parseCordisPatch,
  renderComponentSurface,
  validateComponentSurface,
} from '../domain/components.js'
import { configSurface } from '../domain/config/schema.js'
import { parseBaseline, validateSurfaceBaselineKey } from '../domain/surface.js'
import { readBaseline } from '../scripts/lib/surface.mjs'
import { checkComponents } from '../scripts/check-components.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const fixture = (name) => JSON.parse(read(`tests/fixtures/component-surface/${name}`))
const realSurface = () => parseComponentSurface(read('scripts/component-surface.json'))

test('the shipped component surface passes every rule and classifies all 64 keys', () => {
  const report = checkComponents(root)
  assert.deepEqual(report.findings.filter((entry) => entry.level === 'error'), [])
  assert.equal(report.surface.keys.length, configSurface().count)
  assert.equal(report.surface.keys.length, 64)
  assert.equal(new Set(report.surface.keys.map((key) => key.name)).size, 64)
  assert.deepEqual(report.live.patch.visible, ['tower-bundle'])
  for (const className of ['core', 'optional-component', 'optional-config', 'forbidden-to-disable']) {
    assert.ok(
      report.surface.keys.some((key) => key.class === className),
      `at least one key is classified ${className}`,
    )
  }
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
  assert.equal(baseline.surfaces.components.value, 1)
  // The seed keeps the 2.0.4 history: the 4 -> 1 contraction is a recorded
  // decision, not a quietly lowered value.
  assert.equal(baseline.surfaces.components.seed, 4)
  const decisions = baseline.surfaces.components.decisions
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].from, 4)
  assert.equal(decisions[0].to, 1)
  assert.match(decisions[0].date, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(decisions[0].adr, 'docs/adr/0005-component-surface.md')
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
  assert.deepEqual(patch.visible, ['tower-bundle'])
  assert.deepEqual(
    patch.rows.map((row) => row.id),
    ['tower-bundle', 'tower', 'tower-skills', 'preset-tower-worker', 'preset-tower-reviewer'],
  )
  assert.equal(patch.rows.find((row) => row.id === 'tower-bundle').kind, 'group')
  assert.equal(patch.rows.find((row) => row.id === 'tower').scope, 'internal')
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

  const missingKey = { ...surface, keys: surface.keys.filter((key) => key.name !== 'dev.hotReload') }
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
