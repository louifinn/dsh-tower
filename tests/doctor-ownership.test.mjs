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
import { compareVersions, detectHostVersion, readCompatibility } from '../host/compatibility.js'
import { writeJsonAtomic } from '../adapters/store.js'
import { validateState } from '../domain/state.js'
import { workspaceLockPath } from '../adapters/workspaceLock.js'
import { validateJsonSchema } from './schema-validator.mjs'

const ORIGINAL_DSH_HOME = process.env.DSH_HOME
const OWNER = 'owner-a'
const CALLER = 'owner-b'
const HOST_ENV_KEYS = ['DSH_VERSION', 'DSH_HOST_VERSION', 'npm_config_dsh_version', 'DSH_INSTALL_DIR']

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
    get(name) {
      // Doctor requires the subagent bundle to be mounted for a healthy report.
      if (name === 'subagents') {
        return { list: () => [], listDescendants: async () => [], sendMessage: async () => {}, interrupt: () => {} }
      }
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

function saveHostEnv() {
  return Object.fromEntries(HOST_ENV_KEYS.map((key) => [key, process.env[key]]))
}

function clearHostEnv() {
  for (const key of HOST_ENV_KEYS) delete process.env[key]
}

function restoreHostEnv(saved) {
  for (const key of HOST_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
}

function writeHostPackage(dir, version) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  return dir
}

/** A mission whose worktree record points at a directory the test never creates. */
function missionFixture(tower, { id, status = 'merged' }) {
  const now = Date.now()
  const mission = {
    id,
    title: `${status} ${id}`,
    kind: 'build',
    status,
    scope: [`${id.toLowerCase()}/**`],
    deps: [],
    tasks: [],
    blockers: [],
    notes: [],
    owner: 'worker-1',
    reviewPolicy: 'required-clean',
    updatedAt: now,
    worktree: {
      path: path.join(tower.root, '..', 'worktrees', id),
      branch: `tower/${id.toLowerCase()}-x`,
      baseCommit: 'b'.repeat(40),
    },
  }
  if (status === 'merged') {
    mission.mergedCommit = 'a'.repeat(40)
    mission.mergedAt = now
  }
  return mission
}

/** Append a fixture mission the same way a completed merge would. */
async function appendMission(tower, mission) {
  const state = await tower.load()
  state.missions.push(mission)
  state.revision += 1
  state.updatedAt = Date.now()
  validateState(state, tower.paths.state)
  await writeJsonAtomic(tower.paths.state, state)
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

test('doctor: a merged mission whose worktree is gone is advisory, not a failure (F61)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const tower = await Tower.open(repo)
    await appendMission(tower, missionFixture(tower, { id: 'M45' }))
    await appendMission(tower, missionFixture(tower, { id: 'M50' }))

    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const worktrees = doctor.checks.find((entry) => entry.id === 'worktrees')
    assert.equal(doctor.ok, true, JSON.stringify(doctor.checks.filter((entry) => entry.status === 'fail')))
    assert.equal(worktrees.status, 'warn')
    assert.match(worktrees.detail, /2 terminal mission worktree\(s\) are no longer on disk/)
    assert.match(worktrees.action, /tower_teardown/)

    // The status exemption is terminal-only: an active mission still fails.
    await appendMission(tower, missionFixture(tower, { id: 'M51', status: 'active' }))
    const broken = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const brokenWorktrees = broken.checks.find((entry) => entry.id === 'worktrees')
    assert.equal(broken.ok, false)
    assert.equal(brokenWorktrees.status, 'fail')
    assert.match(brokenWorktrees.detail, /1 mission worktree\(s\) are missing or invalid/)
    assert.match(brokenWorktrees.action, /restore the worktree/)
  } finally {
    removeTemp(root)
  }
})

test('teardown: a merged mission whose checkout is already gone is repaired and recorded (F61)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const tower = await Tower.open(repo)
    await appendMission(tower, missionFixture(tower, { id: 'M45' }))

    const torn = await call(tools, 'tower_teardown', { repoRoot: repo }, OWNER)
    assert.equal(torn.ok, true)
    assert.deepEqual(torn.removed, ['M45'])
    const decision = torn.decisions.find((entry) => entry.missionId === 'M45')
    assert.equal(decision.action, 'removed')
    assert.equal(decision.repaired, true)
    assert.match(decision.reason ?? '', /already gone/)

    const mission = (await tower.load()).missions.find((entry) => entry.id === 'M45')
    assert.equal(typeof mission.worktreeRemovedAt, 'number')
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    assert.equal(doctor.checks.find((entry) => entry.id === 'worktrees').status, 'pass')
  } finally {
    removeTemp(root)
  }
})

test('doctor: an active mission with a dirty worktree still warns (F61)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const tower = await Tower.open(repo)
    await tower.plan({ missions: [{ title: 'Dirty worktree', scope: ['src/**'], tasks: ['write'] }] })
    const provisioned = await tower.provision({ missionId: 'M1' })
    fs.writeFileSync(path.join(provisioned.worktree.path, 'scratch.txt'), 'scratch\n')
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const worktrees = doctor.checks.find((entry) => entry.id === 'worktrees')
    assert.equal(worktrees.status, 'warn')
    assert.match(worktrees.detail, /uncommitted changes/)
    assert.equal(doctor.ok, true, JSON.stringify(doctor.checks.filter((entry) => entry.status === 'fail')))
  } finally {
    removeTemp(root)
  }
})

test('detectHostVersion: DSH_INSTALL_DIR/package.json is a fallback source (F62)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-host-version-'))
  try {
    const installDir = writeHostPackage(path.join(root, 'install', 'node_modules', '@deepseek-ai', 'dsh'), '0.2.2-rc.3')
    assert.equal(detectHostVersion(undefined, { DSH_INSTALL_DIR: installDir }), '0.2.2-rc.3')

    // DSH_INSTALL_DIR may name a directory inside the package; its parent is tried.
    const nested = path.join(installDir, 'dist')
    fs.mkdirSync(nested)
    assert.equal(detectHostVersion(undefined, { DSH_INSTALL_DIR: nested }), '0.2.2-rc.3')

    // A missing package.json and an unparsable version both stay unknown.
    assert.equal(detectHostVersion(undefined, { DSH_INSTALL_DIR: path.join(root, 'missing') }), null)
    const broken = writeHostPackage(path.join(root, 'broken'), 'not-a-version')
    assert.equal(detectHostVersion(undefined, { DSH_INSTALL_DIR: broken }), null)

    // An explicit version still wins over the installed package metadata.
    assert.equal(detectHostVersion(undefined, { DSH_VERSION: '0.2.2-rc.3', DSH_INSTALL_DIR: broken }), '0.2.2-rc.3')
  } finally {
    removeTemp(root)
  }
})

test('doctor: DSH_INSTALL_DIR identifies the host and unknown names the sources (F62)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  const saved = saveHostEnv()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    clearHostEnv()
    const rows = readCompatibility()
    assert.ok(rows.length > 0, 'COMPATIBILITY.md ships version rows')
    const expected = rows.reduce(
      (best, row) => (compareVersions(row.hostVersion, best.hostVersion) >= 0 ? row : best),
      rows[0],
    ).hostVersion
    process.env.DSH_INSTALL_DIR = writeHostPackage(path.join(root, 'host-install'), expected)

    const verified = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const verifiedCheck = verified.checks.find((entry) => entry.id === 'host-version')
    assert.equal(verifiedCheck.status, 'pass')
    assert.match(verifiedCheck.detail, /verified/)
    assert.equal(verified.environmentContract.hostVersion, expected)
    assert.equal(verified.environmentContract.hostCompatibility, 'verified')

    delete process.env.DSH_INSTALL_DIR
    const unknown = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const unknownCheck = unknown.checks.find((entry) => entry.id === 'host-version')
    assert.equal(unknownCheck.status, 'warn')
    assert.match(unknownCheck.action, /DSH_VERSION/)
    assert.match(unknownCheck.action, /DSH_INSTALL_DIR/)
    assert.equal(unknown.environmentContract.hostVersion, null)
  } finally {
    restoreHostEnv(saved)
    removeTemp(root)
  }
})
