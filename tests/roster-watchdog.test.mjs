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
//    the mission, and records why in the activity log.
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
