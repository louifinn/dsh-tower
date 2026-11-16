// F57: a dispatch that failed before activation must never wedge a mission.
//
// `tower_spawn` claims a roster name before activation, so a dispatch that never
// got an agent back leaves `state: 'reserved', agentId: null`. No child exists
// behind that row, yet it was counted as a live worker: `tower_spawn` refused the
// mission, `op: 'takeover'` found no catalog entry, `tower_interrupt` had nothing
// to stop, and `tower_init({ op: 'adopt' })` retired the row but kept the null
// agent id — which the state semantics rejected, so the whole adopt aborted as
// state-corrupt and the disk state never changed (F57).
//
// These tests drive the real Tower use cases against a temporary git repository
// with a faked subagent catalog. The wedge is a roster/state defect, not a
// runtime one, so no DSH runtime and no model call is involved.
//
// Run with: node --test tests/roster-reserved.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'
import { Tower } from '../host/tower.js'
import { precheckWorkerOwnership } from '../app/spawn-prechecks.js'
import { runAdoptView } from '../tools/views/adopt.js'
import { validateState } from '../domain/state.js'
import { stateShapeError } from '../domain/state/schema.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-reserved-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
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

/** A real Tower over a temp repository with one planned build mission M1. */
async function seeded() {
  const { root, repo } = seedRepo()
  const tower = await Tower.open(repo)
  await tower.init({ towerAgentId: 'tower-agent' })
  await tower.plan({ missions: [{ title: 'Wedge case', scope: ['src/**'], tasks: ['fix the wedge'] }] })
  return { root, repo, tower }
}

/** Exactly the row a dispatch leaves behind when activation never returned. */
function reserveOrphan(tower) {
  return tower.reserveRoster({
    missionId: 'M1',
    name: 'worker-m1',
    role: 'worker',
    parentSessionId: 'tower-agent',
  })
}

/** The real ownership precheck, against the view the spawn tool reads first. */
async function precheck(tower, { takeover = false } = {}) {
  return precheckWorkerOwnership({
    role: 'worker',
    tower,
    ctx: {},
    view: await tower.rosterView(),
    missionId: 'M1',
    takeover,
    maxLiveWorkers: 4,
    budget: 4,
    observeActivity: async () => ({
      activity: { 'child-1': 'inactive' },
      parentStatus: { 'tower-agent': 'ok' },
    }),
  })
}

/** The real adopt view body with its composition-root deps stubbed. */
function adopt(tower, repo) {
  const ctx = {
    get: (name) => (name === 'subagents' ? { listDescendants: async () => [] } : undefined),
  }
  const deps = {
    openTower: async () => tower,
    actorFor: async () => ({ name: 'tower', id: 'tower-agent', role: 'tower' }),
    requireTowerActor: () => {},
  }
  return runAdoptView(ctx, { repoRoot: repo }, { agent: { id: 'tower-agent' } }, deps)
}

/** The JSONL activity log the tower appended to. */
function activityText(tower) {
  return fs.existsSync(tower.paths.activity) ? fs.readFileSync(tower.paths.activity, 'utf8') : ''
}

/** The repaired state must satisfy both validation layers, not merely load. */
async function assertValidState(tower) {
  const state = await tower.load()
  assert.equal(stateShapeError(state), null)
  validateState(state, tower.paths.state)
  return state
}

/**
 * Write one roster row into the state file, the way an older release (or the
 * manual recovery F57 needed) could have left it on disk.
 */
async function seedRow(tower, row) {
  const state = await tower.load()
  state.roster = [...(state.roster ?? []), row]
  state.revision += 1
  state.updatedAt = Date.now()
  fs.writeFileSync(tower.paths.state, JSON.stringify(state, null, 2))
}

test('a stalled reservation no longer blocks the spawn precheck, and is reaped', async () => {
  const { root, tower } = await seeded()
  try {
    await reserveOrphan(tower)
    const row = (await tower.rosterView()).roster[0]
    assert.equal(row.state, 'reserved')
    assert.equal(row.agentId, null)

    const before = (await tower.load()).revision
    assert.equal(await precheck(tower), false, 'an orphan reservation must not force takeover mode')

    const state = await assertValidState(tower)
    assert.deepEqual(state.roster ?? [], [], 'the never-started row is gone')
    assert.equal(state.revision, before + 1, 'the reap is one locked revision bump')
    assert.match(activityText(tower), /reaped stalled reservations: worker-m1 \(M1\)/)
  } finally {
    removeTemp(root)
  }
})

test('op: takeover converges on the same orphan row instead of refusing', async () => {
  const { root, tower } = await seeded()
  try {
    await reserveOrphan(tower)
    assert.equal(await precheck(tower, { takeover: true }), false)
    const state = await assertValidState(tower)
    assert.deepEqual(state.roster ?? [], [])
  } finally {
    removeTemp(root)
  }
})

test('adopt reaps the stalled reservation and reports it, without state-corrupt', async () => {
  const { root, repo, tower } = await seeded()
  try {
    await reserveOrphan(tower)
    const result = await adopt(tower, repo)
    assert.deepEqual(result.reaped, ['worker-m1'])
    assert.deepEqual(result.unresolvable, [])
    assert.deepEqual(result.retired, [])
    const state = await assertValidState(tower)
    assert.deepEqual(state.roster ?? [], [])
  } finally {
    removeTemp(root)
  }
})

test('reaping is idempotent: a converged roster neither reaps nor bumps the revision', async () => {
  const { root, repo, tower } = await seeded()
  try {
    await reserveOrphan(tower)
    await precheck(tower)
    const revision = (await tower.load()).revision
    assert.equal(await precheck(tower), false, 'a second precheck must not fail')
    await adopt(tower, repo)
    const second = await adopt(tower, repo)
    assert.deepEqual(second.reaped, [])
    assert.equal((await tower.load()).revision, revision, 'a converged roster must not keep bumping the revision')
  } finally {
    removeTemp(root)
  }
})

test('adopt reports a legacy terminal row without an agent id as unresolvable', async () => {
  const { root, repo, tower } = await seeded()
  try {
    // A failed dispatch recorded as `failed` before the semantics allowed a
    // terminal row to keep the absent agent id. It must load and converge.
    await seedRow(tower, {
      name: 'worker-m1',
      role: 'worker',
      missionId: 'M1',
      parentSessionId: 'tower-agent',
      state: 'failed',
      agentId: null,
      spawnedAt: Date.now(),
    })
    const result = await adopt(tower, repo)
    assert.deepEqual(result.unresolvable, [{ name: 'worker-m1', missionId: 'M1', state: 'failed' }])
    const state = await assertValidState(tower)
    assert.equal(state.roster[0].state, 'failed', 'a row with nothing to observe is reported, not rewritten')
  } finally {
    removeTemp(root)
  }
})

test('a reservation that already carries an agent id is in flight and is never reaped', async () => {
  const { root, repo, tower } = await seeded()
  try {
    // The activation returned but `recordSpawn` has not written the active row
    // yet: the row is reserved *with* an agent id, so a child really exists.
    await seedRow(tower, {
      name: 'worker-m1',
      role: 'worker',
      missionId: 'M1',
      parentSessionId: 'tower-agent',
      state: 'reserved',
      agentId: 'child-9',
      spawnedAt: Date.now(),
    })
    const revision = (await tower.load()).revision
    await assert.rejects(
      () => precheck(tower),
      (error) => error.code === 'invalid-transition' && /already has a live worker "worker-m1"/.test(error.message),
    )
    let state = await assertValidState(tower)
    assert.equal(state.revision, revision, 'the in-flight reservation must not be rewritten')
    assert.equal(state.roster[0].state, 'reserved')
    assert.equal(state.roster[0].agentId, 'child-9')

    const result = await adopt(tower, repo)
    assert.deepEqual(result.reaped, [], 'an in-flight reservation is not a stalled one')
    state = await assertValidState(tower)
    assert.equal(state.roster[0].state, 'reserved')
  } finally {
    removeTemp(root)
  }
})

test('adopt still retires a worker whose catalog entry is gone after two rounds', async () => {
  const { root, repo, tower } = await seeded()
  try {
    await seedRow(tower, {
      name: 'worker-m1',
      role: 'worker',
      missionId: 'M1',
      parentSessionId: 'tower-agent',
      state: 'active',
      agentId: 'ghost-1',
      spawnedAt: Date.now(),
    })
    const first = await adopt(tower, repo)
    assert.deepEqual(first.retired, [], 'one absence observation is not enough')
    assert.deepEqual(first.unconfirmed, ['ghost-1'])
    const second = await adopt(tower, repo)
    assert.deepEqual(second.retired, ['ghost-1'])
    const state = await assertValidState(tower)
    assert.equal(state.roster[0].state, 'retired')
  } finally {
    removeTemp(root)
  }
})
