// #121: the mandatory host anchor plus individually switchable optional rows.
// #122: the host owns the health contract and the recovery escape; they are
// never rows and never config keys.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCordisPatch } from '../domain/components.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')

test('the bundle patch ships a mandatory host group and optional top-level rows', () => {
  const parsed = parseCordisPatch(patch)
  assert.deepEqual(parsed.visible, [
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
  const host = parsed.rows.find((row) => row.id === 'tower')
  assert.equal(host.kind, 'group')
  assert.equal(host.scope, 'visible')
  // The worker preset is a mandatory dependency of the host, never a switch.
  assert.equal(parsed.rows.find((row) => row.id === 'preset-tower-worker').scope, 'internal')
  assert.equal(parsed.rows.find((row) => row.id === 'tower-host').scope, 'internal')
})

test('the dev reload row ships off; every optional capability owns one row', () => {
  const block = patch.slice(patch.indexOf('- id: tower-hmr'), patch.indexOf('- id: preset-tower-reviewer'))
  assert.match(block, /^\s*disabled: true\s*$/m, 'tower-hmr ships disabled')
  for (const id of ['tower-skills', 'tower-batch', 'tower-import', 'tower-leases', 'tower-tests', 'tower-board', 'tower-archive']) {
    assert.match(patch, new RegExp(`^\\s*- id: ${id}\\s*$`, 'm'), `${id} row is shipped`)
  }
  // The old all-or-nothing group and the safety-net switches are gone.
  assert.doesNotMatch(patch, /tower-bundle/)
  assert.doesNotMatch(patch, /expose(Doctor|Recovery|Operational|Batch|Import|Leases|Tests|Operational)\b/)
})

test('the package exports each capability as its own entry point', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  for (const capability of ['worker', 'reviewer', 'skills', 'batch', 'import', 'leases', 'tests', 'board', 'archive']) {
    assert.equal(typeof pkg.exports[`./${capability}`], 'string', `exports ./${capability}`)
  }
  // The HMR row needs its own entry point; it is shipped off.
  assert.equal(typeof pkg.exports['./hmr'], 'string')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})

test('reload required ids reference the new rows, not the deleted bundle group', async () => {
  const { DEFAULT_REQUIRED_IDS } = await import('../host/hmr.js')
  assert.ok(DEFAULT_REQUIRED_IDS.includes('tower'))
  assert.ok(DEFAULT_REQUIRED_IDS.includes('tower-host'))
  assert.ok(!DEFAULT_REQUIRED_IDS.includes('tower-bundle'))
  const { runtimeConfig } = await import('../host/config.js')
  assert.ok(runtimeConfig().dev.reloadRequiredIds.includes('tower'))
})
