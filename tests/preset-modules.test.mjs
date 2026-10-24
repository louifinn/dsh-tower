// The two preset-declaring rows own their module and label (#121).
//
// DSH labels a row from `readPluginMeta(row.moduleName)` and both preset rows
// used to mount `@deepseek-ai/dsh-agent-preset`. That shared module is also not
// resolvable from this package, so Tower could not attach per-row locale files
// to it. These tests pin the replacement contract:
//
//   1. `cordis.patch.yml` points each row at a Tower-owned module and keeps the
//      original id/name/description/order/plugins config unchanged.
//   2. Each module is an import-free object plugin that injects `agentPresets`,
//      forwards the row config to `register(config)`, and returns the registry's
//      disposer so disabling the row unregisters the preset.
//   3. The modules register exactly the ids/names/orders/plugins the old rows
//      declared (the expected config below is asserted against the patch text as
//      well, so a config edit cannot silently diverge).
//
// The real loaded surface is proved by `npm run smoke:mount`; its oracle
// (`scripts/mount-smoke/surface.mjs`) pins the same names and orders.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as workerModule from '../host/preset-worker.js'
import * as reviewerModule from '../host/preset-reviewer.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const patch = read('cordis.patch.yml')

const ROWS = [
  {
    rowId: 'preset-tower-worker',
    specifier: 'preset-worker',
    file: 'host/preset-worker.js',
    module: workerModule,
    config: {
      id: 'tower-worker',
      name: 'Tower Worker',
      description: 'Executes one Tower mission inside its assigned git worktree.',
      order: 60,
      plugins: [
        { id: 'tower-worker-policy', name: 'dsh-tower/worker' },
        { id: 'tower-worker-fs', name: '@deepseek-ai/dsh-tool-fs' },
        { id: 'tower-worker-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
        { id: 'tower-worker-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' },
      ],
    },
  },
  {
    rowId: 'preset-tower-reviewer',
    specifier: 'preset-reviewer',
    file: 'host/preset-reviewer.js',
    module: reviewerModule,
    config: {
      id: 'tower-reviewer',
      name: 'Tower Reviewer',
      description: 'Read-only independent reviewer for a completed Tower mission.',
      order: 61,
      plugins: [
        { id: 'tower-reviewer-policy', name: 'dsh-tower/reviewer' },
        { id: 'tower-reviewer-fs', name: '@deepseek-ai/dsh-tool-fs', config: { write: false, edit: false, readImage: false } },
        { id: 'tower-reviewer-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
      ],
    },
  },
]

/** One row's indented block of `cordis.patch.yml`, as text. */
function rowBlock(id) {
  const lines = patch.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^\\s*- id: ${id}\\s*$`).test(line))
  assert.notEqual(start, -1, `cordis.patch.yml ships row ${id}`)
  const indent = /^(\s*)/.exec(lines[start])[1].length
  const block = [lines[start]]
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() && !/^\s*#/.test(line) && /^(\s*)/.exec(line)[1].length <= indent) break
    block.push(line)
  }
  return { indent, text: block.join('\n') }
}

test('each preset row mounts its Tower-owned module and keeps the original config', () => {
  for (const row of ROWS) {
    const block = rowBlock(row.rowId)
    const propertyIndent = row.indent + 2
    assert.ok(
      block.text.includes(`${' '.repeat(propertyIndent)}name: 'dsh-tower/${row.specifier}'`),
      `${row.rowId} mounts dsh-tower/${row.specifier}`,
    )
    // The config block is unchanged: every expected scalar and plugin entry is
    // still in the patch, and the old shared module is not.
    assert.equal(block.text.includes('@deepseek-ai/dsh-agent-preset'), false)
    assert.ok(block.text.includes(`id: ${row.config.id}`))
    assert.ok(block.text.includes(`name: ${row.config.name}`))
    assert.ok(block.text.includes(`description: ${row.config.description}`))
    assert.ok(block.text.includes(`order: ${row.config.order}`))
    for (const plugin of row.config.plugins) {
      assert.ok(block.text.includes(`- id: ${plugin.id}`), `${row.rowId} declares plugin ${plugin.id}`)
      assert.ok(block.text.includes(`name: '${plugin.name}'`), `${row.rowId} plugin ${plugin.id} names ${plugin.name}`)
    }
    // The specifier is exported as the row's plugin entry point.
    const pkg = JSON.parse(read('package.json'))
    assert.equal(pkg.exports[`./${row.specifier}`], `./${row.file}`)
  }
})

test('the new modules are import-free object plugins that inject agentPresets', () => {
  for (const row of ROWS) {
    const source = read(row.file)
    assert.doesNotMatch(source, /^\s*import\b/m, `${row.file} has no static imports`)
    assert.doesNotMatch(source, /\bfrom\s+['"]@deepseek-ai\//, `${row.file} imports no @deepseek-ai package`)
    assert.doesNotMatch(source, /\brequire\s*\(/, `${row.file} uses no require`)
    assert.equal(row.module.default, undefined, `${row.file} is a named-export object plugin`)
    assert.equal(row.module.name, `dsh-tower/${row.specifier}`)
    assert.ok(Array.isArray(row.module.inject), `${row.file} declares inject`)
    assert.deepEqual(row.module.inject, ['agentPresets'])
    assert.equal(typeof row.module.apply, 'function')
  }
})

test('apply forwards the row config to agentPresets.register and returns its disposer', async () => {
  for (const row of ROWS) {
    const registered = []
    const disposed = []
    const mockCtx = {
      agentPresets: {
        async register(config) {
          registered.push(config)
          return async () => disposed.push(config.id)
        },
      },
    }
    const dispose = await row.module.apply(mockCtx, row.config)
    assert.equal(registered.length, 1, `${row.specifier} registers exactly one preset`)
    assert.deepEqual(registered[0], row.config, `${row.specifier} registers the unchanged row config`)
    assert.equal(typeof dispose, 'function', `${row.specifier} returns the registry disposer`)
    assert.deepEqual(disposed, [])
    await dispose()
    assert.deepEqual(disposed, [row.config.id], `${row.specifier} dispose unregisters the preset`)
  }
})

test('the two rows register distinct preset ids, names, orders and plugin lists', async () => {
  const seen = []
  for (const row of ROWS) {
    const mockCtx = {
      agentPresets: {
        async register(config) {
          seen.push(config)
          return async () => {}
        },
      },
    }
    await row.module.apply(mockCtx, row.config)
  }
  assert.deepEqual(
    seen.map((config) => [config.id, config.name, config.order]),
    [
      ['tower-worker', 'Tower Worker', 60],
      ['tower-reviewer', 'Tower Reviewer', 61],
    ],
  )
  assert.deepEqual(seen[0].plugins.map((plugin) => plugin.id), [
    'tower-worker-policy',
    'tower-worker-fs',
    'tower-worker-fs-search',
    'tower-worker-pwsh',
  ])
  assert.deepEqual(seen[1].plugins.map((plugin) => plugin.id), [
    'tower-reviewer-policy',
    'tower-reviewer-fs',
    'tower-reviewer-fs-search',
  ])
  // The read-only reviewer surface and the worker shell are not interchangeable.
  assert.ok(seen[0].plugins.some((plugin) => plugin.name === '@deepseek-ai/dsh-tool-pwsh'))
  assert.ok(!seen[1].plugins.some((plugin) => plugin.name === '@deepseek-ai/dsh-tool-pwsh'))
})

test('a registry rejection surfaces as an activation failure instead of a silent preset', async () => {
  for (const row of ROWS) {
    const mockCtx = {
      agentPresets: {
        async register() {
          throw new Error(`Duplicate agent preset: ${row.config.id}`)
        },
      },
    }
    await assert.rejects(() => row.module.apply(mockCtx, row.config), /Duplicate agent preset/)
  }
})
