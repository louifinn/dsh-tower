// tower_doctor and tower_status must describe the same ownership facts.
//
// Doctor's tower-owner and workspace-lock checks used to read the mode store,
// workspace lock and roster separately (and the state-lock check claimed a
// live-but-silent lock would be reclaimed by the next mutation). These tests
// pin the single-source behavior: `readOwnership` supplies both checks, the
// snapshot is part of the doctor report, corrupt stores fail closed, and the
// state-lock diagnostic names the explicit recovery command instead.
//
// Run with: node --test tests/doctor-ownership.test.mjs
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { registerTowerTools } from '../host/tool-registry.js'
import { __testResetComponentRegistry, registerComponent } from '../host/capability-registry.js'
import { Tower } from '../host/tower.js'
import { workspaceLockPath } from '../adapters/workspaceLock.js'
import { validateJsonSchema } from './schema-validator.mjs'

const ORIGINAL_DSH_HOME = process.env.DSH_HOME
const OWNER = 'owner-a'
const CALLER = 'owner-b'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-doctor-owner-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  const home = path.join(root, 'home')
  fs.mkdirSync(repo)
  fs.mkdirSync(home)
  process.env.DSH_HOME = home
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo, home }
}

function writeModeStore(home, modes) {
  const dir = path.join(home, 'tower-mode')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'modes.json'), JSON.stringify({ version: 1, modes }))
}

function makeCtx() {
  __testResetComponentRegistry()
  registerComponent('tower-board')
  const tools = new Map()
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get() {
      return undefined
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
      guard() {
        return () => {}
      },
    },
    systemPrompt: { section() {} },
    inject(_deps, callback) {
      callback(ctx)
    },
  }
  registerTowerTools(ctx)
  return { ctx, tools }
}

afterEach(() => {
  __testResetComponentRegistry()
  if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = ORIGINAL_DSH_HOME
})

async function call(tools, name, args, agentId = CALLER) {
  const tool = tools.get(name)
  assert.ok(tool, `${name} is registered`)
  const value = await tool.execute(args, { agent: { id: agentId } })
  const violations = validateJsonSchema(tool.output.schema, value)
  assert.deepEqual(violations, [], `${name}: ${violations.join('; ')}`)
  return value
}

test('doctor and status agree: the owner mode is off and takeover is available', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const status = await call(tools, 'tower_inspect', { view: 'status', repoRoot: repo })
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    assert.equal(status.ownership.owner, OWNER)
    assert.equal(status.ownership.ownerMode, 'off')
    assert.equal(status.ownership.modeStoreStatus, 'missing')
    assert.equal(status.ownership.takeoverAvailable, true)
    assert.equal(doctor.ownership.takeoverAvailable, status.ownership.takeoverAvailable)
    assert.equal(doctor.ownership.modeStoreStatus, status.ownership.modeStoreStatus)
    // #163 Phase 5: default-off subsystems are reported by name and enable step.
    assert.equal(doctor.subsystems.length, 5)
    for (const row of doctor.subsystems) {
      assert.ok(row.tool, `${row.id} names its tool`)
      assert.equal(typeof row.enabled, 'boolean')
      assert.match(row.enable, /disabled: true/)
      assert.match(row.enable, /cordis\.patch\.yml/)
    }
    assert.deepEqual(
      doctor.subsystems.map((row) => row.id),
      ['tower-batch', 'tower-import', 'tower-leases', 'tower-tests', 'tower-hmr'],
    )
    const owner = doctor.checks.find((entry) => entry.id === 'tower-owner')
    assert.equal(owner.status, 'warn')
    assert.match(owner.detail, /appears inactive/)
  } finally {
    removeTemp(root)
  }
})

test('doctor and status agree: an active owner blocks takeover with owner-live', async () => {
  const { root, repo, home } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    writeModeStore(home, { [OWNER]: { on: true, at: Date.now() } })
    const status = await call(tools, 'tower_inspect', { view: 'status', repoRoot: repo })
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    assert.equal(status.ownership.ownerMode, 'on')
    assert.equal(status.ownership.takeoverAvailable, false)
    assert.equal(status.ownership.blockers[0].code, 'owner-live')
    assert.equal(doctor.ownership.takeoverAvailable, false)
    assert.deepEqual(
      doctor.ownership.blockers.map((blocker) => blocker.code),
      status.ownership.blockers.map((blocker) => blocker.code),
    )
    const owner = doctor.checks.find((entry) => entry.id === 'tower-owner')
    assert.equal(owner.status, 'pass')
    assert.match(owner.detail, /Tower mode is active/)
  } finally {
    removeTemp(root)
  }
})

test('doctor and status agree: a corrupt mode store fails closed, not inactive', async () => {
  const { root, repo, home } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const modeFile = path.join(home, 'tower-mode', 'modes.json')
    fs.mkdirSync(path.dirname(modeFile), { recursive: true })
    fs.writeFileSync(modeFile, '{ "version": 1, ')
    const status = await call(tools, 'tower_inspect', { view: 'status', repoRoot: repo })
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    assert.equal(status.ownership.modeStoreStatus, 'corrupt')
    assert.equal(status.ownership.ownerMode, 'unknown')
    assert.equal(status.ownership.takeoverAvailable, false)
    assert.equal(status.ownership.blockers[0].code, 'mode-store-corrupt')
    assert.equal(doctor.ownership.modeStoreStatus, 'corrupt')
    assert.equal(doctor.ownership.takeoverAvailable, false)
    assert.equal(doctor.ownership.blockers[0].code, 'mode-store-corrupt')
    assert.equal(doctor.ok, false)
    const owner = doctor.checks.find((entry) => entry.id === 'tower-owner')
    assert.equal(owner.status, 'fail')
    assert.match(owner.detail, /mode store/)
    assert.match(owner.action, /move aside the mode store/)
  } finally {
    removeTemp(root)
  }
})

test('doctor and status agree: an unreadable mode store is corrupt, not missing', async () => {
  const { root, repo, home } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    fs.mkdirSync(path.join(home, 'tower-mode', 'modes.json'), { recursive: true })
    const status = await call(tools, 'tower_inspect', { view: 'status', repoRoot: repo })
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    assert.equal(status.ownership.modeStoreStatus, 'corrupt')
    assert.equal(doctor.ownership.modeStoreStatus, 'corrupt')
    assert.equal(doctor.checks.find((entry) => entry.id === 'tower-owner').status, 'fail')
  } finally {
    removeTemp(root)
  }
})

test('doctor reuses the same lock facts as status: foreign workspace lock blocks both', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const tower = await Tower.open(repo)
    const lockFile = workspaceLockPath(tower.commonDir)
    fs.mkdirSync(path.dirname(lockFile), { recursive: true })
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ token: 'tok-owner-c', sessionId: 'owner-c', agentId: 'owner-c', pid: process.pid, at: Date.now() }),
    )
    const status = await call(tools, 'tower_inspect', { view: 'status', repoRoot: repo })
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    assert.equal(status.ownership.foreignLock, true)
    assert.equal(status.ownership.takeoverAvailable, false)
    assert.equal(status.ownership.blockers[0].code, 'owner-busy')
    assert.match(status.ownership.blockers[0].detail, /owner-c/)
    assert.equal(doctor.ownership.takeoverAvailable, false)
    assert.equal(doctor.ownership.foreignLock, true)
    const owner = doctor.checks.find((entry) => entry.id === 'tower-owner')
    assert.equal(owner.status, 'warn')
    assert.match(owner.detail, /owner-c/)
    const lockCheck = doctor.checks.find((entry) => entry.id === 'workspace-lock')
    assert.equal(lockCheck.status, 'pass')
    assert.match(lockCheck.detail, /owner-c/)
  } finally {
    removeTemp(root)
  }
})

test('doctor: a live-but-silent state lock is never called reclaimable (F32)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const tower = await Tower.open(repo)
    const stateLockFile = tower.paths.lock
    const at = Date.now() - 10000
    fs.mkdirSync(path.dirname(stateLockFile), { recursive: true })
    fs.writeFileSync(stateLockFile, JSON.stringify({ token: 'silent-holder', pid: process.pid, since: at, at }))
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const lockCheck = doctor.checks.find((entry) => entry.id === 'state-lock')
    assert.equal(lockCheck.status, 'warn')
    assert.match(lockCheck.detail, /alive but silent/)
    assert.match(lockCheck.detail, /never reclaimed automatically/)
    assert.doesNotMatch(lockCheck.detail, /next mutation reclaims it/)
    assert.match(lockCheck.action, /tower_recover clear-stale-lock force:true/)
    assert.match(lockCheck.action, /CLEAR_STALE_LOCK/)
    assert.equal(fs.existsSync(stateLockFile), true, 'doctor must not reclaim or remove the lock record')
  } finally {
    removeTemp(root)
  }
})
