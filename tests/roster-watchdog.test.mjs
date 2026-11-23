// F73: a live worker must never be judged dead.
//
// The watchdog used to treat an empty descendant list as an authoritative
// "no children" and mark any row older than `spawn.staleMs` stale. A worker
// that was alive and mid-turn was then refused by `tower_complete`
// ("a stopped worker cannot report completion") and had no way to rescue
// itself. These tests drive the real watchdog pass against a temporary Git
// repository with a faked subagent catalog:
//
// 1. an empty catalog proves nothing, is never authoritative, and writes
//    nothing — even when earlier misses were already recorded;
// 2. one missed observation cannot stale a row, and two misses must span at
//    least twice `spawn.staleMs`;
// 3. a present observation resets the absence evidence;
// 4. `staleMs: 0` disables the watchdog without writing state or activity;
// 5. a stale-marked worker's own `tower_complete` revives the row, completes
//    the mission, and records why in the activity log;
// 6. a completion that runs while a tick is parked after its roster snapshot
//    still closes the row, and the tick's sweep does not re-stale it;
// 7. a row revived between the snapshot and the sweep never enters the
//    "absent => stale" decision, so it is still active at tick end (no
//    observation is not an observation of absence);
// 8. a sweep that wins the state lock between the two-phase completion check
//    and the commit makes the completion re-prepare, not fail with `stale-base`.
//
// Run with: node --test tests/roster-watchdog.test.mjs
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'
import { Tower } from '../host/tower.js'
import { observeActivity } from '../host/tool-observers.js'
import { watchdogTick } from '../host/tool-capabilities.js'
import { registerTowerTools } from '../host/tool-registry.js'
import { __testResetComponentRegistry } from '../host/capability-registry.js'
import { reviveStaleSelfReporter } from '../app/roster.js'
import { PARENT_STATUS_OK } from '../domain/vocabulary.js'

const MINUTE = 60_000
const STALE_MS = 30_000

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-watchdog-') {
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

/** A real Tower with one planned mission and one live worker row. */
async function seeded({ ageMs = 10 * MINUTE } = {}) {
  const { root, repo } = seedRepo()
  const tower = await Tower.open(repo)
  await tower.init({ towerAgentId: 'tower-agent' })
  await tower.plan({ missions: [{ title: 'F73 live worker', scope: ['src/**'] }] })
  await tower.recordSpawn({
    missionId: 'M1',
    name: 'worker-m1',
    role: 'worker',
    agentId: 'agent-live',
    parentSessionId: 'tower-agent',
    cwd: null,
    branch: null,
  })
  const state = await tower.load()
  const withAge = state.roster.find((entry) => entry.agentId === 'agent-live')
  // The F73 class: the row was spawned longer than staleMs ago but the child
  // is still running. Backdate instead of sleeping.
  withAge.spawnedAt = Date.now() - ageMs
  fs.writeFileSync(tower.paths.state, JSON.stringify(state, null, 2))
  return { root, repo, tower }
}

/** The watchdog only asks `subagents.listDescendants`; accept a fixed list or a thunk. */
function fakeCtx(listDescendants) {
  const list = typeof listDescendants === 'function' ? listDescendants : async () => listDescendants
  return { get: (name) => (name === 'subagents' ? { listDescendants: list } : undefined) }
}

async function row(tower, agentId = 'agent-live') {
  const state = await tower.load()
  const found = (state.roster ?? []).find((entry) => entry.agentId === agentId)
  assert.ok(found, `roster row ${agentId} must exist`)
  return found
}

function activityText(tower) {
  return fs.existsSync(tower.paths.activity) ? fs.readFileSync(tower.paths.activity, 'utf8') : ''
}

/** Backdate the persisted absence evidence the way elapsed watchdog polls would. */
async function ageAbsence(tower, agentId, ageMs) {
  const state = await tower.load()
  const entry = state.roster.find((candidate) => candidate.agentId === agentId)
  assert.ok(entry && Number.isFinite(entry.absentSince), 'absence evidence must be persisted first')
  entry.absentSince = Date.now() - ageMs
  fs.writeFileSync(tower.paths.state, JSON.stringify(state, null, 2))
}

/** Rewrite the persisted roster (another process's write) without waiting. */
async function writeRoster(tower, mutate) {
  const state = await tower.load()
  mutate(state.roster ?? [], state)
  state.revision += 1
  state.updatedAt = Date.now()
  fs.writeFileSync(tower.paths.state, JSON.stringify(state, null, 2))
  return state
}

/**
 * Park a tick after its first `rosterView()` and hand the test a way to resume
 * it. This is the injectable seam for the F73 race: the snapshot is already
 * taken (so `live`/`absent` are fixed) but the sweep has not run yet, which is
 * exactly the window in which a worker revives itself.
 * @param {any} tower
 * @returns {{ reached: Promise<void>, release: () => void }}
 */
function pauseAfterFirstRosterView(tower) {
  const original = tower.rosterView.bind(tower)
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let signal = () => {}
  const reached = new Promise((resolve) => {
    signal = resolve
  })
  let calls = 0
  tower.rosterView = async (...args) => {
    const view = await original(...args)
    if ((calls += 1) === 1) {
      signal()
      await gate
    }
    return view
  }
  return { reached, release: () => release() }
}

/** The two-mission fixture: a worker to race, plus a live bystander the
 * catalog can prove so the tick's sweep is authoritative. */
async function seededPair(prefix) {
  const { root, repo } = seedRepo(prefix)
  const tower = await Tower.open(repo)
  await tower.init({ towerAgentId: 'tower-agent' })
  await tower.plan({
    missions: [
      { title: 'F73 raced completion', scope: ['src/**'] },
      { title: 'F73 bystander', scope: ['src/**'] },
    ],
  })
  await tower.recordSpawn({
    missionId: 'M1',
    name: 'worker-m1',
    role: 'worker',
    agentId: 'agent-live',
    parentSessionId: 'tower-agent',
    cwd: null,
    branch: null,
  })
  await tower.recordSpawn({
    missionId: 'M2',
    name: 'worker-m2',
    role: 'worker',
    agentId: 'agent-bystander',
    parentSessionId: 'tower-agent',
    cwd: null,
    branch: null,
  })
  return { root, repo, tower }
}

test('F73: an empty descendant list is not authoritative evidence and writes nothing', async () => {
  const { root, tower } = await seeded()
  try {
    // The worker is older than staleMs and earlier polls already recorded
    // misses. A catalog that now answers with no rows at all must not confirm
    // that history: no observation is not an observation of absence.
    const history = await tower.load()
    const withHistory = history.roster.find((entry) => entry.agentId === 'agent-live')
    withHistory.absentObservations = 2
    withHistory.absentSince = Date.now() - STALE_MS * 2 - 1
    fs.writeFileSync(tower.paths.state, JSON.stringify(history, null, 2))

    const ctx = fakeCtx([])
    const observed = await observeActivity(ctx, tower)
    assert.equal(observed.parentAuthoritative['tower-agent'], false, 'an empty list cannot prove absence')
    assert.equal(observed.parentStatus['tower-agent'], PARENT_STATUS_OK, 'the parent itself answered')

    const revision = (await tower.load()).revision
    const tick = await watchdogTick(ctx, tower, STALE_MS)
    assert.equal(tick.skipped, 'catalog-unknown')

    const state = await tower.load()
    const live = state.roster.find((entry) => entry.agentId === 'agent-live')
    assert.equal(live.state, 'active', 'a live row must not be staled by an empty catalog')
    assert.equal(live.stale, undefined)
    assert.equal(live.lastObservedAt, undefined, 'an unknown catalog must not stamp an observation time')
    assert.equal(live.absentObservations, 2, 'an unknown catalog must not count another miss')
    assert.equal(state.revision, revision, 'an unknown catalog must not write state')
    assert.doesNotMatch(activityText(tower), /stale agent-live|stale worker-m1/)

    // Guard proof: the count-only sweep the old watchdog called still marks the
    // same row, so the non-authoritative signal is what prevents the incident.
    const direct = await tower.sweepRoster({ staleMs: STALE_MS, activity: {}, authoritative: true })
    assert.deepEqual(direct.marked, ['worker-m1'])
  } finally {
    removeTemp(root)
  }
})

test('F73: a throwing catalog stamps no observation time; an authoritative answer does', async () => {
  const { root, tower } = await seeded()
  try {
    const broken = fakeCtx(() => {
      throw new Error('catalog down')
    })
    const tick = await watchdogTick(broken, tower, STALE_MS)
    assert.equal(tick.skipped, 'catalog-unknown')
    const unobserved = await row(tower)
    assert.equal(unobserved.state, 'active')
    assert.equal(unobserved.lastObservedAt, undefined, 'a catalog that throws is not an observation')

    const present = fakeCtx([{ id: 'agent-live', activity: 'running' }])
    await watchdogTick(present, tower, STALE_MS)
    const live = await row(tower)
    assert.equal(live.state, 'active')
    assert.ok(Number.isFinite(live.lastObservedAt), 'an authoritative present row stamps lastObservedAt')
  } finally {
    removeTemp(root)
  }
})

test('F73: one miss is not stale and two misses must span twice staleMs', async () => {
  const { root, tower } = await seeded()
  try {
    // The catalog is non-empty (so it is authoritative) but does not know the
    // live worker. This is the transient-miss case.
    const ctx = fakeCtx([{ id: 'agent-unrelated', activity: 'running' }])

    const first = await watchdogTick(ctx, tower, STALE_MS)
    assert.deepEqual(first.marked, [])
    assert.deepEqual(first.confirmed, [])
    let live = await row(tower)
    assert.equal(live.state, 'active', 'a single missed sweep must not stale a live worker')
    assert.equal(live.stale, undefined)
    assert.equal(live.absentObservations, 1)
    assert.ok(Number.isFinite(live.absentSince), 'the first miss starts the confirmation window')

    // A second miss immediately after proves that a count alone is not enough:
    // the window has not elapsed yet.
    const second = await watchdogTick(ctx, tower, STALE_MS)
    assert.deepEqual(second.marked, [])
    assert.deepEqual(second.confirmed, [])
    live = await row(tower)
    assert.equal(live.state, 'active')
    assert.equal(live.absentObservations, 2)
    assert.equal(live.stale, undefined)

    // The same two observations, now spanning twice staleMs, confirm the miss.
    await ageAbsence(tower, 'agent-live', STALE_MS * 2 + 1)
    const third = await watchdogTick(ctx, tower, STALE_MS)
    assert.deepEqual(third.confirmed, ['agent-live'])
    assert.deepEqual(third.marked, ['worker-m1'])
    live = await row(tower)
    assert.equal(live.state, 'stale')
    assert.equal(live.stale, true)
    assert.match(activityText(tower), /watchdog.*stale worker-m1|stale worker-m1.*idle/)
  } finally {
    removeTemp(root)
  }
})

test('F73: a present observation resets the absence evidence', async () => {
  const { root, tower } = await seeded()
  try {
    const missing = fakeCtx([{ id: 'agent-unrelated', activity: 'running' }])
    await watchdogTick(missing, tower, STALE_MS)
    assert.equal((await row(tower)).absentObservations, 1)

    const present = fakeCtx([{ id: 'agent-live', activity: 'running' }])
    const tick = await watchdogTick(present, tower, STALE_MS)
    assert.deepEqual(tick.marked, [])
    const live = await row(tower)
    assert.equal(live.state, 'active')
    assert.equal(live.absentObservations, undefined)
    assert.equal(live.absentSince, undefined)
  } finally {
    removeTemp(root)
  }
})

// --- #231: a dead worker leaves a residue record ---------------------------

test('#231: a sweep that stales a worker records the residue it left behind', async () => {
  const { root, repo } = seedRepo('dsh-tower-watchdog-residue-')
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-agent' })
    await tower.plan({ missions: [{ title: '#231 residue', scope: ['src/**'] }] })
    // A branch with real work on it, plus an uncommitted file: the exact shape
    // of a worker that died mid-edit.
    const worktree = path.join(root, 'wt')
    git(repo, ['worktree', 'add', '-b', 'tower/m1-residue', worktree])
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true })
    fs.writeFileSync(path.join(worktree, 'src', 'a.txt'), 'a\n')
    fs.writeFileSync(path.join(worktree, 'src', 'b.txt'), 'b\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-m', 'work'])
    fs.writeFileSync(path.join(worktree, 'src', 'c.txt'), 'c\n')
    const tip = git(worktree, ['rev-parse', 'HEAD'])

    await tower.recordSpawn({
      missionId: 'M1',
      name: 'worker-m1',
      role: 'worker',
      agentId: 'agent-live',
      parentSessionId: 'tower-agent',
      cwd: worktree,
      branch: 'tower/m1-residue',
    })
    const aged = await tower.load()
    aged.roster.find((entry) => entry.agentId === 'agent-live').spawnedAt = Date.now() - 10 * MINUTE
    fs.writeFileSync(tower.paths.state, JSON.stringify(aged, null, 2))

    const swept = await tower.sweepRoster({
      staleMs: STALE_MS,
      activity: { 'agent-unrelated': 'running' },
      authoritative: true,
    })
    assert.deepEqual(swept.marked, ['worker-m1'])

    const dead = await row(tower)
    assert.equal(dead.state, 'stale')
    assert.ok(dead.residue, 'a stale row must record the residue it left behind')
    assert.equal(dead.residue.filesChanged, 1, 'one uncommitted file')
    assert.equal(dead.residue.branch, 'tower/m1-residue')
    assert.equal(dead.residue.tip, tip, 'the tip the worker reached')
    assert.equal(dead.residue.dirty, true)
    assert.ok(Number.isFinite(dead.residue.at), 'the record is timestamped')
    assert.match(activityText(tower), /residue worker-m1: 1 file\(s\) changed/)
  } finally {
    removeTemp(root)
  }
})

test('#231: a dead worker whose worktree is gone still records zero files', async () => {
  const { root, tower } = await seeded()
  try {
    // `seeded` spawns with cwd: null, so the probe has no checkout to read. The
    // death must still be recorded rather than left half-written.
    const swept = await tower.sweepRoster({
      staleMs: STALE_MS,
      activity: { 'agent-unrelated': 'running' },
      authoritative: true,
    })
    assert.deepEqual(swept.marked, ['worker-m1'])
    const dead = await row(tower)
    assert.equal(dead.state, 'stale')
    assert.deepEqual(dead.residue.filesChanged, 0)
    assert.equal(dead.residue.dirty, false)
    assert.ok(Number.isFinite(dead.residue.at))
  } finally {
    removeTemp(root)
  }
})

test('#231: a clean predecessor leaves no residue, a dirty one leaves a bounded record', async () => {
  const { root, repo } = seedRepo('dsh-tower-watchdog-residue-clean-')
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-agent' })
    await tower.plan({ missions: [{ title: '#231 clean', scope: ['src/**'] }] })
    const worktree = path.join(root, 'wt')
    git(repo, ['worktree', 'add', '-b', 'tower/m1-clean', worktree])
    await tower.recordSpawn({
      missionId: 'M1',
      name: 'worker-m1',
      role: 'worker',
      agentId: 'agent-live',
      parentSessionId: 'tower-agent',
      cwd: worktree,
      branch: 'tower/m1-clean',
    })
    const aged = await tower.load()
    aged.roster.find((entry) => entry.agentId === 'agent-live').spawnedAt = Date.now() - 10 * MINUTE
    fs.writeFileSync(tower.paths.state, JSON.stringify(aged, null, 2))

    await tower.sweepRoster({ staleMs: STALE_MS, activity: { 'agent-unrelated': 'running' }, authoritative: true })
    const dead = await row(tower)
    assert.equal(dead.residue.filesChanged, 0)
    assert.equal(dead.residue.dirty, false)
    // Counts and shas only: the record never carries file contents or a diff.
    assert.deepEqual(Object.keys(dead.residue).sort(), ['at', 'branch', 'dirty', 'filesChanged', 'tip'])
    for (const value of Object.values(dead.residue)) {
      if (typeof value === 'string') assert.ok(value.length <= 120, `residue field must stay bounded: ${value}`)
    }
  } finally {
    removeTemp(root)
  }
})

test('F73: staleMs: 0 disables the watchdog without writing state or activity', async () => {
  const { root, tower } = await seeded()
  try {
    const ctx = fakeCtx([{ id: 'agent-unrelated', activity: 'running' }])
    const stateBefore = fs.readFileSync(tower.paths.state, 'utf8')
    const activityBefore = activityText(tower)
    const first = await watchdogTick(ctx, tower, 0)
    const second = await watchdogTick(ctx, tower, 0)
    assert.equal(first.skipped, 'disabled')
    assert.equal(second.skipped, 'disabled')
    assert.equal(fs.readFileSync(tower.paths.state, 'utf8'), stateBefore, '0 disables all watchdog state writes')
    assert.equal(activityText(tower), activityBefore, '0 disables all watchdog activity writes')
    const live = await row(tower)
    assert.equal(live.state, 'active')
    assert.equal(live.absentObservations, undefined)
  } finally {
    removeTemp(root)
  }
})

test('F73: a stale-marked worker completes its own mission and is revived', async () => {
  const { root, repo } = seedRepo('dsh-tower-watchdog-complete-')
  const tools = makeTools()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'F73 self report', scope: ['src/**'] }],
    })
    const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId: 'M1', role: 'worker' })
    assert.ok(spawned.agentId, 'spawn must activate a child')
    fs.mkdirSync(path.join(spawned.worktree.path, 'src'), { recursive: true })
    fs.writeFileSync(path.join(spawned.worktree.path, 'src', 'a.txt'), 'a\n')
    git(spawned.worktree.path, ['add', '-A'])
    git(spawned.worktree.path, ['commit', '-m', 'work'])

    const tower = await Tower.open(repo)
    // The F73 state: a live child whose row the watchdog marked stale.
    const state = await tower.load()
    const live = state.roster.find((entry) => entry.agentId === spawned.agentId)
    live.state = 'stale'
    live.stale = true
    live.staleAt = Date.now()
    live.spawnedAt = Date.now() - 16_000
    state.revision += 1
    state.updatedAt = Date.now()
    fs.writeFileSync(tower.paths.state, JSON.stringify(state, null, 2))

    // Guard proof: admission alone refuses the very worker that is calling.
    await assert.rejects(
      () => tower.checkCompletion({ missionId: 'M1', agentId: spawned.agentId, report: 'done' }),
      /is stale; a stopped worker cannot report completion/,
    )

    const completed = await call(
      tools,
      'tower_complete',
      { repoRoot: repo, missionId: 'M1', report: 'done' },
      { agent: { id: spawned.agentId } },
    )
    assert.equal(completed.mission.status, 'completed')
    assert.equal(completed.mission.completionReport.report.trim(), 'done')

    const after = await (await Tower.open(repo)).load()
    const closed = after.roster.find((entry) => entry.agentId === spawned.agentId)
    assert.equal(closed.state, 'inactive', 'the accepted self report closes the live slot')
    assert.equal(closed.outcome, 'completed (self-report)')
    assert.equal(closed.stale, undefined)
    assert.equal(closed.staleAt, undefined)
    assert.equal(closed.absentObservations, undefined)

    const log = activityText(await Tower.open(repo))
    assert.match(log, /revived worker-m\d+ from stale: it called tower_complete itself, so the child is alive \(F73\)/)
    assert.match(log, /marked worker-m\d+ inactive after self-reported completion \(F73\)/)
  } finally {
    removeTemp(root)
  }
})

// --- F73 round 3: revival is atomic with an in-flight sweep -----------------

test('F73: a row revived mid-tick never enters the absence decision', async () => {
  const { root, tower } = await seededPair('dsh-tower-watchdog-mid-tick-')
  try {
    await writeRoster(tower, (roster) => {
      for (const entry of roster) entry.spawnedAt = Date.now() - 10 * MINUTE
      const straggler = roster.find((entry) => entry.agentId === 'agent-live')
      straggler.state = 'stale'
      straggler.stale = true
      straggler.staleAt = Date.now()
    })
    const ctx = fakeCtx([{ id: 'agent-bystander', activity: 'running' }])
    const seam = pauseAfterFirstRosterView(tower)
    const ticking = watchdogTick(ctx, tower, STALE_MS)
    try {
      await seam.reached
      // The straggler is alive after all: it revived itself in the window
      // between the tick's roster snapshot and its sweep. The snapshot still
      // excludes it, so only an explicit "no observation" can protect it.
      const revived = await reviveStaleSelfReporter(tower, { missionId: 'M1', agentId: 'agent-live' })
      assert.equal(revived.revived, true)
      assert.equal((await row(tower)).state, 'active')
    } finally {
      seam.release()
    }
    const tick = await ticking
    assert.equal(tick.skipped, undefined, `the tick must reach the sweep, got ${tick.skipped}`)
    assert.deepEqual(tick.marked, [], 'a row revived mid-tick is not evidence of absence')
    const live = await row(tower)
    assert.equal(live.state, 'active', 'the revived row is still active at tick end')
    assert.equal(live.stale, undefined)
    assert.equal(live.staleAt, undefined)
    assert.doesNotMatch(activityText(tower), /stale worker-m1/)
  } finally {
    removeTemp(root)
  }
})

test('F73: a completion racing a parked tick closes the row and leaves no worker-stale blocker', async () => {
  const { root, repo } = seedRepo('dsh-tower-watchdog-race-')
  const tools = makeTools()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [
        { title: 'F73 raced completion', scope: ['src/**'] },
        { title: 'F73 bystander', scope: ['src/**'] },
      ],
    })
    const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId: 'M1', role: 'worker' })
    assert.ok(spawned.agentId, 'spawn must activate a child')
    fs.mkdirSync(path.join(spawned.worktree.path, 'src'), { recursive: true })
    fs.writeFileSync(path.join(spawned.worktree.path, 'src', 'a.txt'), 'a\n')
    git(spawned.worktree.path, ['add', '-A'])
    git(spawned.worktree.path, ['commit', '-m', 'work'])

    const tower = await Tower.open(repo)
    await tower.recordSpawn({
      missionId: 'M2',
      name: 'worker-m2',
      role: 'worker',
      agentId: 'agent-bystander',
      parentSessionId: 'tower-agent',
      cwd: null,
      branch: null,
    })
    await writeRoster(tower, (roster) => {
      for (const entry of roster) entry.spawnedAt = Date.now() - 10 * MINUTE
      const live = roster.find((entry) => entry.agentId === spawned.agentId)
      live.state = 'stale'
      live.stale = true
      live.staleAt = Date.now()
    })

    const ctx = fakeCtx([{ id: 'agent-bystander', activity: 'running' }])
    const seam = pauseAfterFirstRosterView(tower)
    const ticking = watchdogTick(ctx, tower, STALE_MS)
    let tick
    try {
      await seam.reached
      // The whole `tower_complete` transition — revival, roster settle and
      // mission commit — runs while the tick is parked after its snapshot. A
      // sweep that resumes afterwards must not treat the row's snapshot state
      // as absence.
      const completed = await call(
        tools,
        'tower_complete',
        { repoRoot: repo, missionId: 'M1', report: 'done' },
        { agent: { id: spawned.agentId } },
      )
      assert.equal(completed.mission.status, 'completed')
    } finally {
      seam.release()
      tick = await ticking
    }
    assert.deepEqual(tick.marked, [], 'the tick must not mark the completed row')
    const after = await (await Tower.open(repo)).load()
    const closed = after.roster.find((entry) => entry.agentId === spawned.agentId)
    assert.equal(closed.state, 'inactive', 'the row stays closed after the sweep')
    assert.equal(closed.outcome, 'completed (self-report)')
    assert.equal(closed.stale, undefined)
    assert.equal(closed.staleAt, undefined)
    const gate = await (await Tower.open(repo)).evaluateGate({ missionId: 'M1', activity: {}, parentStatus: {} })
    const codes = gate.blockers.map((blocker) => blocker.code)
    assert.ok(!codes.includes('worker-stale'), `no worker-stale blocker, got ${codes.join(', ')}`)
  } finally {
    removeTemp(root)
  }
})

test('F73: a sweep that wins the lock before the commit is absorbed, not refused', async () => {
  const { root, repo } = seedRepo('dsh-tower-watchdog-lock-')
  const tools = makeTools()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    await call(tools, 'tower_plan', { repoRoot: repo, missions: [{ title: 'F73 lock race', scope: ['src/**'] }] })
    const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId: 'M1', role: 'worker' })
    assert.ok(spawned.agentId, 'spawn must activate a child')
    fs.mkdirSync(path.join(spawned.worktree.path, 'src'), { recursive: true })
    fs.writeFileSync(path.join(spawned.worktree.path, 'src', 'a.txt'), 'a\n')
    git(spawned.worktree.path, ['add', '-A'])
    git(spawned.worktree.path, ['commit', '-m', 'work'])

    const tower = await Tower.open(repo)
    await writeRoster(tower, (roster) => {
      for (const entry of roster) entry.spawnedAt = Date.now() - 10 * MINUTE
    })
    // Deterministic preemption: the sweep wins the state lock in the window
    // between the two-phase prepare and the commit's own lock — the exact
    // moment the old revision guard turned a live worker's report into
    // `stale-base`.
    const originalCheck = tower.checkCompletion.bind(tower)
    let prepares = 0
    let injected = null
    tower.checkCompletion = async (input, options) => {
      const prepared = await originalCheck(input, options)
      prepares += 1
      if (!injected) injected = await tower.sweepRoster({ staleMs: STALE_MS, activity: {}, authoritative: true })
      return prepared
    }

    const completed = await tower.complete(
      { missionId: 'M1', agentId: spawned.agentId, report: 'done' },
      { allowStaleSelfReport: true },
    )
    assert.deepEqual(injected.marked, ['worker-m1'], 'the race must actually stale the row first')
    assert.ok(prepares >= 2, `completion must re-prepare after the sweep, saw ${prepares}`)
    assert.equal(completed.mission.status, 'completed')

    const after = await (await Tower.open(repo)).load()
    const closed = after.roster.find((entry) => entry.agentId === spawned.agentId)
    assert.equal(closed.state, 'inactive')
    assert.equal(closed.outcome, 'completed (self-report)')
    assert.equal(closed.stale, undefined)
    assert.equal(closed.staleAt, undefined)
    const gate = await (await Tower.open(repo)).evaluateGate({ missionId: 'M1', activity: {}, parentStatus: {} })
    const codes = gate.blockers.map((blocker) => blocker.code)
    assert.ok(!codes.includes('worker-stale'), `no worker-stale blocker, got ${codes.join(', ')}`)
  } finally {
    removeTemp(root)
  }
})

// --- tool-surface fixture for the self-report case -------------------------

afterEach(() => {
  __testResetComponentRegistry()
})

function makeTools() {
  const tools = new Map()
  const subagents = {
    list: () => ['spawn'],
    startActivation: async () => ({ childId: 'child-f73', result: new Promise(() => {}) }),
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
  return tools
}

function call(tools, name, args, exec = { agent: { id: 'tower-agent' } }) {
  return tools.get(name).execute(args, exec)
}
