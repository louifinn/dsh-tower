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
import { teardownWorktreeRoot } from '../app/teardown.js'
import {
  assessHostVersion,
  compareVersions,
  detectHostVersion,
  diagnoseHostVersion,
  readCompatibility,
  resolveHostVersion,
} from '../host/compatibility.js'
import { writeJsonAtomic, stateCommitLockPath } from '../adapters/store.js'
import { FOREIGN_CAPABILITIES, foreignCapabilityStatus } from '../host/doctor-acceptance.js'
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

function makeCtx(options = {}) {
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
      // Only tests that exercise the preset check mount a registry; the default
      // stays absent, which makes that check report it cannot make a claim.
      if (name === 'agentPresets') return options.agentPresets
      // #188/#189: the foreign capability inventory reads the loader inventory,
      // the tool registry and the permission preset catalog as named services.
      if (options.services && Object.prototype.hasOwnProperty.call(options.services, name)) {
        return options.services[name]
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
      // A test may mount a readable registry view; the default registers Tower
      // tools only and exposes none, which the inventory reports as undetectable.
      ...(options.toolRuntime ?? {}),
    },
    systemPrompt: { section() {} },
    inject(_deps, callback) {
      callback(ctx)
    },
  }
  registerTowerTools(ctx)
  return { ctx, tools }
}

// #188/#189: the host loader is a cordis `Loader extends EntryTree`. Its
// `entries()` is a generator over runtime Entry nodes (whose `options` is the
// configured row) and it recurses into nested subtrees; `store` is a
// null-prototype dict keyed by entry id. Fixtures use those shapes so the
// inventory is exercised against what production actually reads.
function loaderFixture(rows = []) {
  const store = Object.create(null)
  for (const row of rows) {
    store[row.id] = {
      options: row,
      get disabled() {
        return row.disabled === true
      },
    }
  }
  return {
    root: { data: rows },
    store,
    *entries() {
      for (const entry of Object.values(this.store)) {
        yield entry
        if (entry.subtree) yield* entry.subtree.entries()
      }
    },
  }
}

// The same tree without `entries()`: the fallback every other entry-tree
// consumer needs when only the store dict is readable.
function loaderStoreFixture(rows = []) {
  const store = Object.create(null)
  for (const row of rows) store[row.id] = { options: row }
  return { store, root: { data: rows } }
}

// F89: the shipped `cordis.patch.yml` does not mount the host plugin as a
// top-level row. The first top-level row is a mandatory `cordis:group` anchor
// (`id: tower`, `group: true`) whose nested `config` holds the real plugin row
// (`id: tower-host`, `name: dsh-tower`). The runtime entry tree spells the same
// nesting as a group entry with a `subtree`; `entries()` recurses into it and
// yields both rows, which is what `readLoaderRows` reads in production.
function shippedLoaderFixture(extraRows = []) {
  const hostRow = {
    id: 'tower-host',
    name: 'dsh-tower',
    config: { mode: { allowAgentControl: true, workspaceLock: true } },
  }
  const groupRow = { id: 'tower', name: 'cordis:group', group: true, config: [hostRow] }
  const child = loaderFixture([hostRow])
  const store = Object.create(null)
  store.tower = { options: groupRow, subtree: child }
  for (const row of extraRows) store[row.id] = { options: row }
  return {
    root: { data: [groupRow, ...extraRows] },
    store,
    *entries() {
      for (const entry of Object.values(this.store)) {
        yield entry
        if (entry.subtree) yield* entry.subtree.entries()
      }
    },
  }
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
  return writePackage(dir, '@deepseek-ai/dsh', version)
}

/** Write a package.json with an explicit name (a profile dependency fixture). */
function writePackage(dir, name, version) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }))
  return dir
}

/** Write a profile-installed @deepseek-ai package the way npm lays it out. */
function writeProfilePackage(home, profile, name, version) {
  return writePackage(path.join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', name), `@deepseek-ai/${name}`, version)
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

test('doctor presets failure names the visible preset rows and offers both remedies (#F69)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx({ agentPresets: { list: async () => [] } })
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const presets = doctor.checks.find((entry) => entry.id === 'presets')
    assert.equal(presets.status, 'fail')
    // Default review mode is optional, so the worker preset is the only required
    // one. The detail names the visible row title; neither field may render the
    // internal preset id.
    assert.match(presets.detail, /Tower Worker preset/)
    assert.match(presets.action, /switch the missing preset row back on in the plugin page and restart DSH/)
    assert.match(presets.action, /choose a registered preset on the plugin configuration form/)
    assert.doesNotMatch(`${presets.detail} ${presets.action}`, /tower-worker|tower-reviewer/)
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
    assert.match(lockCheck.action, /clear-stale-lock recovery step/)
    assert.match(lockCheck.action, /force:true/)
    assert.match(lockCheck.action, /CLEAR_STALE_LOCK/)
    assert.doesNotMatch(lockCheck.action, /tower_recover/)
    assert.equal(fs.existsSync(stateLockFile), true, 'doctor must not reclaim or remove the lock record')
  } finally {
    removeTemp(root)
  }
})

test('doctor and recover handle a leftover commit mutex without manual deletion (F71)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const tower = await Tower.open(repo)
    const commitLockFile = stateCommitLockPath(tower.paths)
    const at = Date.now() - 10000
    fs.writeFileSync(
      commitLockFile,
      JSON.stringify({ token: 'leftover-commit', pid: process.pid, kind: 'state-commit', since: at, at }),
    )

    // Doctor reports the record and names the audited recovery command.
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    assert.equal(doctor.commitLock.held, true)
    assert.equal(doctor.commitLock.pid, process.pid)
    assert.equal(doctor.commitLock.stale, true)
    const commitCheck = doctor.checks.find((entry) => entry.id === 'commit-lock')
    assert.equal(commitCheck.status, 'warn')
    assert.match(commitCheck.detail, /alive but silent/)
    assert.match(commitCheck.detail, /never reclaimed automatically/)
    assert.match(commitCheck.action, /clear-stale-lock recovery step/)
    assert.match(commitCheck.action, /force:true/)
    assert.match(commitCheck.action, /CLEAR_STALE_LOCK/)
    assert.doesNotMatch(commitCheck.action, /tower_recover/)
    assert.equal(fs.existsSync(commitLockFile), true, 'doctor must never move the record')

    // status sees the same record; an unforced clear refuses the live PID.
    const status = await call(tools, 'tower_recover', { repoRoot: repo, action: 'status' }, OWNER)
    assert.equal(status.commitLock.pid, process.pid)
    assert.equal(status.commitLock.alive, true)
    assert.equal(status.stateLock, null)
    await assert.rejects(
      () =>
        call(
          tools,
          'tower_recover',
          { repoRoot: repo, action: 'clear-stale-lock', confirm: 'CLEAR_STALE_LOCK' },
          OWNER,
        ),
      /commit mutex/,
    )
    assert.equal(fs.existsSync(commitLockFile), true)

    // force moves the record to a backup and the writer is usable again.
    const cleared = await call(
      tools,
      'tower_recover',
      { repoRoot: repo, action: 'clear-stale-lock', confirm: 'CLEAR_STALE_LOCK', force: true },
      OWNER,
    )
    assert.equal(cleared.cleared, true)
    assert.equal(cleared.forced, true)
    assert.match(cleared.commitBackup, /state\.commit\.lock\.recovered-\d+$/)
    assert.equal(fs.existsSync(commitLockFile), false)
    assert.equal(fs.existsSync(cleared.commitBackup), true, 'the moved record must remain auditable')

    await tower.withStateLock(async (_paths, held) => {
      const state = await tower.load()
      state.revision += 1
      state.updatedAt = Date.now()
      await tower.writeState(state, held)
    })
    assert.equal(JSON.parse(fs.readFileSync(tower.paths.state, 'utf8')).revision, 1)
  } finally {
    removeTemp(root)
  }
})

test('doctor warns on an unreadable commit mutex instead of passing it (F71)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const tower = await Tower.open(repo)
    const commitLockFile = stateCommitLockPath(tower.paths)
    // A torn write: the mutex is created with `wx`, not atomically, so a crash
    // can leave a prefix of the JSON record behind.
    const raw = '{"token":"torn",'
    fs.writeFileSync(commitLockFile, raw)

    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    assert.equal(doctor.commitLock.unreadable, true)
    assert.equal(doctor.commitLock.held, false)
    assert.equal(typeof doctor.commitLock.error, 'string')
    assert.equal(doctor.commitLock.path, commitLockFile)
    const commitCheck = doctor.checks.find((entry) => entry.id === 'commit-lock')
    assert.equal(commitCheck.status, 'warn', 'an unreadable record is a wedge, not a pass')
    assert.match(commitCheck.detail, /unreadable/i)
    assert.match(commitCheck.detail, /state-commit-busy/)
    assert.match(commitCheck.action, /clear-stale-lock recovery step/)
    assert.match(commitCheck.action, /force:true/)
    assert.match(commitCheck.action, /CLEAR_STALE_LOCK/)
    assert.doesNotMatch(commitCheck.action, /tower_recover/)
    assert.equal(
      doctor.checks.find((entry) => entry.id === 'state-lock').status,
      'pass',
      'the state writer lock itself is fine',
    )
    assert.equal(fs.existsSync(commitLockFile), true, 'doctor must never move the record')

    // status used to answer "no commit lock" here; it must report the record.
    const status = await call(tools, 'tower_recover', { repoRoot: repo, action: 'status' }, OWNER)
    assert.equal(status.stateLock, null)
    assert.equal(status.commitLock.unreadable, true)
    assert.equal(typeof status.commitLock.error, 'string')

    // An unforced clear refuses (never a silent cleared:false) and keeps the file.
    await assert.rejects(
      () =>
        call(
          tools,
          'tower_recover',
          { repoRoot: repo, action: 'clear-stale-lock', confirm: 'CLEAR_STALE_LOCK' },
          OWNER,
        ),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.details.reason, 'state-commit-lock-unreadable')
        assert.match(error.nextAction, /force:true/)
        return true
      },
    )
    assert.equal(fs.readFileSync(commitLockFile, 'utf8'), raw)

    // force moves (never deletes) the bytes and the writer is usable again.
    const cleared = await call(
      tools,
      'tower_recover',
      { repoRoot: repo, action: 'clear-stale-lock', confirm: 'CLEAR_STALE_LOCK', force: true },
      OWNER,
    )
    assert.equal(cleared.cleared, true)
    assert.equal(cleared.forced, true)
    assert.match(cleared.commitBackup, /state\.commit\.lock\.recovered-\d+$/)
    assert.equal(fs.existsSync(commitLockFile), false)
    assert.equal(fs.readFileSync(cleared.commitBackup, 'utf8'), raw, 'the unreadable bytes stay auditable')

    await tower.withStateLock(async (_paths, held) => {
      const state = await tower.load()
      state.revision += 1
      state.updatedAt = Date.now()
      await tower.writeState(state, held)
    })
    assert.equal(JSON.parse(fs.readFileSync(tower.paths.state, 'utf8')).revision, 1)
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
    assert.match(worktrees.action, /mission teardown step/)
    assert.doesNotMatch(worktrees.action, /tower_teardown/)

    // The status exemption is terminal-only: an active mission still fails.
    await appendMission(tower, missionFixture(tower, { id: 'M51', status: 'active' }))
    const broken = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const brokenWorktrees = broken.checks.find((entry) => entry.id === 'worktrees')
    assert.equal(broken.ok, false)
    assert.equal(brokenWorktrees.status, 'fail')
    assert.match(brokenWorktrees.detail, /1 mission worktree\(s\) are missing or invalid/)
    assert.match(brokenWorktrees.action, /restore the worktree/)
    assert.match(brokenWorktrees.action, /environment health check/)
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
  const home = path.join(root, 'home')
  fs.mkdirSync(home)
  // DSH_HOME is pinned so the profile fallback (#F65) can never see a real ~/.dsh.
  const env = (extra) => ({ DSH_HOME: home, ...extra })
  try {
    const installDir = writeHostPackage(path.join(root, 'install', 'node_modules', '@deepseek-ai', 'dsh'), '0.2.2-rc.3')
    assert.equal(detectHostVersion(undefined, env({ DSH_INSTALL_DIR: installDir })), '0.2.2-rc.3')

    // DSH_INSTALL_DIR may name a directory inside the package; its parent is tried.
    const nested = path.join(installDir, 'dist')
    fs.mkdirSync(nested)
    assert.equal(detectHostVersion(undefined, env({ DSH_INSTALL_DIR: nested })), '0.2.2-rc.3')

    // A missing package.json and an unparsable version both stay unknown.
    assert.equal(detectHostVersion(undefined, env({ DSH_INSTALL_DIR: path.join(root, 'missing') })), null)
    const broken = writeHostPackage(path.join(root, 'broken'), 'not-a-version')
    assert.equal(detectHostVersion(undefined, env({ DSH_INSTALL_DIR: broken })), null)

    // An explicit version still wins over the installed package metadata.
    assert.equal(detectHostVersion(undefined, env({ DSH_VERSION: '0.2.2-rc.3', DSH_INSTALL_DIR: broken })), '0.2.2-rc.3')
  } finally {
    removeTemp(root)
  }
})

test('detectHostVersion: the desktop asar shape stays unknown and says why (F65)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-host-asar-'))
  try {
    const resources = path.join(root, 'resources')
    fs.mkdirSync(resources)
    // The desktop DSH_INSTALL_DIR sits inside app.asar: a container file that
    // ordinary fs cannot read through, so no package.json is reachable there.
    fs.writeFileSync(path.join(resources, 'app.asar'), 'asar container placeholder\n')
    const installDir = path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
    // The unused resources\app.asar.unpacked subtree holds only libreoffice-kit.
    writePackage(
      path.join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'libreoffice-kit'),
      '@deepseek-ai/libreoffice-kit',
      '0.2.3',
    )
    const home = path.join(root, 'home')
    fs.mkdirSync(home)
    const env = { DSH_HOME: home, DSH_VERSION: '', DSH_HOST_VERSION: '   ', DSH_INSTALL_DIR: installDir }
    const ctx = { get: (name) => (['app', 'runtime', 'host'].includes(name) ? {} : undefined) }

    assert.equal(detectHostVersion(ctx, env), null)
    const report = resolveHostVersion(ctx, env)
    assert.equal(report.version, null)
    assert.equal(report.source, null)
    assert.equal(report.authoritative, false)
    assert.equal(report.asar.container, path.join(resources, 'app.asar'))
    // The substitution mirrors the install path into the unpacked sibling.
    assert.equal(
      report.asar.unpackedDir,
      path.join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'),
    )
    assert.equal(report.asar.directReadable, false)
    assert.equal(report.asar.unpackedAnswered, false)
    assert.match(report.asar.note, /cannot read/)
    assert.match(report.detail, /no source answered/)
    assert.match(report.detail, /app\.asar/)
    assert.equal(report.probes.find((probe) => probe.source === 'env:DSH_VERSION').status, 'skipped')
    assert.match(
      report.probes.find((probe) => probe.source === 'env:DSH_VERSION').reason,
      /empty or whitespace-only; treated as absent/,
    )
    assert.equal(report.probes.find((probe) => probe.source === 'env:DSH_HOST_VERSION').status, 'skipped')
    const asarProbe = report.probes.find((probe) => probe.source === 'DSH_INSTALL_DIR')
    assert.equal(asarProbe.status, 'miss')
    assert.match(asarProbe.reason, /inside an asar container, which ordinary fs cannot read/)
    const unpackedProbe = report.probes.find((probe) => probe.source === 'DSH_INSTALL_DIR.asar.unpacked')
    assert.equal(unpackedProbe.status, 'miss')
    assert.match(unpackedProbe.reason, /app\.asar\.unpacked substitution/)
    assert.match(unpackedProbe.target, /app\.asar\.unpacked/)
    assert.deepEqual(
      report.probes.filter((probe) => probe.source.startsWith('service:')).map((probe) => probe.status),
      ['miss', 'miss', 'miss'],
    )
  } finally {
    removeTemp(root)
  }
})

test('detectHostVersion: the app.asar.unpacked copy answers when the archive is unreadable (F65)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-host-unpacked-'))
  try {
    const resources = path.join(root, 'resources')
    fs.mkdirSync(resources)
    fs.writeFileSync(path.join(resources, 'app.asar'), 'asar container placeholder\n')
    const installDir = path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
    const unpacked = writeHostPackage(
      path.join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'),
      '0.2.2-rc.3',
    )
    const home = path.join(root, 'home')
    fs.mkdirSync(home)
    const env = { DSH_HOME: home, DSH_HOST_VERSION: '', DSH_INSTALL_DIR: installDir }

    assert.equal(detectHostVersion(undefined, env), '0.2.2-rc.3')
    const report = resolveHostVersion(undefined, env)
    assert.equal(report.version, '0.2.2-rc.3')
    assert.equal(report.source, 'DSH_INSTALL_DIR.asar.unpacked')
    assert.equal(report.authoritative, true)
    assert.equal(report.asar.container, path.join(resources, 'app.asar'))
    assert.equal(report.asar.directReadable, false)
    assert.equal(report.asar.unpackedAnswered, true)
    assert.match(report.detail, /app\.asar\.unpacked copy/)
    const hit = report.probes.find((probe) => probe.source === 'DSH_INSTALL_DIR.asar.unpacked')
    assert.equal(hit.status, 'hit')
    assert.equal(hit.authoritative, true)
    assert.equal(hit.target, unpacked)
  } finally {
    removeTemp(root)
  }
})

test('detectHostVersion: empty and whitespace-only env values are absent, not versions (F65)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-host-empty-'))
  const home = path.join(root, 'home')
  fs.mkdirSync(home)
  try {
    const env = {
      DSH_HOME: home,
      DSH_VERSION: '',
      DSH_HOST_VERSION: '  \t ',
      npm_config_dsh_version: '\n',
      DSH_INSTALL_DIR: '   ',
    }
    assert.equal(detectHostVersion(undefined, env), null)
    const report = resolveHostVersion(undefined, env)
    assert.equal(report.version, null)
    for (const key of ['DSH_VERSION', 'DSH_HOST_VERSION', 'npm_config_dsh_version']) {
      const probe = report.probes.find((entry) => entry.source === `env:${key}`)
      assert.ok(probe, `${key} is probed`)
      assert.equal(probe.status, 'skipped')
      assert.match(probe.reason, /treated as absent/)
    }
    const installProbe = report.probes.find((entry) => entry.source === 'env:DSH_INSTALL_DIR')
    assert.equal(installProbe.status, 'skipped')
    assert.match(installProbe.reason, /treated as absent/)

    // A padded real value is answered trimmed, never with its whitespace.
    assert.equal(detectHostVersion(undefined, { DSH_HOME: home, DSH_VERSION: ' 0.2.2-rc.3 ' }), '0.2.2-rc.3')
  } finally {
    removeTemp(root)
  }
})

test('detectHostVersion: a profile dependency answers only as a labelled secondary source (F65)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-host-profile-'))
  const home = path.join(root, 'home')
  fs.mkdirSync(home)
  try {
    const profilePackageDir = writeProfilePackage(home, 'desktop', 'dsh-tool-subagent', '0.2.2-rc.3')
    const env = { DSH_HOME: home }
    assert.equal(detectHostVersion(undefined, env), '0.2.2-rc.3')
    const report = resolveHostVersion(undefined, env)
    assert.equal(report.version, '0.2.2-rc.3')
    assert.equal(report.source, 'profile:@deepseek-ai/dsh-tool-subagent')
    assert.equal(report.authoritative, false)
    assert.match(report.detail, /profile-installed dependency/)
    assert.match(report.detail, /secondary source/)
    assert.match(report.detail, /may lag/)
    const hit = report.probes.find((entry) => entry.source === 'profile:@deepseek-ai/dsh-tool-subagent')
    assert.equal(hit.status, 'hit')
    assert.equal(hit.authoritative, false)
    assert.equal(hit.target, profilePackageDir)

    // An authoritative source still wins and the profile is never probed.
    const authoritative = resolveHostVersion(undefined, { DSH_HOME: home, DSH_VERSION: '0.2.2-rc.3' })
    assert.equal(authoritative.source, 'env:DSH_VERSION')
    assert.equal(authoritative.authoritative, true)
    assert.equal(authoritative.probes.some((entry) => entry.source.startsWith('profile:')), false)

    // A sibling @deepseek-ai/dsh* package is a candidate when the named one is absent.
    const otherHome = path.join(root, 'other-home')
    fs.mkdirSync(otherHome)
    writeProfilePackage(otherHome, 'desktop', 'dsh-tool-batch', '0.2.2-rc.3')
    const sibling = resolveHostVersion(undefined, { DSH_HOME: otherHome })
    assert.equal(sibling.version, '0.2.2-rc.3')
    assert.equal(sibling.source, 'profile:@deepseek-ai/dsh-tool-batch')
    assert.equal(sibling.authoritative, false)
  } finally {
    removeTemp(root)
  }
})

test('detectHostVersion: a bogus version string is rejected, never returned (F65)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-host-bogus-'))
  const home = path.join(root, 'home')
  fs.mkdirSync(home)
  try {
    const broken = writeHostPackage(path.join(root, 'broken'), 'not-a-version')
    const env = { DSH_HOME: home, DSH_VERSION: 'not-a-version', DSH_HOST_VERSION: 'unknown', DSH_INSTALL_DIR: broken }
    assert.equal(detectHostVersion(undefined, env), null)
    const report = resolveHostVersion(undefined, env)
    const versionProbe = report.probes.find((entry) => entry.source === 'env:DSH_VERSION')
    assert.equal(versionProbe.status, 'miss')
    assert.match(versionProbe.reason, /not a parsable version/)
    assert.equal(report.probes.find((entry) => entry.source === 'env:DSH_HOST_VERSION').status, 'miss')
    const installProbe = report.probes.find((entry) => entry.source === 'DSH_INSTALL_DIR')
    assert.equal(installProbe.status, 'miss')
    assert.match(installProbe.reason, /not a parsable version/)

    // A later authoritative source still answers when the earlier ones are bogus.
    assert.equal(detectHostVersion(undefined, { ...env, npm_config_dsh_version: '0.2.2-rc.3' }), '0.2.2-rc.3')
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

test('doctor: the desktop asar shape is reported and a profile dependency never passes (F65)', async () => {
  const { root, repo, home } = seedRepo()
  const { tools } = makeCtx()
  const saved = saveHostEnv()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    clearHostEnv()
    const rows = readCompatibility()
    const expected = rows.reduce(
      (best, row) => (compareVersions(row.hostVersion, best.hostVersion) >= 0 ? row : best),
      rows[0],
    ).hostVersion

    // The real desktop shape: the install dir lives inside app.asar, the version
    // env vars exist but are empty, and no app/runtime/host service answers.
    const resources = path.join(root, 'resources')
    fs.mkdirSync(resources, { recursive: true })
    fs.writeFileSync(path.join(resources, 'app.asar'), 'asar container placeholder\n')
    process.env.DSH_VERSION = ''
    process.env.DSH_HOST_VERSION = ''
    process.env.DSH_INSTALL_DIR = path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
    writePackage(
      path.join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'libreoffice-kit'),
      '@deepseek-ai/libreoffice-kit',
      '0.2.3',
    )

    const unknown = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const unknownCheck = unknown.checks.find((entry) => entry.id === 'host-version')
    assert.equal(unknownCheck.status, 'warn')
    assert.match(unknownCheck.detail, /unknown host version/)
    assert.match(unknownCheck.detail, /app\.asar/)
    assert.match(unknownCheck.detail, /cannot read/)
    assert.equal(unknown.environmentContract.hostVersion, null)
    assert.equal(unknown.environmentContract.hostAsar.container, path.join(resources, 'app.asar'))
    assert.equal(unknown.environmentContract.hostAsar.directReadable, false)
    assert.ok(
      unknown.environmentContract.hostVersionProbes.some(
        (probe) => probe.source === 'env:DSH_VERSION' && probe.status === 'skipped',
      ),
    )

    // The profile-installed tool package is versioned in lockstep with the host,
    // but it is only a dependency and may lag: advisory, never a pass.
    writeProfilePackage(home, 'desktop', 'dsh-tool-subagent', expected)
    const secondary = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const secondaryCheck = secondary.checks.find((entry) => entry.id === 'host-version')
    assert.equal(secondary.environmentContract.hostVersion, expected)
    assert.equal(secondary.environmentContract.hostVersionSource, 'profile:@deepseek-ai/dsh-tool-subagent')
    assert.equal(secondary.environmentContract.hostVersionAuthoritative, false)
    assert.equal(secondary.environmentContract.hostCompatibility, 'verified')
    assert.equal(secondaryCheck.status, 'warn', 'a secondary source never passes')
    assert.match(secondaryCheck.detail, /profile-installed dependency/)
    assert.match(secondaryCheck.detail, /may lag/)
    assert.match(secondaryCheck.action, /DSH_VERSION/)
    const hit = secondary.environmentContract.hostVersionProbes.find(
      (probe) => probe.source === 'profile:@deepseek-ai/dsh-tool-subagent',
    )
    assert.equal(hit.status, 'hit')
    assert.equal(hit.authoritative, false)
  } finally {
    restoreHostEnv(saved)
    removeTemp(root)
  }
})

test('detectHostVersion: the first readable install package answers, not its parent (F65, R122)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-host-precedence-'))
  const home = path.join(root, 'home')
  fs.mkdirSync(home)
  const saved = saveHostEnv()
  const seeded = seedRepo()
  const { tools } = makeCtx()
  try {
    // 9.9.9 is newer than every COMPATIBILITY row; the parent's 0.2.2-rc.3 is a
    // verified row, so the last-readable-candidate bug used to turn this into a
    // `verified` doctor pass.
    const rows = readCompatibility()
    assert.ok(rows.some((row) => row.hostVersion === '0.2.2-rc.3'), 'the parent fixture is a verified row')
    const installDir = writeHostPackage(path.join(root, 'install', 'node_modules', '@deepseek-ai', 'dsh'), '9.9.9')
    const parentDir = writePackage(path.dirname(installDir), '@deepseek-ai/dsh', '0.2.2-rc.3')
    const env = {
      DSH_HOME: home,
      DSH_VERSION: '',
      DSH_HOST_VERSION: '',
      npm_config_dsh_version: '',
      DSH_INSTALL_DIR: installDir,
    }

    const report = resolveHostVersion(undefined, env)
    assert.equal(report.version, '9.9.9', 'the install dir itself answers, not its older parent')
    assert.equal(report.source, 'DSH_INSTALL_DIR')
    assert.equal(report.authoritative, true)
    assert.match(report.detail, /named by DSH_INSTALL_DIR/)

    const assessment = assessHostVersion(report.version, readCompatibility())
    assert.equal(assessment.verdict, 'untested-newer')
    assert.notEqual(assessment.verdict, 'verified')
    const diagnosis = diagnoseHostVersion(report, assessment)
    assert.equal(diagnosis.status, 'warn', 'an untested-newer install must not be a doctor pass')
    assert.match(diagnosis.detail, /^9\.9\.9: /)
    assert.match(diagnosis.detail, /newer than every verified build/)

    // Provenance keeps both readable candidates; only the parent is displaced.
    const chosen = report.probes.find((probe) => probe.source === 'DSH_INSTALL_DIR')
    assert.equal(chosen.status, 'hit')
    assert.equal(chosen.target, installDir)
    assert.match(chosen.reason, /declares 9\.9\.9/)
    const displaced = report.probes.find((probe) => probe.source === 'DSH_INSTALL_DIR(parent)')
    assert.equal(displaced.status, 'hit')
    assert.equal(displaced.target, parentDir)
    assert.match(displaced.reason, /declares 0\.2\.2-rc\.3/)
    assert.match(displaced.reason, /higher-precedence source answered/)
    assert.match(displaced.reason, /recorded and not used/)

    // End to end: doctor's host-version check is a warn, never the false pass
    // the last-readable-candidate bug produced.
    await call(tools, 'tower_init', { repoRoot: seeded.repo }, OWNER)
    clearHostEnv()
    process.env.DSH_INSTALL_DIR = installDir
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: seeded.repo })
    const check = doctor.checks.find((entry) => entry.id === 'host-version')
    assert.equal(check.status, 'warn')
    assert.equal(doctor.environmentContract.hostVersion, '9.9.9')
    assert.equal(doctor.environmentContract.hostVersionSource, 'DSH_INSTALL_DIR')
    assert.equal(doctor.environmentContract.hostCompatibility, 'untested-newer')
    assert.equal(doctor.environmentContract.hostVersionAuthoritative, true)
  } finally {
    restoreHostEnv(saved)
    removeTemp(seeded.root)
    removeTemp(root)
  }
})

test('detectHostVersion: the unpacked install package outranks the unpacked parent (F65, R122)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-host-unpacked-precedence-'))
  try {
    const resources = path.join(root, 'resources')
    fs.mkdirSync(resources)
    fs.writeFileSync(path.join(resources, 'app.asar'), 'asar container placeholder\n')
    const installDir = path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
    const unpacked = writeHostPackage(
      path.join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'),
      '9.9.9',
    )
    const unpackedParent = writePackage(path.dirname(unpacked), '@deepseek-ai/dsh', '0.2.2-rc.3')
    const home = path.join(root, 'home')
    fs.mkdirSync(home)
    const env = { DSH_HOME: home, DSH_HOST_VERSION: '', DSH_INSTALL_DIR: installDir }

    const report = resolveHostVersion(undefined, env)
    assert.equal(report.version, '9.9.9')
    assert.equal(report.source, 'DSH_INSTALL_DIR.asar.unpacked')
    assert.equal(report.authoritative, true)
    assert.equal(report.asar.unpackedAnswered, true)
    assert.equal(report.asar.directReadable, false)
    assert.match(report.detail, /app\.asar\.unpacked copy/)

    const answered = report.probes.find((probe) => probe.source === 'DSH_INSTALL_DIR.asar.unpacked')
    assert.equal(answered.status, 'hit')
    assert.equal(answered.target, unpacked)
    assert.match(answered.reason, /declares 9\.9\.9/)
    const displaced = report.probes.find((probe) => probe.source === 'DSH_INSTALL_DIR.asar.unpacked(parent)')
    assert.equal(displaced.status, 'hit')
    assert.equal(displaced.target, unpackedParent)
    assert.match(displaced.reason, /declares 0\.2\.2-rc\.3/)
    assert.match(displaced.reason, /higher-precedence source answered/)
    assert.match(displaced.reason, /recorded and not used/)
  } finally {
    removeTemp(root)
  }
})

test('detectHostVersion: provenance records every install candidate exactly once (F65, R122)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-host-provenance-'))
  try {
    const resources = path.join(root, 'resources')
    fs.mkdirSync(resources)
    fs.writeFileSync(path.join(resources, 'app.asar'), 'asar container placeholder\n')
    // DSH_INSTALL_DIR names the container itself: the unpacked parent collapses
    // onto `resources`, so the dedupe must keep one probe for that path.
    writePackage(resources, '@fixture/resources', '0.2.2-rc.3')
    const home = path.join(root, 'home')
    fs.mkdirSync(home)
    const env = { DSH_HOME: home, DSH_INSTALL_DIR: path.join(resources, 'app.asar') }

    const report = resolveHostVersion(undefined, env)
    assert.equal(report.version, '0.2.2-rc.3')
    assert.equal(report.source, 'DSH_INSTALL_DIR(parent)')
    assert.equal(report.authoritative, true)
    const sources = report.probes.filter((probe) => probe.source.startsWith('DSH_INSTALL_DIR')).map((probe) => probe.source)
    assert.deepEqual(sources, [
      'DSH_INSTALL_DIR',
      'DSH_INSTALL_DIR(parent)',
      'DSH_INSTALL_DIR.asar.unpacked',
    ])
    const containerProbe = report.probes.find((probe) => probe.source === 'DSH_INSTALL_DIR')
    assert.equal(containerProbe.status, 'miss')
    assert.match(containerProbe.reason, /inside an asar container, which ordinary fs cannot read/)
    const unpackedProbe = report.probes.find((probe) => probe.source === 'DSH_INSTALL_DIR.asar.unpacked')
    assert.equal(unpackedProbe.status, 'miss')
    assert.match(unpackedProbe.reason, /app\.asar\.unpacked substitution/)
  } finally {
    removeTemp(root)
  }
})

test('detectHostVersion: a throwing os.homedir() is a failed probe, never a throw (F65, R122)', () => {
  const savedHomedir = os.homedir
  try {
    os.homedir = () => {
      throw new Error('homedir unavailable')
    }
    const env = { DSH_VERSION: '', DSH_HOST_VERSION: '', npm_config_dsh_version: '', DSH_INSTALL_DIR: '' }
    let report
    assert.doesNotThrow(() => {
      report = resolveHostVersion(undefined, env)
    })
    assert.equal(report.version, null)
    const probe = report.probes.find((entry) => entry.source === 'profile')
    assert.ok(probe, 'the failed homedir lookup is recorded')
    assert.equal(probe.status, 'miss')
    assert.match(probe.reason, /os\.homedir\(\) threw/)
    assert.match(probe.reason, /homedir unavailable/)
    assert.equal(probe.authoritative, false)
  } finally {
    os.homedir = savedHomedir
  }
})

test('doctor: a terminal mission with a live worktree and no live agent prompts for teardown (#182)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const tower = await Tower.open(repo)
    await tower.plan({ missions: [{ title: 'Awaiting teardown', scope: ['src/**'], tasks: ['write'] }] })
    const provisioned = await tower.provision({ missionId: 'M1' })
    const now = Date.now()
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === 'M1')
    mission.status = 'merged'
    mission.mergedCommit = 'a'.repeat(40)
    mission.mergedAt = now
    mission.updatedAt = now
    state.roster = []
    state.revision += 1
    validateState(state, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, state)

    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const worktrees = doctor.checks.find((entry) => entry.id === 'worktrees')
    assert.equal(worktrees.status, 'warn')
    assert.equal(worktrees.detail, '1 terminal mission worktree(s) awaiting teardown; run tower_teardown')
    assert.match(worktrees.action, /worktree teardown step/)
    assert.match(worktrees.action, /nothing is removed automatically/)
    assert.doesNotMatch(worktrees.action, /tower_teardown/, 'the remedy copy never names a tool id')
    assert.equal(fs.existsSync(provisioned.worktree.path), true, 'doctor never removes a worktree')
    assert.equal(doctor.ok, true, 'the prompt is advisory, not a failure')

    // Dirtiness is orthogonal: a dirty terminal checkout is still a finished
    // mission waiting for teardown, so both advisory lines appear together.
    fs.writeFileSync(path.join(provisioned.worktree.path, 'scratch.txt'), 'scratch\n')
    const dirty = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const dirtyWorktrees = dirty.checks.find((entry) => entry.id === 'worktrees')
    assert.equal(dirtyWorktrees.status, 'warn')
    assert.match(dirtyWorktrees.detail, /1 terminal mission worktree\(s\) awaiting teardown; run tower_teardown/)
    assert.match(dirtyWorktrees.detail, /1 worktree\(s\) have uncommitted changes/)
    assert.equal(dirty.ok, true)
    fs.rmSync(path.join(provisioned.worktree.path, 'scratch.txt'))

    // A live roster row on the mission suppresses the prompt: the agent may
    // still be finishing work in that checkout.
    const withAgent = await tower.load()
    withAgent.roster = [{ name: 'worker-m1', agentId: 'agent-m1', missionId: 'M1', state: 'active', spawnedAt: now }]
    withAgent.revision += 1
    validateState(withAgent, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, withAgent)

    const rechecked = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const recheckedWorktrees = rechecked.checks.find((entry) => entry.id === 'worktrees')
    assert.equal(recheckedWorktrees.status, 'pass')
    assert.doesNotMatch(recheckedWorktrees.detail, /awaiting teardown/)
  } finally {
    removeTemp(root)
  }
})

test('doctor: an unrecorded checkout inside the root is visible and orphan teardown clears the report (#185, #187)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const tower = await Tower.open(repo)
    const checkoutRoot = teardownWorktreeRoot(tower)
    fs.mkdirSync(checkoutRoot, { recursive: true })
    const orphan = path.join(checkoutRoot, 'unrecorded-clean')
    git(repo, ['worktree', 'add', '-b', 'orphan-unrecorded-clean', orphan, 'HEAD'])

    const before = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const beforeCheck = before.checks.find((entry) => entry.id === 'worktrees-orphans')
    assert.ok(beforeCheck, 'the orphan report is a doctor check')
    assert.equal(beforeCheck.status, 'warn')
    assert.match(beforeCheck.detail, /1 unrecorded worktree\(s\) under the worktree root/)
    assert.match(beforeCheck.detail, /1 clean/)
    assert.match(beforeCheck.action, /worktree teardown step/)
    assert.match(beforeCheck.action, /nothing is removed automatically/)
    assert.doesNotMatch(beforeCheck.action, /tower_teardown/, 'the remedy copy never names a tool id')
    assert.equal(before.ok, true, 'an unrecorded checkout is advisory, not a failure')
    assert.equal(fs.existsSync(orphan), true, 'doctor never removes a worktree')

    const swept = await tower.teardown({ orphans: true })
    assert.ok(
      swept.orphanWorktrees.removed.some((entry) => path.resolve(entry) === path.resolve(orphan)),
      'the opt-in sweep is the remedy the report asks for',
    )

    const after = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const afterCheck = after.checks.find((entry) => entry.id === 'worktrees-orphans')
    assert.equal(afterCheck.status, 'pass')
    assert.equal(afterCheck.detail, 'no unrecorded worktrees')
    assert.equal(afterCheck.action, undefined, 'a clean report needs no remedy')
    assert.equal(fs.existsSync(orphan), false)
  } finally {
    removeTemp(root)
  }
})

test('doctor: a checkout outside the worktree root is reported as a documented limit and never removed (#187)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const tower = await Tower.open(repo)
    const outsideRoot = path.dirname(teardownWorktreeRoot(tower))
    fs.mkdirSync(outsideRoot, { recursive: true })
    const external = path.join(outsideRoot, 'external-checkout')
    git(repo, ['worktree', 'add', '-b', 'external-checkout', external, 'HEAD'])

    const report = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const check = report.checks.find((entry) => entry.id === 'worktrees-orphans')
    assert.equal(check.status, 'warn')
    assert.match(check.detail, /outside the worktree root/)
    assert.match(check.detail, /never removed by Tower/)
    assert.equal(report.ok, true)

    const swept = await tower.teardown({ orphans: true })
    const decision = swept.orphanWorktrees.decisions.find((entry) => path.resolve(entry.path) === path.resolve(external))
    assert.equal(decision.action, 'keep')
    assert.equal(decision.reason, 'outside the worktree root')
    assert.equal(fs.existsSync(external), true, 'Tower never removes a path outside its worktree root')

    const recheck = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const recheckCheck = recheck.checks.find((entry) => entry.id === 'worktrees-orphans')
    assert.equal(recheckCheck.status, 'warn', 'the documented limit stays visible until the operator accepts it')
    assert.match(recheckCheck.detail, /outside the worktree root/)
  } finally {
    removeTemp(root)
  }
})

test('doctor: a survey mission cannot hide an unrecorded checkout at its worktree path (#185 R1, #187)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const tower = await Tower.open(repo)
    const planned = await tower.plan({ missions: [{ title: 'Read the seed', kind: 'survey' }] })
    const mission = planned.missions[0]
    const checkoutRoot = teardownWorktreeRoot(tower)
    fs.mkdirSync(checkoutRoot, { recursive: true })
    const checkout = path.join(checkoutRoot, mission.id)
    git(repo, ['worktree', 'add', '-b', 'survey-unrecorded', checkout, 'HEAD'])

    // Before the fix the survey reserved `<root>/<id>`, the inventory dropped the
    // reserved row from `orphans`, and the doctor printed a bare pass.
    const before = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const beforeCheck = before.checks.find((entry) => entry.id === 'worktrees-orphans')
    assert.equal(beforeCheck.status, 'warn', 'a survey does not make an unrecorded checkout invisible')
    assert.match(beforeCheck.detail, /1 unrecorded worktree\(s\) under the worktree root/)
    assert.equal(beforeCheck.detail.includes('in flight'), false, 'no in-flight claim is made for a survey path')

    const swept = await tower.teardown({ orphans: true })
    assert.ok(
      swept.orphanWorktrees.removed.some((entry) => path.resolve(entry) === path.resolve(checkout)),
      'the opt-in sweep is the remedy the report asks for',
    )
    assert.equal(fs.existsSync(checkout), false)

    const after = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const afterCheck = after.checks.find((entry) => entry.id === 'worktrees-orphans')
    assert.equal(afterCheck.status, 'pass')
    assert.equal(afterCheck.detail, 'no unrecorded worktrees')
  } finally {
    removeTemp(root)
  }
})

test('doctor: a provisionable mission reports its unrecorded checkout as in flight, not as unrecorded (#187)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const tower = await Tower.open(repo)
    const planned = await tower.plan({ missions: [{ title: 'Live build', scope: ['src/**'] }] })
    const mission = planned.missions[0]
    const checkoutRoot = teardownWorktreeRoot(tower)
    fs.mkdirSync(checkoutRoot, { recursive: true })
    const checkout = path.join(checkoutRoot, mission.id)
    git(repo, ['worktree', 'add', '-b', 'inflight-unrecorded', checkout, 'HEAD'])

    const report = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const check = report.checks.find((entry) => entry.id === 'worktrees-orphans')
    assert.equal(check.status, 'pass', 'an in-flight checkout is not an unrecorded defect')
    assert.equal(check.detail, 'no unrecorded worktrees; 1 checkout(s) in flight (kept)')
    assert.equal(check.action, undefined, 'no remedy is applied to an in-flight checkout')
    assert.equal(fs.existsSync(checkout), true, 'doctor never removes a worktree')

    // The same reservation keeps the sweep from reclaiming it: a genuine
    // in-flight build provision is still protected.
    const swept = await tower.teardown({ orphans: true })
    const decision = swept.orphanWorktrees.decisions.find((entry) => path.resolve(entry.path) === path.resolve(checkout))
    assert.equal(decision.action, 'keep')
    assert.equal(decision.reason, 'a checkout is being provisioned and is not recorded by state yet')
    assert.equal(fs.existsSync(checkout), true)
  } finally {
    removeTemp(root)
  }
})

// #188/#189: the foreign capability inventory. Tower does not deny a capability
// it does not replace, so doctor reports every known type with its stance, how it
// is detected and the one-line cost of denying it; a type it cannot detect is a
// warning, never an assumed absence.
test('the foreign capability inventory covers every known type with a stance, detection and denial cost', () => {
  assert.deepEqual(
    FOREIGN_CAPABILITIES.map((row) => row.id),
    ['forge', 'liveshare', 'plugin-manager', 'auto-review'],
  )
  for (const row of FOREIGN_CAPABILITIES) {
    assert.equal(row.stance, 'warn+allow', `${row.id} is allowed, not denied`)
    assert.ok(row.name, `${row.id} names itself`)
    assert.ok(row.detection, `${row.id} names how doctor detects it`)
    assert.ok(row.denialCost, `${row.id} records the cost of denying it`)
    assert.ok(row.remedy, `${row.id} records the remedy where an action is possible`)
  }
  const auto = FOREIGN_CAPABILITIES.find((row) => row.id === 'auto-review')
  assert.match(auto.failureMode, /approval policy to never/)
  assert.match(auto.failureMode, /fails closed/)
  assert.match(auto.failureMode, /no escalation path/)
})

test('doctor: an unreadable foreign capability surface is a warning, not an assumed absence (#188, #189)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const row = doctor.checks.find((entry) => entry.id === 'foreign-capabilities')
    assert.equal(row.status, 'warn')
    assert.equal(doctor.ok, true, 'a warning is advisory')
    assert.match(row.action, /keep the capability available/)
    assert.deepEqual(doctor.foreignCapabilities.notDetectable, ['forge', 'liveshare', 'plugin-manager', 'auto-review'])
    for (const name of ['Forge change requests', 'Live sharing', 'Plugin manager', 'Auto review']) {
      assert.ok(row.detail.includes(name), `the detail names ${name}`)
    }
    assert.match(row.detail, /detection is unavailable/)
  } finally {
    removeTemp(root)
  }
})

test('doctor: a provably clean surface passes the foreign capability check (#188, #189)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx({
    services: {
      loader: loaderFixture(),
      permissionPresets: { names: [], current: () => null },
    },
    toolRuntime: { definitions: () => [] },
  })
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const row = doctor.checks.find((entry) => entry.id === 'foreign-capabilities')
    assert.deepEqual(
      doctor.foreignCapabilities.notDetectable,
      [],
      'a readable loader tree must make every type detectable',
    )
    assert.equal(row.status, 'pass')
    assert.equal(row.action, undefined)
    assert.match(row.detail, /no non-Tower capability is available; 4 known types checked/)
    assert.deepEqual(doctor.foreignCapabilities.present, [])
    assert.deepEqual(doctor.foreignCapabilities.installed, [])
    assert.deepEqual(doctor.foreignCapabilities.stances, {
      forge: 'warn+allow',
      liveshare: 'warn+allow',
      'plugin-manager': 'warn+allow',
      'auto-review': 'warn+allow',
    })
    // The same entries() read feeds the pre-existing loader-conflicts check.
    assert.equal(doctor.checks.find((entry) => entry.id === 'loader-conflicts').status, 'pass')
  } finally {
    removeTemp(root)
  }
})

test('doctor: the loader store dict and a group subtree supply the inventory rows (#188, #189)', async () => {
  const { root, repo } = seedRepo()
  const child = loaderStoreFixture([
    { id: 'forge', name: '@deepseek-ai/dsh-experimental-forge' },
  ])
  const loader = loaderStoreFixture()
  loader.store['optional-group'] = {
    options: { id: 'optional-group', name: 'cordis:group', group: true },
    subtree: child,
  }
  const { tools } = makeCtx({
    services: {
      loader,
      permissionPresets: { names: [], current: () => null },
    },
    toolRuntime: { definitions: () => [] },
  })
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    assert.deepEqual(doctor.foreignCapabilities.notDetectable, [])
    assert.deepEqual(doctor.foreignCapabilities.present, ['forge'])
    const forge = doctor.foreignCapabilities.capabilities.find((entry) => entry.id === 'forge')
    assert.equal(forge.installed, true)
    assert.ok(forge.evidence.some((entry) => entry.includes('loader row "forge"')), 'the nested row is found')
  } finally {
    removeTemp(root)
  }
})

test('doctor: the shipped group anchor and its tower-host child are Tower itself, not a conflict (F89)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx({
    services: {
      loader: shippedLoaderFixture([{ id: 'forge', name: '@deepseek-ai/dsh-experimental-forge' }]),
      permissionPresets: { names: [], current: () => null },
    },
    toolRuntime: { definitions: () => [] },
  })
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const row = doctor.checks.find((entry) => entry.id === 'loader-conflicts')
    assert.equal(row.status, 'pass', JSON.stringify(row))
    assert.equal(row.detail, 'no conflicting dsh-tower loader rows')
    // The same shipped-shaped inventory still feeds the foreign-capability probe.
    assert.ok(doctor.foreignCapabilities.present.includes('forge'))
    assert.equal(doctor.foreignCapabilities.capabilities.find((entry) => entry.id === 'forge').detectable, true)
  } finally {
    removeTemp(root)
  }
})

test('doctor: a lone legacy dsh-tower row is Tower itself, not a conflict (F89)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx({
    services: {
      loader: loaderFixture([{ id: 'tower', name: 'dsh-tower' }]),
    },
  })
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const row = doctor.checks.find((entry) => entry.id === 'loader-conflicts')
    assert.equal(row.status, 'pass', JSON.stringify(row))
    assert.equal(row.detail, 'no conflicting dsh-tower loader rows')
  } finally {
    removeTemp(root)
  }
})

test('doctor: a legacy dsh-tower row beside the shipped anchor still fails (F89)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx({
    services: {
      loader: shippedLoaderFixture([{ id: 'tower-legacy', name: 'dsh-tower' }]),
    },
  })
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const row = doctor.checks.find((entry) => entry.id === 'loader-conflicts')
    assert.equal(row.status, 'fail')
    assert.equal(doctor.ok, false)
    assert.match(row.detail, /another loader row in this repository also resolves to "dsh-tower"/)
    assert.match(row.detail, /tower-legacy/)
    assert.doesNotMatch(row.detail, /tower-host/, 'the anchor child is Tower itself, never the conflict')
    assert.doesNotMatch(`${row.detail} ${row.action}`, /dsh-plugins-tower/, 'the retired package name is gone')
    assert.match(row.action, /remove or disable/)
    assert.match(row.action, /restart DSH/)
  } finally {
    removeTemp(root)
  }
})

test('doctor: an unreadable loader inventory still warns instead of passing (F89)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx({
    services: {
      loader: {
        entries() {
          throw new Error('loader unavailable')
        },
      },
    },
  })
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const row = doctor.checks.find((entry) => entry.id === 'loader-conflicts')
    assert.equal(row.status, 'warn')
    assert.equal(row.detail, 'loader inventory unavailable; cannot detect co-installed Tower packages')
    assert.equal(row.action, undefined)
  } finally {
    removeTemp(root)
  }
})

test('doctor: the shared loader inventory still detects conflicting dsh-tower rows (#188)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx({
    services: {
      loader: loaderFixture([
        { id: 'tower', name: 'dsh-tower' },
        { id: 'tower-2', name: 'dsh-tower' },
      ]),
    },
  })
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const row = doctor.checks.find((entry) => entry.id === 'loader-conflicts')
    assert.equal(row.status, 'fail')
    assert.match(row.detail, /tower-2/)
    assert.doesNotMatch(`${row.detail} ${row.action}`, /dsh-plugins-tower/)
    assert.match(row.action, /remove or disable/)
  } finally {
    removeTemp(root)
  }
})

test('doctor: a visible plugin manager warns with the cost of denying it (#188, #189)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx({
    services: {
      loader: loaderStoreFixture(),
      permissionPresets: { names: [], current: () => null },
    },
    toolRuntime: { definitions: () => [{ name: 'plugin_manager' }] },
  })
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const row = doctor.checks.find((entry) => entry.id === 'foreign-capabilities')
    assert.equal(row.status, 'warn')
    assert.match(row.detail, /Plugin manager \(warn\+allow\)/)
    assert.match(row.detail, /no longer install or enable a plugin from a session/)
    assert.deepEqual(doctor.foreignCapabilities.present, ['plugin-manager'])
    const report = doctor.foreignCapabilities.capabilities.find((entry) => entry.id === 'plugin-manager')
    assert.equal(report.detectable, true)
    assert.ok(report.evidence.some((entry) => entry.includes('plugin_manager')))
  } finally {
    removeTemp(root)
  }
})

test('doctor: liveshare is detected through the service name the package provides (#188, #189)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx({
    services: {
      loader: loaderStoreFixture(),
      permissionPresets: { names: [], current: () => null },
      liveshareShares: {},
    },
    toolRuntime: { definitions: () => [] },
  })
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const row = doctor.checks.find((entry) => entry.id === 'foreign-capabilities')
    assert.equal(row.status, 'warn')
    assert.match(row.detail, /Live sharing \(warn\+allow\)/)
    const liveshare = doctor.foreignCapabilities.capabilities.find((entry) => entry.id === 'liveshare')
    assert.equal(liveshare.present, true)
    assert.equal(liveshare.detectable, true)
    assert.ok(
      liveshare.evidence.some((entry) => entry.includes('liveshareShares service is mounted')),
      'the probe reads the service the package registers',
    )
    assert.match(liveshare.detection, /liveshareShares/)
  } finally {
    removeTemp(root)
  }
})

test('doctor: a disabled capability row is installed but not mounted, and does not warn (#188, #189)', async () => {
  const { root, repo } = seedRepo()
  const disabledRow = { id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools', disabled: true }
  const { tools } = makeCtx({
    services: {
      loader: loaderFixture([disabledRow]),
      permissionPresets: { names: [], current: () => null },
    },
    toolRuntime: { definitions: () => [] },
  })
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const row = doctor.checks.find((entry) => entry.id === 'foreign-capabilities')
    assert.equal(row.status, 'pass')
    assert.match(row.detail, /installed but not mounted: Plugin manager/)
    assert.deepEqual(doctor.foreignCapabilities.installed, ['plugin-manager'])
    assert.deepEqual(doctor.foreignCapabilities.present, [])
  } finally {
    removeTemp(root)
  }
})

test('doctor: a selected Auto preset repeats the fail-closed child contract (#188)', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx({
    services: {
      loader: loaderStoreFixture(),
      permissionPresets: { names: ['auto'], current: () => 'auto' },
    },
    toolRuntime: { definitions: () => [] },
  })
  try {
    await call(tools, 'tower_init', { repoRoot: repo }, OWNER)
    const doctor = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    const row = doctor.checks.find((entry) => entry.id === 'foreign-capabilities')
    assert.equal(row.status, 'warn')
    assert.match(row.detail, /Auto review is selected/)
    assert.match(row.detail, /approval policy to never/)
    assert.match(row.detail, /no escalation path/)
    const auto = doctor.foreignCapabilities.capabilities.find((entry) => entry.id === 'auto-review')
    assert.equal(auto.selected, true)
    assert.equal(auto.stance, 'warn+allow')
    assert.match(auto.failureMode, /fails closed/)
  } finally {
    removeTemp(root)
  }
})

test('a deny stance present fails the check while compatibility and deployment-config pass (#188, #189)', () => {
  const deny = foreignCapabilityStatus([
    { id: 'x', name: 'X', stance: 'deny', present: true, installed: true, detectable: true, denialCost: 'x' },
  ])
  assert.equal(deny.status, 'fail')
  assert.match(deny.detail, /cannot enforce that stance/)
  const compatible = foreignCapabilityStatus([
    { id: 'y', name: 'Y', stance: 'compatibility', present: true, installed: true, detectable: true },
  ])
  assert.equal(compatible.status, 'pass')
  assert.match(compatible.detail, /supported and reported: Y \(compatibility\)/)
  const deployment = foreignCapabilityStatus([
    { id: 'z', name: 'Z', stance: 'deployment-config', present: true, installed: true, detectable: true },
  ])
  assert.equal(deployment.status, 'pass')
  assert.match(deployment.detail, /configured at deployment and reported: Z \(deployment-config\)/)
  assert.doesNotMatch(deployment.detail, /supported and reported/)
})
