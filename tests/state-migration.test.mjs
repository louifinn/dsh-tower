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
import { fileURLToPath } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'

import { Tower } from '../host/tower.js'
import { SCHEMA_VERSION } from '../domain/mission.js'
import { inspectStateVersion, prepareState, validateState } from '../domain/state.js'
import { STATE_MIGRATIONS } from '../domain/state/migrations.js'
import { V3_FIXTURE } from './property/fixtures/state-versions.mjs'
import { registerTowerTools } from '../host/tool-registry.js'
import { validateJsonSchema } from './schema-validator.mjs'
import * as store from '../adapters/store.js'
import { loadStateFile } from '../adapters/stateFile.js'

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

function makeCtx(options = {}) {
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
  registerTowerTools(ctx, options)
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
  assert.equal(SCHEMA_VERSION, 5, 'the registry reaches schema version 5 (#72 added 2, #90 adds 3, #149 adds 4, W3 adds 5)')
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
  assert.deepEqual(prepared.migrated, [
    { from: 1, to: 2 },
    { from: 2, to: 3 },
    { from: 3, to: 4 },
    { from: 4, to: 5 },
  ])
  assert.equal(prepared.state.schemaVersion, SCHEMA_VERSION)
  assert.equal(prepared.state.revision, 0, 'the migration backfills a missing revision')
  assert.deepEqual(prepared.state.missions[0].tasks, [])
  assert.deepEqual(prepared.state.missions[0].deps, [])
  // v3 -> v4 stamps every mission with its shape: an absent kind is a build, and
  // the legacy branch-shaped document keeps its worktree fields untouched.
  assert.equal(prepared.state.missions[0].kind, 'build')
  // v2 -> v3 backfills the detected case mode as unknown; a migration must not
  // read the filesystem, so the next tower_init probes and records it (#90).
  assert.equal(prepared.state.caseInsensitive, null)
  // Validation ran after the migration: the migrated document is valid and the
  // pre-migration document was not mutated.
  assert.equal(validateState(prepared.state, 'state.json'), prepared.state)
  assert.equal(JSON.stringify(legacy), snapshot, 'migration steps must not mutate their input')

  // Idempotent: a current document is a no-op, and the steps themselves are stable.
  const again = prepareState(prepared.state, 'state.json')
  assert.equal(again.changed, false)
  assert.equal(again.state, prepared.state)
  const step = STATE_MIGRATIONS[0]
  assert.deepEqual(step.migrate(step.migrate(legacy)), step.migrate(legacy))
  const caseStep = STATE_MIGRATIONS[1]
  assert.deepEqual(caseStep.migrate(caseStep.migrate(legacy)), caseStep.migrate(legacy))
})

test('v2 -> v3 backfills the case mode as unknown and preserves a recorded value', () => {
  const unrecorded = { schemaVersion: 2, revision: 4, missions: [], base: 'main' }
  const snapshot = JSON.stringify(unrecorded)
  const migrated = prepareState(unrecorded, 'state.json')
  assert.equal(migrated.changed, true)
  assert.deepEqual(migrated.migrated, [{ from: 2, to: 3 }, { from: 3, to: 4 }, { from: 4, to: 5 }])
  assert.equal(migrated.state.caseInsensitive, null, 'a migration must not guess at the filesystem')
  assert.equal(JSON.stringify(unrecorded), snapshot, 'the pre-migration document is not mutated')

  const recorded = prepareState({ ...unrecorded, caseInsensitive: true }, 'state.json')
  assert.equal(recorded.state.caseInsensitive, true)
})

test('v4 -> v5 derives blocked from blockers and normalizes batch statuses (#149)', () => {
  const v4 = STATE_MIGRATIONS.find((step) => step.from === 3).migrate(JSON.parse(JSON.stringify(V3_FIXTURE)))
  v4.schemaVersion = 4
  const base = v4.missions[0]
  v4.missions = [
    { ...base, status: 'blocked', blockers: [] },
    { ...base, id: 'M2', status: 'active', blockers: ['stale blocker'], pauseCause: 'user' },
    { ...base, id: 'M3', status: 'paused', blockers: ['stop'], pauseCause: 'failure' },
    { ...base, id: 'M4', status: 'merged', blockers: ['history only'], pauseCause: null },
  ]
  v4.batches = [
    { id: 'B1', status: 'active', createdAt: 1 },
    { id: 'B2', status: 'closed', createdAt: 1, closedAt: 2 },
    { id: 'B3', status: 'abandoned', createdAt: 1, abandonedAt: 2 },
  ]
  const snapshot = JSON.stringify(v4)
  const prepared = prepareState(v4, 'state.json')
  assert.deepEqual(prepared.migrated, [{ from: 4, to: 5 }])
  assert.equal(prepared.state.schemaVersion, SCHEMA_VERSION)
  const [m1, m2, m3, m4] = prepared.state.missions
  assert.equal(m1.status, 'blocked')
  assert.equal(m1.blockers.length, 1, 'a blocked mission without a blocker gains an explicit legacy blocker')
  assert.match(m1.blockers[0], /legacy blocked state/)
  assert.equal(m2.status, 'blocked', 'open blockers make the mission blocked')
  assert.equal(m2.pauseCause, undefined, 'a blocker supersedes a pause')
  assert.equal(m3.status, 'blocked')
  assert.equal(m3.pauseCause, undefined)
  assert.equal(m4.status, 'merged', 'terminal history keeps its blockers')
  assert.deepEqual(m4.blockers, ['history only'])
  assert.deepEqual(prepared.state.batches.map((batch) => batch.status), ['open', 'closed', 'abandoned'])
  assert.equal(validateState(prepared.state, 'state.json'), prepared.state)
  assert.equal(JSON.stringify(v4), snapshot, 'the pre-migration document is not mutated')
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
    // The injected registry must still reach SCHEMA_VERSION; otherwise the gap
    // is classified as unmigratable before the throwing step can run.
    { from: 2, to: 3, migrate: (state) => state },
    { from: 3, to: 4, migrate: (state) => state },
    { from: 4, to: 5, migrate: (state) => state },
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
    assert.equal(migrated[0].to, SCHEMA_VERSION)
    assert.equal(tower.stateLoad.migration.persisted, true)
  } finally {
    removeTemp(root)
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
    removeTemp(root)
  }
})

test('the real load path anchors a planned-but-never-provisioned legacy survey (#149)', async () => {
  const { root, repo } = makeRepo()
  try {
    const { tools } = makeCtx()
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    const baseBranch = readState(tower.paths.state).base
    const baseCommit = git(repo, ['rev-parse', baseBranch])
    // Park the checkout on another branch with its own commit: HEAD is no
    // longer the state base. The migration must still load, anchored at the
    // base ref rather than at HEAD.
    git(repo, ['checkout', '-b', 'parked'])
    fs.appendFileSync(path.join(repo, 'README.md'), 'parked work\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-m', 'parked work'])
    // A tracked edit at load time is the survey's evidence; it must be captured.
    fs.appendFileSync(path.join(repo, 'README.md'), 'dirty\n')

    const fixturePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'state-v3-shape-migration-unprovisioned.json',
    )
    const legacy = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
    legacy.base = baseBranch
    legacy.repoRoot = repo
    legacy.towerAgentId = 'tower-agent'
    const text = JSON.stringify(legacy, null, 2)
    fs.writeFileSync(tower.paths.state, text)

    const status = await call(tools, 'tower_inspect', { view: 'status', repoRoot: repo })
    assert.equal(status.revision, legacy.revision, 'a read-only load never rewrites the v3 file')
    const survey = status.missions.find((mission) => mission.id === 'M2')
    assert.equal(survey.kind, 'survey')
    assert.equal(survey.readCommit, baseCommit, 'anchored at the state base, not at HEAD')
    assert.deepEqual(survey.readDirty, ['README.md'], 'the tracked status at load time is recorded, never fabricated empty')
    assert.equal(survey.status, 'planned')
    assert.equal(fs.readFileSync(tower.paths.state, 'utf8'), text, 'the original v3 document stays byte-identical')

    // A second load of the same document is the same fixed point.
    const again = await call(tools, 'tower_inspect', { view: 'status', repoRoot: repo })
    assert.deepEqual(again.missions, status.missions)

    // The migrated survey is usable: a state write persists v4 and keeps the
    // resolved evidence, with the pre-migration document backed up.
    await call(tools, 'tower_mission', { repoRoot: repo, missionId: 'M2', note: 'inspected after migration' })
    const persisted = readState(tower.paths.state)
    assert.equal(persisted.schemaVersion, SCHEMA_VERSION)
    const persistedSurvey = persisted.missions.find((mission) => mission.id === 'M2')
    assert.equal(persistedSurvey.kind, 'survey')
    assert.equal(persistedSurvey.readCommit, baseCommit)
    assert.deepEqual(persistedSurvey.readDirty, ['README.md'])
    assert.ok(backupsFor(tower).includes('state.json.v3.bak'), 'the v3 document is backed up before the rewrite')
    const reloaded = await call(tools, 'tower_inspect', { view: 'status', repoRoot: repo })
    const reloadedSurvey = reloaded.missions.find((mission) => mission.id === 'M2')
    assert.equal(reloadedSurvey.kind, 'survey')
    assert.equal(reloadedSurvey.readCommit, baseCommit)
    assert.deepEqual(reloadedSurvey.readDirty, ['README.md'])
  } finally {
    removeTemp(root)
  }
})

test('a state written by a newer plugin degrades status but is never rewritten', async () => {
  const { root, repo } = makeRepo()
  try {
    const { tools } = makeCtx()
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    const parsed = readState(tower.paths.state)
    const future = JSON.stringify({ ...parsed, schemaVersion: SCHEMA_VERSION + 1, futureField: true }, null, 2)
    fs.writeFileSync(tower.paths.state, future)
    const before = sha256(tower.paths.state)

    // F40: status is a public read-only diagnostic row. It reports the
    // unreadable state from disk (including the raw schema version) instead of
    // failing inside the handler, and it never rewrites or migrates the file.
    const status = await call(tools, 'tower_inspect', { view: 'status', repoRoot: repo })
    assert.equal(status.ok, false)
    assert.match(status.stateError, /state-version-unsupported/)
    assert.equal(status.stateSchema.status, 'newer')
    assert.equal(status.stateSchema.currentVersion, SCHEMA_VERSION + 1)
    assert.equal(status.stateSchema.supportedVersion, SCHEMA_VERSION)
    assert.deepEqual(status.stateSchema.migrations, [])
    assert.deepEqual(status.counts, {})
    assert.deepEqual(status.missions, [])
    assert.deepEqual(status.activity, [])
    assert.equal(status.repoRoot, tower.root)
    assert.equal(status.commonDir, tower.commonDir)
    assert.equal(status.statePath, tower.paths.state)
    assert.equal(status.base, parsed.base, 'the base branch is read from the on-disk document')
    assert.equal(status.revision, parsed.revision)
    assert.equal(status.boardPath, tower.boardFile())
    assert.equal(status.mode, null)
    assert.equal(typeof status.review, 'object')
    assert.ok(status.components)
    // The declared output contract covers the degraded payload, not only the
    // normal one.
    assert.deepEqual(validateJsonSchema(tools.get('tower_inspect').output.schema, status), [])

    // A mission detail request degrades the same way rather than throwing.
    const detail = await call(tools, 'tower_inspect', { view: 'status', repoRoot: repo, missionId: 'M1' })
    assert.equal(detail.ok, false)
    assert.equal(detail.missionId, 'M1')
    assert.equal(detail.detail, null)
    assert.match(detail.stateError, /state-version-unsupported/)

    await assert.rejects(
      () => call(tools, 'tower_plan', { repoRoot: repo, missions: [{ title: 'Nope', scope: ['x/**'] }] }),
      (error) => error.code === 'state-version-unsupported',
    )
    // A known-only row must propagate the unreadable state too: the public-row
    // fallback is a diagnostic surface, not a blanket downgrade to anonymous.
    await assert.rejects(
      () => call(tools, 'tower_inbox', { repoRoot: repo }),
      (error) => error.code === 'state-version-unsupported',
    )
    assert.equal(sha256(tower.paths.state), before, 'a refused newer state must not be rewritten')
    assert.deepEqual(backupsFor(tower), [], 'a refused newer state must not be backed up or migrated')
  } finally {
    removeTemp(root)
  }
})

test('a corrupt state file degrades tower_status and stays byte-identical', async () => {
  const { root, repo } = makeRepo()
  try {
    const { tools } = makeCtx()
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    const parsed = readState(tower.paths.state)
    for (const { text, raw } of [
      { text: 'this is not json at all', raw: null },
      { text: JSON.stringify({ ...parsed, schemaVersion: 'v2' }, null, 2), raw: { ...parsed, schemaVersion: 'v2' } },
    ]) {
      fs.writeFileSync(tower.paths.state, text)
      const status = await call(tools, 'tower_inspect', { view: 'status', repoRoot: repo })
      assert.equal(status.ok, false)
      assert.match(status.stateError, /\[tower:state-corrupt\]/)
      assert.equal(status.stateSchema.status, 'invalid')
      assert.equal(status.stateSchema.currentVersion, null)
      assert.equal(status.stateSchema.supportedVersion, SCHEMA_VERSION)
      assert.deepEqual(status.stateSchema.migrations, [])
      assert.match(status.stateSchema.message, /could not be inspected|no usable schemaVersion/)
      assert.deepEqual(status.counts, {})
      assert.deepEqual(status.missions, [])
      assert.deepEqual(status.activity, [])
      assert.equal(status.statePath, tower.paths.state)
      assert.equal(status.base, raw?.base ?? tower.branch ?? '')
      assert.equal(status.revision, raw?.revision ?? 0)
      assert.deepEqual(validateJsonSchema(tools.get('tower_inspect').output.schema, status), [])
      await assert.rejects(
        () => call(tools, 'tower_inbox', { repoRoot: repo }),
        /\[tower:state-corrupt\]/,
        'a known-only row still sees the corrupt state instead of anonymous behavior',
      )
      assert.equal(fs.readFileSync(tower.paths.state, 'utf8'), text)
      assert.deepEqual(backupsFor(tower), [], 'a degraded status must not back up or migrate a corrupt state')
    }
  } finally {
    removeTemp(root)
  }
})

test('tower_preflight keeps failing with the state error instead of inventing a gate', async () => {
  const { root, repo } = makeRepo()
  try {
    const seen = []
    // The workspace hook runs only after authorization, so a recorded call
    // proves the public-row fallback let an unreadable state reach the handler.
    const { tools } = makeCtx({
      workspace: {
        ensure: async (_repoRoot, _exec, toolName) => {
          seen.push(toolName)
        },
      },
    })
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    const parsed = readState(tower.paths.state)

    fs.writeFileSync(tower.paths.state, JSON.stringify({ ...parsed, schemaVersion: SCHEMA_VERSION + 1 }, null, 2))
    const newerBefore = sha256(tower.paths.state)
    await assert.rejects(
      () => call(tools, 'tower_inspect', { view: 'preflight', repoRoot: repo, missionId: 'M1' }),
      (error) => error.code === 'state-version-unsupported',
      'a merge gate cannot be computed from a newer state',
    )
    assert.deepEqual(seen, ['tower_inspect'], 'authorization fallback reached the handler, which rethrew the state error')
    assert.equal(sha256(tower.paths.state), newerBefore, 'a failed preflight must not rewrite state')

    fs.writeFileSync(tower.paths.state, 'this is not json at all')
    const corruptBefore = sha256(tower.paths.state)
    await assert.rejects(
      () => call(tools, 'tower_inspect', { view: 'preflight', repoRoot: repo, missionId: 'M1' }),
      (error) => error.code === 'state-corrupt',
      'a merge gate cannot be computed from a corrupt state',
    )
    assert.deepEqual(seen, ['tower_inspect', 'tower_inspect'])
    assert.equal(sha256(tower.paths.state), corruptBefore, 'a failed preflight must not rewrite state')
  } finally {
    removeTemp(root)
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
      { from: 2, to: 3, migrate: (state) => state },
      { from: 3, to: 4, migrate: (state) => state },
      { from: 4, to: 5, migrate: (state) => state },
    ]

    await assert.rejects(
      () => loadStateFile({ store, paths, persist: true, now: 123, migrations }),
      (error) => error.code === 'state-migration-failed',
    )
    assert.equal(sha256(paths.state), before, 'the original state.json must be byte-identical')
    assert.equal(fs.readFileSync(`${paths.state}.v1.bak`, 'utf8'), text, 'the backup holds the pre-migration document')
    assert.deepEqual(readState(paths.state), legacy)
  } finally {
    removeTemp(root)
  }
})

test('tower_doctor reports the state schema version and the pending migration without writing', async () => {
  const { root, repo } = makeRepo()
  try {
    const { tools } = makeCtx()
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)

    const current = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    assert.deepEqual(current.stateSchema, {
      currentVersion: SCHEMA_VERSION,
      supportedVersion: SCHEMA_VERSION,
      migrations: [],
      status: 'current',
    })
    assert.equal(current.checks.find((check) => check.id === 'state-schema').status, 'pass')

    downgradeToV1(tower)
    const before = sha256(tower.paths.state)
    const pending = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    assert.deepEqual(pending.stateSchema, {
      currentVersion: 1,
      supportedVersion: SCHEMA_VERSION,
      migrations: [
        { from: 1, to: 2 },
        { from: 2, to: 3 },
        { from: 3, to: 4 },
        { from: 4, to: 5 },
      ],
      status: 'migratable',
    })
    assert.equal(pending.checks.find((check) => check.id === 'state-schema').status, 'warn')
    assert.equal(sha256(tower.paths.state), before, 'doctor must not write state')
    assert.deepEqual(backupsFor(tower), [], 'doctor must not migrate state')

    fs.writeFileSync(
      tower.paths.state,
      JSON.stringify({ ...readState(tower.paths.state), schemaVersion: SCHEMA_VERSION + 1 }, null, 2),
    )
    const newerBefore = sha256(tower.paths.state)
    const newer = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    assert.equal(newer.stateSchema.currentVersion, SCHEMA_VERSION + 1)
    assert.equal(newer.stateSchema.status, 'newer')
    assert.equal(newer.checks.find((check) => check.id === 'state-schema').status, 'fail')
    assert.equal(newer.ok, false)
    assert.equal(sha256(tower.paths.state), newerBefore, 'doctor must not rewrite a newer state')
    assert.deepEqual(backupsFor(tower), [], 'doctor must not back up or migrate a newer state')

    // F40: a corrupt state must reach the handler as well. Authorization falls
    // back to the anonymous actor for this public row, and the report names the
    // unreadable schema instead of failing with a generic authorization error.
    const corruptText = 'this is not json at all'
    fs.writeFileSync(tower.paths.state, corruptText)
    const corruptBefore = sha256(tower.paths.state)
    const corrupt = await call(tools, 'tower_inspect', { view: 'doctor', repoRoot: repo })
    assert.equal(corrupt.stateSchema.currentVersion, null)
    assert.equal(corrupt.stateSchema.supportedVersion, SCHEMA_VERSION)
    assert.deepEqual(corrupt.stateSchema.migrations, [])
    assert.equal(corrupt.stateSchema.status, 'invalid')
    const schemaCheck = corrupt.checks.find((check) => check.id === 'state-schema')
    assert.equal(schemaCheck.status, 'fail')
    assert.match(schemaCheck.detail, /could not be inspected/)
    assert.equal(corrupt.ok, false)
    assert.equal(sha256(tower.paths.state), corruptBefore, 'doctor must not rewrite a corrupt state')
    assert.deepEqual(backupsFor(tower), [], 'doctor must not back up or migrate a corrupt state')
  } finally {
    removeTemp(root)
  }
})
