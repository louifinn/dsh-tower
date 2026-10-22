// Contract tests for the mount smoke's expected-surface derivation.
//
// These are the cheap half of #95: they pin the oracle (module name -> tool id,
// skill file -> skill name, one top-level bundle row) without booting a host.
// The real loaded-surface proof is `npm run smoke:mount`.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLE_ID,
  INDEX_TOOL_IDS,
  PRESET_IDS,
  checkBundleRow,
  compareIds,
  expectedSkillIds,
  expectedToolIds,
  toolIdForModule,
} from '../scripts/mount-smoke/surface.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('a tool module file name is its tool id', () => {
  assert.equal(toolIdForModule('doctor.js'), 'tower_doctor')
  assert.equal(toolIdForModule('import-legacy.js'), 'tower_import_legacy')
  assert.equal(toolIdForModule('legacy-map.js'), 'tower_legacy_map')
  assert.equal(toolIdForModule('index.js'), null, 'the wiring module registers nothing itself')
  assert.equal(toolIdForModule('README.md'), null)
})

test('expected tool ids are the tool modules plus the host entry tools', () => {
  const modules = fs.readdirSync(path.join(root, 'tools')).filter((name) => name.endsWith('.js'))
  const ids = expectedToolIds(modules)
  assert.equal(ids.length, modules.length - 1 + INDEX_TOOL_IDS.length)
  assert.deepEqual(ids, [...ids].sort(), 'ids stay sorted for stable diagnostics')
  assert.ok(ids.includes('tower_doctor'))
  assert.ok(ids.includes('tower_import_legacy'))
  for (const id of INDEX_TOOL_IDS) assert.ok(ids.includes(id))
})

test('expected skill ids are the bundled skill files', () => {
  const files = fs.readdirSync(path.join(root, 'skills')).filter((name) => name.endsWith('.md'))
  const ids = expectedSkillIds(files)
  assert.deepEqual(ids, ['tower-recovery', 'tower-review', 'tower-worker-protocol'])
  assert.equal(ids.length, files.length)
})

test('compareIds names every missing and unexpected id', () => {
  assert.deepEqual(compareIds('tool', ['tower_a', 'tower_b'], ['tower_a', 'tower_renamed']), [
    'tool: missing tower_b',
    'tool: unexpected tower_renamed',
  ])
  assert.deepEqual(compareIds('tool', ['tower_a'], []), ['tool: missing tower_a', 'tool: loaded 0 ids, expected 1'])
})

const baseRows = [
  { id: 'session', name: '@deepseek-ai/dsh-session', group: false },
  { id: 'tools', name: '@deepseek-ai/dsh-tools', group: false },
]
const towerRow = (childIds) => ({
  id: BUNDLE_ID,
  name: 'cordis:group',
  group: true,
  childIds,
})
const expectedChildren = ['preset-tower-reviewer', 'preset-tower-worker', 'tower', 'tower-skills']
const activeStates = () => ({
  [BUNDLE_ID]: 2,
  tower: 2,
  'tower-skills': 2,
  'preset-tower-worker': 2,
  'preset-tower-reviewer': 2,
})

test('one top-level group row with the four nested sections is the #66 invariant', () => {
  const failures = checkBundleRow([towerRow(expectedChildren), ...baseRows], activeStates())
  assert.deepEqual(failures, [])
})

test('a child row leaked to the top level is named', () => {
  const children = expectedChildren.filter((id) => id !== 'tower-skills')
  const failures = checkBundleRow([towerRow(children), { id: 'tower-skills', name: 'dsh-tower/skills' }, ...baseRows], activeStates())
  assert.ok(failures.includes('bundle: tower-skills is a top-level row; it must stay nested in tower-bundle'))
  assert.ok(failures.includes('bundle: tower-bundle is missing child tower-skills'))
})

test('a missing bundle row is named', () => {
  const failures = checkBundleRow(baseRows, activeStates())
  assert.deepEqual(failures, ['bundle: no top-level tower-bundle row; the bundle did not compose'])
})

test('two bundle rows fail the single-row invariant', () => {
  const failures = checkBundleRow([towerRow(expectedChildren), towerRow(expectedChildren)], activeStates())
  assert.ok(failures.includes('bundle: found 2 top-level tower-bundle rows, expected exactly 1'))
})

test('a renamed bundle child is reported with the expected child list', () => {
  const children = ['preset-tower-reviewer', 'preset-tower-worker', 'tower-skills', 'tower-skills-next']
  const failures = checkBundleRow([towerRow(children), ...baseRows], activeStates())
  assert.ok(failures.includes('bundle: tower-bundle is missing child tower'))
  assert.ok(failures.includes('bundle: tower-bundle has unexpected child tower-skills-next'))
})

test('a composed but not mounted section is reported with its entry state', () => {
  const states = { ...activeStates(), 'tower-skills': 1 }
  const failures = checkBundleRow([towerRow(expectedChildren), ...baseRows], states)
  assert.deepEqual(failures, ['bundle: entry tower-skills is not active (entry state 1)'])
})

test('the presets claim both preset ids', () => {
  assert.deepEqual(PRESET_IDS, ['tower-reviewer', 'tower-worker'])
})

test('CI runs the seeded fixtures against one shared host install', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['smoke:fixtures'], 'node scripts/mount-smoke/fixtures.mjs')
  assert.match(workflow, /^ {2}mount-fixtures:/m, 'the fixtures run as their own job')
  assert.match(workflow, /npm run smoke:fixtures -- --host-dir/)
  assert.match(workflow, /actions\/cache@v4/, 'the pinned host install is cached between runs')
  assert.match(workflow, /hashFiles\('scripts\/mount-smoke\/host\.json'\)/)
  // Required contexts stay exactly `test (22)`, `test (24)` and `mount`; the
  // fixtures job is evidence, not a merge gate, so it must not borrow that name.
  assert.match(workflow, /node: \[22, 24\]/)
  assert.equal((workflow.match(/^ {4}name: mount$/gm) ?? []).length, 1)
  assert.doesNotMatch(workflow, /^ {4}name: mount-fixtures$/m)
})

test('the mount smoke host pin matches the newest compatibility row', () => {
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'mount-smoke', 'host.json'), 'utf8'))
  assert.match(pin.dsh, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  const row = fs
    .readFileSync(path.join(root, 'COMPATIBILITY.md'), 'utf8')
    .split('\n')
    .find((line) => /^\| \d+\.\d+\.\d+/.test(line))
  assert.ok(row, 'COMPATIBILITY.md needs a verified-host row')
  const verified = row.split('|')[1].trim()
  assert.equal(pin.dsh, verified, 'CI must mount the same host build COMPATIBILITY records; bump both via scripts/mount-smoke/host.json')
})
