// Concurrency and resource policies: spawn.maxLiveWorkers, tower_send rate
// limiting, stale roster views and parallel writers sharing the state lock.
// Run with: node --test tests/concurrency.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { registerTowerTools } from '../host/tool-registry.js'
import { Tower } from '../host/tower.js'
import { validateState } from '../app/tower.js'
import { countLiveWorkers } from '../domain/roster.js'
import { __testResetComponentRegistry, registerComponent } from '../host/capability-registry.js'
import { lockRecord } from '../adapters/lock.js'
import { pathsFor, stateCommitLockPath, stateLockSuperseded, withLock, writeStateLocked } from '../adapters/store.js'

const exec = { agent: { id: 'tower-concurrency' } }

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-concurrency-') {
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

function fakeSubagents({ pendingResults = false } = {}) {
  let seq = 0
  const activations = []
  return {
    activations,
    list: () => ['spawn'],
    async startActivation(input) {
      seq += 1
      activations.push(input)
      return {
        childId: `child-${seq}`,
        // A pending result models a child that is still running: `tower_spawn`
        // returns immediately and never records an inactive outcome.
        result: pendingResults
          ? new Promise(() => {})
          : Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }], diagnostic: null }),
      }
    },
    async sendMessage() {},
    async listDescendants() {
      return []
    },
  }
}

function makeCtx(options = {}) {
  // Component enablement is process-local; mount only the rows a fixture asks
  // for so one test cannot leak tower-survey into the next.
  __testResetComponentRegistry()
  for (const id of options.components ?? []) registerComponent(id)
  const tools = new Map()
  const subagents = fakeSubagents(options)
  const agentPresets = {
    list: async () => [{ id: 'tower-worker' }, { id: 'tower-reviewer' }, { id: 'tower-survey' }],
  }
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
  return { ctx, tools, subagents }
}

function writeRepoConfig(repo, value) {
  const file = path.join(repo, '.git', 'dsh-tower', 'config.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
  return file
}

test('spawn.maxLiveWorkers caps live roster workers and allows the limit', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    writeRepoConfig(repo, { spawn: { maxLiveWorkers: 1 } })
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    const planned = await tools.get('tower_plan').execute(
      {
        repoRoot: repo,
        missions: [
          { title: 'Live one', scope: ['one/**'] },
          { title: 'Live two', scope: ['two/**'] },
        ],
      },
      exec,
    )
    assert.equal(planned.missions.length, 2)

    // A directly recorded live worker consumes the only slot.
    const tower = await Tower.open(repo)
    await tower.recordSpawn({
      missionId: 'M1',
      name: 'worker-m1',
      role: 'worker',
      agentId: 'agent-live-1',
      parentSessionId: 'session-concurrency',
      cwd: null,
      branch: null,
    })

    await assert.rejects(
      () => tools.get('tower_spawn').execute({ repoRoot: repo, missionId: 'M2', role: 'worker' }, exec),
      (error) => {
        assert.equal(error.code, 'worker-limit', error.message)
        assert.match(error.message, /live worker limit reached \(1\)/)
        return true
      },
    )

    // The failed spawn must not add a second live worker to the roster.
    const roster = await tools.get('tower_inspect').execute({ view: 'roster', repoRoot: repo }, exec)
    assert.equal(roster.roster.filter((entry) => entry.role === 'worker').length, 1)

    // Raising the limit to 2 lets exactly one more worker start.
    writeRepoConfig(repo, { spawn: { maxLiveWorkers: 2 } })
    const spawned = await tools.get('tower_spawn').execute({ repoRoot: repo, missionId: 'M2', role: 'worker' }, exec)
    assert.equal(spawned.role, 'worker')
    const after = await tools.get('tower_inspect').execute({ view: 'roster', repoRoot: repo }, exec)
    assert.equal(
      after.roster.filter((entry) => entry.role === 'worker').length,
      2,
      'raising spawn.maxLiveWorkers to 2 must allow a second worker entry',
    )
  } finally {
    removeTemp(root)
  }
})

test('a live survey worker does not consume the build worker budget (#148)', async () => {
  const { root, repo } = seedRepo('dsh-tower-concurrency-survey-')
  // Keep every spawned child "running": a resolved fake result would let the
  // background recordOutcome mark the row inactive between assertions.
  const { tools } = makeCtx({ pendingResults: true, components: ['tower-survey'] })
  try {
    writeRepoConfig(repo, { spawn: { maxLiveWorkers: 1 } })
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    const planned = await tools.get('tower_plan').execute(
      {
        repoRoot: repo,
        missions: [
          { title: 'Survey one', kind: 'survey' },
          { title: 'Build two', scope: ['two/**'] },
          { title: 'Build three', scope: ['three/**'] },
          { title: 'Survey four', kind: 'survey' },
          { title: 'Survey five', kind: 'survey' },
        ],
      },
      exec,
    )
    assert.deepEqual(
      planned.missions.map((mission) => mission.kind),
      ['survey', 'build', 'build', 'survey', 'survey'],
    )

    // A survey starts first in the shared checkout with the only build slot free.
    const surveyOne = await tools.get('tower_spawn').execute({ repoRoot: repo, missionId: 'M1', role: 'worker' }, exec)
    assert.equal(surveyOne.provisioning, 'shared')
    assert.equal(surveyOne.worktree ?? null, null)

    // The live survey is not counted, so a build worker still fits in one slot.
    await tools.get('tower_spawn').execute({ repoRoot: repo, missionId: 'M2', role: 'worker' }, exec)

    // The build slot is now full: a second build is refused with worker-limit.
    await assert.rejects(
      () => tools.get('tower_spawn').execute({ repoRoot: repo, missionId: 'M3', role: 'worker' }, exec),
      (error) => {
        assert.equal(error.code, 'worker-limit', error.message)
        assert.match(error.message, /live worker limit reached \(1\)/)
        return true
      },
    )

    // A survey is still allowed while every build slot is busy.
    const surveyFour = await tools.get('tower_spawn').execute({ repoRoot: repo, missionId: 'M4', role: 'worker' }, exec)
    assert.equal(surveyFour.provisioning, 'shared')
    assert.equal(surveyFour.worktree ?? null, null)

    // State-aware count: the two live surveys do not consume the build budget.
    const state = await Tower.open(repo).then((tower) => tower.load())
    assert.equal(countLiveWorkers(state), 1)
    for (const name of ['worker-m1', 'worker-m4']) {
      const entry = state.roster.find((row) => row.name === name)
      assert.equal(entry.state, 'active', `${name} must stay a live survey row`)
    }

    // Single-owner and takeover rules are shape-independent and still apply.
    await assert.rejects(
      () => tools.get('tower_spawn').execute({ repoRoot: repo, missionId: 'M1', role: 'worker' }, exec),
      (error) => error.code === 'invalid-transition' && /already has a live worker/.test(error.message),
    )
    await assert.rejects(
      () => tools.get('tower_spawn').execute({ repoRoot: repo, missionId: 'M1', role: 'worker', op: 'takeover' }, exec),
      (error) => error.code === 'takeover-refused' && /not in the live catalog/.test(error.message),
    )
  } finally {
    removeTemp(root)
  }
})

test('tower_send rate limit: send.maxPerMinute rejects further sends in the window', async () => {
  const { root, repo } = seedRepo('dsh-tower-concurrency-send-')
  const { tools } = makeCtx()
  try {
    writeRepoConfig(repo, { send: { maxPerMinute: 1 } })
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    const first = await tools
      .get('tower_send')
      .execute({ repoRoot: repo, to: 'all', subject: 'first', body: 'one' }, exec)
    assert.equal(first.message.id, 'msg-1')

    await assert.rejects(
      () => tools.get('tower_send').execute({ repoRoot: repo, to: 'all', subject: 'second', body: 'two' }, exec),
      (error) => {
        assert.equal(error.code, 'rate-limited', error.message)
        assert.match(error.message, /rate limit reached \(1\/min/)
        return true
      },
    )
    // The rejected send was not persisted.
    const status = await tools.get('tower_inspect').execute({ view: 'status', repoRoot: repo }, exec)
    assert.equal(status.messages, 1)

    // maxPerMinute:0 disables the limiter entirely.
    writeRepoConfig(repo, { send: { maxPerMinute: 0 } })
    await tools.get('tower_send').execute({ repoRoot: repo, to: 'all', subject: 'third', body: 'three' }, exec)
    await tools.get('tower_send').execute({ repoRoot: repo, to: 'all', subject: 'fourth', body: 'four' }, exec)
    const reloaded = await tools.get('tower_inspect').execute({ view: 'status', repoRoot: repo }, exec)
    assert.equal(reloaded.messages, 3)
  } finally {
    removeTemp(root)
  }
})

test('spawn.staleMs marks roster entries without catalog activity as stale', async () => {
  const { root, repo } = seedRepo('dsh-tower-concurrency-stale-')
  const { tools } = makeCtx()
  try {
    writeRepoConfig(repo, { spawn: { staleMs: 50 } })
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    await tools
      .get('tower_plan')
      .execute({ repoRoot: repo, missions: [{ title: 'Stale case', scope: ['src/**'] }] }, exec)
    const spawned = await tools.get('tower_spawn').execute({ repoRoot: repo, missionId: 'M1', role: 'worker' }, exec)
    await new Promise((resolve) => setTimeout(resolve, 120))

    const stale = await tools.get('tower_inspect').execute({ view: 'roster', repoRoot: repo }, exec)
    const entry = stale.roster.find((candidate) => candidate.agentId === spawned.agentId)
    assert.ok(entry, 'spawned entry must be listed')
    assert.equal(entry.observed, false)
    assert.equal(entry.activity, 'missing')
    assert.equal(entry.stale, true, 'a quiet roster entry older than staleMs must be flagged')
    assert.equal(stale.parentStatus['tower-concurrency'], 'ok')

    // staleMs:0 disables staleness detection.
    writeRepoConfig(repo, { spawn: { staleMs: 0 } })
    const fresh = await tools.get('tower_inspect').execute({ view: 'roster', repoRoot: repo }, exec)
    const entryAgain = fresh.roster.find((candidate) => candidate.agentId === spawned.agentId)
    assert.equal(entryAgain.stale, false)
  } finally {
    removeTemp(root)
  }
})

test('parallel writers serialize on the state lock and keep revisions monotonic', async () => {
  const { root, repo } = seedRepo('dsh-tower-concurrency-parallel-')
  const { tools } = makeCtx()
  try {
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    const missions = Array.from({ length: 8 }, (_, index) => ({
      title: `Parallel ${index}`,
      scope: [`parallel-${index}/**`],
    }))
    await tools.get('tower_plan').execute({ repoRoot: repo, missions }, exec)
    // The property under test is serialization, not the default 5 s lock
    // budget: sixteen concurrent tool calls can queue for longer than that on a
    // loaded Windows runner. `mode.lockTimeoutMs` is the app's state-lock
    // budget — `Tower.withStateLock` passes it to `store.withLock` — so raising
    // it in the repo config gives every waiter room while the exact revision
    // assertion below stays in place.
    writeRepoConfig(repo, { mode: { lockTimeoutMs: 60000 } })
    const tower = await Tower.open(repo)
    const before = await tower.load()

    // Mix writers (notes on distinct missions) with readers (status calls).
    const writes = Array.from({ length: 8 }, (_, index) =>
      tools.get('tower_mission').execute(
        { repoRoot: repo, id: `M${index + 1}`, note: `parallel note ${index}` },
        exec,
      ),
    )
    const reads = Array.from({ length: 8 }, () => tools.get('tower_inspect').execute({ view: 'status', repoRoot: repo }, exec))
    const results = await Promise.allSettled([...writes, ...reads])
    const rejected = results.filter((result) => result.status === 'rejected')
    assert.deepEqual(rejected, [], `no parallel operation may fail: ${rejected.map((result) => result.reason?.message).join('; ')}`)
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 16)

    const after = await tower.load()
    validateState(after, tower.paths.state)
    assert.equal(after.revision, before.revision + 8, 'each successful mutation must bump the revision exactly once')
    // A lost update is silent in the final document (the last writer wins), so
    // the returned revisions are asserted too: the eight successful mutations
    // must have committed exactly the eight consecutive revisions, never the
    // same base revision twice (#F24, #F15).
    const writeRevisions = results.slice(0, writes.length).map((result) => result.value.revision)
    assert.deepEqual(
      [...writeRevisions].sort((a, b) => a - b),
      Array.from({ length: 8 }, (_, index) => before.revision + index + 1),
      `each successful mutation must commit its own revision, got ${writeRevisions.join(',')}`,
    )
    assert.equal(new Set(writeRevisions).size, 8, 'two writers must never apply the same revision')
    for (let index = 0; index < 8; index += 1) {
      const mission = after.missions.find((entry) => entry.id === `M${index + 1}`)
      assert.ok(mission.notes.includes(`parallel note ${index}`), `M${index + 1} lost its concurrent note`)
    }
    assert.ok(after.revision > before.revision)
  } finally {
    removeTemp(root)
  }
})

// #F24: the state lock alone cannot make a state write safe when the record is
// taken away mid-mutation — a late heartbeat can resurrect the old record, so
// the old code's token check passed and its stale document overwrote a
// committed revision. The store fences the document itself: a write may only
// replace the exact bytes this mutation loaded. These two tests force the
// takeover deterministically (no sleeping, no load) and assert the commit that
// actually happened survives.
function lostUpdatePaths(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const paths = pathsFor(path.join(root, '.git'))
  fs.mkdirSync(paths.dir, { recursive: true })
  return { root, paths }
}

test('a takeover followed by a resurrected record cannot lose a committed update (F24)', async () => {
  const { root, paths } = lostUpdatePaths('dsh-tower-lost-update-')
  try {
    const base = JSON.stringify({ revision: 1, marker: 'base' }, null, 2)
    const successorDoc = JSON.stringify({ revision: 2, marker: 'successor' }, null, 2)
    fs.writeFileSync(paths.state, base)

    let refusal = null
    await assert.rejects(
      () =>
        withLock(
          paths,
          async (_paths, held) => {
            // The mutation has loaded revision 1. An operator recovery moves the
            // live record aside (force:true), a successor takes the freed path
            // and commits revision 2, then the first holder's record comes back.
            const recordRaw = fs.readFileSync(paths.lock, 'utf8')
            fs.renameSync(paths.lock, `${paths.lock}.recovered-1`)
            fs.writeFileSync(paths.lock, JSON.stringify(lockRecord('successor-holder')))
            fs.writeFileSync(paths.state, successorDoc)
            fs.writeFileSync(paths.lock, recordRaw)
            // Pretend the takeover interrupted the mutation: this state object
            // is the revision-1 document with revision bumped, as app/mission.js
            // would build it from the load before the takeover.
            await writeStateLocked(paths, { revision: 2, marker: 'first' }, held.token)
          },
          // No heartbeat: the document CAS, not heartbeat health, must catch it.
          { heartbeat: false },
        ),
      (error) => {
        refusal = error
        return error?.code === 'state-locked'
      },
    )
    assert.equal(refusal.details.reason, 'state-lock-lost-update')
    assert.equal(refusal.retryable, true, 're-running the mutation against the committed state succeeds')
    assert.equal(refusal.details.expectedRevision, 1)
    assert.equal(refusal.details.actualRevision, 2)
    assert.equal(fs.readFileSync(paths.state, 'utf8'), successorDoc, 'the committed update must survive byte for byte')
  } finally {
    removeTemp(root)
  }
})

test('a commit that lands during serialisation fails the stale write at the last check (F24)', async () => {
  const { root, paths } = lostUpdatePaths('dsh-tower-lost-update-window-')
  try {
    const base = JSON.stringify({ revision: 1, marker: 'base' }, null, 2)
    const successorDoc = JSON.stringify({ revision: 2, marker: 'successor' }, null, 2)
    fs.writeFileSync(paths.state, base)

    let refusal = null
    await assert.rejects(
      () =>
        withLock(
          paths,
          async (_paths, held) => {
            // A second writer commits between this mutation's load and its
            // rename. The lock record is still ours, so only the document CAS
            // inside the atomic writer's verify hook can see it.
            const stale = {
              revision: 2,
              marker: 'first',
              toJSON() {
                fs.writeFileSync(paths.state, successorDoc)
                return { revision: 2, marker: 'first' }
              },
            }
            await writeStateLocked(paths, stale, held.token)
          },
          { heartbeat: false },
        ),
      (error) => {
        refusal = error
        return error?.code === 'state-locked'
      },
    )
    assert.equal(refusal.details.reason, 'state-lock-lost-update')
    assert.equal(fs.readFileSync(paths.state, 'utf8'), successorDoc, 'state.json must keep the committed document')
    // The refused write leaves no temp file behind.
    assert.deepEqual(
      fs.readdirSync(paths.dir).filter((name) => name.includes('.tmp-')),
      [],
      'a refused write must remove its temp file',
    )
  } finally {
    removeTemp(root)
  }
})

// #F24/R123: the document CAS still ends at a blind rename. A takeover can
// land a complete foreign commit between the last check and the rename, so the
// commit itself is fenced by a short-lived mutex. The fixture pauses A inside
// `writeJsonAtomic` (test seam) after its last check, performs the operator's
// forced state-lock recovery, and lets B commit; only the mutex stops B. No
// timing or machine load is involved.
test('a commit mutex fences the rename window against a forced takeover (F24/R123)', async () => {
  const { root, paths } = lostUpdatePaths('dsh-tower-commit-mutex-')
  const commitLockPath = stateCommitLockPath(paths)
  try {
    fs.writeFileSync(paths.state, JSON.stringify({ revision: 1, workers: { seed: true } }, null, 2))

    let signalPaused = null
    let releaseA = null
    const aPaused = new Promise((resolve) => {
      signalPaused = resolve
    })
    const aGate = new Promise((resolve) => {
      releaseA = resolve
    })
    const aDone = withLock(
      paths,
      async (_paths, held) => {
        const state = JSON.parse(fs.readFileSync(paths.state, 'utf8'))
        state.revision += 1
        state.workers.a = true
        return writeStateLocked(paths, state, held.token, {
          // Pause after the last ownership/base check and before the rename —
          // exactly the window the commit mutex must cover.
          onBeforeRename: async () => {
            signalPaused()
            await aGate
          },
          commitLockTimeoutMs: 250,
        })
      },
      { heartbeatMs: 60000 },
    )
    await aPaused

    // `tower_recover clear-stale-lock force` moves the live state-lock record
    // aside; B then acquires the freed path and loads the same revision.
    fs.renameSync(paths.lock, `${paths.lock}.forced-recovery`)
    let bError = null
    try {
      await withLock(
        paths,
        async (_paths, held) => {
          const state = JSON.parse(fs.readFileSync(paths.state, 'utf8'))
          state.revision += 1
          state.workers.b = true
          await writeStateLocked(paths, state, held.token, { commitLockTimeoutMs: 250 })
        },
        { heartbeatMs: 60000 },
      )
    } catch (error) {
      bError = error
    }

    releaseA()
    await aDone
    // A blocked B is retried; B reloads and applies on top of A. If the mutex
    // were missing, B has already committed here and this retry is skipped:
    // the final assertions below then catch the silently lost update.
    if (bError?.details?.reason === 'state-commit-busy') {
      await withLock(
        paths,
        async (_paths, held) => {
          const state = JSON.parse(fs.readFileSync(paths.state, 'utf8'))
          state.revision += 1
          state.workers.b = true
          await writeStateLocked(paths, state, held.token)
        },
        { heartbeatMs: 60000 },
      )
    }

    const final = JSON.parse(fs.readFileSync(paths.state, 'utf8'))
    assert.equal(
      final.workers?.b,
      true,
      'the mutation B committed while A was inside its rename window must survive A’s later rename',
    )
    assert.deepEqual(final.workers, { seed: true, a: true, b: true })
    assert.equal(final.revision, 3, 'each successful mutation must bump the revision exactly once')

    // B was stopped by the commit mutex, and the error names the in-flight
    // committer so the caller can act on it.
    assert.equal(bError?.code, 'state-locked')
    assert.equal(bError?.details?.reason, 'state-commit-busy')
    assert.equal(bError?.retryable, true)
    assert.equal(bError?.details?.holderPid, process.pid)
    assert.equal(bError?.details?.stateLockPath, paths.lock)
    assert.equal(bError?.details?.waitMs, 250)

    // The mutex is released on every path and leaves no record or temp file.
    assert.equal(fs.existsSync(commitLockPath), false, 'the commit mutex must be released')
    assert.deepEqual(
      fs.readdirSync(paths.dir).filter((name) => name.startsWith('state.commit.lock')),
      [],
      'the commit mutex must not leave a record or a quarantine file behind',
    )
  } finally {
    removeTemp(root)
  }
})

// #F24/R123 P2: bytes that differ from our payload after the rename are not
// automatically a lost update. If the disk revision is *higher*, our commit
// reached the disk and a successor built on it, so a retry would apply the
// mutation twice; only a document that cannot contain our commit is retried.
test('a commit inherited by a successor revision is applied, never retried (R123 P2)', async () => {
  const { root, paths } = lostUpdatePaths('dsh-tower-superseded-')
  try {
    fs.writeFileSync(paths.state, JSON.stringify({ revision: 1, marker: 'base' }, null, 2))
    let successorRaw = null
    let first = null
    let second = null
    await withLock(
      paths,
      async (_paths, held) => {
        first = await writeStateLocked(paths, { revision: 2, marker: 'mine' }, held.token, {
          onAfterRename: async ({ file }) => {
            // A successor commits between our rename and our read-back, on top
            // of the document this mutation just published.
            const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
            doc.revision += 1
            doc.marker = 'successor'
            successorRaw = JSON.stringify(doc, null, 2)
            fs.writeFileSync(file, successorRaw)
          },
        })
        assert.deepEqual(stateLockSuperseded(paths), { revision: 2, landedRevision: 3 })
        // The section chains its next commit from the successor bytes, so a
        // second write replaces exactly what is on disk and succeeds.
        second = await writeStateLocked(paths, { revision: 4, marker: 'after' }, held.token)
      },
      { heartbeat: false },
    )
    assert.equal(first.superseded, true)
    assert.equal(first.revision, 2)
    assert.equal(first.landedRevision, 3)
    assert.equal(second.superseded, false, 'the next commit lands on the successor bytes')
    assert.equal(second.revision, 4)
    assert.equal(JSON.parse(fs.readFileSync(paths.state, 'utf8')).marker, 'after')
    assert.equal(typeof successorRaw, 'string')
  } finally {
    removeTemp(root)
  }
})

test('a commit that lands unchanged is applied exactly once (post-commit classification baseline)', async () => {
  const { root, paths } = lostUpdatePaths('dsh-tower-commit-ok-')
  try {
    fs.writeFileSync(paths.state, JSON.stringify({ revision: 1, marker: 'base' }, null, 2))
    let result = null
    await withLock(
      paths,
      async (_paths, held) => {
        result = await writeStateLocked(paths, { revision: 2, marker: 'mine' }, held.token)
      },
      { heartbeat: false },
    )
    assert.equal(result.superseded, false)
    assert.equal(result.revision, 2)
    assert.equal(result.landedRevision, 2)
    assert.equal(stateLockSuperseded(paths), null)
    assert.equal(JSON.parse(fs.readFileSync(paths.state, 'utf8')).marker, 'mine')
  } finally {
    removeTemp(root)
  }
})

test('a same-revision replacement after the rename is a retryable lost update (R123 P2)', async () => {
  const { root, paths } = lostUpdatePaths('dsh-tower-post-commit-lost-')
  try {
    fs.writeFileSync(paths.state, JSON.stringify({ revision: 1, marker: 'base' }, null, 2))
    let refusal = null
    await assert.rejects(
      () =>
        withLock(
          paths,
          async (_paths, held) => {
            await writeStateLocked(paths, { revision: 2, marker: 'mine' }, held.token, {
              // Same revision, different bytes: the document cannot contain
              // this mutation, so the commit must be retried, not reported.
              onAfterRename: async ({ file }) => {
                fs.writeFileSync(file, JSON.stringify({ revision: 2, marker: 'intruder' }, null, 2))
              },
            })
          },
          { heartbeat: false },
        ),
      (error) => {
        refusal = error
        return error?.code === 'state-locked'
      },
    )
    assert.equal(refusal.details.reason, 'state-lock-lost-update')
    assert.equal(refusal.retryable, true)
    assert.equal(refusal.details.expectedRevision, 2)
    assert.equal(refusal.details.actualRevision, 2)
    assert.equal(JSON.parse(fs.readFileSync(paths.state, 'utf8')).marker, 'intruder')
    assert.equal(fs.existsSync(stateCommitLockPath(paths)), false, 'the commit mutex must be released on the failure path')
  } finally {
    removeTemp(root)
  }
})

test('Tower.withStateLock passes the configured mode.lockTimeoutMs to the state lock', async () => {
  const { root, repo } = seedRepo('dsh-tower-concurrency-lock-budget-')
  try {
    const { defaultDeps } = await import('../adapters/default.js')
    const calls = []
    const deps = {
      ...defaultDeps,
      store: {
        ...defaultDeps.store,
        // Capture the options the app hands to the real lock port. The inner
        // callable runs synchronously so the test measures wiring, not timing.
        withLock: async (paths, fn, options) => {
          calls.push({ paths, options })
          return fn(paths, { token: 'test-token' })
        },
      },
    }
    const repoInfo = await deps.vcs.resolveRepo(repo)
    const defaults = await deps.config.resolveRepoConfig(repoInfo)
    assert.equal(defaults.mode.lockTimeoutMs, 5000, 'schema default is the fallback budget')

    const tower = new Tower(repoInfo, defaults, deps)
    assert.equal(await tower.withStateLock(async (_paths, held) => held.token), 'test-token')
    assert.equal(calls.at(-1).options.timeoutMs, 5000)
    assert.equal(calls.at(-1).paths.lock, tower.paths.lock)

    // The path every tool handler takes: repo config is resolved by Tower.open,
    // so the same key that tunes modes.lock now tunes the state lock too.
    writeRepoConfig(repo, { mode: { lockTimeoutMs: 60000 } })
    const configured = await Tower.open(repo, deps)
    assert.equal(configured.config.mode.lockTimeoutMs, 60000)
    await configured.withStateLock(async () => 'configured')
    assert.equal(calls.at(-1).options.timeoutMs, 60000)

    // A per-call budget still wins, and unrelated options pass through.
    await configured.withStateLock(async () => 'explicit', { timeoutMs: 1234, pollMs: 7 })
    assert.equal(calls.at(-1).options.timeoutMs, 1234)
    assert.equal(calls.at(-1).options.pollMs, 7)
  } finally {
    removeTemp(root)
  }
})

test('reconcileObservedInactive releases a slot as soon as the catalog reports inactive', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    writeRepoConfig(repo, { spawn: { maxLiveWorkers: 1 } })
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    await tools.get('tower_plan').execute(
      { repoRoot: repo, missions: [{ title: 'One', scope: ['one/**'] }, { title: 'Two', scope: ['two/**'] }] },
      exec,
    )
    const tower = await Tower.open(repo)
    await tower.recordSpawn({
      missionId: 'M1', name: 'worker-m1', role: 'worker', agentId: 'agent-inactive-1',
      parentSessionId: 'session-inactive', cwd: null, branch: null,
    })
    const result = await tower.reconcileObservedInactive({ 'agent-inactive-1': 'inactive' })
    assert.deepEqual(result.released, ['worker-m1'])
    const state = await tower.load()
    assert.equal(state.roster.find((entry) => entry.name === 'worker-m1').state, 'inactive')
    const spawned = await tools.get('tower_spawn').execute({ repoRoot: repo, missionId: 'M2', role: 'worker' }, exec)
    assert.equal(spawned.name, 'worker-m2')
  } finally {
    removeTemp(root)
  }
})

test('Tower instances keep independent git timeouts without mutating the process default', async () => {
  const { root, repo } = seedRepo()
  const { configuredGitTimeout } = await import('../adapters/git.js')
  try {
    git(repo, ['init'])
    const first = new Tower({ root: repo, commonDir: path.join(repo, '.git'), branch: 'main' }, { git: { timeoutMs: 1000 } })
    const second = new Tower({ root: repo, commonDir: path.join(repo, '.git'), branch: 'main' }, { git: { timeoutMs: 3000 } })
    assert.equal(first.config.git.timeoutMs, 1000)
    assert.equal(second.config.git.timeoutMs, 3000)
    assert.equal(configuredGitTimeout(), 15000)
  } finally {
    removeTemp(root)
  }
})

test('withGitLock serializes git work without the state lock', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { withGitLock, pathsFor } = await import('../adapters/store.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-gitlock-'))
  const commonDir = path.join(root, '.git')
  try {
    const paths = pathsFor(commonDir)
    paths.dir = path.join(commonDir, 'dsh-tower')
    paths.gitLock = path.join(paths.dir, 'git.lock')
    fs.mkdirSync(paths.dir, { recursive: true })
    const value = await withGitLock(paths, async () => 42)
    assert.equal(value, 42)
    assert.equal(fs.existsSync(paths.gitLock), false)
    fs.writeFileSync(paths.gitLock, JSON.stringify({ pid: 999999, token: 'dead', at: 1 }))
    assert.equal(await withGitLock(paths, async () => 'ok'), 'ok')
  } finally {
    removeTemp(root)
  }
})

test('withGitLock serializes concurrent git mutations', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { withGitLock, pathsFor } = await import('../adapters/store.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-gitlock-serialize-'))
  const commonDir = path.join(root, '.git')
  try {
    const paths = pathsFor(commonDir)
    paths.dir = path.join(commonDir, 'dsh-tower')
    paths.gitLock = path.join(paths.dir, 'git.lock')
    fs.mkdirSync(paths.dir, { recursive: true })
    let active = 0
    let max = 0
    const work = async () => {
      active += 1
      max = Math.max(max, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active -= 1
    }
    await Promise.all([withGitLock(paths, work), withGitLock(paths, work)])
    assert.equal(max, 1)
  } finally {
    removeTemp(root)
  }
})

test('Tower accepts injected adapters instead of importing the defaults', async () => {
  const { Tower } = await import('../host/tower.js')
  const { defaultDeps } = await import('../adapters/default.js')
  let gitCalls = 0
  let readCalls = 0
  const deps = {
    ...defaultDeps,
    vcs: {
      ...defaultDeps.vcs,
      git: async () => {
        gitCalls += 1
        return 'injected\n'
      },
    },
    store: {
      ...defaultDeps.store,
      readJson: async () => {
        readCalls += 1
        throw new Error('injected store used')
      },
    },
  }
  const nodeFs = await import('node:fs')
  const nodePath = await import('node:path')
  const nodeOs = await import('node:os')
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dsh-tower-di-'))
  const commonDir = nodePath.join(root, '.git')
  nodeFs.mkdirSync(nodePath.join(commonDir, 'dsh-tower'), { recursive: true })
  nodeFs.writeFileSync(nodePath.join(commonDir, 'dsh-tower', 'state.json'), '{}')
  try {
    const tower = new Tower({ root, commonDir }, {}, deps)
    assert.equal(await tower.git(root, ['status']), 'injected\n')
    await assert.rejects(() => tower.load(), /injected store used/)
    assert.equal(gitCalls, 1)
    assert.equal(readCalls, 1)
  } finally {
    removeTemp(root)
  }
})
