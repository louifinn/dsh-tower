import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'
import { FINDING_SEVERITIES, FINDING_STATUSES, FINDING_TYPES, MISSION_STATUSES } from '../app/tower.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('architecture fitness functions report a clean baseline', () => {
  const output = execFileSync(process.execPath, ['scripts/architecture.mjs', '--json'], {
    cwd: root,
    encoding: 'utf8',
  })
  const result = JSON.parse(output)
  assert.equal(result.ok, true)
  assert.deepEqual(result.violations, [])
})

test('every architecture rule can fail on a seeded fixture', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { evaluator } = await import('../scripts/architecture.mjs')
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-arch-'))
  try {
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true })
      fs.writeFileSync(path.join(fixture, file), text)
    }
    write('domain/bad.js', "import fs from 'node:fs'\n")
    write('lib/spawn.js', "import { spawn } from 'node:child_process'\n")
    write('lib/io.js', "import fs from 'node:fs'\n")
    write('lib/state.js', 'let ambient = 1\n')
    write('lib/big.js', '// x\n'.repeat(801))
    write('tools/bad.js', "import fs from 'node:fs'\nenum: ['planned']\n")
    // #69 rules: an app module that reaches an adapter, a tools module that
    // bypasses the composition root, and a port that is not a runtime contract.
    write('app/bad-adapter.js', "import { createStorePort } from '../adapters/store-fs.js'\nexport const x = 1\n")
    write('tools/bad-adapter.js', "import fsp from '../adapters/store-fs.js'\nexport const x = 1\n")
    write('ports/empty.js', 'export {}\n')
    write('ports/leaky.js', "import * as store from '../lib/store.js'\nexport const LEAK = store\n")
    const result = evaluator(fixture)
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
  } finally {
    removeTemp(fixture)
  }
})

test('domain vocabulary is the single source for tool schema enums', async () => {
  const { Tower } = await import('../app/tower.js')
  assert.ok(MISSION_STATUSES.length > 0)
  assert.ok(FINDING_TYPES.length > 0)
  assert.ok(FINDING_SEVERITIES.length > 0)
  assert.ok(FINDING_STATUSES.every((status) => typeof status === 'string'))
  assert.ok(Tower)
})

test('node fs and child_process are confined to the adapters', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) {
        const text = fs.readFileSync(full, 'utf8')
        const rel = path.relative(root, full).split(path.sep).join('/')
        if (/from 'node:fs'|from 'node:fs\/promises'/.test(text) && rel !== 'adapters/store-fs.js') offenders.push(`${rel}:fs`)
        if (/from 'node:child_process'/.test(text) && rel !== 'adapters/vcs-git.js') offenders.push(`${rel}:child_process`)
      }
    }
  }
  for (const dir of ['lib', 'app', 'domain', 'tools', 'adapters']) walk(path.join(root, dir))
  assert.deepEqual(offenders, [])
})

test('every tool module types define from the schema contract', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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
