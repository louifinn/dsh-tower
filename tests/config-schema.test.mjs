// #M64: the Schemastery tree is the single source for the config surface.
// These tests are load-bearing: they mutate the tree, compare the generated
// page with the resolver, and break a copy of the docs to prove the gate fails.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import {
  Config,
  assertKnownKeys,
  configSurface,
  resolveTowerConfig,
} from '../domain/config/schema.js'
import {
  CONFIG_REFERENCE_FILE,
  configReferenceRows,
  renderConfigReference,
} from '../scripts/generate-config-reference.mjs'
import { checkConfigReference, generatedReferenceLinks } from '../scripts/check-config-reference.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const baselineFile = path.join(root, 'scripts', 'surface-baseline.json')
const handPages = ['docs/reference/config.md', 'docs/zh/reference/config.md']

function copyToTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm64-config-'))
  for (const rel of [CONFIG_REFERENCE_FILE, ...handPages, 'scripts/surface-baseline.json']) {
    const target = path.join(dir, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(root, rel), target)
  }
  return dir
}

function withTempRoot(mutate, run) {
  const dir = copyToTempRoot()
  try {
    if (mutate) mutate(dir)
    return run(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function problemsFor(mutate) {
  return withTempRoot(mutate, (dir) => checkConfigReference({ root: dir }).problems)
}

test('validation derives from the Schemastery tree, including added keys', () => {
  const before = configSurface().keys
  try {
    Config.dict.gates.dict.__probe = Schema.string().description('Probe key added by tests/config-schema.test.mjs.')
    assert.ok(configSurface().keys.includes('gates.__probe'))
    assert.doesNotThrow(() => assertKnownKeys({ gates: { __probe: 'x' } }, 'probe'))
    assert.ok(configReferenceRows().some((row) => row.key === 'gates.__probe'))
  } finally {
    delete Config.dict.gates.dict.__probe
  }
  assert.deepEqual(configSurface().keys, before)
  assert.throws(() => assertKnownKeys({ gates: { __probe: 'x' } }, 'probe'), /config-unknown-key.*gates\.__probe/)
})

test('the unknown-key suggestion list is derived, not hand-maintained', () => {
  assert.throws(() => assertKnownKeys({ nope: true }, 'probe'), /config-unknown-key[\s\S]*survey\?/)
  for (const group of configSurface().sections) {
    assert.match(renderConfigReference({ root }), new RegExp(`\\\`${group}\\.`))
  }
})

test('removing a schema key removes it from validation and the surface', () => {
  const saved = Config.dict.git.dict.timeoutMs
  try {
    delete Config.dict.git.dict.timeoutMs
    assert.ok(!configSurface().keys.includes('git.timeoutMs'))
    assert.throws(() => assertKnownKeys({ git: { timeoutMs: 1000 } }, 'probe'), /git\.timeoutMs/)
  } finally {
    Config.dict.git.dict.timeoutMs = saved
  }
  assert.ok(configSurface().keys.includes('git.timeoutMs'))
  assert.doesNotThrow(() => assertKnownKeys({ git: { timeoutMs: 1000 } }, 'probe'))
})

test('the generated reference is deterministic and equals the checked-in page', () => {
  assert.equal(renderConfigReference({ root }), renderConfigReference({ root }))
  assert.equal(renderConfigReference({ root }), fs.readFileSync(path.join(root, CONFIG_REFERENCE_FILE), 'utf8'))
})

test('header counts, rows and defaults derive from the schema and the baseline', () => {
  const surface = configSurface()
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
  const text = renderConfigReference({ root })
  assert.match(
    text,
    new RegExp(
      `config keys: ${surface.count} · sections: ${surface.sections.length} · tools: ${baseline.surfaces.tools.value} · baseline ${baseline.date}`,
    ),
  )
  const defaults = resolveTowerConfig({})
  const rows = configReferenceRows()
  assert.deepEqual(rows.map((row) => row.key), surface.keys)
  for (const row of rows) {
    const [group, key] = row.key.includes('.') ? row.key.split('.') : [null, row.key]
    const resolved = group === null ? defaults[key] : defaults[group]?.[key]
    assert.equal(row.value, resolved === undefined ? '' : JSON.stringify(resolved), row.key)
    assert.notEqual(row.description, '', `${row.key} has a description in the schema`)
  }
  assert.equal(rows.length, surface.count)
})

test('every generated default validates when fed back through resolution', () => {
  const defaults = resolveTowerConfig({})
  for (const [group, value] of Object.entries(defaults)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue
      assert.doesNotThrow(
        () => resolveTowerConfig({ [group]: { [key]: child } }),
        `${group}.${key} default must satisfy the schema`,
      )
    }
  }
})

test('resolution is a fixed point and review.mode semantics are unchanged', () => {
  const cases = [
    {},
    { section: 'custom', allowAgentControl: false },
    { review: { mode: 'off' } },
    { review: { mode: 'optional' } },
    { review: { mode: 'required' } },
    { mode: { promptSection: 'custom', allowAgentControl: false }, review: { mode: 'optional' } },
  ]
  for (const raw of cases) {
    const once = resolveTowerConfig(raw)
    assert.deepEqual(resolveTowerConfig(once), once, JSON.stringify(raw))
  }
  assert.equal(resolveTowerConfig({ review: { mode: 'off' } }).review.mode, 'off')
  assert.equal(resolveTowerConfig({ review: { mode: 'optional' } }).review.mode, 'optional')
  assert.equal(resolveTowerConfig({ review: { mode: 'required' } }).review.mode, 'required')
  assert.equal('requireReview' in resolveTowerConfig({}).review, false)
  assert.throws(
    () => resolveTowerConfig({ review: { mode: 'optional', requireReview: true } }),
    (error) => {
      assert.equal(error.code, 'config-unknown-key')
      assert.match(error.message, /review\.requireReview/)
      return true
    },
  )
})

test('removed keys still carry their upgrade note', () => {
  assert.throws(() => resolveTowerConfig({ docs: { board: {} } }), /tower-board component row/)
  assert.throws(() => resolveTowerConfig({ archive: { enabled: true } }), /tower-archive component row/)
  assert.throws(() => resolveTowerConfig({ tests: { autoChecks: true } }), /testRuns receipt/)
  assert.throws(
    () => resolveTowerConfig({ review: { requireReview: true } }),
    (error) => {
      assert.equal(error.code, 'config-unknown-key')
      assert.match(error.message, /review\.requireReview was removed on 2026-11-11/)
      assert.match(error.message, /review\.mode/)
      return true
    },
  )
})

test('hand-written config pages link the generated single source and hold no key table', () => {
  assert.ok(fs.existsSync(path.join(root, CONFIG_REFERENCE_FILE)), `${CONFIG_REFERENCE_FILE} exists`)
  for (const page of handPages) {
    const text = fs.readFileSync(path.join(root, page), 'utf8')
    const links = generatedReferenceLinks(text, page)
    assert.ok(links.length > 0, `${page} links the generated reference`)
    for (const { target, resolved } of links) {
      assert.equal(resolved, CONFIG_REFERENCE_FILE, `${page} link ${target} resolves from the page`)
      assert.ok(fs.existsSync(path.join(root, resolved)), `${page} link target ${resolved} exists`)
    }
    assert.doesNotMatch(
      text,
      /^\|\s*`(?:section|allowAgentControl|[a-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*)`\s*\|/m,
      `${page} must not restate config keys`,
    )
  }
})

test('the repository itself passes the gate', () => {
  assert.deepEqual(checkConfigReference({ root }).problems, [])
})

test('the gate catches drift, duplicates, a stale default, a changed count, a hand table and a dead link', () => {
  assert.ok(
    problemsFor((dir) => {
      const file = path.join(dir, CONFIG_REFERENCE_FILE)
      fs.appendFileSync(file, '| `gates.__extra` | `` | Not in the schema. |\n')
    }).some((problem) => problem.includes('`gates.__extra` is not a live config key')),
  )

  assert.ok(
    problemsFor((dir) => {
      const file = path.join(dir, CONFIG_REFERENCE_FILE)
      const text = fs.readFileSync(file, 'utf8')
      const row = text.split('\n').find((line) => line.startsWith('| `review.mode`'))
      fs.writeFileSync(file, `${text}${row}\n`)
    }).some((problem) => problem.includes('appears more than once')),
  )

  assert.ok(
    problemsFor((dir) => {
      const file = path.join(dir, CONFIG_REFERENCE_FILE)
      const text = fs.readFileSync(file, 'utf8')
      fs.writeFileSync(file, text.replace('| `git.timeoutMs` | `15000` |', '| `git.timeoutMs` | `9999` |'))
    }).some((problem) => problem.includes('default for `git.timeoutMs`')),
  )

  assert.ok(
    problemsFor((dir) => {
      const file = path.join(dir, CONFIG_REFERENCE_FILE)
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('config keys: 57', 'config keys: 56'))
    }).some((problem) => problem.includes('header says 56 config keys')),
  )

  assert.ok(
    problemsFor((dir) => {
      const file = path.join(dir, 'docs/reference/config.md')
      fs.appendFileSync(file, '| `review.mode` | `optional` | Hand table. |\n')
    }).some((problem) => problem.includes('restates config keys')),
  )

  assert.ok(
    problemsFor((dir) => {
      const file = path.join(dir, 'docs/zh/reference/config.md')
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('../../reference/config.generated.md', 'config.generated.md'))
    }).some((problem) =>
      problem.includes('docs/zh/reference/config.md links config.generated.md, which resolves to docs/zh/reference/config.generated.md'),
    ),
  )

  assert.ok(
    problemsFor((dir) => {
      const file = path.join(dir, 'docs/zh/reference/config.md')
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('config.generated.md', 'config.generated'))
    }).some((problem) => problem.includes('must link')),
  )
})

test('the CLI runs against --root and exits non-zero on drift', () => {
  const args = ['scripts/check-config-reference.mjs']
  const clean = withTempRoot(null, (dir) =>
    spawnSync(process.execPath, [...args, '--root', dir], { cwd: root, encoding: 'utf8' }),
  )
  assert.equal(clean.status, 0, clean.stderr)
  assert.match(clean.stdout, /config reference: \d+ keys in sync/)

  const dirty = withTempRoot((dir) => {
    fs.appendFileSync(path.join(dir, CONFIG_REFERENCE_FILE), '| `gates.__extra` | `` | Not in the schema. |\n')
  }, (dir) => spawnSync(process.execPath, [...args, '--root', dir], { cwd: root, encoding: 'utf8' }))
  assert.equal(dirty.status, 1)
  assert.match(dirty.stderr, /config reference check failed:/)
})
