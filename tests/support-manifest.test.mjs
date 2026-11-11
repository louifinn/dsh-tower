// Published support floor (#M71 W4-A): scripts/support.json is the single
// manifest, and the manifest, package engines, lock root engines, mount-smoke
// host pin, live CI matrix and newest COMPATIBILITY row must all say the same
// thing. The fixture tests tamper with one source at a time, so a real
// disagreement fails with the file that drifted named in the message.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  evaluateSupport,
  liveMatrixPins,
  newestCompatibilityRow,
  readSupportInputs,
} from '../scripts/check-support.mjs'
import { removeTemp } from './helpers/cleanup.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(repoRoot, 'scripts', 'check-support.mjs')
const INPUT_FILES = [
  'scripts/support.json',
  'package.json',
  'package-lock.json',
  'scripts/mount-smoke/host.json',
  '.github/workflows/test.yml',
  'COMPATIBILITY.md',
]

const read = (root, relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const readJson = (root, relative) => JSON.parse(read(root, relative))
const write = (root, relative, text) => fs.writeFileSync(path.join(root, relative), text)
const writeJson = (root, relative, value) => write(root, relative, `${JSON.stringify(value, null, 2)}\n`)

/** A throwaway tree holding only the six files the gate reads. */
function supportFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-support-'))
  t.after(() => removeTemp(root))
  for (const relative of INPUT_FILES) {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(repoRoot, relative), target)
  }
  return root
}

test('the checkout states one support floor everywhere', () => {
  const inputs = readSupportInputs(repoRoot)
  const result = evaluateSupport(inputs)
  assert.deepEqual(result.problems, [])
  assert.equal(result.ok, true)
  // #M71: this is the floor the release publishes. Raising it is a deliberate
  // edit here, in scripts/support.json, and in every restatement the gate reads.
  assert.equal(result.facts.node, '>=24.9')
  assert.equal(result.facts.dsh, '0.2.2-rc.1')
  assert.equal(result.facts.packageEngine, result.facts.node)
  assert.equal(result.facts.lockEngine, result.facts.node)
  assert.equal(result.facts.hostPin, result.facts.dsh)
  assert.deepEqual(result.facts.liveMatrixPins, [result.facts.dsh])
  assert.equal(result.facts.newestRow.hostVersion, result.facts.dsh)
  assert.match(result.facts.newestRow.tag, /^v\d+\.\d+\.\d+$/)
  assert.equal(newestCompatibilityRow(inputs.compatibility).hostVersion, inputs.support.dsh)
  assert.deepEqual(liveMatrixPins(inputs.workflow), [inputs.support.dsh])
})

test('one manifest catches every disagreeing restatement', (t) => {
  /** @type {{ name: string, apply: (root: string) => void, expect: (problem: string) => boolean }[]} */
  const cases = [
    {
      name: 'package engines',
      apply(root) {
        const pkg = readJson(root, 'package.json')
        pkg.engines.node = '>=22'
        writeJson(root, 'package.json', pkg)
      },
      expect: (problem) => problem.includes('package.json: engines.node is ">=22"'),
    },
    {
      name: 'lock root engines',
      apply(root) {
        const lock = readJson(root, 'package-lock.json')
        delete lock.packages[''].engines
        writeJson(root, 'package-lock.json', lock)
      },
      expect: (problem) => problem.includes('package-lock.json (packages[""]): engines.node is missing'),
    },
    {
      name: 'lock root engines disagree',
      apply(root) {
        const lock = readJson(root, 'package-lock.json')
        lock.packages[''].engines.node = '>=22'
        writeJson(root, 'package-lock.json', lock)
      },
      expect: (problem) => problem.includes('package-lock.json (packages[""]): engines.node is ">=22"'),
    },
    {
      name: 'mount-smoke host pin',
      apply(root) {
        const pin = readJson(root, 'scripts/mount-smoke/host.json')
        pin.dsh = '0.2.1-rc.2'
        writeJson(root, 'scripts/mount-smoke/host.json', pin)
      },
      expect: (problem) => problem.includes('scripts/mount-smoke/host.json: dsh is "0.2.1-rc.2"'),
    },
    {
      name: 'live matrix pin',
      apply(root) {
        const workflow = read(root, '.github/workflows/test.yml')
        const next = workflow.replace(/^( {10}- )'0\.2\.2-rc\.1'$/m, "$1'0.2.1-rc.2'")
        assert.notEqual(next, workflow, 'fixture must contain the live matrix pin')
        write(root, '.github/workflows/test.yml', next)
      },
      expect: (problem) => problem.includes('.github/workflows/test.yml (live matrix): dsh is "0.2.1-rc.2"'),
    },
    {
      name: 'live matrix lists two pins',
      apply(root) {
        const workflow = read(root, '.github/workflows/test.yml')
        const next = workflow.replace(/^( {10}- )'0\.2\.2-rc\.1'$/m, "$1'0.2.2-rc.1'\n$1'0.2.1-rc.2'")
        assert.notEqual(next, workflow, 'fixture must contain the live matrix pin')
        write(root, '.github/workflows/test.yml', next)
      },
      expect: (problem) => problem.includes('live job matrix lists 2 dsh versions'),
    },
    {
      name: 'newest compatibility row host',
      apply(root) {
        const compatibility = read(root, 'COMPATIBILITY.md')
        const next = compatibility.replace('| 0.2.2-rc.1 |', '| 0.2.1-rc.2 |')
        assert.notEqual(next, compatibility, 'fixture must contain the newest compatibility row')
        write(root, 'COMPATIBILITY.md', next)
      },
      expect: (problem) => problem.includes('COMPATIBILITY.md: newest row host version is "0.2.1-rc.2"'),
    },
    {
      name: 'newest compatibility row omits the Node floor',
      apply(root) {
        const compatibility = read(root, 'COMPATIBILITY.md')
        const next = compatibility.replace('Node >=24.9', 'Node 22')
        assert.notEqual(next, compatibility, 'fixture must state the Node floor in the newest row')
        write(root, 'COMPATIBILITY.md', next)
      },
      expect: (problem) => problem.includes('does not state the Node floor'),
    },
    {
      name: 'manifest floor is not a single range',
      apply(root) {
        const support = readJson(root, 'scripts/support.json')
        support.node = '^24'
        writeJson(root, 'scripts/support.json', support)
      },
      expect: (problem) => problem.includes('scripts/support.json: node is "^24"'),
    },
  ]

  for (const entry of cases) {
    const root = supportFixture(t)
    entry.apply(root)
    const result = evaluateSupport(readSupportInputs(root))
    assert.equal(result.ok, false, `${entry.name}: the gate must fail`)
    assert.ok(
      result.problems.some(entry.expect),
      `${entry.name}: expected a source-named problem, got ${JSON.stringify(result.problems)}`,
    )
  }
})

test('the gate is wired into npm run check and the CI test job', () => {
  const pkg = readJson(repoRoot, 'package.json')
  assert.equal(pkg.scripts['support:check'], 'node scripts/check-support.mjs')
  const chain = pkg.scripts.check.split('&&').map((step) => step.trim())
  const support = chain.indexOf('npm run support:check')
  assert.ok(support !== -1, 'check must run the support gate')
  assert.ok(chain.indexOf('npm run test:property') < support, 'the cheap static gate follows the offline suites')
  assert.ok(support < chain.indexOf('npm run docs:check'), 'the gate runs before the docs checks')
  const workflow = read(repoRoot, '.github/workflows/test.yml')
  assert.match(workflow, /- name: Support manifest\n {8}run: npm run support:check/)
})

test('the CLI is green on the checkout and fails on a tampered copy', (t) => {
  const ok = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(
    ok.stdout,
    /^support ok: Node >=24\.9, DSH 0\.2\.2-rc\.1, package engines\/lock, host pin, live matrix and COMPATIBILITY v2\.8\.0 agree$/m,
  )

  const json = spawnSync(process.execPath, [script, '--json'], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(json.status, 0, json.stderr)
  const parsed = JSON.parse(json.stdout)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.problems, [])

  const root = supportFixture(t)
  const pin = readJson(root, 'scripts/mount-smoke/host.json')
  pin.dsh = '0.2.1-rc.2'
  writeJson(root, 'scripts/mount-smoke/host.json', pin)
  const bad = spawnSync(process.execPath, [script, '--root', root], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /support check: scripts\/mount-smoke\/host\.json: dsh is "0\.2\.1-rc\.2"/)
})
