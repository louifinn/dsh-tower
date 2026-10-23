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
  BUNDLE_CHILD_IDS,
  BUNDLE_ID,
  DEFAULT_OFF_ROW_IDS,
  INDEX_TOOL_IDS,
  OPTIONAL_ROW_IDS,
  PRESET_IDS,
  checkBundleRow,
  compareIds,
  defaultOffToolIds,
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

test('expected tool ids are the tool modules plus the host entry tools, minus default-off rows', () => {
  const modules = fs.readdirSync(path.join(root, 'tools')).filter((name) => name.endsWith('.js'))
  const off = defaultOffToolIds()
  const ids = expectedToolIds(modules)
  // The shipped profile: one id per tool module (index.js registers none) plus
  // the two Host entry tools, minus the tools of rows that ship off (#121).
  assert.equal(ids.length, modules.length - 1 + INDEX_TOOL_IDS.length - off.size)
  assert.equal(ids.length, 28, 'the shipped profile mounts 28 tools (tower-hmr is off)')
  assert.deepEqual(ids, [...ids].sort(), 'ids stay sorted for stable diagnostics')
  assert.ok(ids.includes('tower_doctor'))
  assert.ok(ids.includes('tower_import_legacy'))
  for (const id of INDEX_TOOL_IDS) assert.ok(ids.includes(id))
  for (const id of off) assert.ok(!ids.includes(id), `${id} belongs to a default-off row and must not be expected`)
  assert.ok(!ids.includes('tower_reload'), 'tower_reload is owned by the shipped-off tower-hmr row')

  // The build surface with every optional row on is 29, so both numbers are
  // pinned: the smoke must not silently accept the wrong one.
  const allRowsOn = expectedToolIds(modules, { enabledRows: [...BUNDLE_CHILD_IDS, ...OPTIONAL_ROW_IDS] })
  assert.equal(allRowsOn.length, 29, 'enabling tower-hmr yields the full 29-tool build surface')
  assert.ok(allRowsOn.includes('tower_reload'))
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
const hostRow = (childIds) => ({
  id: BUNDLE_ID,
  name: 'cordis:group',
  group: true,
  childIds,
})
const optionalRows = () => OPTIONAL_ROW_IDS.map((id) => ({ id, name: `dsh-tower/${id.replace(/^tower-/, '')}` }))
const expectedChildren = [...BUNDLE_CHILD_IDS].sort()
const activeStates = () => {
  const states = { [BUNDLE_ID]: 2 }
  for (const id of [...BUNDLE_CHILD_IDS, ...OPTIONAL_ROW_IDS]) states[id] = 2
  for (const id of DEFAULT_OFF_ROW_IDS) delete states[id]
  return states
}

test('one mandatory host group plus the optional top-level rows is the #121 invariant', () => {
  const failures = checkBundleRow([hostRow(expectedChildren), ...optionalRows(), ...baseRows], activeStates())
  assert.deepEqual(failures, [])
})

test('a host child leaked to the top level is named', () => {
  const children = expectedChildren.filter((id) => id !== 'tower-host')
  const failures = checkBundleRow([hostRow(children), { id: 'tower-host', name: 'dsh-tower' }, ...optionalRows(), ...baseRows], activeStates())
  assert.ok(failures.includes('bundle: tower-host is a top-level row; it must stay nested in tower'))
  assert.ok(failures.includes('bundle: tower is missing child tower-host'))
})

test('a missing host row is named', () => {
  const failures = checkBundleRow([...optionalRows(), ...baseRows], activeStates())
  assert.deepEqual(failures, ['bundle: no top-level tower host row; the bundle did not compose'])
})

test('two host rows fail the single-row invariant', () => {
  const failures = checkBundleRow([hostRow(expectedChildren), hostRow(expectedChildren), ...optionalRows(), ...baseRows], activeStates())
  assert.ok(failures.includes('bundle: found 2 top-level tower rows, expected exactly 1'))
})

test('a missing optional row is named', () => {
  const rows = optionalRows().filter((row) => row.id !== 'tower-batch')
  const failures = checkBundleRow([hostRow(expectedChildren), ...rows, ...baseRows], activeStates())
  assert.ok(failures.includes('bundle: missing optional top-level row tower-batch'))
})

test('the shipped-off dev reload row must not be active', () => {
  const states = { ...activeStates(), 'tower-hmr': 2 }
  const failures = checkBundleRow([hostRow(expectedChildren), ...optionalRows(), ...baseRows], states)
  assert.deepEqual(failures, ['bundle: tower-hmr ships disabled but is active'])
})

test('a composed but not mounted section is reported with its entry state', () => {
  const states = { ...activeStates(), 'tower-skills': 1 }
  const failures = checkBundleRow([hostRow(expectedChildren), ...optionalRows(), ...baseRows], states)
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
  // #86: every matrix leg names its own context, so adding the Windows leg must
  // not rename the two required ones (a renamed context never reports).
  assert.match(workflow, /^ {4}name: \$\{\{ matrix\.name \}\}$/m, 'matrix legs pin their context names')
  const matrixNames = [...workflow.matchAll(/^ {10}- name: (.+)$/gm)].map((match) => match[1])
  assert.deepEqual(matrixNames, ['test (22)', 'test (24)', 'test (22, windows)'])
  assert.match(workflow, /^ {12}os: windows-latest$/m, 'the Windows leg runs on windows-latest')
  assert.match(workflow, /^ {12}os: ubuntu-latest$/m, 'the required legs stay on ubuntu-latest')
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
