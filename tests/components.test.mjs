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
  checkGroupLabelCoverage,
  checkKeyClassifications,
  checkLocaleCoverage,
  checkMetaLabelCoverage,
  checkRowOverrides,
  mergeCordisPatches,
  parseComponentSurface,
  parseCordisPatch,
  renderComponentSurface,
  validateComponentSurface,
} from '../domain/components.js'
import { OFF_EFFECT_LABEL, PRESET_LOCALES, ROW_LOCALES, rowLocalePaths } from '../scripts/generate-capability-locale.mjs'
import { configSurface } from '../domain/config/schema.js'
import { parseBaseline, validateSurfaceBaselineKey } from '../domain/surface.js'
import { readBaseline } from '../scripts/lib/surface.mjs'
import {
  checkComponents,
  checkReviewPolicySurface,
  checkRowLabelSources,
  checkRowLocaleCoverage,
  checkShippedPatchCoverage,
  discoverShippedPatches,
  liveKeyTypes,
} from '../scripts/check-components.mjs'
import { removeTemp } from './helpers/cleanup.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const fixture = (name) => JSON.parse(read(`tests/fixtures/component-surface/${name}`))
const realSurface = () => parseComponentSurface(read('scripts/component-surface.json'))
const realLocales = () => ({
  'locale/en.json': JSON.parse(read('locale/en.json')),
  'locale/zh.json': JSON.parse(read('locale/zh.json')),
})
const realMetaLocales = () => ({
  'ui-bundle/locale/en.json': JSON.parse(read('ui-bundle/locale/en.json')),
  'ui-bundle/locale/zh.json': JSON.parse(read('ui-bundle/locale/zh.json')),
})
// #134: the policy gate reads every shipped patch, so the live shape is the
// merged one, not the root patch alone.
const realMergedPatch = () =>
  mergeCordisPatches({
    'cordis.patch.yml': parseCordisPatch(read('cordis.patch.yml')),
    'ui-bundle/cordis.patch.yml': parseCordisPatch(read('ui-bundle/cordis.patch.yml')),
  })

// The files `checkComponents` reads from a root, so the integration proofs below
// can tamper with a throwaway copy instead of the worktree.
const GATE_FILES = [
  'cordis.patch.yml',
  'ui-bundle/cordis.patch.yml',
  'ui-bundle/locale/en.json',
  'ui-bundle/locale/zh.json',
  'scripts/component-surface.json',
  'scripts/surface-baseline.json',
  'docs/reference/component-surface.md',
  'docs/adr/0005-component-surface.md',
  'host/tool-registry.js',
  'locale/en.json',
  'locale/zh.json',
  // #137: the copy gate reads the generated row labels and the glossary.
  ...rowLocalePaths(),
  'GLOSSARY.md',
]

// The real registry imports the Host runtime, which a throwaway root cannot
// resolve. #138 makes the gate import the table, so the integration copies get a
// self-contained module with the same export contract.
const REGISTRY_STUB = `// Test stub: only the exported route table matters to the gate.
export const OPERATIONAL_TOOLS = new Map()
`

function gateRoot(transforms = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-components-'))
  for (const relative of GATE_FILES) {
    const target = path.join(dir, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const source = relative === 'host/tool-registry.js' ? REGISTRY_STUB : read(relative)
    fs.writeFileSync(target, transforms[relative] ? transforms[relative](source) : source)
  }
  return dir
}

test('the shipped component surface passes every rule and classifies all 54 keys', async () => {
  const report = await checkComponents(root)
  assert.deepEqual(report.findings.filter((entry) => entry.level === 'error'), [])
  assert.equal(report.surface.keys.length, configSurface().count)
  assert.equal(report.surface.keys.length, 54)
  assert.equal(new Set(report.surface.keys.map((key) => key.name)).size, 54)
  assert.deepEqual(report.live.patch.visible, [
    'tower',
    'tower-skills',
    'tower-batch',
    'tower-import',
    'tower-leases',
    'tower-tests',
    'tower-board',
    'tower-archive',
    'tower-hmr',
    'preset-tower-reviewer',
    'tower-ui',
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

test('the review-policy decision is dated and count-consistent (#M42)', () => {
  const surface = realSurface()
  const baseline = readBaseline(root)
  const reference = read('docs/reference/component-surface.md')
  const adr = read(surface.adr)

  assert.match(surface.date, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(surface.date, '2026-11-01', 'the reclassification carries its own decision date')
  assert.match(
    adr,
    new RegExp(`## Addendum \\(wave 5\\)[\\s\\S]*?- Date: ${surface.date}`),
    'ADR 0005 records the wave-5 decision on the surface decision date',
  )
  assert.match(adr, /one tri-state control/)
  assert.match(adr, /not a component row/)
  assert.match(adr, /54 config keys, 11 visible components/)
  assert.match(reference, new RegExp(`decision date: ${surface.date}`))

  // The dated decision is count-consistent with the source of truth and the
  // baseline: reclassification moves no key and no component.
  assert.equal(surface.keys.length, 54)
  assert.equal(baseline.surfaces.configKeys.value, 54)
  assert.equal(realMergedPatch().visible.length, 11)
  assert.equal(baseline.surfaces.components.value, 11)
})

test('the review policy is one tri-state control, not a component row (#M42)', () => {
  const surface = realSurface()
  const live = { configKeys: configSurface().keys, patch: realMergedPatch() }
  assert.deepEqual(checkReviewPolicySurface(surface, live), [])

  // The two policy keys are configuration/alias, never a switch.
  assert.equal(surface.keys.find((key) => key.name === 'review.mode').class, 'core')
  assert.equal(surface.keys.find((key) => key.name === 'review.requireReview').class, 'core')
  assert.ok(!surface.components.some((component) => /review.*policy|^review$|^review-mode/.test(component.id)))
  assert.equal(surface.components.filter((component) => component.id === 'preset-tower-reviewer').length, 1)

  // A review-policy row is refused.
  const policyRow = {
    ...surface,
    components: surface.components.map((component) =>
      component.id === 'tower-board' ? { ...component, id: 'review-policy' } : component,
    ),
  }
  assert.ok(checkReviewPolicySurface(policyRow, live).some((entry) => entry.code === 'review-policy-row'))

  // No component row may own the control, through `allowedOverrides` ...
  const allowed = {
    ...surface,
    components: surface.components.map((component) =>
      component.id === 'tower-board' ? { ...component, allowedOverrides: ['review.mode'] } : component,
    ),
  }
  assert.ok(checkReviewPolicySurface(allowed, live).some((entry) => entry.code === 'review-policy-switch'))

  // ... or through the shipped `config:` block, whatever value it picks.
  const rowPolicy = {
    ...live,
    patch: {
      ...live.patch,
      rows: live.patch.rows.map((row) =>
        row.id === 'tower-board' ? { ...row, configOverrides: [{ key: 'review.mode', value: 'off' }] } : row,
      ),
    },
  }
  assert.ok(checkReviewPolicySurface(surface, rowPolicy).some((entry) => entry.code === 'review-policy-switch'))

  // The required-mode gate must stay recorded as non-disableable.
  const noGate = { ...surface, forbidden: surface.forbidden.filter((capability) => capability.id !== 'review') }
  assert.ok(checkReviewPolicySurface(noGate, live).some((entry) => entry.code === 'review-policy-gate'))

  // The reviewer row is not mutually exclusive with the policy.
  const exclusive = {
    ...surface,
    forbidden: surface.forbidden.map((capability) =>
      capability.id === 'review' ? { ...capability, rowIds: ['preset-tower-reviewer'] } : capability,
    ),
  }
  assert.ok(checkReviewPolicySurface(exclusive, live).some((entry) => entry.code === 'review-policy-exclusive'))
})

test('the component count is baselined next to the other surfaces', () => {
  const baseline = readBaseline(root)
  assert.equal(baseline.surfaces.components.value, realMergedPatch().visible.length)
  assert.equal(baseline.surfaces.components.value, 11)
  // The seed keeps the 2.0.4 history: the 4 -> 1 contraction, the #121 growth
  // back to individually switchable optional rows, and the wave-2 rows (#133
  // tower-board, #135 tower-archive, #134 tower-ui) are recorded decisions.
  assert.equal(baseline.surfaces.components.seed, 4)
  const decisions = baseline.surfaces.components.decisions
  assert.equal(decisions.length, 5)
  assert.deepEqual(
    decisions.map((decision) => [decision.from, decision.to]),
    [
      [4, 1],
      [1, 8],
      [8, 9],
      [9, 10],
      [10, 11],
    ],
  )
  for (const decision of decisions) {
    assert.match(decision.date, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(decision.adr, 'docs/adr/0005-component-surface.md')
  }
})

test('a component or config-key contraction without a decision fails, unlike sections and tools', () => {
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

  // #138: the config-key surface is two-way too. Removing a switch is a
  // capability decision, so a pure shrink without a record no longer passes.
  const shrink = parseBaseline({
    ...current,
    surfaces: { ...current.surfaces, configKeys: { seed: 64, value: 63, decisions: [] } },
  })
  const shrinkFindings = validateSurfaceBaselineKey(shrink, 'configKeys', {
    configKeys: 63,
    liveNames: { configKeys: [] },
  })
  assert.ok(shrinkFindings.some((entry) => entry.code === 'broken-chain'))
  assert.match(shrinkFindings[0].message, /every count change needs a decision record/)

  // A dated decision naming an ADR is the way through.
  const recorded = parseBaseline({
    ...current,
    surfaces: {
      ...current.surfaces,
      configKeys: {
        seed: 64,
        value: 63,
        decisions: [{ from: 64, to: 63, date: '2026-11-03', adr: 'docs/adr/0005-component-surface.md' }],
      },
    },
  })
  assert.deepEqual(
    validateSurfaceBaselineKey(recorded, 'configKeys', { configKeys: 63, liveNames: { configKeys: [] } }, {
      exists: (relative) => relative === 'docs/adr/0005-component-surface.md',
    }),
    [],
  )

  // Sections keep the ADR 0004 cheap-shrink rule.
  const sectionShrink = parseBaseline({
    ...current,
    surfaces: { ...current.surfaces, sections: { seed: 15, value: 14, decisions: [] } },
  })
  assert.deepEqual(
    validateSurfaceBaselineKey(sectionShrink, 'sections', { sections: 14, liveNames: { sections: [] } }),
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
    'tower-board',
    'tower-archive',
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
      'tower-board',
      'tower-archive',
      'tower-hmr',
      'preset-tower-reviewer',
    ],
  )
  assert.equal(patch.rows.find((row) => row.id === 'tower').kind, 'group')
  assert.equal(patch.rows.find((row) => row.id === 'tower-host').scope, 'internal')
  assert.equal(patch.rows.find((row) => row.id === 'preset-tower-worker').scope, 'internal')
  assert.ok(!patch.rows.some((row) => row.id === 'tower-worker-policy'), 'plugin ids are not components')

  // #138: the row's own scalar config is captured as full key paths, while the
  // row metadata and the nested `plugins:` configs are not.
  assert.deepEqual(patch.rows.find((row) => row.id === 'tower-host').configOverrides, [
    { key: 'mode.allowAgentControl', value: 'true' },
    { key: 'mode.workspaceLock', value: 'true' },
    { key: 'mode.workspaceLockScope', value: 'all' },
    { key: 'mode.planModePolicy', value: 'clear' },
    { key: 'init.autoGitInit', value: 'true' },
    { key: 'send.interruptDefault', value: 'true' },
    { key: 'spawn.staleMs', value: '15000' },
  ])
  assert.deepEqual(patch.rows.find((row) => row.id === 'preset-tower-worker').configOverrides, [])
  assert.deepEqual(patch.rows.find((row) => row.id === 'preset-tower-reviewer').configOverrides, [])

  // #134: the ui-bundle patch is a shipped patch too, and its row is visible.
  const ui = parseCordisPatch(read('ui-bundle/cordis.patch.yml'))
  assert.deepEqual(ui.visible, ['tower-ui'])
})

test('a boolean or behaviour knob cannot hide a capability on the optional-config class (#138)', () => {
  const surface = realSurface()
  const live = { keyTypes: liveKeyTypes() }
  assert.deepEqual(checkKeyClassifications(surface, live), [])

  const drop = (name) => ({
    ...surface,
    keys: surface.keys.map((key) => (key.name === name ? { ...key, exemption: undefined } : key)),
  })
  const noExemption = checkKeyClassifications(drop('tests.autoChecks'), live)
  assert.ok(noExemption.some((entry) => entry.code === 'boolean-class' && /tests\.autoChecks/.test(entry.message)))

  // A recorded exemption must name a tuning-only nature, not just exist.
  const wrongReason = {
    ...surface,
    keys: surface.keys.map((key) =>
      key.name === 'tests.autoChecks' ? { ...key, exemption: { ...key.exemption, reason: 'it was already like this' } } : key,
    ),
  }
  assert.ok(checkKeyClassifications(wrongReason, live).some((entry) => entry.code === 'boolean-exemption'))

  // The recorded behaviour knobs are reviewed on the same axis.
  const noKnob = checkKeyClassifications(drop('spawn.requireLease'), live)
  assert.ok(noKnob.some((entry) => entry.code === 'boolean-class' && /spawn\.requireLease/.test(entry.message)))

  // The exemption is only legal on a reviewed boolean/knob.
  const offAxis = {
    ...surface,
    keys: surface.keys.map((key) =>
      key.name === 'docs.boardLocation' ? { ...key, exemption: { ...surface.keys.find((entry) => entry.name === 'tests.autoChecks').exemption } } : key,
    ),
  }
  assert.ok(checkKeyClassifications(offAxis, live).some((entry) => entry.code === 'exemption-invalid'))

  // A knob recorded in the source of truth but absent from the live schema fails.
  const staleKnob = { ...surface, behaviorKnobs: [...surface.behaviorKnobs, 'ghost.requireLease'] }
  assert.ok(checkKeyClassifications(staleKnob, live).some((entry) => entry.code === 'behavior-knob-unknown'))
})

test('a row may only override the config its component owns (#138)', () => {
  const surface = realSurface()
  const live = { configKeys: configSurface().keys, patch: realMergedPatch() }
  assert.deepEqual(checkRowOverrides(surface, live), [])

  const withRow = (id, configOverrides) => ({
    ...live,
    patch: { ...live.patch, rows: live.patch.rows.map((row) => (row.id === id ? { ...row, configOverrides } : row)) },
  })
  const foreign = checkRowOverrides(surface, withRow('tower-board', [{ key: 'mode.workspaceLock', value: 'true' }]))
  assert.ok(foreign.some((entry) => entry.code === 'row-override-foreign' && /tower-board/.test(entry.message)))

  // #133/#135/#136 shapes: a removed switch is not a live key, so a row cannot
  // keep it working from config.
  for (const key of ['docs.board', 'archive.enabled', 'tests.enabled']) {
    const findings = checkRowOverrides(surface, withRow('tower-board', [{ key, value: 'false' }]))
    assert.ok(
      findings.some((entry) => entry.code === 'row-override-unknown' && entry.message.includes(key)),
      `${key} must not be a row override`,
    )
  }

  // A component cannot allow itself a forbidden-to-disable key, and cannot name
  // a key that does not exist. `review.requireReview` is no longer the example:
  // #M42 classifies it as the deprecated policy alias (`core`), and the review
  // policy's row-ownership rule is checked by checkReviewPolicySurface instead.
  const forbidden = {
    ...surface,
    components: surface.components.map((component) =>
      component.id === 'tower-board' ? { ...component, allowedOverrides: ['review.maxRoundsPerReviewer'] } : component,
    ),
  }
  assert.ok(checkRowOverrides(forbidden, live).some((entry) => entry.code === 'row-override-forbidden'))
  const unknown = {
    ...surface,
    components: surface.components.map((component) =>
      component.id === 'tower-board' ? { ...component, allowedOverrides: ['ghost.key'] } : component,
    ),
  }
  assert.ok(checkRowOverrides(unknown, live).some((entry) => entry.code === 'component-override-unknown'))
})

test('every shipped cordis.patch.yml is discovered and accounted for (#138)', () => {
  const discovered = discoverShippedPatches(root)
  assert.deepEqual(discovered, ['cordis.patch.yml', 'ui-bundle/cordis.patch.yml'])
  assert.deepEqual(checkShippedPatchCoverage(discovered), [])

  const extra = [...discovered, 'packages/tower-extra/cordis.patch.yml']
  assert.ok(
    checkShippedPatchCoverage(extra).some(
      (entry) => entry.code === 'patch-unclassified' && /tower-extra/.test(entry.message),
    ),
  )

  const missing = discovered.filter((file) => file !== 'ui-bundle/cordis.patch.yml')
  assert.ok(
    checkShippedPatchCoverage(missing).some(
      (entry) => entry.code === 'patch-missing' && /ui-bundle/.test(entry.message),
    ),
  )
})

test('a shipped row or a live config key without a classification fails', () => {
  const surface = realSurface()
  const live = { configKeys: configSurface().keys, patch: realMergedPatch() }
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

test('integration: a row that owns the review policy fails the gate (#M42)', async () => {
  for (const [label, block] of [
    ['mode', 'mode: off'],
    ['alias', 'requireReview: false'],
  ]) {
    const dir = gateRoot({
      'cordis.patch.yml': (text) =>
        text.replace(
          /^(\s*)spawn:\s*$/m,
          (line, indent) => `${indent}review:\n${indent}  ${block}\n${indent}spawn:`,
        ),
    })
    try {
      const report = await checkComponents(dir)
      assert.equal(report.ok, false, label)
      assert.ok(
        report.findings.some(
          (entry) =>
            entry.code === 'review-policy-switch' && /review\.(?:mode|requireReview)/.test(entry.message),
        ),
        `${label}: ${JSON.stringify(report.findings, null, 2)}`,
      )
    } finally {
      removeTemp(dir)
    }
  }
})

test('integration: the #133/#135/#136 shapes and a foreign override fail the gate (#138)', async () => {
  const hostConfig = (block) => (text) =>
    text.replace(
      /^(            send:\n              interruptDefault: true\n)/m,
      (match) => `${match}${block}`,
    )
  const cases = [
    ['docs', '            docs:\n              board: false\n'],
    ['archive', '            archive:\n              enabled: false\n'],
    ['tests', '            tests:\n              enabled: false\n'],
  ]
  for (const [label, block] of cases) {
    const dir = gateRoot({ 'cordis.patch.yml': hostConfig(block) })
    try {
      const report = await checkComponents(dir)
      assert.equal(report.ok, false)
      assert.ok(
        report.findings.some((entry) => entry.code === 'row-override-unknown'),
        `${label}: ${JSON.stringify(report.findings, null, 2)}`,
      )
    } finally {
      removeTemp(dir)
    }
  }

  const dir = gateRoot({
    'cordis.patch.yml': (text) =>
      text.replace(
        "    - id: tower-board\n      name: 'dsh-tower/board'",
        "    - id: tower-board\n      name: 'dsh-tower/board'\n      config:\n        mode:\n          workspaceLock: true",
      ),
  })
  try {
    const report = await checkComponents(dir)
    assert.equal(report.ok, false)
    assert.ok(
      report.findings.some((entry) => entry.code === 'row-override-foreign' && /tower-board/.test(entry.message)),
      JSON.stringify(report.findings, null, 2),
    )
  } finally {
    removeTemp(dir)
  }
})

test('integration: a shipped patch outside the policy or a listed patch that is missing fails (#138)', async () => {
  const extra = gateRoot()
  try {
    fs.mkdirSync(path.join(extra, 'packages', 'tower-extra'), { recursive: true })
    fs.writeFileSync(path.join(extra, 'packages', 'tower-extra', 'cordis.patch.yml'), '- insert:\n    - id: tower-extra\n')
    const report = await checkComponents(extra)
    assert.equal(report.ok, false)
    assert.ok(report.findings.some((entry) => entry.code === 'patch-unclassified'))
  } finally {
    removeTemp(extra)
  }

  const missing = gateRoot()
  try {
    fs.rmSync(path.join(missing, 'ui-bundle', 'cordis.patch.yml'))
    const report = await checkComponents(missing)
    assert.equal(report.ok, false)
    assert.ok(report.findings.some((entry) => entry.code === 'patch-missing'))
  } finally {
    removeTemp(missing)
  }
})

test('integration: a new OPERATIONAL_TOOLS route to tower_merge fails the gate', async () => {
  const dir = gateRoot({
    'host/tool-registry.js': (text) =>
      text.replace('new Map()', "new Map([['tower_merge', 'exposeBatch']])"),
  })
  try {
    const report = await checkComponents(dir)
    assert.equal(report.ok, false)
    assert.ok(
      report.findings.some((entry) => entry.code === 'forbidden-tool-gate' && /tower_merge/.test(entry.message)),
      JSON.stringify(report.findings, null, 2),
    )
  } finally {
    removeTemp(dir)
  }
})

// F11: a reformatted table (trailing comma, one entry per line) or a rewritten
// `Map.set(...)` route must still be imported and checked, or a forbidden switch
// could be added without the gate noticing.
test('F11: an imported route table with a trailing comma and Map.set routes is checked', async () => {
  const dir = gateRoot({
    'host/tool-registry.js': () => read('tests/fixtures/component-surface/registry-routes.txt'),
  })
  try {
    const report = await checkComponents(dir)
    assert.equal(report.ok, false)
    assert.ok(
      report.findings.some((entry) => entry.code === 'forbidden-tool-gate' && /tower_merge/.test(entry.message)),
      JSON.stringify(report.findings, null, 2),
    )
  } finally {
    removeTemp(dir)
  }
})

test('integration: an unreadable or exportless registry fails closed (#138)', async () => {
  for (const source of ['', 'export const NOPE = new Map()\n', 'export const OPERATIONAL_TOOLS = []\n']) {
    const dir = gateRoot({ 'host/tool-registry.js': () => source })
    try {
      const report = await checkComponents(dir)
      assert.equal(report.ok, false)
      assert.ok(
        report.findings.some((entry) => entry.code === 'registry-unreadable'),
        JSON.stringify(report.findings, null, 2),
      )
    } finally {
      removeTemp(dir)
    }
  }

  // A missing file is not the legitimate empty table either.
  const dir = gateRoot()
  try {
    fs.rmSync(path.join(dir, 'host/tool-registry.js'))
    const report = await checkComponents(dir)
    assert.equal(report.ok, false)
    assert.ok(report.findings.some((entry) => entry.code === 'registry-unreadable'))
  } finally {
    removeTemp(dir)
  }
})

test('the root language meta states the tower group off consequence (#132)', () => {
  const surface = realSurface()
  const locales = realLocales()
  assert.deepEqual(checkGroupLabelCoverage(surface, locales), [])
  for (const file of ['locale/en.json', 'locale/zh.json']) {
    const consequence = locales[file].components.tower.disables
    assert.ok(
      locales[file].meta.description.includes(consequence),
      `${file} meta.description carries the off consequence verbatim`,
    )
  }
  const stripped = {
    ...locales,
    'locale/en.json': {
      ...locales['locale/en.json'],
      meta: { ...locales['locale/en.json'].meta, description: 'Mission planning, isolated worktrees.' },
    },
  }
  assert.ok(checkGroupLabelCoverage(surface, stripped).some((entry) => entry.code === 'group-locale'))
})

test('a row that ships in its own package needs its own meta label (#134)', () => {
  const ids = ['tower-ui']
  const meta = realMetaLocales()
  assert.deepEqual(checkMetaLabelCoverage(ids, meta, OFF_EFFECT_LABEL), [])
  const stripped = {
    ...meta,
    'ui-bundle/locale/zh.json': { meta: { title: 'Tower 界面', description: '显示界面。' } },
  }
  assert.ok(checkMetaLabelCoverage(ids, stripped, OFF_EFFECT_LABEL).some((entry) => entry.code === 'meta-locale'))
})

test('every visible row has a label source (#134)', () => {
  assert.deepEqual(checkRowLabelSources(realMergedPatch(), ROW_LOCALES), [])
  const withoutBoard = ROW_LOCALES.filter((row) => row.component !== 'tower-board')
  assert.ok(
    checkRowLabelSources(realMergedPatch(), withoutBoard).some(
      (entry) => entry.code === 'row-locale-missing' && /tower-board/.test(entry.message),
    ),
  )
})

test('integration: a row added to ui-bundle/cordis.patch.yml without a classification fails the gate (#134)', async () => {
  const dir = gateRoot({
    'ui-bundle/cordis.patch.yml': (text) =>
      `${text}    - id: tower-spectrum\n      name: 'dsh-tower-spectrum'\n`,
  })
  try {
    const report = await checkComponents(dir)
    assert.equal(report.ok, false)
    assert.ok(
      report.findings.some(
        (entry) => entry.code === 'component-unclassified' && /tower-spectrum/.test(entry.message),
      ),
      JSON.stringify(report.findings, null, 2),
    )
  } finally {
    removeTemp(dir)
  }
})

test('integration: a group meta description without the off consequence fails the gate (#132)', async () => {
  const dir = gateRoot({
    'locale/en.json': (text) => {
      const data = JSON.parse(text)
      data.meta.description = 'Mission planning, isolated worktrees.'
      return `${JSON.stringify(data, null, 2)}\n`
    },
  })
  try {
    const report = await checkComponents(dir)
    assert.equal(report.ok, false)
    assert.ok(
      report.findings.some((entry) => entry.code === 'group-locale'),
      JSON.stringify(report.findings, null, 2),
    )
  } finally {
    removeTemp(dir)
  }
})

// #137: the copy gate. Each case tampers one user-facing field on a throwaway
// root, so the shipped copy passes and a leak fails with a greppable code.
const tamperLocale = (text, edit) => {
  const data = JSON.parse(text)
  edit(data)
  return `${JSON.stringify(data, null, 2)}\n`
}

test('integration: config-key syntax in an English off sentence fails the copy gate (#137)', async () => {
  const dir = gateRoot({
    'locale/en.json': (text) =>
      tamperLocale(text, (data) => {
        data.components['tower-tests'].disables += ' With gates.requireTests:true planning is refused.'
      }),
  })
  try {
    const report = await checkComponents(dir)
    assert.equal(report.ok, false)
    assert.ok(
      report.findings.some((entry) => entry.code === 'locale-copy-config-key'),
      JSON.stringify(report.findings, null, 2),
    )
  } finally {
    removeTemp(dir)
  }
})

test('integration: a bare tool id in the Chinese off sentence fails the copy gate (#137)', async () => {
  const dir = gateRoot({
    'locale/zh.json': (text) =>
      tamperLocale(text, (data) => {
        data.components['tower-batch'].disables = '不再注册 tower_batch；任务线、合并与其他能力继续工作。'
      }),
  })
  try {
    const report = await checkComponents(dir)
    assert.equal(report.ok, false)
    assert.ok(
      report.findings.some((entry) => entry.code === 'locale-copy-tool-id'),
      JSON.stringify(report.findings, null, 2),
    )
  } finally {
    removeTemp(dir)
  }
})

test('integration: an untranslated English noun in Chinese copy fails the copy gate (#137)', async () => {
  const dir = gateRoot({
    'locale/zh.json': (text) =>
      tamperLocale(text, (data) => {
        data.components['tower-batch'].summary = '把 mission 收进一个批次。'
      }),
  })
  try {
    const report = await checkComponents(dir)
    assert.equal(report.ok, false)
    assert.ok(
      report.findings.some(
        (entry) => entry.code === 'locale-copy-untranslated' && /mission/.test(entry.message),
      ),
      JSON.stringify(report.findings, null, 2),
    )
  } finally {
    removeTemp(dir)
  }
})

test('integration: a glossary term mismatch between zh and en fails the copy gate (#137)', async () => {
  const dir = gateRoot({
    'locale/zh.json': (text) =>
      tamperLocale(text, (data) => {
        data.components.tower.disables = '关闭该行等同于卸载 Tower：不再保留任何工具、预置或技能。'
      }),
  })
  try {
    const report = await checkComponents(dir)
    assert.equal(report.ok, false)
    assert.ok(
      report.findings.some(
        (entry) => entry.code === 'locale-glossary' && /预设/.test(entry.message),
      ),
      JSON.stringify(report.findings, null, 2),
    )
  } finally {
    removeTemp(dir)
  }
})

test('integration: a hand-written ui-bundle meta label that drifts from the root source fails (#137)', async () => {
  const dir = gateRoot({
    'ui-bundle/locale/en.json': (text) =>
      tamperLocale(text, (data) => {
        data.meta.description += ' Extra copy.'
      }),
  })
  try {
    const report = await checkComponents(dir)
    assert.equal(report.ok, false)
    assert.ok(
      report.findings.some((entry) => entry.code === 'meta-row-copy'),
      JSON.stringify(report.findings, null, 2),
    )
  } finally {
    removeTemp(dir)
  }
})

test('integration: a missing GLOSSARY.md fails the copy gate (#137)', async () => {
  const dir = gateRoot()
  try {
    fs.rmSync(path.join(dir, 'GLOSSARY.md'))
    const report = await checkComponents(dir)
    assert.equal(report.ok, false)
    assert.ok(
      report.findings.some((entry) => entry.code === 'glossary-missing'),
      JSON.stringify(report.findings, null, 2),
    )
  } finally {
    removeTemp(dir)
  }
})
