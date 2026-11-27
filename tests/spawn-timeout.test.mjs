// #237: a spawn is bounded, cancellable and visible while it runs.
//
// The defect: `tower_spawn` could hang forever *before* writing any state. A
// pre-flight read that never settled (a `listDescendants` on a host that never
// answered) held the call open indefinitely: no roster row, no worktree, no
// activity line, and a mission that stayed `planned` with no trace of why. The
// caller could not tell a stuck spawn from a slow one, and could not cancel it.
//
// These tests pin the properties the fix must have, and each one hangs (or
// fails) against the unbounded implementation:
//   1. the pre-flight is bounded — a read that never settles still fails within
//      the configured deadline, naming the phase it stalled in;
//   2. a queued spawn is bounded — waiting behind a stuck spawn refuses with the
//      queue facts instead of queueing forever;
//   3. the queue is visible — `tower_inspect` status reports depth and the
//      oldest wait while a spawn is running, without waiting for it;
//   4. a cancelled caller aborts the pre-flight instead of waiting it out.
//
// Assertions match substrings only: messages are `[tower:<code>] ` prefixed.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-spawn-timeout-home-'))
process.env.DSH_HOME = home
const { apply } = await import('../index.js')
const { enqueueSpawn, spawnQueueView } = await import('../host/tool-runtime.js')

after(() => removeTemp(home))

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

/** A temp root containing `repo`, seeded with one commit (Tower needs a base). */
function seedRepo(prefix) {
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

/**
 * A subagents service whose catalog read never settles. `hang: 'descendants'`
 * is the observed real-world wedge (#237): the `listDescendants` read for a
 * roster parent never answers, so `observeActivity` never returns. It honors the
 * signal the way a compliant host should, so the cancellation path is real.
 * @param {{ hang?: boolean, descendants?: any[] }} [options]
 */
function stuckSubagents(options = {}) {
  const descendants = options.descendants ?? []
  return {
    list: () => ['spawn'],
    async listDescendants(_parent, signal) {
      if (!options.hang) return descendants
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
      })
    },
    async startActivation() {
      return {
        childId: 'child-new',
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }], diagnostic: null }),
      }
    },
    async sendMessage() {},
    interrupt() {},
  }
}

/** @param {string[]} ids */
function fakeAgentPresets(ids = ['tower-worker', 'tower-reviewer']) {
  return { list: async () => ids.map((id) => ({ id })) }
}

/** @param {{ subagents?: any, agentPresets?: any, hangPresets?: boolean }} [options] */
function makeHarness(options = {}) {
  // #237: a preset catalog that never answers and ignores its caller's signal.
  // This is the read that wedges a spawn *after* it owns the queue slot, which
  // is the only way a second spawn can be genuinely queued behind it: a wedged
  // pre-flight that had not taken the slot would let the second one run.
  const agentPresets = options.hangPresets
    ? { list: () => new Promise(() => {}) }
    : (options.agentPresets ?? fakeAgentPresets())
  const services = {
    subagents: options.subagents,
    agentPresets,
    goals: undefined,
  }
  const tools = new Map()
  /** @type {any} */
  const ctx = {
    effect(fn) {
      const dispose = fn()
      void dispose
      return () => {}
    },
    get(name) {
      return services[name]
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => {}
      },
      guard() {
        return () => {}
      },
    },
    systemPrompt: {
      section() {
        return () => {}
      },
    },
    commands: {
      register() {
        return () => {}
      },
    },
  }
  apply(ctx, {})
  return { ctx, tools, subagents: services.subagents }
}

/** @param {Map<string, any>} tools @param {string} name @param {any} args @param {any} [exec] */
function callTool(tools, name, args, exec = {}) {
  const definition = tools.get(name)
  assert.ok(definition, `tool ${name} is registered`)
  return definition.execute(args, { agent: { id: 'tower-agent' }, signal: undefined, ...exec })
}

/** @param {any} harness @param {any} args @param {any} [exec] */
function spawn(harness, args, exec) {
  return callTool(harness.tools, 'tower_spawn', args, exec)
}

/**
 * Run `factory` with a hard wall clock. A test that would wedge the suite is
 * itself a failure of the property under test, so this rejects instead of
 * relying on `node --test`'s own timeout.
 * @param {() => Promise<any>} factory @param {number} ms
 */
async function within(factory, ms) {
  let timer
  const bound = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms}ms (the call is unbounded)`)), ms)
  })
  try {
    return await Promise.race([factory(), bound])
  } finally {
    clearTimeout(timer)
  }
}

/** @param {string} repo @param {any} value */
function writeRepoConfig(repo, value) {
  const dir = path.join(repo, '.git', 'dsh-tower')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(value, null, 2))
}

/**
 * Plan a one-mission repository with no roster row, so a spawn reaches the
 * queue and the later pre-checks instead of being refused on ownership.
 * @param {string} repo
 */
async function initPlan(repo) {
  const harness = makeHarness()
  await callTool(harness.tools, 'tower_init', { repoRoot: repo })
  await callTool(harness.tools, 'tower_plan', {
    repoRoot: repo,
    missions: [{ title: 'Mission one', scope: ['README.md'], tasks: ['do the thing'] }],
  })
}

/**
 * Plan a one-mission repository, then record one live roster row so a catalog
 * read is on the spawn pre-flight path exactly as in the reported wedge.
 * @param {string} repo
 */
async function initPlanAndSeedLiveRow(repo) {
  const { Tower } = await import('../host/tower.js')
  const harness = makeHarness()
  await callTool(harness.tools, 'tower_init', { repoRoot: repo })
  await callTool(harness.tools, 'tower_plan', {
    repoRoot: repo,
    missions: [{ title: 'Mission one', scope: ['README.md'], tasks: ['do the thing'] }],
  })
  const tower = await Tower.open(repo)
  await tower.recordSpawn({
    missionId: 'M1',
    name: 'worker-live',
    role: 'worker',
    agentId: 'child-live',
    parentSessionId: 'tower-agent',
  })
  return { tower }
}

test('#237: a pre-flight that never settles fails within the deadline instead of hanging', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-timeout-')
  try {
    const { tower } = await initPlanAndSeedLiveRow(repo)
    // The default bound is 30 s; the test configures a short one so the suite
    // stays fast while still proving the value is read from the repository.
    writeRepoConfig(repo, { spawn: { preflightTimeoutMs: 1000 } })
    const stuck = makeHarness({ subagents: stuckSubagents({ hang: true }) })
    const before = await tower.load()
    const startedAt = Date.now()
    const error = await within(
      () => spawn(stuck, { repoRoot: repo, missionId: 'M1', role: 'worker' }).catch((caught) => caught),
      15000,
    )
    const elapsedMs = Date.now() - startedAt
    assert.ok(error instanceof Error, 'the stuck pre-flight rejects instead of hanging')
    assert.match(String(error.message), /spawn-unavailable/)
    assert.match(String(error.message), /spawn\.preflightTimeoutMs/)
    assert.ok(elapsedMs < 15000, `the pre-flight returned in ${elapsedMs}ms`)
    // The failure names the phase that stalled, so a caller can tell "the host
    // never answered" from "the queue never freed".
    assert.equal(error.details?.phase, 'observe')
    assert.ok(Number.isFinite(error.details?.elapsedMs), 'the failure carries how long it burned')
    // Nothing was written: no reservation, no second roster row, same status.
    // (The seeded live row already moved M1 to `active`; what the bound must not
    // do is move it further, or leave a reservation behind.)
    const after = await tower.load()
    assert.deepEqual(after.roster.map((row) => row.name), before.roster.map((row) => row.name), 'the stuck pre-flight writes no roster row')
    assert.equal(after.missions[0].status, before.missions[0].status, 'the stuck pre-flight does not change the mission status')
    assert.equal(after.roster[0].reservedAt ?? null, null, 'the stuck pre-flight leaves no reservation behind')
  } finally {
    removeTemp(root)
  }
})

test('#237: the spawn queue refuses a wait past the deadline with the queue facts', async () => {
  // Unit-level: the guard is the queue itself, so it is proven without racing
  // the outer pre-flight deadline (both read the same configured bound).
  const key = 'dsh-tower-spawn-queue-unit'
  let release
  const blocker = enqueueSpawn(key, () => new Promise((resolve) => {
    release = resolve
  }), { timeoutMs: 60000 })
  const startedAt = Date.now()
  const error = await enqueueSpawn(key, async () => 'never runs', { timeoutMs: 50 }).catch((caught) => caught)
  const waitedMs = Date.now() - startedAt
  assert.ok(error instanceof Error, 'a spawn that outwaited its bound rejects')
  assert.match(String(error.message), /spawn-unavailable/)
  assert.match(String(error.message), /stayed queued/)
  assert.equal(error.details?.phase, 'queue')
  assert.ok(error.details?.waitedMs >= 50, `the failure reports the wait (saw ${error.details?.waitedMs})`)
  assert.equal(error.details?.depth, 2, 'the failure reports the depth it found')
  assert.ok(waitedMs < 5000, 'the refusal is the deadline, not the blocker')
  // The read-only snapshot reports the same facts while the slot is held.
  const busy = spawnQueueView(key)
  assert.equal(busy.depth, 1)
  assert.equal(busy.oldestWaitMs, 0, 'a running spawn is not a wait')
  release('done')
  await blocker.catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(spawnQueueView(key), { depth: 0, oldestWaitMs: 0 }, 'the queue drains')
})

test('#237: a spawn queued behind a stuck spawn refuses instead of waiting forever', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-queue-')
  try {
    // No roster row: an earlier generation of this test seeded a live worker,
    // which made the second spawn fail in `ownership` before it ever reached the
    // queue — the queue phase was unreachable and the test proved nothing.
    await initPlan(repo)
    writeRepoConfig(repo, { spawn: { preflightTimeoutMs: 1000 } })
    // The first spawn wedges *inside* the queue slot: the preset catalog never
    // answers and ignores the caller's signal, so the slot is still held when
    // the second spawn arrives. (The roster reads are healthy on purpose — the
    // queue must be reachable for a reason that is not the roster.)
    const first = spawn(makeHarness({ subagents: stuckSubagents(), hangPresets: true }), {
      repoRoot: repo,
      missionId: 'M1',
      role: 'worker',
    })
    // Wait until the first spawn genuinely owns the slot, so the queueing of the
    // second is a fact and not a race with the first one's own start.
    const holdDeadline = Date.now() + 2000
    while (spawnQueueView(repo).depth < 1 && Date.now() < holdDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(spawnQueueView(repo).depth >= 1, 'the first spawn holds the queue slot')
    const second = spawn(makeHarness({ subagents: stuckSubagents() }), { repoRoot: repo, missionId: 'M1', role: 'worker' })
    const [firstError, secondError] = await within(
      () => Promise.all([first.catch((caught) => caught), second.catch((caught) => caught)]),
      15000,
    )
    // The holder's own deadline expires in the phase that actually stalled.
    assert.ok(firstError instanceof Error, 'the wedged spawn fails instead of hanging')
    assert.match(String(firstError.message), /spawn-unavailable/)
    assert.equal(firstError.details?.phase, 'services')
    // The waiter is refused by the queue, naming the queue and what it cost.
    assert.ok(secondError instanceof Error, 'the queued spawn fails instead of hanging')
    assert.match(String(secondError.message), /spawn-unavailable/)
    assert.equal(secondError.details?.phase, 'queue')
    assert.ok(Number.isFinite(secondError.details?.waitedMs), `the refusal reports a finite wait (saw ${secondError.details?.waitedMs})`)
    assert.ok(secondError.details?.waitedMs > 0, 'the reported wait is a real elapsed time')
    assert.ok(secondError.details?.depth >= 2, `the refusal reports the depth it saw (saw ${secondError.details?.depth})`)
  } finally {
    removeTemp(root)
  }
})

test('#237: tower_inspect status reports the spawn queue while a spawn runs', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-queue-view-')
  try {
    await initPlanAndSeedLiveRow(repo)
    writeRepoConfig(repo, { spawn: { preflightTimeoutMs: 3000 } })
    // Idle repository: the queue is empty and the snapshot is a fact.
    const idle = await callTool(makeHarness().tools, 'tower_inspect', { view: 'status', repoRoot: repo })
    assert.equal(idle.spawn.depth, 0)
    assert.equal(idle.spawn.oldestWaitMs, 0)
    // A spawn is in flight: the dashboard reports the queue without waiting.
    const pending = spawn(makeHarness({ subagents: stuckSubagents({ hang: true }) }), {
      repoRoot: repo,
      missionId: 'M1',
      role: 'worker',
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const busy = await within(
      () => callTool(makeHarness().tools, 'tower_inspect', { view: 'status', repoRoot: repo }),
      5000,
    )
    assert.ok(busy.spawn.depth >= 1, `depth reports the spawn holding the slot (saw ${busy.spawn.depth})`)
    await pending.catch(() => {})
    // The queue drains: a settled spawn leaves no phantom waiter behind.
    const settled = await callTool(makeHarness().tools, 'tower_inspect', { view: 'status', repoRoot: repo })
    assert.equal(settled.spawn.depth, 0, 'a settled spawn leaves the queue empty')
  } finally {
    removeTemp(root)
  }
})

test('#237: a cancelled caller aborts the pre-flight instead of running it to completion', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-cancel-')
  try {
    await initPlanAndSeedLiveRow(repo)
    // A long deadline: only the caller's cancellation can explain a fast return.
    writeRepoConfig(repo, { spawn: { preflightTimeoutMs: 30000 } })
    const controller = new AbortController()
    const pending = spawn(
      makeHarness({ subagents: stuckSubagents({ hang: true }) }),
      { repoRoot: repo, missionId: 'M1', role: 'worker' },
      { signal: controller.signal },
    )
    // Give the pre-flight a moment to reach the stuck read.
    await new Promise((resolve) => setTimeout(resolve, 100))
    const startedAt = Date.now()
    controller.abort(new Error('caller went away'))
    const error = await within(() => pending.catch((caught) => caught), 5000)
    assert.ok(error instanceof Error, 'the cancelled pre-flight rejects')
    assert.match(String(error.message), /cancelled/)
    assert.ok(Date.now() - startedAt < 5000, 'cancellation does not wait for the deadline')
  } finally {
    removeTemp(root)
  }
})

test('#237: a duck-typed exec signal without addEventListener still runs, and still cancels', async () => {
  // The host and the mock suite drive the tool with `{ aborted }` rather than a
  // real AbortSignal. Reading the listener API unconditionally turned that shape
  // into `tool-internal: signal.addEventListener is not a function` — a fresh
  // regression that was worse than the hang being fixed.
  const { withSpawnDeadline } = await import('../app/spawn-support.js')
  /** @type {{ aborted: boolean }} */
  const stub = { aborted: false }
  /** @type {string[]} */
  const phases = []
  const value = await withSpawnDeadline({
    timeoutMs: 5000,
    signal: /** @type {any} */ (stub),
    phase: 'pending',
    onPhase: (phase) => phases.push(phase),
    run: async ({ signal, reach }) => {
      reach('open')
      // The pre-flight runs to completion: no listener API, no throw.
      assert.equal(signal.aborted, false)
      return 'ran'
    },
  })
  assert.equal(value, 'ran', 'a stub signal does not stop the pre-flight running')
  assert.deepEqual(phases, ['open'])

  // A stub that reports itself aborted is honoured before any read runs.
  /** @type {string[]} */
  const ran = []
  const error = await withSpawnDeadline({
    timeoutMs: 5000,
    signal: /** @type {any} */ ({ aborted: true, reason: new Error('gone') }),
    phase: 'pending',
    run: async () => {
      ran.push('ran')
      return 'unreachable'
    },
  }).catch((caught) => caught)
  assert.deepEqual(ran, [], 'an already-cancelled caller starts nothing')
  assert.match(String(error.message), /cancelled/)
  assert.equal(error.details?.phase, 'pending')
})

/**
 * A subagents service whose activation request never answers until its signal
 * aborts. `assertLive` cannot help here — the deadline has to reach *through*
 * the in-flight request — so this is the shape that proves a refusal rolls the
 * reservation back rather than leaving a row no worker owns.
 * @param {{ childId?: string }} [options]
 */
function activationHangSubagents(options = {}) {
  const childId = options.childId ?? 'child-late'
  return {
    list: () => ['spawn'],
    async listDescendants() {
      return []
    },
    async startActivation(spec) {
      return await new Promise((_resolve, reject) => {
        const signal = spec?.signal
        // A host that ignores the signal must not hang the suite: the test's own
        // `within` bound is the backstop, but honoring the abort is the contract.
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('activated too late')), { once: true })
      })
    },
    async sendMessage() {},
    interrupt() {},
  }
}

test('#237 R2 P1: a deadline that expires during activation starts no child and leaves no reservation behind', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-activate-refusal-')
  try {
    await initPlan(repo)
    // The bound has to outlast provisioning (a real `git worktree add`) and
    // expire inside the activation request, which is the window that used to
    // leave a `reserved` row plus a recorded worktree for a spawn that failed.
    writeRepoConfig(repo, { spawn: { preflightTimeoutMs: 1500 } })
    const { Tower } = await import('../host/tower.js')
    const harness = makeHarness({ subagents: activationHangSubagents() })
    const error = await within(
      () => spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker' }).catch((caught) => caught),
      20000,
    )
    assert.ok(error instanceof Error, 'the refused spawn rejects instead of hanging')
    assert.match(String(error.message), /spawn-unavailable/)
    assert.match(String(error.message), /spawn\.preflightTimeoutMs/)
    // The failure names the step the call was in when the deadline fired.
    assert.equal(error.details?.phase, 'activate', `the refusal names the activation (saw ${error.details?.phase})`)
    // ...and the rollback is a reported fact, not a promise in the prose (#237 R2 P1).
    assert.ok(error.details?.rollback, 'the refusal carries what the pre-flight released')
    assert.equal(error.details.rollback.reservation, 'released', 'the reservation this call wrote is gone')
    assert.equal(error.details.rollback.worktree, 'removed', 'the worktree it created is gone')

    const tower = await Tower.open(repo)
    const after = await tower.load()
    assert.deepEqual(
      after.roster.filter((row) => row.name === 'worker-m1'),
      [],
      'no roster row survives a spawn that never activated',
    )
    const mission = after.missions.find((entry) => entry.id === 'M1')
    assert.equal(mission.status, 'planned', 'the mission keeps its planned status')
    assert.equal(mission.worktree ?? null, null, 'the mission no longer records a worktree')
    // The checkout is gone from git too, not merely from state: a leftover
    // registration would make the honest retry fail with "worktree path already
    // exists" even though the tower forgot about it.
    const listed = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    assert.doesNotMatch(listed, /worktrees/, 'the created checkout is unregistered from git')
  } finally {
    removeTemp(root)
  }
})

test('#237 R2 P1: a deadline that expires during the reservation releases the row it wrote', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-reserve-refusal-')
  try {
    await initPlan(repo)
    writeRepoConfig(repo, { spawn: { preflightTimeoutMs: 1200 } })
    // The tool opens its own tower through `host/tool-runtime.js`, which imports
    // the base class from `app/tower.js` directly — patching the host subclass
    // would never reach it. Patching the base prototype is the only seam that
    // lets the real reservation land and still stall inside the phase, which is
    // the shape of a slow state lock or filesystem.
    const { Tower: InjectedTower } = await import('../app/tower.js')
    const { Tower } = await import('../host/tower.js')
    const original = InjectedTower.prototype.reserveRoster
    InjectedTower.prototype.reserveRoster = async function slowReservation(input) {
      const reserved = await original.call(this, input)
      // Outlive the bound (the schema floor is 1000ms), then let the pre-flight
      // continue so its own guard is what refuses — the row is real, the phase is
      // merely late.
      await new Promise((resolve) => setTimeout(resolve, 1800))
      return reserved
    }
    try {
      const harness = makeHarness({ subagents: stuckSubagents() })
      const error = await within(
        () => spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker' }).catch((caught) => caught),
        20000,
      )
      assert.ok(error instanceof Error, 'the refused spawn rejects instead of hanging')
      assert.match(String(error.message), /spawn-unavailable/)
      // The phase named is where the timer fired, even though the run advanced
      // one step further before it could be stopped: that is the stall point.
      assert.equal(error.details?.phase, 'reserve', `the refusal names the reservation (saw ${error.details?.phase})`)
      assert.ok(error.details?.rollback, 'the refusal carries what the pre-flight released')
      assert.equal(error.details.rollback.reservation, 'released', 'the reservation the phase wrote is released')

      const tower = await Tower.open(repo)
      const after = await tower.load()
      assert.deepEqual(
        after.roster.filter((row) => row.name === 'worker-m1'),
        [],
        'no roster row survives the refused reservation',
      )
      const mission = after.missions.find((entry) => entry.id === 'M1')
      assert.equal(mission.status, 'planned', 'the mission keeps its planned status')
      assert.equal(mission.worktree ?? null, null, 'the mission records no worktree')
    } finally {
      InjectedTower.prototype.reserveRoster = original
    }
  } finally {
    removeTemp(root)
  }
})

test('#237: the pre-flight phase list is frozen, small and used verbatim', async () => {
  const { SPAWN_PREFLIGHT_PHASES, SPAWN_PHASE_PENDING, isSpawnPreflightPhase } = await import('../app/spawn-support.js')
  assert.deepEqual([...SPAWN_PREFLIGHT_PHASES], [
    'queue', 'open', 'resolve', 'observe', 'roster', 'ownership',
    'services', 'provision', 'discovery', 'reserve', 'activate', 'record',
  ])
  assert.equal(SPAWN_PHASE_PENDING, 'pending')
  assert.ok(!isSpawnPreflightPhase(SPAWN_PHASE_PENDING), 'the pending marker is not a phase')
  assert.ok(!isSpawnPreflightPhase('nonsense'))
})
