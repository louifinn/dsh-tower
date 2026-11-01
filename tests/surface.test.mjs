// Concept budget (#84): the live surface equals the committed baseline, the
// generated references carry the same count line, and the brake fails for a
// seeded growth without an ADR or a matching deletion.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'

import { configSurface, resolveTowerConfig } from '../domain/config/schema.js'
import {
  parseBaseline,
  surfaceLine,
  validateBaseline,
  validateClassification,
} from '../domain/surface.js'
import { readBaseline } from '../scripts/lib/surface.mjs'
import { liveSurface } from '../scripts/surface-baseline.mjs'
import {
  definedToolCount,
  definedToolNames,
  recordToolRegistration,
  __testResetToolSurface,
} from '../host/tool-registry.js'
import { runDoctor } from '../host/doctor.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The tool names docs:check derives from source, reproduced so the test pins
 * the same definition of "documented surface" the docs gate uses.
 */
function documentedToolNames() {
  const modules = fs
    .readdirSync(path.join(root, 'tools'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(root, 'tools', name), 'utf8'))
    .join('\n')
  const source =
    fs.readFileSync(path.join(root, 'tools', 'index.js'), 'utf8') +
    modules +
    fs.readFileSync(path.join(root, 'host', 'tool-registry.js'), 'utf8') +
    fs.readFileSync(path.join(root, 'index.js'), 'utf8')
  return [...new Set([...source.matchAll(/name: '(tower_[a-z_]+)'/g)].map((match) => match[1]))]
    .filter((name) => name !== 'tower-control')
    .sort()
}

function baselineFor(values, decisions = {}, seeds = {}) {
  return parseBaseline({
    schema: 1,
    date: '2026-10-23',
    surfaces: {
      configKeys: {
        seed: seeds.configKeys ?? values.configKeys ?? 1,
        value: values.configKeys ?? 1,
        decisions: decisions.configKeys ?? [],
      },
      sections: {
        seed: seeds.sections ?? values.sections ?? 1,
        value: values.sections ?? 1,
        decisions: decisions.sections ?? [],
      },
      tools: {
        seed: seeds.tools ?? values.tools ?? 1,
        value: values.tools ?? 1,
        decisions: decisions.tools ?? [],
      },
      components: {
        seed: seeds.components ?? values.components ?? 1,
        value: values.components ?? 1,
        decisions: decisions.components ?? [],
      },
    },
  })
}

function currentFor(values, names = {}) {
  return {
    configKeys: values.configKeys,
    sections: values.sections,
    tools: values.tools,
    components: values.components ?? 1,
    liveNames: {
      configKeys: names.configKeys ?? [],
      sections: names.sections ?? [],
      tools: names.tools ?? [],
      components: names.components ?? [],
    },
  }
}

test('the live surface equals the committed baseline and is fully classified', () => {
  const current = liveSurface()
  const baseline = readBaseline(root)
  assert.equal(current.configKeys, baseline.surfaces.configKeys.value)
  assert.equal(current.sections, baseline.surfaces.sections.value)
  assert.equal(current.tools, baseline.surfaces.tools.value)
  assert.equal(current.components, baseline.surfaces.components.value)
  assert.equal(current.configKeys, configSurface().count)
  // #120/#121/#133/#134/#135: the component surface is every visible row in
  // every shipped cordis.patch.yml (root + ui-bundle).
  assert.equal(current.components, 11)
  assert.deepEqual(current.liveNames.components, [
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

  const classification = fs.readFileSync(path.join(root, 'docs', 'reference', 'surface-budget.md'), 'utf8')
  const result = validateClassification(classification, current.liveNames, { baselineDate: baseline.date })
  assert.deepEqual(result.findings, [])

  for (const file of ['config.generated.md', 'tools.generated.md']) {
    const generated = fs.readFileSync(path.join(root, 'docs', 'reference', file), 'utf8')
    const line = surfaceLine({
      configKeys: baseline.surfaces.configKeys.value,
      sections: baseline.surfaces.sections.value,
      tools: baseline.surfaces.tools.value,
    })
    assert.ok(generated.includes(`> Surface: ${line} · baseline ${baseline.date}.`), `${file} carries the generated count line`)
  }

  // #118: the count covers the full registered surface, including the two tools
  // index.js registers directly, and agrees with the count docs:check derives.
  assert.equal(current.tools, 29)
  assert.ok(current.liveNames.tools.includes('tower_mode'))
  assert.ok(current.liveNames.tools.includes('tower_control'))
  assert.deepEqual(current.liveNames.tools, documentedToolNames())
  const generatedTools = fs.readFileSync(path.join(root, 'docs', 'reference', 'tools.generated.md'), 'utf8')
  for (const name of current.liveNames.tools) {
    assert.ok(generatedTools.includes(`| \`${name}\` |`), `tools.generated.md lists ${name}`)
  }

  // #118 fixture: a tool registered directly (outside define()) is counted once
  // the Host entry records it through the same recorder.
  __testResetToolSurface()
  try {
    recordToolRegistration('tower_fixture_direct')
    assert.equal(definedToolCount(), 1)
    assert.deepEqual(definedToolNames(), ['tower_fixture_direct'])
  } finally {
    __testResetToolSurface()
  }
})

test('tower_doctor prints the surface counts plus the baseline date', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-surface-doctor-'))
  try {
    const dir = path.join(repo, '.git', 'dsh-tower')
    fs.mkdirSync(dir, { recursive: true })
    const current = liveSurface()
    const tower = {
      root: repo,
      commonDir: path.join(repo, '.git'),
      paths: {
        state: path.join(dir, 'state.json'),
        dir,
        lock: path.join(dir, 'state.lock'),
        gitLock: path.join(dir, 'git.lock'),
      },
      config: resolveTowerConfig({}),
      async load() {
        throw new Error('not initialized')
      },
    }
    const report = await runDoctor({
      tower,
      ctx: { get() { return undefined } },
      agent: null,
      surface: { tools: current.tools },
    })
    const check = report.checks.find((entry) => entry.id === 'surface')
    assert.equal(check.status, 'pass')
    assert.match(check.detail, new RegExp(`^${surfaceLine(current).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.equal(report.surface.line, surfaceLine(current))
    assert.equal(report.surface.configKeys, current.configKeys)
    assert.equal(report.surface.sections, current.sections)
    assert.equal(report.surface.tools, current.tools)
    assert.equal(report.surface.baselineDate, readBaseline(root).date)
    // #118: the doctor line, the generated reference and docs:check agree.
    assert.equal(report.surface.line, surfaceLine({ configKeys: 54, sections: 14, tools: 29 }))
    assert.equal(current.tools, 29)
    assert.equal(current.tools, documentedToolNames().length)
    const generatedTools = fs.readFileSync(path.join(root, 'docs', 'reference', 'tools.generated.md'), 'utf8')
    assert.ok(generatedTools.includes(`> Surface: ${surfaceLine(current)} · baseline ${readBaseline(root).date}.`))
  } finally {
    removeTemp(repo)
  }
})

test('a baseline that matches the live counts and decision chain passes', () => {
  const baseline = baselineFor({ configKeys: 2 }, {
    configKeys: [{ from: 1, to: 2, date: '2026-10-23', adr: 'docs/adr/0004-surface-budget.md' }],
  }, { configKeys: 1 })
  const findings = validateBaseline(baseline, currentFor({ configKeys: 2, sections: 1, tools: 1 }), {
    exists: (relative) => relative === 'docs/adr/0004-surface-budget.md',
  })
  assert.deepEqual(findings, [])

  // #118: a measurement correction with a reason, a date and a resolving
  // reference authorizes the 27 -> 29 step it names (and only that step).
  const corrected = baselineFor({ configKeys: 2, sections: 1, tools: 29 }, {
    tools: [{
      from: 27,
      to: 29,
      date: '2026-10-23',
      correction: {
        reason: 'the 2.3.0 measurement recorded only the define() path; the shipped surface was always 29',
        date: '2026-10-23',
        ref: 'docs/adr/0004-surface-budget.md',
      },
    }],
  }, { configKeys: 2, tools: 27 })
  assert.deepEqual(
    validateBaseline(corrected, currentFor({ configKeys: 2, sections: 1, tools: 29 }), {
      exists: (relative) => relative === 'docs/adr/0004-surface-budget.md',
    }),
    [],
  )
})

test('growth that is not recorded in the baseline fails', () => {
  const baseline = baselineFor({ configKeys: 1 })
  const findings = validateBaseline(baseline, currentFor({ configKeys: 2, sections: 1, tools: 1 }))
  assert.ok(findings.some((finding) => finding.code === 'stale-baseline'))
  assert.match(findings[0].message, /configKeys grew from the committed baseline 1 to 2/)
})

test('a decision that grows without an existing ADR fails', () => {
  const baseline = baselineFor({ configKeys: 2 }, {
    configKeys: [{ from: 1, to: 2, date: '2026-10-23', adr: 'docs/adr/9999-missing.md' }],
  }, { configKeys: 1 })
  const findings = validateBaseline(baseline, currentFor({ configKeys: 2, sections: 1, tools: 1 }), {
    exists: () => false,
  })
  assert.ok(findings.some((finding) => finding.code === 'growth-without-evidence'))

  // #118: an incomplete correction is not evidence. A reason and a resolving
  // reference are what separate a measurement correction from silent growth.
  const noReason = baselineFor({ configKeys: 2 }, {
    configKeys: [{ from: 1, to: 2, date: '2026-10-23', correction: { date: '2026-10-23' } }],
  }, { configKeys: 1 })
  const noReasonFindings = validateBaseline(noReason, currentFor({ configKeys: 2, sections: 1, tools: 1 }), {
    exists: () => false,
  })
  assert.ok(noReasonFindings.some((finding) => finding.code === 'correction-invalid'))
  assert.ok(noReasonFindings.some((finding) => finding.code === 'growth-without-evidence'))

  const missingRef = baselineFor({ configKeys: 2 }, {
    configKeys: [{
      from: 1,
      to: 2,
      date: '2026-10-23',
      correction: { reason: 'a correction that points nowhere', date: '2026-10-23', ref: 'docs/adr/9999-missing.md' },
    }],
  }, { configKeys: 1 })
  const missingRefFindings = validateBaseline(missingRef, currentFor({ configKeys: 2, sections: 1, tools: 1 }), {
    exists: () => false,
  })
  assert.ok(missingRefFindings.some((finding) => finding.code === 'correction-invalid'))
})

test('a matching deletion that is really gone authorizes growth; one still live does not', () => {
  const baseline = baselineFor({ configKeys: 2 }, {
    configKeys: [{ from: 1, to: 2, date: '2026-10-23', deletions: ['legacy.key'] }],
  }, { configKeys: 1 })
  const gone = validateBaseline(baseline, currentFor({ configKeys: 2, sections: 1, tools: 1 }, { configKeys: ['new.key'] }))
  assert.deepEqual(gone, [])

  const live = validateBaseline(baseline, currentFor({ configKeys: 2, sections: 1, tools: 1 }, { configKeys: ['legacy.key'] }))
  assert.ok(live.some((finding) => finding.code === 'growth-without-evidence'))
  assert.match(live.find((finding) => finding.code === 'growth-without-evidence').message, /still in the live surface/)
})

test('config keys are two-way: a shrink needs a decision, while sections and tools stay cheap', () => {
  // #138: removing a switch is a capability decision, so the config-key count may
  // not ratchet down silently.
  const shrink = baselineFor({ configKeys: 1 }, {}, { configKeys: 2 })
  const shrinkFindings = validateBaseline(shrink, currentFor({ configKeys: 1, sections: 1, tools: 1 }))
  assert.ok(shrinkFindings.some((finding) => finding.code === 'broken-chain'))
  assert.match(shrinkFindings[0].message, /every count change needs a decision record/)

  // A dated decision reaches the lower count.
  const recorded = baselineFor(
    { configKeys: 1 },
    { configKeys: [{ from: 2, to: 1, date: '2026-11-03', adr: 'docs/adr/0005-component-surface.md' }] },
    { configKeys: 2 },
  )
  assert.deepEqual(
    validateBaseline(recorded, currentFor({ configKeys: 1, sections: 1, tools: 1 }), {
      exists: (relative) => relative === 'docs/adr/0005-component-surface.md',
    }),
    [],
  )

  // Sections keep the ADR 0004 cheap-shrink rule.
  const sections = baselineFor({ sections: 1 }, {}, { sections: 2 })
  assert.deepEqual(validateBaseline(sections, currentFor({ configKeys: 1, sections: 1, tools: 1 })), [])
})

test('a two-way decision must be dated, not just reach the new count (#138)', () => {
  // ADR 0005 and the reference page say a two-way change needs a *dated*
  // decision. A bare from/to record must therefore fail even when its chain
  // reaches the committed value: otherwise a config-key removal passes the gate
  // with an undated note.
  const undatedShrink = baselineFor(
    { configKeys: 52 },
    { configKeys: [{ from: 53, to: 52 }] },
    { configKeys: 53 },
  )
  const shrinkFindings = validateBaseline(undatedShrink, currentFor({ configKeys: 52, sections: 1, tools: 1 }))
  const shrinkDates = shrinkFindings.filter(
    (finding) => finding.code === 'broken-chain' && /\.date is required/.test(finding.message),
  )
  assert.equal(shrinkDates.length, 1, JSON.stringify(shrinkFindings))
  assert.match(shrinkDates[0].message, /configKeys\.decisions\[0\]\.date is required/)

  // The same applies to growth whose only evidence is a matching deletion: the
  // deletion proves the count moved, the date says when the decision was made.
  const undatedGrowth = baselineFor(
    { configKeys: 65 },
    { configKeys: [{ from: 64, to: 65, deletions: ['gone.key'] }] },
    { configKeys: 64 },
  )
  const growthFindings = validateBaseline(
    undatedGrowth,
    currentFor({ configKeys: 65, sections: 1, tools: 1 }, { configKeys: ['new.key'] }),
  )
  assert.equal(growthFindings.length, 1, JSON.stringify(growthFindings))
  assert.equal(growthFindings[0].code, 'broken-chain')
  assert.match(growthFindings[0].message, /\.date is required/)

  // A present-but-malformed date is still refused.
  const malformed = baselineFor(
    { configKeys: 52 },
    { configKeys: [{ from: 53, to: 52, date: '11/03/2026' }] },
    { configKeys: 53 },
  )
  const malformedFindings = validateBaseline(malformed, currentFor({ configKeys: 52, sections: 1, tools: 1 }))
  assert.ok(malformedFindings.some((finding) => finding.code === 'broken-chain' && /not YYYY-MM-DD/.test(finding.message)))

  // The dated form of both decisions passes, so the brake is on the date, not on
  // the direction of the change.
  const datedShrink = baselineFor(
    { configKeys: 52 },
    { configKeys: [{ from: 53, to: 52, date: '2026-11-03' }] },
    { configKeys: 53 },
  )
  assert.deepEqual(validateBaseline(datedShrink, currentFor({ configKeys: 52, sections: 1, tools: 1 })), [])
  const datedGrowth = baselineFor(
    { configKeys: 65 },
    { configKeys: [{ from: 64, to: 65, date: '2026-11-03', deletions: ['gone.key'] }] },
    { configKeys: 64 },
  )
  assert.deepEqual(
    validateBaseline(datedGrowth, currentFor({ configKeys: 65, sections: 1, tools: 1 }, { configKeys: ['new.key'] })),
    [],
  )
})

test('a value that does not match its decision chain fails, so edits need a record', () => {
  const baseline = baselineFor({ tools: 5 }, { tools: [{ from: 4, to: 4 }] })
  const findings = validateBaseline(baseline, currentFor({ configKeys: 1, sections: 1, tools: 5 }))
  assert.ok(findings.some((finding) => finding.code === 'broken-chain'))
})

test('classification: a missing key, a duplicate and a niche without removal note all fail', () => {
  const text = `# Surface budget

Decision date: 2026-10-23

## Config keys

| Key | Class | Note |
|---|---|---|
| \`a\` | core | one |
| \`a\` | core | duplicate |
| \`b\` | niche | added for a workflow |

## Tools

| Tool | Class | Note |
|---|---|---|
| \`tower_a\` | core | one |
`
  const result = validateClassification(text, { configKeys: ['a', 'b', 'c'], sections: [], tools: ['tower_a', 'tower_b'] })
  const codes = result.findings.map((finding) => finding.code)
  assert.ok(codes.includes('classification-duplicate'))
  assert.ok(codes.includes('classification-missing'))
  assert.ok(codes.includes('niche-removal-note'))
})

test('classification: a niche entry with a removal note satisfies the mechanism', () => {
  const text = `# Surface budget

Decision date: 2026-10-23

## Config keys

| Key | Class | Note |
|---|---|---|
| \`a\` | core | one |
| \`b\` | niche | one workflow. Removal note: fold into a in the next minor. |

## Tools

| Tool | Class | Note |
|---|---|---|
| \`tower_a\` | optional | one |
`
  const result = validateClassification(text, { configKeys: ['a', 'b'], sections: [], tools: ['tower_a'] })
  assert.deepEqual(result.findings, [])
})
