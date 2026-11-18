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
import { STALLED_RESERVATION_GRACE_MS } from '../app/roster.js'
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

/**
 * Test-only age for a reservation: the shell of a dispatch that never returned
 * ages in real time; tests backdate `reservedAt` instead of waiting. The window
 * itself is owned by `STALLED_RESERVATION_GRACE_MS`.
 */
const STALE_MS = STALLED_RESERVATION_GRACE_MS + 60_000

/** Backdate a reservation the way a dispatch that failed ages. */
async function ageReservation(tower, name, ageMs = STALE_MS) {
  const state = await tower.load()
  const row = (state.roster ?? []).find((entry) => entry.name === name)
  assert.ok(row, `reservation ${name} must exist before it can age`)
  row.reservedAt = Date.now() - ageMs
  fs.writeFileSync(tower.paths.state, JSON.stringify(state, null, 2))
}

/** Exactly the row a dispatch leaves behind when activation never returned. */
async function reserveOrphan(tower, { fresh = false } = {}) {
  const entry = await tower.reserveRoster({
    missionId: 'M1',
    name: 'worker-m1',
    role: 'worker',
    parentSessionId: 'tower-agent',
  })
  // A retry normally arrives long after the failed dispatch; only the grace
  // tests leave the reservation fresh.
  if (!fresh) await ageReservation(tower, entry.name)
  return entry
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

/**
 * The real adopt view body with its composition-root deps stubbed.
 *
 * `descendants` is what the parent catalog answers (an array, or a function
 * called per observation, which may throw). F83: an empty answer is not
 * authoritative, so tests that expect a retirement must pass at least one
 * unrelated row. `args` are merged over `repoRoot`, e.g. `retire_missing:false`.
 */
function adopt(tower, repo, { descendants = [], args = {} } = {}) {
  const ctx = {
    get: (name) =>
      name === 'subagents'
        ? { listDescendants: async () => (typeof descendants === 'function' ? descendants() : descendants) }
        : undefined,
  }
  const deps = {
    openTower: async () => tower,
    actorFor: async () => ({ name: 'tower', id: 'tower-agent', role: 'tower' }),
    requireTowerActor: () => {},
  }
  return runAdoptView(ctx, { repoRoot: repo, ...args }, { agent: { id: 'tower-agent' } }, deps)
}

/** An authoritative catalog that does not list the row under test. */
const UNRELATED_CATALOG = [{ id: 'agent-unrelated', activity: 'running' }]

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
    // Defensive input, not a row production writes today: `recordSpawn` flips
    // the row to active as it binds the child id, so a reserved row with an
    // agent id can only come from a hand-edited state file or a future caller.
    // If it exists, a child really does (or may) exist, so the reap must not
    // treat the reservation as abandoned.
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

test('a fresh reservation is kept through the grace window instead of being reaped', async () => {
  const { root, tower } = await seeded()
  try {
    await reserveOrphan(tower, { fresh: true })
    const before = (await tower.load()).revision

    // A concurrent dispatch may hold a reservation for the same mission for a
    // moment; the precheck must not write that in-flight name off immediately.
    assert.equal(await precheck(tower), false, 'a fresh reservation must not force takeover mode')
    let state = await assertValidState(tower)
    assert.equal(state.revision, before, 'inside the grace window nothing is rewritten')
    assert.equal(state.roster.length, 1, 'a young reservation is retried, not reaped')
    assert.equal(state.roster[0].state, 'reserved')

    // Once it is old enough to be abandoned, the next precheck releases it.
    await ageReservation(tower, 'worker-m1')
    assert.equal(await precheck(tower), false)
    state = await assertValidState(tower)
    assert.deepEqual(state.roster ?? [], [])
    assert.match(activityText(tower), /reaped stalled reservations: worker-m1 \(M1\)/)
  } finally {
    removeTemp(root)
  }
})

test('P2-2: a stale spawn outcome cannot overwrite a newer reservation that reused the name', async () => {
  const { root, repo, tower } = await seeded()
  const other = await Tower.open(repo)
  try {
    // Process A reserved, failed before activation, and its reservation is
    // eventually reaped by a later precheck of the same process.
    await reserveOrphan(tower)
    assert.equal(await precheck(tower), false)
    assert.deepEqual((await tower.load()).roster ?? [], [])

    // The name is free again: process B reserves it and activates its child.
    await other.reserveRoster({
      missionId: 'M1',
      name: 'worker-m1',
      role: 'worker',
      parentSessionId: 'tower-agent',
    })
    await other.recordSpawn({
      missionId: 'M1',
      name: 'worker-m1',
      role: 'worker',
      agentId: 'child-2',
      parentSessionId: 'tower-agent',
    })

    const revision = (await tower.load()).revision
    const skipped = await tower.recordSpawnOutcome({
      missionId: 'M1',
      name: 'worker-m1',
      state: 'failed',
      detail: 'spawn failed before activation: activation channel closed',
    })
    assert.equal(skipped, null, 'the stale outcome is skipped instead of being applied to a foreign row')
    const state = await assertValidState(tower)
    const row = state.roster.find((entry) => entry.name === 'worker-m1')
    assert.equal(row.state, 'active', 'a stale cleanup must not fail an in-use row')
    assert.equal(row.agentId, 'child-2')
    assert.equal(row.outcome, undefined)
    assert.equal(state.revision, revision, 'a skipped outcome must not rewrite state')
    assert.match(activityText(tower), /worker-m1 outcome skipped/)
  } finally {
    removeTemp(root)
  }
})

test('P2-2: the owning reservation still records its own activation failure', async () => {
  const { root, tower } = await seeded()
  try {
    await reserveOrphan(tower, { fresh: true })
    const recorded = await tower.recordSpawnOutcome({
      missionId: 'M1',
      name: 'worker-m1',
      state: 'failed',
      detail: 'spawn failed before activation: activation channel closed',
    })
    assert.ok(recorded, 'the owner of the reservation may always record its outcome')
    assert.equal(recorded.state, 'failed')
    assert.equal(recorded.agentId, null)
    const state = await assertValidState(tower)
    assert.equal(state.roster[0].state, 'failed')
    assert.match(activityText(tower), /worker-m1 failed: spawn failed before activation/)
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
    // F83: the catalog must positively answer with at least one descendant for
    // an absence to count. The unrelated row makes the answer authoritative
    // while `ghost-1` stays outside it.
    const first = await adopt(tower, repo, { descendants: UNRELATED_CATALOG })
    assert.deepEqual(first.retired, [], 'one absence observation is not enough')
    assert.deepEqual(first.unconfirmed, ['ghost-1'])
    const second = await adopt(tower, repo, { descendants: UNRELATED_CATALOG })
    assert.deepEqual(second.retired, ['ghost-1'])
    const state = await assertValidState(tower)
    assert.equal(state.roster[0].state, 'retired')
  } finally {
    removeTemp(root)
  }
})

test('adopt leaves a live worker alone when the catalog answers empty', async () => {
  const { root, repo, tower } = await seeded()
  try {
    await seedRow(tower, {
      name: 'worker-m1',
      role: 'worker',
      missionId: 'M1',
      parentSessionId: 'tower-agent',
      state: 'active',
      agentId: 'live-1',
      spawnedAt: Date.now(),
    })
    const first = await adopt(tower, repo)
    const second = await adopt(tower, repo)
    const state = await assertValidState(tower)
    assert.equal(state.roster[0].state, 'active', 'two empty-catalog adopts must leave the worker active')
    for (const result of [first, second]) {
      assert.deepEqual(result.retired, [], 'an empty catalog is never evidence of absence (F83)')
      assert.deepEqual(result.missing, [])
      assert.deepEqual(result.unconfirmed, [], 'an unjudged row is not an absence observation')
      assert.match(String(result.parentStatus['tower-agent']), /^empty:/, 'the status names the empty answer')
      assert.equal(result.unjudged.length, 1, 'the unjudged row is reported with its reason')
      assert.equal(result.unjudged[0].name, 'worker-m1')
      assert.equal(result.unjudged[0].missionId, 'M1')
      assert.equal(result.unjudged[0].agentId, 'live-1')
      assert.match(String(result.unjudged[0].reason), /^empty:/)
    }
  } finally {
    removeTemp(root)
  }
})

test('adopt leaves a live worker alone when the catalog throws', async () => {
  const { root, repo, tower } = await seeded()
  try {
    await seedRow(tower, {
      name: 'worker-m1',
      role: 'worker',
      missionId: 'M1',
      parentSessionId: 'tower-agent',
      state: 'active',
      agentId: 'live-1',
      spawnedAt: Date.now(),
    })
    const throwing = () => {
      throw new Error('catalog unavailable')
    }
    const first = await adopt(tower, repo, { descendants: throwing })
    const second = await adopt(tower, repo, { descendants: throwing })
    for (const result of [first, second]) {
      assert.deepEqual(result.retired, [], 'a failing catalog is never evidence of absence (F83)')
      assert.match(String(result.parentStatus['tower-agent']), /^unavailable:/)
      assert.equal(result.unjudged.length, 1)
      assert.equal(result.unjudged[0].agentId, 'live-1')
      assert.match(String(result.unjudged[0].reason), /^unavailable:/)
    }
    const state = await assertValidState(tower)
    assert.equal(state.roster[0].state, 'active')
  } finally {
    removeTemp(root)
  }
})

test('adopt keeps a worker present while an authoritative catalog lists it', async () => {
  const { root, repo, tower } = await seeded()
  try {
    await seedRow(tower, {
      name: 'worker-m1',
      role: 'worker',
      missionId: 'M1',
      parentSessionId: 'tower-agent',
      state: 'active',
      agentId: 'live-1',
      spawnedAt: Date.now(),
    })
    const catalog = [{ id: 'live-1', activity: 'running' }]
    for (let round = 0; round < 3; round += 1) {
      const result = await adopt(tower, repo, { descendants: catalog })
      assert.deepEqual(result.retired, [], 'a present row is never a retirement candidate')
      assert.deepEqual(result.unconfirmed, [])
      assert.deepEqual(result.unjudged, [], 'an authoritative catalog judges every row')
      assert.equal(result.parentStatus['tower-agent'], 'ok')
      assert.equal((await tower.load()).roster[0].state, 'active')
    }
  } finally {
    removeTemp(root)
  }
})

test('adopt marks an authoritative absence missing when retire_missing is false', async () => {
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
    const options = { descendants: UNRELATED_CATALOG, args: { retire_missing: false } }
    const first = await adopt(tower, repo, options)
    assert.deepEqual(first.missing, [], 'one absence observation is not enough')
    const second = await adopt(tower, repo, options)
    assert.deepEqual(second.retired, [], 'the operator opted out of retirement')
    assert.deepEqual(second.missing, ['ghost-1'])
    const state = await assertValidState(tower)
    assert.equal(state.roster[0].state, 'missing')
  } finally {
    removeTemp(root)
  }
})
