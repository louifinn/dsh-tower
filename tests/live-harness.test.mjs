// #87 / #47: contract tests for the reproducible, safe live harness.
//
// These run on every push and never launch a browser. They pin the install path
// (own package + lockfile), the resolver order, the actionable missing-install
// message, the isolated-DSH_HOME guard, and the CI policy (nightly live job on a
// pinned host; offline + protocol e2e on every push).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'
import resolveModule from './live/resolve-playwright.cjs'
import guardModule from './live/_guard.cjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const liveDir = path.join(root, 'tests', 'live')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const readLive = (file) => fs.readFileSync(path.join(liveDir, file), 'utf8')
const node = process.execPath
const { INSTALL_COMMANDS, installHint, resolvePlaywright } = resolveModule
const { announceLine, assertIsolatedHome, hostVersion } = guardModule

const HARNESS_FILES = ['run.cjs', '_env.cjs', '_guard.cjs', 'resolve-playwright.cjs']

function tempDir(prefix = 'tower-live-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** Strip environment that could change resolution or the banner between machines. */
function liveEnv(home, extra = {}) {
  const env = { ...process.env }
  for (const key of ['NODE_PATH', 'DSH_HOST_VERSION', 'DSH_HOST_DIR', 'DSH_TEST_URL', 'DSH_LIVE_REQUIRE', 'DSH_LIVE_ANNOUNCED']) {
    delete env[key]
  }
  return { ...env, DSH_LIVE: '1', DSH_HOME: home, ...extra }
}

function copyHarness(target) {
  for (const file of HARNESS_FILES) fs.copyFileSync(path.join(liveDir, file), path.join(target, file))
}

function spawnRun(harnessDir, args, env, cwd = harnessDir) {
  return spawnSync(node, [path.join(harnessDir, 'run.cjs'), ...args], { cwd, env, encoding: 'utf8' })
}

function workflowJob(workflow, id) {
  const lines = workflow.split(/\r?\n/)
  const start = lines.indexOf(`  ${id}:`)
  assert.notEqual(start, -1, `workflow must define the ${id} job`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

test('live suite pins Playwright in its own package and lockfile; the root install stays light', () => {
  const livePackage = JSON.parse(readLive('package.json'))
  const pin = livePackage.devDependencies.playwright
  assert.match(pin, /^\d+\.\d+\.\d+$/, 'playwright must be pinned exactly, not a range')
  assert.equal(livePackage.dependencies, undefined, 'the live harness must not add runtime dependencies')

  const lock = JSON.parse(readLive('package-lock.json'))
  assert.equal(lock.lockfileVersion, 3)
  assert.equal(lock.packages[''].devDependencies.playwright, pin)
  assert.equal(lock.packages['node_modules/playwright'].version, pin)

  const rootPackage = JSON.parse(read('package.json'))
  assert.equal(rootPackage.scripts['test:live'], 'node tests/live/run.cjs')
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = rootPackage[section] ?? {}
    assert.ok(!('playwright' in deps), `root ${section} must not pull Playwright (and its browsers)`)
    assert.ok(!('playwright-core' in deps), `root ${section} must not pull playwright-core`)
  }
})

test('the resolver searches tests/live/node_modules before NODE_PATH, and nothing implicit', () => {
  const live = tempDir()
  const nodePathDir = tempDir()
  const writePlaywright = (dir) => {
    const packageDir = path.join(dir, 'playwright')
    fs.mkdirSync(packageDir, { recursive: true })
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'playwright', version: '9.9.9', main: 'index.js' }))
    fs.writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = { chromium: {} }\n')
  }
  try {
    assert.equal(resolvePlaywright({ liveDir: live, env: { NODE_PATH: nodePathDir } }), null, 'no implicit global install may count as present')

    writePlaywright(nodePathDir)
    const fallback = resolvePlaywright({ liveDir: live, env: { NODE_PATH: nodePathDir } })
    assert.equal(fallback.source, 'NODE_PATH')
    assert.equal(fallback.modulePath, path.join(nodePathDir, 'playwright'))

    writePlaywright(path.join(live, 'node_modules'))
    const local = resolvePlaywright({ liveDir: live, env: { NODE_PATH: nodePathDir } })
    assert.equal(local.source, 'tests/live', 'the local install wins even when NODE_PATH also resolves')
    assert.equal(local.modulePath, path.join(live, 'node_modules', 'playwright'))
  } finally {
    removeTemp(live)
    removeTemp(nodePathDir)
  }
})

test('every live script goes through the resolver instead of require("playwright")', () => {
  // The two helper modules name `require('playwright')` in their own comments.
  const scripts = fs
    .readdirSync(liveDir)
    .filter((name) => name.endsWith('.cjs') && !['resolve-playwright.cjs', '_env.cjs'].includes(name))
  for (const name of scripts) {
    assert.doesNotMatch(readLive(name), /require\(\s*['"]playwright['"]\s*\)/, `${name} must use resolve-playwright.cjs`)
  }
  for (const name of ['command', 'desktop-command', 'explore', 'model', 'steer-role', 'hmr', 'ui-slots', 'boot-smoke']) {
    assert.match(readLive(`${name}.cjs`), /resolve-playwright\.cjs/, `${name}.cjs must resolve Playwright through the shared helper`)
  }
})

test('missing Playwright prints the two exact install commands, exits 2, and has no stack', () => {
  const harness = tempDir('tower-live-clean-')
  const home = tempDir()
  try {
    copyHarness(harness)
    const result = spawnRun(harness, [], liveEnv(home, { NODE_PATH: '' }))
    assert.equal(result.status, 2, result.stderr)
    const stderr = result.stderr
    for (const command of INSTALL_COMMANDS) assert.ok(stderr.includes(command), `message must name ${command}`)
    assert.match(stderr, /npm ci --prefix tests\/live/)
    assert.match(stderr, /npx playwright install chromium/)
    assert.match(stderr, /npm run test:live/, 'the message must point at the documented entry point')
    assert.doesNotMatch(stderr, /^\s+at .+\)?$/m, 'a missing install is an instruction, not a MODULE_NOT_FOUND stack')
    assert.ok(!stderr.includes('MODULE_NOT_FOUND'), 'the hint must replace MODULE_NOT_FOUND')
    const firstLine = result.stdout.split(/\r?\n/)[0]
    assert.match(firstLine, /^live: DSH_HOME=.+ host=/)
  } finally {
    removeTemp(harness)
    removeTemp(home)
  }
})

test('--check passes on a clean clone without a browser and prints provenance first', () => {
  const harness = tempDir('tower-live-clean-')
  const home = tempDir()
  try {
    copyHarness(harness)
    const result = spawnRun(harness, ['--check'], liveEnv(home, { NODE_PATH: '', DSH_HOST_VERSION: '9.9.9' }))
    assert.equal(result.status, 0, result.stderr)
    const firstLine = result.stdout.split(/\r?\n/)[0]
    assert.match(firstLine, /^live: DSH_HOME=.+ host=9\.9\.9$/, 'the first line must name the resolved home and host version')
    assert.match(result.stdout, /live check: ok/)
    assert.ok(result.stdout.includes(INSTALL_COMMANDS[0]), '--check still prints the setup commands when Playwright is absent')
    assert.doesNotMatch(result.stderr, /Error:|at /, '--check must not fail or throw on a clean clone')
  } finally {
    removeTemp(harness)
    removeTemp(home)
  }
})

test('the environment guard rejects a real home, an operator profile, and missing DSH_HOME', () => {
  const outside = spawnRun(liveDir, ['--check'], liveEnv(path.parse(root).root, { NODE_PATH: '' }))
  assert.notEqual(outside.status, 0)
  assert.match(outside.stderr, /under os\.tmpdir\(\)/)
  assert.match(outside.stderr, /npm run test:live/)

  const operator = tempDir('tower-live-operator-')
  try {
    const profileHome = path.join(operator, '.dsh', 'profiles', 'towertest')
    fs.mkdirSync(profileHome, { recursive: true })
    // Simulate the operator's real home so no real profile is touched.
    const env = liveEnv(profileHome, { NODE_PATH: '', HOME: operator, USERPROFILE: operator })
    const profile = spawnRun(liveDir, ['--check'], env)
    assert.notEqual(profile.status, 0)
    assert.match(profile.stderr, /operator profile/)
    assert.match(profile.stderr, /npm run test:live/)

    const realHome = spawnRun(liveDir, ['--check'], liveEnv(path.join(operator, '.dsh'), { NODE_PATH: '', HOME: operator, USERPROFILE: operator }))
    assert.notEqual(realHome.status, 0)
    assert.match(realHome.stderr, /operator's real DSH_HOME/)

    const missing = spawnRun(liveDir, ['--check'], liveEnv(path.join(operator, 'absent'), { NODE_PATH: '' }))
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /does not exist/)

    const noLiveEnv = liveEnv(operator)
    delete noLiveEnv.DSH_LIVE
    const noLive = spawnRun(liveDir, ['--check'], noLiveEnv)
    assert.notEqual(noLive.status, 0)
    assert.match(noLive.stderr, /DSH_LIVE=1/)
    assert.match(noLive.stderr, /npm run test:live/)
  } finally {
    removeTemp(operator)
  }
})

test('guard: the isolated home must be a strict child of os.tmpdir() and never an operator profile', () => {
  const home = tempDir('tower-live-guard-')
  const operator = tempDir('tower-live-operator-')
  try {
    assert.equal(assertIsolatedHome({ dshHome: home }), fs.realpathSync(home))
    assert.throws(() => assertIsolatedHome({ dshHome: os.tmpdir() }), /under os\.tmpdir\(\)/)

    const file = path.join(home, 'not-a-dir')
    fs.writeFileSync(file, 'x')
    assert.throws(() => assertIsolatedHome({ dshHome: file }), /not a directory/)
    assert.throws(() => assertIsolatedHome({ dshHome: path.join(home, 'absent') }), /does not exist/)

    const operatorDsh = path.join(operator, '.dsh')
    const profileHome = path.join(operatorDsh, 'profiles', 'towertest')
    fs.mkdirSync(profileHome, { recursive: true })
    assert.throws(() => assertIsolatedHome({ dshHome: profileHome, operatorHome: operatorDsh }), /operator profile/)
    assert.throws(() => assertIsolatedHome({ dshHome: operatorDsh, operatorHome: operatorDsh }), /operator's real DSH_HOME/)
  } finally {
    removeTemp(home)
    removeTemp(operator)
  }
})

test('the live banner names the resolved DSH_HOME and host version', () => {
  assert.equal(hostVersion({ DSH_HOST_VERSION: '1.2.3' }), '1.2.3')
  assert.equal(hostVersion({}), 'unknown')
  const hostDir = tempDir('tower-live-host-')
  try {
    const manifestDir = path.join(hostDir, 'node_modules', '@deepseek-ai', 'dsh')
    fs.mkdirSync(manifestDir, { recursive: true })
    fs.writeFileSync(path.join(manifestDir, 'package.json'), JSON.stringify({ version: '0.2.1-rc.2' }))
    assert.equal(hostVersion({ DSH_HOST_DIR: hostDir }), '0.2.1-rc.2')
    assert.equal(announceLine('/tmp/example', { DSH_HOST_VERSION: '2.0.0' }), 'live: DSH_HOME=/tmp/example host=2.0.0')
  } finally {
    removeTemp(hostDir)
  }
})

test('CI keeps the offline suite and protocol e2e on push, and moves the live run to a nightly pinned matrix', () => {
  const workflow = read('.github/workflows/test.yml')
  const onBlock = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('\njobs:'))
  for (const trigger of ['push:', 'pull_request:', 'schedule:', 'workflow_dispatch:']) {
    assert.match(onBlock, new RegExp(`^ {2}${trigger}`, 'm'), `the workflow must keep the ${trigger.replace(':', '')} trigger`)
  }
  assert.match(onBlock, /cron: '\d+ \d+ \* \* \*'/)

  const testJob = workflowJob(workflow, 'test')
  assert.match(testJob, /run: npm test/)
  assert.match(testJob, /Offline suite \(includes protocol end-to-end\)/)
  assert.ok(fs.existsSync(path.join(root, 'tests', 'protocol.e2e.test.mjs')))
  assert.doesNotMatch(testJob, /npm ci --prefix tests\/live/, 'push CI must not download the live harness')
  assert.doesNotMatch(testJob, /playwright install/, 'push CI must not download a browser')
  assert.match(testJob, /npm run test:live -- --check/, 'push CI still checks the harness environment/resolution')

  const liveJob = workflowJob(workflow, 'live')
  assert.match(liveJob, /if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/, 'the live suite never runs on push/PR')
  assert.match(liveJob, /name: live \(\$\{\{ matrix\.dsh \}\}\)/)
  const pin = JSON.parse(read('scripts/mount-smoke/host.json')).dsh
  assert.match(liveJob, new RegExp(`- '${pin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), 'the live matrix pins the host build')
  const compatibilityRow = read('COMPATIBILITY.md')
    .split('\n')
    .find((line) => /^\| \d+\.\d+\.\d+/.test(line))
  assert.equal(compatibilityRow.split('|')[1].trim(), pin, 'the live pin must match the newest verified host row')
  assert.match(liveJob, /npm ci --prefix tests\/live/)
  assert.match(liveJob, /playwright install --with-deps chromium/)
  assert.match(liveJob, /DSH_HOME:/)
  assert.match(liveJob, /DSH_HOST_VERSION:/)
  assert.match(liveJob, /npm run test:live -- --script nightly/)
  assert.doesNotMatch(workflowJob(workflow, 'mount'), /live/, 'the offline mount job stays offline')
})

test('the live entries announce the resolved home and host version before anything observable', () => {
  for (const file of ['run.cjs', 'boot-smoke.cjs', 'nightly.cjs']) {
    const source = readLive(file)
    assert.match(source, /env\.announce\(\)/, `${file} must print the provenance banner`)
    const announceAt = source.indexOf('env.announce()')
    const launchAt = source.search(/chromium\.launch|spawn\(/)
    assert.ok(launchAt === -1 || announceAt < launchAt, `${file} must announce before it starts a browser or a server`)
  }
})
