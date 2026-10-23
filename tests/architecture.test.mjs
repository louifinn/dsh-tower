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
    'app/bad-lib.js': "import * as store from '../lib/store.js'\nexport const LEAK = store\n",
    'host/spawn.js': "import { spawn } from 'node:child_process'\n",
    'host/io.js': "import fs from 'node:fs'\n",
    'app/state.js': 'let ambient = 1\n',
    'host/big.js': '// x\n'.repeat(801),
    'tools/bad.js': "import fs from 'node:fs'\nenum: ['planned']\n",
    // #69 rules: an app module that reaches an adapter, a tools module that
    // bypasses the composition root, and a port that is not a runtime contract.
    'app/bad-adapter.js': "import { createStorePort } from '../adapters/store-fs.js'\nexport const x = 1\n",
    'tools/bad-adapter.js': "import fsp from '../adapters/store-fs.js'\nexport const x = 1\n",
    'ports/empty.js': 'export {}\n',
    'ports/leaky.js': "import * as store from '../adapters/store.js'\nexport const LEAK = store\n",
    // #71: the Web client tier. One seeded violation per client rule.
    'ui-bundle/client.js': "import fs from 'node:fs'\n",
    'ui-bundle/big.js': '// x\n'.repeat(801),
    'ui-bundle/ambient.js': 'let clientState = 1\n',
  }
  await withFixture(fixtureFiles, (fixture) => {
    const result = evaluator(fixture, { waivers: [] })
    const rules = new Set(result.violations.map((violation) => violation.rule))
    for (const rule of [
      'domain-pure',
      'no-lib-from-core',
      'child-process-surface',
      'fs-surface',
      'tools-thin',
      'tools-vocabulary',
      'aggregate-size',
      'host-scope',
      'app-ports-only',
      'composition-root',
      'port-shape',
      'client-no-node',
      'client-size',
      'client-ambient',
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
  assert.ok(waivers.length > 0, 'the two I/O adapter boundaries still need their documented waivers')
  for (const waiver of waivers) {
    assert.ok(typeof waiver.reason === 'string' && waiver.reason.trim().length > 0, `${waiver.path}: reason`)
    assert.ok(
      (typeof waiver.owner === 'string' && waiver.owner.trim().length > 0) ||
        (typeof waiver.ref === 'string' && waiver.ref.trim().length > 0),
      `${waiver.path}: owner or ref`,
    )
  }
  // #70: ambient state is a host privilege and the retired lib/ layer has no
  // exemptions left; the only waivers are the two I/O adapter boundaries.
  assert.ok(waivers.every((waiver) => !waiver.path.startsWith('lib/')), 'the retired lib/ layer has no waivers')
  assert.ok(
    waivers.every((waiver) => waiver.rule !== 'ambient-state' && waiver.rule !== 'host-scope'),
    'ambient state is governed by host-scope, not a waiver',
  )
})

test('an exemption without a reason fails the gate and names the file and rule', async () => {
  await withFixture({ 'adapters/store-fs.js': "import fs from 'node:fs'\n" }, (fixture) => {
    const result = evaluator(fixture, {
      waivers: [{ rule: 'fs-surface', path: 'adapters/store-fs.js', owner: 'louifinn', ref: '#80' }],
    })
    assert.equal(result.ok, false)
    const contract = result.violations.find((violation) => violation.rule === 'waiver-contract')
    assert.ok(contract, 'an unexplained waiver must be reported as a contract violation')
    assert.equal(contract.file, 'adapters/store-fs.js')
    assert.match(contract.detail, /fs-surface/)
    assert.match(contract.detail, /no reason/)
    assert.ok(
      result.violations.some((violation) => violation.rule === 'fs-surface' && violation.file === 'adapters/store-fs.js'),
      'an invalid waiver must not suppress the rule it was meant to waive',
    )
    assert.equal(result.waived, 0)
  })
})

test('a justified exemption passes and suppresses exactly its violation', async () => {
  await withFixture({ 'adapters/store-fs.js': "import fs from 'node:fs'\n" }, (fixture) => {
    const result = evaluator(fixture, {
      waivers: [
        {
          rule: 'fs-surface',
          path: 'adapters/store-fs.js',
          reason: 'the filesystem adapter is the single node:fs boundary',
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

test('host-scope allows ambient state under host/** and rejects it in app/ and domain/', async () => {
  await withFixture(
    {
      'host/ambient.js': 'let profileRaw = {}\n',
      'app/ambient.js': 'let appState = 1\n',
      'domain/ambient.js': 'let domainState = 2\n',
    },
    (fixture) => {
      const result = evaluator(fixture, { waivers: [] })
      const scope = result.violations.filter((violation) => violation.rule === 'host-scope')
      assert.deepEqual(
        scope.map((violation) => [violation.file, violation.match]).sort(),
        [
          ['app/ambient.js', 'appState'],
          ['domain/ambient.js', 'domainState'],
        ],
        'host/** is the only ambient-state home',
      )
      assert.equal(
        result.violations.some((violation) => violation.file === 'host/ambient.js'),
        false,
        'host/ambient.js is allowed to hold process state',
      )
    },
  )
})

test('host-scope records every binding and ignores nested lets', async () => {
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
  await withFixture({ 'app/ambient.js': source }, (fixture) => {
    const result = evaluator(fixture, { waivers: [] })
    assert.equal(result.ok, false)
    const matches = result.violations
      .filter((violation) => violation.rule === 'host-scope')
      .map((violation) => violation.match)
    assert.deepEqual(matches.sort(), ['alsoReal', 'fourth', 'real', 'third'])
  })
})

test('host-scope is not hidden by a statement-position regex with a brace', async () => {
  // F3: a slash after `)` used to be treated as division, so the `{` inside a
  // statement-position regex stayed unbalanced and every later top-level `let`
  // was skipped. The control-flow `)` must start a new statement, while a plain
  // call `)` still divides.
  const source = [
    'const read = (value) => value',
    'const ratio = read(4) / 2',
    'if (ratio) /{/.test(source)',
    'let leaked = ratio',
    '',
  ].join('\n')
  await withFixture({ 'app/ambient.js': source }, (fixture) => {
    const result = evaluator(fixture, { waivers: [] })
    assert.equal(result.ok, false)
    const matches = result.violations
      .filter((violation) => violation.rule === 'host-scope')
      .map((violation) => violation.match)
    assert.deepEqual(matches, ['leaked'])
  })
})

test('host-scope keeps division after a member call even when the method is named if', async () => {
  // The control-flow `)` heuristic must not fire for `helper.if(4)`: the slash
  // after a member call is division, and a later slash on the same line must not
  // be swallowed as the closing delimiter of a fake regex.
  const source = [
    'const helper = { if: (value) => value }',
    'const ratio = helper.if(4) / 2; let leaked = ratio / 1',
    '',
  ].join('\n')
  await withFixture({ 'app/ambient.js': source }, (fixture) => {
    const result = evaluator(fixture, { waivers: [] })
    assert.equal(result.ok, false)
    const matches = result.violations
      .filter((violation) => violation.rule === 'host-scope')
      .map((violation) => violation.match)
    assert.deepEqual(matches, ['leaked'])
  })
})

test('host-scope cannot be waived even with a justification', async () => {
  await withFixture({ 'app/ambient.js': 'let appState = 1\n' }, (fixture) => {
    const result = evaluator(fixture, {
      waivers: [
        {
          rule: 'host-scope',
          path: 'app/ambient.js',
          match: 'appState',
          reason: 'this would defeat the host-only ambient-state rule',
          owner: 'louifinn',
          ref: '#70',
        },
      ],
    })
    assert.equal(result.ok, false)
    const contract = result.violations.find((violation) => violation.rule === 'waiver-contract')
    assert.ok(contract, 'a host-scope waiver must be rejected as a contract violation')
    assert.match(contract.detail, /host-scope/)
    assert.match(contract.detail, /cannot be waived/)
    assert.ok(
      result.violations.some((violation) => violation.rule === 'host-scope' && violation.file === 'app/ambient.js'),
      'the rejected waiver must not suppress host-scope',
    )
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

test('no-lib-from-core rejects a lib import from app/ and domain/', async () => {
  await withFixture(
    {
      'app/bad.js': "import * as store from '../lib/store.js'\nexport const A = store\n",
      'domain/bad.js': "import * as store from '../../lib/store.js'\nexport const D = store\n",
      'host/ok.js': "import * as store from '../lib/store.js'\nexport const H = store\n",
    },
    (fixture) => {
      const result = evaluator(fixture, { waivers: [] })
      const violations = result.violations.filter((violation) => violation.rule === 'no-lib-from-core')
      assert.deepEqual(
        violations.map((violation) => violation.file).sort(),
        ['app/bad.js', 'domain/bad.js'],
        'app/ and domain/ may not import lib/; host/** is not a core layer',
      )
      assert.equal(result.ok, false)
    },
  )
})

test('no-lib-from-core cannot be waived even with a justification', async () => {
  await withFixture({ 'app/bad-lib.js': "import * as store from '../lib/store.js'\nexport const LEAK = store\n" }, (fixture) => {
    const result = evaluator(fixture, {
      waivers: [
        {
          rule: 'no-lib-from-core',
          path: 'app/bad-lib.js',
          reason: 'this would reintroduce the retired layer',
          owner: 'louifinn',
          ref: '#70',
        },
      ],
    })
    assert.equal(result.ok, false)
    const contract = result.violations.find((violation) => violation.rule === 'waiver-contract')
    assert.ok(contract, 'a no-lib-from-core waiver must be rejected as a contract violation')
    assert.match(contract.detail, /no-lib-from-core/)
    assert.match(contract.detail, /cannot be waived/)
    assert.ok(
      result.violations.some((violation) => violation.rule === 'no-lib-from-core' && violation.file === 'app/bad-lib.js'),
      'the rejected waiver must not suppress no-lib-from-core',
    )
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

test('client rules form their own tier and a clean ui-bundle passes', async () => {
  await withFixture(
    {
      'ui-bundle/client.js': "window.__ModuleLoader__.load({ id: 'dsh-tower-ui', factory() { return {} } })\n",
      'ui-bundle/client.dock.js': "window.__ModuleLoader__.load({ id: 'dsh-tower-ui', chunk: 'client.dock.js', factory() { return {} } })\n",
      'ui-bundle/index.js': 'export function apply() {}\n',
    },
    (fixture) => {
      const result = evaluator(fixture, { waivers: [] })
      assert.deepEqual(result.violations, [])
    },
  )
})

test('client-no-node rejects every Host capability import in ui-bundle/', async () => {
  const specs = ['node:fs', 'node:fs/promises', 'node:child_process', 'node:os', 'node:process']
  const files = {}
  for (const spec of specs) {
    files['ui-bundle/' + spec.replace(/[:/]/g, '-') + '.js'] = `import value from '${spec}'\nexport const V = value\n`
  }
  await withFixture(files, (fixture) => {
    const result = evaluator(fixture, { waivers: [] })
    const noNode = result.violations.filter((violation) => violation.rule === 'client-no-node')
    assert.equal(noNode.length, specs.length)
    assert.ok(noNode.every((violation) => violation.level === 'error'))
    assert.ok(noNode.every((violation) => violation.file.startsWith('ui-bundle/') && /node:/.test(violation.detail)))
  })
})

test('client-size caps a client file at 800 lines and client-ambient is statement-aware', async () => {
  await withFixture(
    {
      'ui-bundle/ok.js': '// x\n'.repeat(799),
      'ui-bundle/too-big.js': '// x\n'.repeat(800),
      'ui-bundle/ambient.js': 'let first = 1, second = 2; let third = 3\n',
    },
    (fixture) => {
      const result = evaluator(fixture, { waivers: [] })
      assert.deepEqual(
        result.violations.filter((violation) => violation.rule === 'client-size').map((violation) => violation.file),
        ['ui-bundle/too-big.js'],
      )
      assert.deepEqual(
        result.violations
          .filter((violation) => violation.rule === 'client-ambient')
          .map((violation) => violation.match)
          .sort(),
        ['first', 'second', 'third'],
      )
      assert.ok(result.violations.every((violation) => violation.level === 'error'))
    },
  )
})

test('domain metrics prints the ui-bundle client tier next to the pure-domain share', () => {
  const output = execFileSync(process.execPath, ['scripts/domain-metrics.mjs'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.match(output, /domain-metrics: pure domain share \d+\.\d+% \(\d+\/\d+\)/)
  assert.match(output, /domain-metrics: ui-bundle \d+ lines/)
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
  for (const dir of ['host', 'app', 'domain', 'tools', 'adapters', 'ports', 'ui-bundle']) walk(path.join(root, dir))
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
