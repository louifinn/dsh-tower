// Contract test for #50: a small mission lifecycle runs entirely against the
// in-memory store and the scripted vcs - no disk, no git.
//
// The driver below mirrors the store/vcs call pattern of the real Tower use
// cases (init -> plan -> provision -> spawn -> task -> complete -> roster
// observation -> review -> merge -> teardown), and reuses the production pure
// validators and gates on the resulting state. It does not replace the
// real-repository suites; it proves that the doubles compose into the lifecycle
// a future injected Tower will run.
//
// Run with: node --test tests/memory-lifecycle.contract.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'

import { validateState } from '../lib/domain/state.js'
import { completionBlockers, mergeGateBlockers } from '../lib/domain/gate.js'
import { ROSTER_INACTIVE, ROSTER_INACTIVE_STATES } from '../lib/domain/roster.js'
import { SCHEMA_VERSION } from '../lib/domain/mission.js'
import { createMemoryStore, MEMORY_SCHEME } from './support/memory-store.js'
import { createScriptedVcs } from './support/scripted-vcs.js'

const REPO_ROOT = '/virtual/repo'
const COMMON_DIR = '/virtual/repo/.git'
const MISSION_ID = 'M1'
const BRANCH = 'tower/m1-scripted-lifecycle'
const WORKTREE = '/virtual/worktrees/M1'
const WORKER = { name: 'worker-1', role: 'worker', agentId: 'agent-worker' }
const REVIEWER = { name: 'reviewer-1', role: 'reviewer', agentId: 'agent-reviewer' }
const CONFIG = {
  review: { requireReview: true },
  gates: { requireChecks: false, allowReviewExemption: false },
  spawn: { maxLiveWorkers: 4 },
}

function createClock(start = 1_700_000_000_000, step = 1_000) {
  let current = start
  return () => {
    current += step
    return current
  }
}

function createHarness() {
  const clock = createClock()
  const store = createMemoryStore()
  const vcs = createScriptedVcs({ repoRoot: REPO_ROOT })
  const seedCommit = vcs.seed({ branch: 'main', message: 'seed' })
  return { clock, store, vcs, seedCommit, paths: store.pathsFor(COMMON_DIR) }
}

async function readState(harness) {
  return harness.store.readJson(harness.paths.state)
}

async function writeState(harness, state, activity) {
  validateState(state, harness.paths.state)
  await harness.store.writeJsonAtomic(harness.paths.state, state)
  if (activity) await harness.store.appendJsonl(harness.paths.activity, activity)
}

async function runScriptedLifecycle() {
  const harness = createHarness()
  const { clock, store, vcs, paths } = harness
  const transcript = []
  await store.ensureDir(paths.dir)

  async function record(phase) {
    const state = await readState(harness)
    transcript.push({
      phase,
      revision: state.revision,
      mission: state.missions[0] ? { id: state.missions[0].id, status: state.missions[0].status } : null,
    })
    return state
  }

  // 1. init -- Tower.init: base discovery, initial state, activity.
  await store.withLock(paths, async () => {
    const now = clock()
    const dirty = !(await vcs.isClean(REPO_ROOT))
    const state = {
      schemaVersion: SCHEMA_VERSION,
      repoRoot: REPO_ROOT,
      commonDir: COMMON_DIR,
      base: 'main',
      revision: 0,
      createdAt: now,
      updatedAt: now,
      dirtyBase: dirty,
      missions: [],
    }
    await writeState(harness, state, { at: now, type: 'init', text: 'base main' })
  })
  await record('init')

  // 2. plan -- Tower.plan: one mission with one task.
  await store.withLock(paths, async () => {
    const state = await readState(harness)
    const now = clock()
    state.missions.push({
      id: MISSION_ID,
      title: 'Scripted in-memory lifecycle',
      scope: ['tests/**'],
      deps: [],
      status: 'planned',
      tasks: [{ text: 'run the scripted lifecycle', status: 'open' }],
      blockers: [],
      notes: [],
      ownerGeneration: 0,
      createdAt: now,
      updatedAt: now,
    })
    state.revision += 1
    state.updatedAt = now
    await writeState(harness, state, { at: now, type: 'plan', text: `created ${MISSION_ID}` })
  })
  await record('plan')

  // 3. provision -- Tower.provision: a mission worktree on its own branch.
  await store.withLock(paths, async () => {
    const state = await readState(harness)
    const mission = state.missions.find((entry) => entry.id === MISSION_ID)
    const now = clock()
    const baseCommit = await vcs.revParse(REPO_ROOT, state.base)
    await vcs.git(REPO_ROOT, ['worktree', 'add', '-b', BRANCH, WORKTREE, baseCommit])
    mission.worktree = { path: WORKTREE, branch: BRANCH, baseCommit, createdAt: now }
    mission.baseCommit = baseCommit
    mission.updatedAt = now
    state.revision += 1
    state.updatedAt = now
    await writeState(harness, state, {
      at: now,
      type: 'worktree',
      missionId: MISSION_ID,
      text: `${BRANCH} at ${WORKTREE}`,
    })
  })
  const provisioned = await record('provision')
  const baseCommit = provisioned.missions[0].worktree.baseCommit

  // 4. spawn -- Tower.recordSpawn: owner + roster row, planned -> active.
  await store.withLock(paths, async () => {
    const state = await readState(harness)
    const mission = state.missions.find((entry) => entry.id === MISSION_ID)
    const now = clock()
    const spawnTip = await vcs.revParse(WORKTREE, 'HEAD')
    state.roster = [{ ...WORKER, missionId: MISSION_ID, branch: BRANCH, spawnTip, state: 'active', spawnedAt: now }]
    mission.owner = WORKER.name
    mission.status = 'active'
    mission.ownerGeneration = 1
    mission.updatedAt = now
    state.revision += 1
    state.updatedAt = now
    await writeState(harness, state, {
      at: now,
      type: 'spawn',
      missionId: MISSION_ID,
      text: `${WORKER.role} ${WORKER.name} (${WORKER.agentId})`,
    })
  })
  await record('spawn')

  // The worker is an external actor: it commits in its worktree, outside Tower.
  const workerTip = vcs.commit(WORKTREE, 'feat: scripted in-memory work')

  // 5. task done -- Tower.mission with task_done.
  await store.withLock(paths, async () => {
    const state = await readState(harness)
    const mission = state.missions.find((entry) => entry.id === MISSION_ID)
    const now = clock()
    const task = mission.tasks.find((entry) => entry.status === 'open')
    task.status = 'done'
    mission.updatedAt = now
    state.revision += 1
    state.updatedAt = now
    await writeState(harness, state, { at: now, type: 'task', missionId: MISSION_ID, text: 'task done' })
  })
  await record('task')

  // 6. complete -- Tower.complete: prepare the evidence, then commit under the lock.
  const preparedRevision = (await readState(harness)).revision
  const completion = await store.withLock(paths, async () => {
    const state = await readState(harness)
    const mission = state.missions.find((entry) => entry.id === MISSION_ID)
    assert.equal(state.revision, preparedRevision, 'revision must not move during the completion phase')
    assert.equal(mission.status, 'active')
    assert.deepEqual(mission.tasks.filter((task) => task.status === 'open'), [])
    assert.deepEqual(mission.blockers ?? [], [])
    assert.equal(await vcs.isClean(WORKTREE), true)
    const commits = Number(await vcs.git(WORKTREE, ['rev-list', '--count', `${mission.worktree.baseCommit}..HEAD`]))
    assert.ok(commits >= 1, 'the mission branch must have a commit since base')
    const now = clock()
    mission.status = 'completed'
    mission.completionReport = {
      report: 'scripted in-memory lifecycle complete',
      by: WORKER.name,
      at: now,
      checks: [{ name: 'scripted lifecycle', exitCode: 0 }],
    }
    mission.updatedAt = now
    // The production completion gate must accept the finished mission.
    assert.deepEqual(completionBlockers(mission, CONFIG), [])
    state.revision += 1
    state.updatedAt = now
    await writeState(harness, state, {
      at: now,
      type: 'complete',
      missionId: MISSION_ID,
      text: `${WORKER.name} reported completion (${commits} commit(s))`,
    })
    return { commits }
  })
  await record('complete')

  // 7. roster observation -- Tower reconciliation: the idle worker frees its slot.
  await store.withLock(paths, async () => {
    const state = await readState(harness)
    const now = clock()
    const released = []
    for (const entry of state.roster ?? []) {
      if (entry.state === 'reserved' || ROSTER_INACTIVE.has(entry.state)) continue
      if (entry.agentId !== WORKER.agentId) continue
      entry.state = 'inactive'
      entry.outcome = 'catalog reported inactive'
      entry.outcomeAt = now
      released.push(entry.name)
    }
    assert.deepEqual(released, [WORKER.name])
    state.revision += 1
    state.updatedAt = now
    await writeState(harness, state, { at: now, type: 'roster', text: `released inactive slots: ${released.join(', ')}` })
  })
  await record('roster')

  // 8. review -- Tower.submitReview: clean verdict bound to the current tip.
  const reviewedTip = await vcs.revParse(WORKTREE, 'HEAD')
  const preparedReviewRevision = (await readState(harness)).revision
  await store.withLock(paths, async () => {
    const state = await readState(harness)
    const mission = state.missions.find((entry) => entry.id === MISSION_ID)
    assert.equal(state.revision, preparedReviewRevision, 'revision must not move during the review phase')
    assert.equal(mission.status, 'completed')
    const now = clock()
    const tip = await vcs.revParse(WORKTREE, 'HEAD')
    assert.equal(tip, reviewedTip)
    state.roster.push({
      ...REVIEWER,
      missionId: MISSION_ID,
      branch: BRANCH,
      spawnTip: tip,
      state: 'inactive',
      spawnedAt: now,
    })
    if (!Array.isArray(state.reviews)) state.reviews = []
    const seq = (state.reviewSeq ?? 0) + 1
    state.reviewSeq = seq
    state.reviews.push({
      id: `R${seq}`,
      seq,
      missionId: MISSION_ID,
      branch: BRANCH,
      reviewedCommit: tip,
      status: 'clean',
      mergeVerdict: 'merge',
      findings: 'none',
      checks: [],
      decision: 'the doubles satisfy the scripted lifecycle contract',
      reviewer: REVIEWER.name,
      reviewerRole: REVIEWER.role,
      round: 1,
      at: now,
    })
    mission.notes.push(`review round 1 by ${REVIEWER.name}: clean (merge)`)
    mission.updatedAt = now
    state.revision += 1
    state.updatedAt = now
    await writeState(harness, state, {
      at: now,
      type: 'review',
      missionId: MISSION_ID,
      text: `round 1 ${REVIEWER.name}: clean / merge @ ${tip.slice(0, 12)}`,
    })
  })
  await record('review')

  // 9. merge -- Tower.merge: gate, intent write, exact-tip --no-ff merge, record.
  const merged = await store.withLock(paths, async () => {
    const state = await readState(harness)
    const mission = state.missions.find((entry) => entry.id === MISSION_ID)
    const review = state.reviews.find((entry) => entry.missionId === MISSION_ID)
    const baseTipBefore = await vcs.revParse(REPO_ROOT, 'HEAD')
    const branchTip = await vcs.revParse(WORKTREE, 'HEAD')
    const blockers = mergeGateBlockers({
      mission,
      roster: state.roster ?? [],
      branch: mission.worktree.branch,
      branchTip,
      review,
      config: CONFIG,
      activity: {},
      parentStatus: null,
      inactiveStates: ROSTER_INACTIVE_STATES,
    })
    assert.deepEqual(blockers, [], 'the production merge gate must accept the scripted state')
    const now = clock()
    // Two writes like the real merge: record the intent before touching git...
    state.mergeIntent = { missionId: MISSION_ID, baseTip: baseTipBefore, branchTip, gateTip: branchTip, startedAt: now }
    state.revision += 1
    state.updatedAt = now
    await validateState(state, paths.state)
    await store.writeJsonAtomic(paths.state, state)
    // ...then merge the exact reviewed tip and record the resulting commit.
    await vcs.git(REPO_ROOT, ['merge', '--no-ff', branchTip, '-m', `tower: merge ${MISSION_ID} - ${mission.title}`])
    const mergedCommit = await vcs.revParse(REPO_ROOT, 'HEAD')
    const parentLine = (await vcs.tryGit(REPO_ROOT, ['rev-list', '--parents', '-n', '1', mergedCommit])) ?? ''
    const parents = parentLine.trim().split(/\s+/).slice(1)
    assert.deepEqual(parents, [baseTipBefore, branchTip], 'merge commit must have the exact base and reviewed tip')
    const mergedAt = clock()
    delete state.mergeIntent
    mission.status = 'merged'
    mission.mergedAt = mergedAt
    mission.mergedCommit = mergedCommit
    mission.updatedAt = mergedAt
    mission.notes.push(`merged ${branchTip.slice(0, 7)} into ${state.base} as ${mergedCommit.slice(0, 7)}`)
    state.revision += 1
    state.updatedAt = mergedAt
    await writeState(harness, state, {
      at: mergedAt,
      type: 'merge',
      missionId: MISSION_ID,
      text: `${branchTip.slice(0, 7)} -> ${mergedCommit.slice(0, 7)} on ${state.base}`,
    })
    return { baseTipBefore, branchTip, mergedCommit }
  })
  await record('merge')

  // 10. teardown -- Tower.teardown: remove the merged worktree, then its branch.
  const finalState = await store.withLock(paths, async () => {
    const state = await readState(harness)
    const mission = state.missions.find((entry) => entry.id === MISSION_ID)
    assert.equal(mission.status, 'merged')
    assert.equal(await vcs.isClean(WORKTREE), true)
    await vcs.git(REPO_ROOT, ['worktree', 'remove', WORKTREE])
    let branchDeleteError = null
    try {
      await vcs.git(REPO_ROOT, ['branch', '-d', mission.worktree.branch])
    } catch (error) {
      branchDeleteError = String(error?.message ?? error)
    }
    assert.equal(branchDeleteError, null)
    const now = clock()
    mission.worktreeRemovedAt = now
    mission.updatedAt = now
    state.revision += 1
    state.updatedAt = now
    await writeState(harness, state, { at: now, type: 'teardown', missionId: MISSION_ID, text: mission.worktree.branch })
    return state
  })
  transcript.push({
    phase: 'teardown',
    revision: finalState.revision,
    mission: { id: MISSION_ID, status: finalState.missions[0].status },
  })

  return {
    harness,
    transcript,
    finalState,
    completion,
    merged,
    baseCommit,
    workerTip,
    reviewedTip,
    finalBaseTip: await vcs.revParse(REPO_ROOT, 'HEAD'),
    activity: store.inspect.readActivity(paths.activity),
    writes: store.inspect.stats.writes,
  }
}

let cachedRun
function lifecycle() {
  cachedRun ??= runScriptedLifecycle()
  return cachedRun
}

test('a scripted mission lifecycle reaches merged and torn down on the doubles', async () => {
  const run = await lifecycle()
  const { harness } = run
  const { store, vcs } = harness

  assert.deepEqual(
    run.transcript.map((entry) => entry.phase),
    ['init', 'plan', 'provision', 'spawn', 'task', 'complete', 'roster', 'review', 'merge', 'teardown'],
  )
  assert.deepEqual(
    run.activity.map((entry) => entry.type),
    ['init', 'plan', 'worktree', 'spawn', 'task', 'complete', 'roster', 'review', 'merge', 'teardown'],
  )
  assert.deepEqual(run.completion, { commits: 1 })

  assert.equal(run.finalState.revision, 10)
  const mission = run.finalState.missions.find((entry) => entry.id === MISSION_ID)
  assert.equal(mission.status, 'merged')
  assert.equal(mission.mergedCommit, run.merged.mergedCommit)
  assert.equal(typeof mission.worktreeRemovedAt, 'number')
  assert.equal(run.finalState.missions.length, 1)

  // The exact reviewed commit landed on the base branch.
  assert.notEqual(run.merged.mergedCommit, run.workerTip)
  assert.equal(run.finalBaseTip, run.merged.mergedCommit)
  assert.ok(await vcs.isAncestorCommit(run.baseCommit, run.workerTip))
  assert.ok(await vcs.isAncestorCommit(run.workerTip, run.merged.mergedCommit))
  assert.ok(await vcs.isAncestorCommit(run.merged.baseTipBefore, run.merged.mergedCommit))
  assert.deepEqual(vcs.mergeParents(run.merged.mergedCommit), [run.merged.baseTipBefore, run.merged.branchTip])

  // Teardown removed both git resources.
  assert.equal(vcs.branchTip(BRANCH), null)
  assert.deepEqual(vcs.worktreePaths(), [])

  // Locks were exclusive and every write/append stayed in the virtual store.
  assert.equal(store.inspect.stats.maxConcurrentLocks, 1)
  assert.equal(store.inspect.stats.activeLocks, 0)
  assert.equal(store.inspect.stats.lockHolds.length, 10)
  assert.equal(store.inspect.stats.writes.length, 11)
  assert.equal(store.inspect.stats.appends.length, 10)
  assert.ok(store.inspect.stats.writes.every((write) => write.file.startsWith(MEMORY_SCHEME)))
  assert.ok(store.inspect.stats.appends.every((append) => append.file.startsWith(MEMORY_SCHEME)))
})

test('every state written during the lifecycle passes the production validator', async () => {
  const run = await lifecycle()
  const revisions = run.writes.map((write) => JSON.parse(write.text).revision)
  assert.deepEqual(
    revisions,
    Array.from({ length: run.writes.length }, (_, index) => index),
    'each locked mutation must advance the revision by exactly one',
  )
  for (const write of run.writes) {
    assert.doesNotThrow(() => validateState(JSON.parse(write.text), write.file), `invalid state at ${write.file}`)
  }
  const timestamps = run.activity.map((entry) => entry.at)
  assert.deepEqual(timestamps, [...timestamps].sort((a, b) => a - b), 'activity timestamps must be monotonic')
})

test('the scripted vcs proves no git command escaped the double', async () => {
  const run = await lifecycle()
  const { vcs } = run.harness
  assert.deepEqual(vcs.unscripted, [], 'the lifecycle must only issue scripted commands')
  assert.ok(vcs.calls.length > 0)
  assert.ok(vcs.calls.every((call) => call.cwd.startsWith('/virtual/')), 'every git call must stay virtual')
  const commands = vcs.calls.map((call) => call.args[0])
  for (const command of ['rev-parse', 'status', 'worktree', 'rev-list', 'merge', 'branch']) {
    assert.ok(commands.includes(command), `expected the lifecycle to exercise git ${command}`)
  }
})
