// #69 acceptance: one full mission lifecycle runs through the real app layer
// with in-memory port implementations supplied directly to the Tower service.
//
// This is not the scripted transcript under tests/memory-lifecycle.contract;
// it calls the production use cases (init -> plan -> provision -> spawn ->
// mission -> complete -> review -> gate -> merge -> teardown) on app/tower.js.
// The composition in this file supplies every port itself: no disk, no git, no
// adapters/default.js and no defaultDeps. If any app module still reached an
// adapter or infrastructure module directly, the scripted vcs would record it
// in `unscripted`/`calls` or the memory store would not see the write.
import test from 'node:test'
import assert from 'node:assert/strict'

import { Tower } from '../app/tower.js'
import * as archive from '../lib/archive.js'
import { loadStateFile } from '../lib/stateFile.js'
import { createMemoryStore, MEMORY_SCHEME } from './support/memory-store.js'
import { createScriptedVcs } from './support/scripted-vcs.js'

const REPO_ROOT = '/virtual/repo'
const COMMON_DIR = '/virtual/repo/.git'
const WORKTREES = '/virtual/worktrees'
const WORKER_AGENT = 'agent-worker'
const REVIEWER_AGENT = 'agent-reviewer'

const CONFIG = {
  git: { timeoutMs: 5000 },
  merge: { timeoutMs: 5000, maxBufferBytes: 64 * 1024 },
  spawn: { maxLiveWorkers: 4, staleMs: 0 },
  review: { requireReview: true, maxRoundsPerReviewer: 5 },
  gates: { requireChecks: false, maxReportBytes: 32768, allowReviewExemption: false },
  archive: { enabled: false },
  worktrees: { root: WORKTREES },
  init: { autoExclude: false },
  docs: { board: false },
  tests: { enabled: false },
}

function createClock(start = 1_700_000_000_000, step = 1_000) {
  let current = start
  return { now: () => (current += step) }
}

/**
 * Assemble every port the app layer needs. The store and vcs are the in-memory
 * doubles; ownership is verified against the scripted worktree graph; the
 * config/clock/ids ports are deterministic.
 */
function createInMemoryDeps() {
  const store = createMemoryStore()
  const vcs = createScriptedVcs({ repoRoot: REPO_ROOT })
  vcs.seed({ branch: 'main', message: 'seed' })
  const clock = createClock()
  let uuidSeq = 0
  const deps = {
    store,
    vcs,
    ownership: {
      async assertOwnership(input) {
        const storedPath = String(input.storedPath)
        // The scripted vcs keys worktrees by slash-normalized virtual paths.
        const virtualPath = storedPath.replace(/\\/g, '/')
        if (!vcs.worktreePaths().includes(virtualPath)) {
          const error = new Error(`mission worktree is missing: ${storedPath}`)
          error.code = 'invalid-transition'
          throw error
        }
        return { path: storedPath, realPath: input.storedRealPath ?? storedPath }
      },
      async canonicalPath(target) {
        return target
      },
    },
    caseSensitivity: { detect: async () => false },
    archive: {
      readIndex: archive.readArchiveIndex,
      readEntry: archive.readArchivedEntry,
      writeEntries: archive.writeArchiveEntries,
    },
    state: { loadStateFile },
    config: {
      runtimeConfig: () => CONFIG,
      resolveRepoConfig: async () => CONFIG,
    },
    clock,
    ids: { uuid: () => `uuid-${(uuidSeq += 1)}`, shortHash: (text) => String(text).slice(-8) },
  }
  return { deps, store, vcs }
}

async function runLifecycle() {
  const { deps, store, vcs } = createInMemoryDeps()
  const tower = new Tower({ root: REPO_ROOT, commonDir: COMMON_DIR, branch: 'main' }, CONFIG, deps)
  const transcript = []

  await tower.init({ base: 'main', towerAgentId: 'agent-tower' })
  transcript.push('init')

  const planned = await tower.plan({
    missions: [{ title: 'In-memory port lifecycle', scope: ['tests/**'], tasks: ['run the lifecycle'] }],
  })
  const missionId = planned.missions[0].id
  assert.equal(missionId, 'M1')
  transcript.push('plan')

  const provisioned = await tower.provision({ missionId, worktreeRoot: WORKTREES })
  const worktree = provisioned.worktree
  assert.equal(provisioned.created, true)
  assert.ok(vcs.worktreePaths().includes(worktree.path.replace(/\\/g, '/')))
  transcript.push('provision')

  await tower.reserveRoster({ missionId, name: 'worker-1', role: 'worker', parentSessionId: 'session-tower' })
  await tower.recordSpawn({
    missionId,
    name: 'worker-1',
    role: 'worker',
    agentId: WORKER_AGENT,
    parentSessionId: 'session-tower',
    cwd: worktree.path,
  })
  transcript.push('spawn')

  vcs.commit(worktree.path, 'feat: in-memory worker commit')
  await tower.mission({ id: missionId, task_done: 'run the lifecycle' })
  transcript.push('task')

  const completed = await tower.complete({
    missionId,
    agentId: WORKER_AGENT,
    report: 'the injected ports carry the whole lifecycle',
    checks: [{ name: 'in-memory lifecycle', exitCode: 0, evidence: 'scripted vcs' }],
  })
  assert.equal(completed.mission.status, 'completed')
  transcript.push('complete')

  await tower.recordSpawn({
    missionId,
    name: 'reviewer-1',
    role: 'reviewer',
    agentId: REVIEWER_AGENT,
    parentSessionId: 'session-tower',
    cwd: worktree.path,
  })
  const reviewed = await tower.submitReview({
    missionId,
    agentId: REVIEWER_AGENT,
    actor: { role: 'reviewer' },
    status: 'clean',
    merge: 'merge',
    findings: 'none',
    decision: 'the ports compose without the disk',
    checks: ['in-memory lifecycle'],
  })
  assert.equal(reviewed.review.status, 'clean')
  transcript.push('review')

  // Both agents are idle now; the merge gate must see no running worker and a
  // clean review bound to the current tip.
  await tower.reconcileObservedInactive({ [WORKER_AGENT]: 'inactive', [REVIEWER_AGENT]: 'inactive' })
  transcript.push('roster')

  const gate = await tower.evaluateGate({ missionId, activity: {} })
  assert.equal(gate.ok, true, JSON.stringify(gate.blockers))
  transcript.push('gate')

  const merged = await tower.merge({ missionId })
  assert.equal(merged.ok, true, JSON.stringify(merged))
  transcript.push('merge')

  const torn = await tower.teardown({})
  assert.deepEqual(torn.removed, [missionId])
  transcript.push('teardown')

  const state = await tower.load()
  return { tower, store, vcs, state, missionId, worktree, transcript }
}

let cached
function lifecycle() {
  cached ??= runLifecycle()
  return cached
}

test('a full mission lifecycle runs through the app services on in-memory ports', async () => {
  const run = await lifecycle()
  assert.deepEqual(run.transcript, [
    'init',
    'plan',
    'provision',
    'spawn',
    'task',
    'complete',
    'review',
    'roster',
    'gate',
    'merge',
    'teardown',
  ])

  const mission = run.state.missions.find((entry) => entry.id === run.missionId)
  assert.equal(mission.status, 'merged')
  assert.equal(typeof mission.mergedCommit, 'string')
  assert.equal(typeof mission.worktreeRemovedAt, 'number')
  assert.equal(run.state.missions.length, 1)
})

test('the in-memory lifecycle never touches the filesystem or a real process', async () => {
  const run = await lifecycle()
  // Every store path is the virtual scheme; no real file path was used.
  assert.ok(run.store.inspect.paths().length > 0)
  assert.ok(run.store.inspect.paths().every((file) => file.startsWith(MEMORY_SCHEME)))
  // No unscripted git command was issued, and every call stayed virtual.
  assert.deepEqual(run.vcs.unscripted, [])
  assert.ok(run.vcs.calls.length > 0)
  assert.ok(
    run.vcs.calls.every((call) => /^(?:[a-z]:)?[\\/]virtual[\\/]/i.test(call.cwd)),
    `every git call must stay under the virtual root, saw ${JSON.stringify([...new Set(run.vcs.calls.map((call) => call.cwd))])}`,
  )
  // The lifecycle exercised init/provision/merge/teardown through the vcs port.
  const commands = new Set(run.vcs.calls.map((call) => call.args[0]))
  for (const command of ['rev-parse', 'worktree', 'merge', 'branch']) {
    assert.ok(commands.has(command), `expected the lifecycle to drive git ${command}`)
  }
  // Locks were serialized per domain and all released. The merge nests the
  // state lock inside the git mutex by design (two distinct domains), so the
  // meaningful assertion is per-lock exclusivity, not a global counter.
  const paths = run.store.pathsFor('/virtual/repo/.git')
  assert.equal(run.store.inspect.maxConcurrent(paths.lock), 1)
  assert.equal(run.store.inspect.maxConcurrent(paths.gitLock), 1)
  assert.equal(run.store.inspect.stats.activeLocks, 0)
})

test('the lifecycle state document passes the production validator', async () => {
  const run = await lifecycle()
  const { validateState } = await import('../domain/state.js')
  assert.doesNotThrow(() => validateState(run.state, run.state.path ?? '/virtual/repo/.git/dsh-tower/state.json'))
})
