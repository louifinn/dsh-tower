import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'
import { evaluator, loadWaivers } from '../scripts/architecture.mjs'
import { FINDING_SEVERITIES, FINDING_STATUSES, FINDING_TYPES, MISSION_STATUSES } from '../app/tower.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function withFixture(files, run) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-arch-'))
  try {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true })
      fs.writeFileSync(path.join(fixture, file), text)
    }
    return await run(fixture)
  } finally {
    removeTemp(fixture)
  }
}

test('architecture fitness functions report a clean baseline', () => {
  const output = execFileSync(process.execPath, ['scripts/architecture.mjs', '--json'], {
    cwd: root,
    encoding: 'utf8',
  })
  const result = JSON.parse(output)
  assert.equal(result.ok, true)
  assert.deepEqual(result.violations, [])
  assert.equal(result.waivers, loadWaivers().length)
  assert.equal(result.waived, result.waivers, 'every repository waiver must suppress exactly one violation')
})

test('every architecture rule can fail on a seeded fixture', async () => {
  const fixtureFiles = {
    'domain/bad.js': "import fs from 'node:fs'\n",
    'lib/spawn.js': "import { spawn } from 'node:child_process'\n",
    'lib/io.js': "import fs from 'node:fs'\n",
    'lib/state.js': 'let ambient = 1\n',
    'lib/big.js': '// x\n'.repeat(801),
    'tools/bad.js': "import fs from 'node:fs'\nenum: ['planned']\n",
    // #69 rules: an app module that reaches an adapter, a tools module that
    // bypasses the composition root, and a port that is not a runtime contract.
    'app/bad-adapter.js': "import { createStorePort } from '../adapters/store-fs.js'\nexport const x = 1\n",
    'tools/bad-adapter.js': "import fsp from '../adapters/store-fs.js'\nexport const x = 1\n",
    'ports/empty.js': 'export {}\n',
    'ports/leaky.js': "import * as store from '../lib/store.js'\nexport const LEAK = store\n",
  }
  await withFixture(fixtureFiles, (fixture) => {
    const result = evaluator(fixture, { waivers: [] })
    const rules = new Set(result.violations.map((violation) => violation.rule))
    for (const rule of [
      'domain-pure',
      'child-process-surface',
      'fs-surface',
      'tools-thin',
      'tools-vocabulary',
      'aggregate-size',
      'ambient-state',
      'app-ports-only',
      'composition-root',
      'port-shape',
    ]) {
      assert.ok(rules.has(rule), `${rule} must be able to fail`)
    }
    for (const violation of result.violations) {
      assert.equal(violation.level, 'error', `${violation.rule} must be blocking`)
    }
  })
})

test('the green gate output reports how many waivers were applied', () => {
  const waivers = loadWaivers()
  const output = execFileSync(process.execPath, ['scripts/architecture.mjs'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(output.trim(), `architecture: ok (waivers: ${waivers.length})`)
})

test('every repository waiver is justified and targeted', () => {
  const waivers = loadWaivers()
  assert.ok(waivers.length > 0, 'the repository still needs its four documented waivers')
  for (const waiver of waivers) {
    assert.ok(typeof waiver.reason === 'string' && waiver.reason.trim().length > 0, `${waiver.path}: reason`)
    assert.ok(
      (typeof waiver.owner === 'string' && waiver.owner.trim().length > 0) ||
        (typeof waiver.ref === 'string' && waiver.ref.trim().length > 0),
      `${waiver.path}: owner or ref`,
    )
    if (waiver.rule === 'ambient-state') {
      assert.ok(typeof waiver.match === 'string' && waiver.match.trim().length > 0, `${waiver.path}: match`)
    }
  }
})

test('an exemption without a reason fails the gate and names the file and rule', async () => {
  await withFixture({ 'lib/ambient.js': 'let profileRaw = {}\n' }, (fixture) => {
    const result = evaluator(fixture, {
      waivers: [{ rule: 'ambient-state', path: 'lib/ambient.js', match: 'profileRaw', owner: 'louifinn', ref: '#80' }],
    })
    assert.equal(result.ok, false)
    const contract = result.violations.find((violation) => violation.rule === 'waiver-contract')
    assert.ok(contract, 'an unexplained waiver must be reported as a contract violation')
    assert.equal(contract.file, 'lib/ambient.js')
    assert.match(contract.detail, /ambient-state/)
    assert.match(contract.detail, /no reason/)
    assert.ok(
      result.violations.some((violation) => violation.rule === 'ambient-state' && violation.file === 'lib/ambient.js'),
      'an invalid waiver must not suppress the rule it was meant to waive',
    )
    assert.equal(result.waived, 0)
  })
})

test('a justified exemption passes and suppresses exactly its violation', async () => {
  await withFixture({ 'lib/ambient.js': 'let profileRaw = {}\n' }, (fixture) => {
    const result = evaluator(fixture, {
      waivers: [
        {
          rule: 'ambient-state',
          path: 'lib/ambient.js',
          match: 'profileRaw',
          reason: 'process-local profile snapshot owned by the config layer',
          owner: 'louifinn',
          ref: '#80',
        },
      ],
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.violations, [])
    assert.equal(result.waivers, 1)
    assert.equal(result.waived, 1)
  })
})

test('a new violation in a previously exempt file is caught', async () => {
  const waivers = loadWaivers()
  for (const file of ['lib/config.js', 'lib/git.js']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    const baseline = await withFixture({ [file]: text }, (fixture) => evaluator(fixture, { waivers }))
    assert.equal(baseline.ok, true, `${file}: the documented binding stays waived`)
    assert.equal(baseline.waived, 1, `${file}: exactly one binding is waived`)

    const injected = await withFixture(
      { [file]: `${text}\nlet newlyInjected = 1\n` },
      (fixture) => evaluator(fixture, { waivers }),
    )
    assert.equal(injected.ok, false, `${file}: a new top-level let must fail`)
    const violation = injected.violations.find(
      (candidate) => candidate.rule === 'ambient-state' && candidate.file === file,
    )
    assert.ok(violation, `${file}: ambient-state violation is missing`)
    assert.equal(violation.match, 'newlyInjected')
  }
})

test('a waivered binding cannot hide a second top-level let on the same line', async () => {
  const waivers = [
    {
      rule: 'ambient-state',
      path: 'lib/ambient.js',
      match: 'profileRaw',
      reason: 'process-local profile snapshot owned by the config layer',
      owner: 'louifinn',
      ref: '#80',
    },
  ]
  for (const text of ['let profileRaw = {}; let evil = 1\n', 'let profileRaw = {}, evil = 1\n']) {
    await withFixture({ 'lib/ambient.js': text }, (fixture) => {
      const result = evaluator(fixture, { waivers })
      const label = JSON.stringify(text)
      assert.equal(result.ok, false, `${label}: the second binding must fail`)
      const violation = result.violations.find(
        (candidate) => candidate.rule === 'ambient-state' && candidate.file === 'lib/ambient.js',
      )
      assert.ok(violation, `${label}: ambient-state violation is missing`)
      assert.equal(violation.match, 'evil', `${label}: only the new binding fails`)
      assert.equal(result.waived, 1, `${label}: the justified binding stays waived`)
    })
  }
})

test('a justified multi-binding declaration passes when every binding is named', async () => {
  await withFixture({ 'lib/ambient.js': 'let profileRaw = {}, other = 1\n' }, (fixture) => {
    const result = evaluator(fixture, {
      waivers: [
        {
          rule: 'ambient-state',
          path: 'lib/ambient.js',
          match: 'profileRaw',
          reason: 'process-local profile snapshot owned by the config layer',
          owner: 'louifinn',
          ref: '#80',
        },
        {
          rule: 'ambient-state',
          path: 'lib/ambient.js',
          match: 'other',
          reason: 'the second documented process-local binding',
          owner: 'louifinn',
          ref: '#80',
        },
      ],
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.violations, [])
    assert.equal(result.waivers, 2)
    assert.equal(result.waived, 2, 'each named binding is waived exactly once')
  })
})

test('only real module-level bindings are recorded', async () => {
  const source = [
    'const brace = /\\{[^}]*\\}/',
    "const quoted = /['\"]/",
    'const template = `let fake = 1; } ${`nested ${name}`}`',
    '// let commented = 1',
    '/* let blocked = 1 */',
    'function nested() {',
    '  let inner = 1',
    '}',
    'for (let i = 0; i < 1; i += 1) {',
    '  void i',
    '}',
    'let real = 1',
    'let alsoReal = 2, third = 3; let fourth = 4',
    '',
  ].join('\n')
  await withFixture({ 'lib/ambient.js': source }, (fixture) => {
    const result = evaluator(fixture, { waivers: [] })
    assert.equal(result.ok, false)
    const matches = result.violations
      .filter((violation) => violation.rule === 'ambient-state')
      .map((violation) => violation.match)
    assert.deepEqual(matches.sort(), ['alsoReal', 'fourth', 'real', 'third'])
  })
})

test('an ambient-state waiver must name the exact binding', async () => {
  await withFixture({ 'lib/ambient.js': 'let profileRaw = {}\n' }, (fixture) => {
    const result = evaluator(fixture, {
      waivers: [
        {
          rule: 'ambient-state',
          path: 'lib/ambient.js',
          reason: 'process-local profile snapshot',
          owner: 'louifinn',
        },
      ],
    })
    assert.equal(result.ok, false)
    const contract = result.violations.find((violation) => violation.rule === 'waiver-contract')
    assert.ok(contract, 'a file-wide ambient waiver must be rejected')
    assert.match(contract.detail, /match/)
    assert.ok(result.violations.some((violation) => violation.rule === 'ambient-state'))
  })
})

test('an exemption without an owner or reference fails the gate', async () => {
  await withFixture({ 'adapters/store-fs.js': "import fs from 'node:fs'\n" }, (fixture) => {
    const result = evaluator(fixture, {
      waivers: [{ rule: 'fs-surface', path: 'adapters/store-fs.js', reason: 'the only fs boundary' }],
    })
    assert.equal(result.ok, false)
    const contract = result.violations.find((violation) => violation.rule === 'waiver-contract')
    assert.ok(contract)
    assert.match(contract.detail, /owner or reference/)
    assert.match(contract.detail, /fs-surface/)
  })
})

test('domain-pure and domain/** cannot be waived even with a justification', async () => {
  await withFixture({ 'domain/bad.js': "import fs from 'node:fs'\n" }, (fixture) => {
    const result = evaluator(fixture, {
      waivers: [
        {
          rule: 'domain-pure',
          path: 'domain/bad.js',
          reason: 'this would defeat the load-bearing rule',
          owner: 'louifinn',
          ref: '#80',
        },
      ],
    })
    assert.equal(result.ok, false)
    const contract = result.violations.filter((violation) => violation.rule === 'waiver-contract')
    assert.ok(contract.length >= 2, 'both the rule and the domain path must reject the entry')
    assert.ok(contract.some((violation) => /domain-pure/.test(violation.detail) && /cannot be waived/.test(violation.detail)))
    assert.ok(contract.some((violation) => /domain\/\*\*/.test(violation.detail)))
    assert.ok(
      result.violations.some((violation) => violation.rule === 'domain-pure' && violation.file === 'domain/bad.js'),
      'the rejected waiver must not suppress domain-pure',
    )
  })
})

test('domain vocabulary is the single source for tool schema enums', async () => {
  const { Tower } = await import('../app/tower.js')
  assert.ok(MISSION_STATUSES.length > 0)
  assert.ok(FINDING_TYPES.length > 0)
  assert.ok(FINDING_SEVERITIES.length > 0)
  assert.ok(FINDING_STATUSES.every((status) => typeof status === 'string'))
  assert.ok(Tower)
})

test('node fs and child_process are confined to the waived adapters', () => {
  const allowedFor = (rule) =>
    new Set(loadWaivers().filter((waiver) => waiver.rule === rule).map((waiver) => waiver.path))
  const fsAllowed = allowedFor('fs-surface')
  const childProcessAllowed = allowedFor('child-process-surface')
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) {
        const text = fs.readFileSync(full, 'utf8')
        const rel = path.relative(root, full).split(path.sep).join('/')
        if (/from 'node:fs'|from 'node:fs\/promises/.test(text) && !fsAllowed.has(rel)) offenders.push(`${rel}:fs`)
        if (/from 'node:child_process'/.test(text) && !childProcessAllowed.has(rel)) offenders.push(`${rel}:child_process`)
      }
    }
  }
  for (const dir of ['lib', 'app', 'domain', 'tools', 'adapters']) walk(path.join(root, dir))
  assert.deepEqual(offenders, [])
})

test('every tool module types define from the schema contract', () => {
  const dir = path.join(root, 'tools')
  const support = new Set(['index.js', 'schema.js'])
  const offenders = []
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.js') || support.has(entry)) continue
    const text = fs.readFileSync(path.join(dir, entry), 'utf8')
    if (!text.includes('DefineTool')) offenders.push(entry)
  }
  assert.deepEqual(offenders, [])
})
