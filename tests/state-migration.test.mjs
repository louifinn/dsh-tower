// State schema migration (#72).
//
// The state file is guaranteed to evolve, so a version move must be a migration
// path: older documents are transformed by an ordered, pure registry, newer ones
// are refused without being rewritten, and a migration that throws leaves the
// document byte-identical. These tests cover the pure decisions, the on-disk
// effects under the state lock, and the doctor report.
//
// Run with: node --test tests/state-migration.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Tower } from '../app/tower.js'
import { SCHEMA_VERSION } from '../domain/mission.js'
import { inspectStateVersion, prepareState, validateState } from '../domain/state.js'
import { STATE_MIGRATIONS } from '../domain/state/migrations.js'
import { registerTowerTools } from '../lib/tool-registry.js'
import * as store from '../lib/store.js'
import { loadStateFile } from '../lib/stateFile.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-migration-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo }
}

function makeCtx() {
  const tools = new Map()
  const subagents = {
    list: () => ['spawn'],
    startActivation: async () => ({
      childId: 'child-1',
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }], diagnostic: null }),
    }),
    sendMessage: async () => {},
    listDescendants: async () => [],
    interrupt: () => {},
  }
  const agentPresets = { list: async () => [{ id: 'tower-worker' }, { id: 'tower-reviewer' }] }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'subagents') return subagents
      if (name === 'agentPresets') return agentPresets
      return undefined
    },
    emit() {},
    tools: { register: (definition) => (tools.set(definition.name, definition), () => {}), guard: () => () => {}, restrict() {} },
    systemPrompt: { section() {} },
    inject(_deps, callback) { callback(ctx) },
  }
  registerTowerTools(ctx)
  return { ctx, tools }
}

const towerExec = { agent: { id: 'tower-agent' } }
const call = (tools, name, args, exec = towerExec) => tools.get(name).execute(args, exec)

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function readState(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function backupsFor(tower) {
  return fs
    .readdirSync(tower.paths.dir)
    .filter((name) => /^state\.json\.v\d+\.bak$/.test(name))
    .sort()
}

function activityFor(tower) {
  const text = fs.existsSync(tower.paths.activity) ? fs.readFileSync(tower.paths.activity, 'utf8') : ''
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/** Rewrite the current state as a v1 document, as an older release would have left it. */
function downgradeToV1(tower, mutate = null) {
  const legacy = { ...readState(tower.paths.state), schemaVersion: 1 }
  if (mutate) mutate(legacy)
  fs.writeFileSync(tower.paths.state, JSON.stringify(legacy, null, 2))
  return legacy
}

/** A v1 document predating the current schema: no revision, no tasks/deps arrays. */
function v1Fixture() {
  return {
    schemaVersion: 1,
    repoRoot: '/repo',
    commonDir: '/repo/.git',
    base: 'main',
    missions: [{ id: 'M1', title: 'Legacy mission', status: 'planned', scope: ['src/**'] }],
  }
}

test('the migration registry is ordered, contiguous and ends at SCHEMA_VERSION', () => {
  assert.equal(SCHEMA_VERSION, 2, 'this issue introduces schema version 2')
  assert.ok(Array.isArray(STATE_MIGRATIONS))
  assert.ok(Object.isFrozen(STATE_MIGRATIONS))
  let version = 1
  for (const step of STATE_MIGRATIONS) {
    assert.ok(Object.isFrozen(step))
    assert.equal(step.from, version, 'migrations must be ordered and contiguous')
    assert.equal(step.to, version + 1)
    version = step.to
  }
  assert.equal(version, SCHEMA_VERSION, 'the registry must reach the supported version')
})

test('prepareState migrates a v1 fixture, validates the target schema and is idempotent', () => {
  const legacy = v1Fixture()
  const snapshot = JSON.stringify(legacy)
  // A v1 document is not valid under this build's schema; only the migration
  // path may turn it into one.
  assert.throws(
    () => validateState(legacy, 'state.json'),
    (error) => error.code === 'state-version-unsupported',
  )

  const prepared = prepareState(legacy, 'state.json')
  assert.equal(prepared.changed, true)
  assert.equal(prepared.from, 1)
  assert.equal(prepared.to, SCHEMA_VERSION)
  assert.deepEqual(prepared.migrated, [{ from: 1, to: 2 }])
  assert.equal(prepared.state.schemaVersion, SCHEMA_VERSION)
  assert.equal(prepared.state.revision, 0, 'the migration backfills a missing revision')
  assert.deepEqual(prepared.state.missions[0].tasks, [])
  assert.deepEqual(prepared.state.missions[0].deps, [])
  // Validation ran after the migration: the migrated document is valid and the
  // pre-migration document was not mutated.
  assert.equal(validateState(prepared.state, 'state.json'), prepared.state)
  assert.equal(JSON.stringify(legacy), snapshot, 'migration steps must not mutate their input')

  // Idempotent: a current document is a no-op, and the step itself is stable.
  const again = prepareState(prepared.state, 'state.json')
  assert.equal(again.changed, false)
  assert.equal(again.state, prepared.state)
  const step = STATE_MIGRATIONS[0]
  assert.deepEqual(step.migrate(step.migrate(legacy)), step.migrate(legacy))
})

test('a newer state version is state-version-unsupported, never state-corrupt', () => {
  const newer = { schemaVersion: SCHEMA_VERSION + 1, missions: [] }
  const info = inspectStateVersion(newer, 'state.json')
  assert.equal(info.status, 'newer')
  assert.equal(info.currentVersion, SCHEMA_VERSION + 1)
  assert.equal(info.supportedVersion, SCHEMA_VERSION)
  assert.deepEqual(info.migrations, [])

  const isUnsupported = (error) =>
    error.code === 'state-version-unsupported' &&
    error.nextAction !== null &&
    /newer/.test(error.message)
  assert.throws(() => validateState(newer, 'state.json'), isUnsupported)
  assert.throws(() => prepareState(newer, 'state.json'), isUnsupported)
})

test('a migration that throws is state-migration-failed and leaves its input untouched', () => {
  const legacy = v1Fixture()
  const snapshot = JSON.stringify(legacy)
  const migrations = [
    {
      from: 1,
      to: 2,
      migrate() {
        throw new Error('injected migration failure')
      },
    },
  ]
  assert.throws(
    () => prepareState(legacy, 'state.json', { migrations }),
    (error) => error.code === 'state-migration-failed' && /injected migration failure/.test(error.message),
  )
  assert.equal(JSON.stringify(legacy), snapshot)
})

test('a v1 state migrates under the state lock: backup, one revision bump, state.migrated activity', async () => {
  const { root, repo } = makeRepo()
  try {
    const { tools } = makeCtx()
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    const legacy = downgradeToV1(tower)
    assert.equal(legacy.schemaVersion, 1)

    const loaded = await store.withLock(tower.paths, () => tower.load())
    assert.equal(loaded.schemaVersion, SCHEMA_VERSION)
    assert.equal(loaded.revision, legacy.revision + 1, 'the migration bumps the revision exactly once')

    const onDisk = readState(tower.paths.state)
    assert.equal(onDisk.schemaVersion, SCHEMA_VERSION)
    assert.equal(onDisk.revision, legacy.revision + 1)

    // The pre-migration document is kept next to the state file.
    assert.deepEqual(backupsFor(tower), ['state.json.v1.bak'])
    const backup = readState(path.join(tower.paths.dir, 'state.json.v1.bak'))
    assert.equal(backup.schemaVersion, 1)
    assert.deepEqual(backup.missions, legacy.missions)

    const migrated = activityFor(tower).filter((entry) => entry.type === 'state.migrated')
    assert.equal(migrated.length, 1)
    assert.equal(migrated[0].from, 1)
    assert.equal(migrated[0].to, 2)
    assert.equal(tower.stateLoad.migration.persisted, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('read-only loads migrate in memory without rewriting the file; the first locked write persists once', async () => {
  const { root, repo } = makeRepo()
  try {
    const { tools } = makeCtx()
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    downgradeToV1(tower)
    const before = sha256(tower.paths.state)

    // A read tool sees the migrated document but never writes a state file.
    const status = await tower.status({})
    assert.equal(status.revision, 0)
    assert.equal(sha256(tower.paths.state), before, 'a read-only load must not rewrite state.json')
    assert.deepEqual(backupsFor(tower), [])
    assert.equal(tower.stateLoad.migration.persisted, false)

    // The first mutation migrates under the lock, then applies its own change.
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'After upgrade', scope: ['src/**'] }],
    })
    assert.equal(planned.revision, 2, 'migration (+1) then the plan (+1)')
    assert.deepEqual(backupsFor(tower), ['state.json.v1.bak'])
    assert.equal(readState(tower.paths.state).schemaVersion, SCHEMA_VERSION)
    assert.equal(activityFor(tower).filter((entry) => entry.type === 'state.migrated').length, 1)
    assert.equal(JSON.parse(fs.readFileSync(path.join(tower.paths.dir, 'state.json.v1.bak'), 'utf8')).schemaVersion, 1)

    // A later mutation does not migrate again.
    await call(tools, 'tower_plan', { repoRoot: repo, missions: [{ title: 'After that', scope: ['src/**'] }] })
    assert.equal(activityFor(tower).filter((entry) => entry.type === 'state.migrated').length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a state written by a newer plugin is refused and left byte-identical', async () => {
  const { root, repo } = makeRepo()
  try {
    const { tools } = makeCtx()
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    const parsed = readState(tower.paths.state)
    const future = JSON.stringify({ ...parsed, schemaVersion: SCHEMA_VERSION + 1, futureField: true }, null, 2)
    fs.writeFileSync(tower.paths.state, future)
    const before = sha256(tower.paths.state)

    await assert.rejects(
      () => tools.get('tower_status').execute({ repoRoot: repo }, towerExec),
      (error) => error.code === 'state-version-unsupported' && /newer/.test(error.message) && error.nextAction !== null,
    )
    await assert.rejects(
      () => call(tools, 'tower_plan', { repoRoot: repo, missions: [{ title: 'Nope', scope: ['x/**'] }] }),
      (error) => error.code === 'state-version-unsupported',
    )
    assert.equal(sha256(tower.paths.state), before, 'a refused newer state must not be rewritten')
    assert.deepEqual(backupsFor(tower), [], 'a refused newer state must not be backed up or migrated')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a corrupt state file stays state-corrupt and byte-identical', async () => {
  const { root, repo } = makeRepo()
  try {
    const { tools } = makeCtx()
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    for (const text of [
      'this is not json at all',
      JSON.stringify({ ...readState(tower.paths.state), schemaVersion: 'v2' }, null, 2),
    ]) {
      fs.writeFileSync(tower.paths.state, text)
      await assert.rejects(
        () => tools.get('tower_status').execute({ repoRoot: repo }, towerExec),
        /\[tower:state-corrupt\]/,
      )
      assert.equal(fs.readFileSync(tower.paths.state, 'utf8'), text)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a throwing migration leaves the original file byte-identical and keeps the pre-migration backup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-migration-file-'))
  try {
    const paths = store.pathsFor(path.join(root, 'repo', '.git'))
    await store.ensureDir(paths.dir)
    const legacy = v1Fixture()
    const text = JSON.stringify(legacy, null, 2)
    fs.writeFileSync(paths.state, text)
    const before = sha256(paths.state)
    const migrations = [
      {
        from: 1,
        to: 2,
        migrate() {
          throw new Error('injected migration failure')
        },
      },
    ]

    await assert.rejects(
      () => loadStateFile({ store, paths, persist: true, now: 123, migrations }),
      (error) => error.code === 'state-migration-failed',
    )
    assert.equal(sha256(paths.state), before, 'the original state.json must be byte-identical')
    assert.equal(fs.readFileSync(`${paths.state}.v1.bak`, 'utf8'), text, 'the backup holds the pre-migration document')
    assert.deepEqual(readState(paths.state), legacy)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('tower_doctor reports the state schema version and the pending migration without writing', async () => {
  const { root, repo } = makeRepo()
  try {
    const { tools } = makeCtx()
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)

    const current = await call(tools, 'tower_doctor', { repoRoot: repo })
    assert.deepEqual(current.stateSchema, {
      currentVersion: SCHEMA_VERSION,
      supportedVersion: SCHEMA_VERSION,
      migrations: [],
      status: 'current',
    })
    assert.equal(current.checks.find((check) => check.id === 'state-schema').status, 'pass')

    downgradeToV1(tower)
    const before = sha256(tower.paths.state)
    const pending = await call(tools, 'tower_doctor', { repoRoot: repo })
    assert.deepEqual(pending.stateSchema, {
      currentVersion: 1,
      supportedVersion: SCHEMA_VERSION,
      migrations: [{ from: 1, to: 2 }],
      status: 'migratable',
    })
    assert.equal(pending.checks.find((check) => check.id === 'state-schema').status, 'warn')
    assert.equal(sha256(tower.paths.state), before, 'doctor must not write state')
    assert.deepEqual(backupsFor(tower), [], 'doctor must not migrate state')

    fs.writeFileSync(
      tower.paths.state,
      JSON.stringify({ ...readState(tower.paths.state), schemaVersion: SCHEMA_VERSION + 1 }, null, 2),
    )
    const newer = await call(tools, 'tower_doctor', { repoRoot: repo })
    assert.equal(newer.stateSchema.currentVersion, SCHEMA_VERSION + 1)
    assert.equal(newer.stateSchema.status, 'newer')
    assert.equal(newer.checks.find((check) => check.id === 'state-schema').status, 'fail')
    assert.equal(newer.ok, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
