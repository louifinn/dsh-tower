// Mock-runtime tests for `tower_spawn`: the real tools layer against a real
// temporary git repository, with fake `subagents` / `agentPresets` services
// standing in for the Host catalogs. No DSH runtime and no model calls.
//
// The error assertions deliberately use substrings, never exact message starts:
// every Tower tool error is wrapped with a `[tower:<code>] ` prefix, and the
// stable code catalog may grow without breaking these tests.
//
// Run with: node --test tests/spawn.mock.test.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

// index.js reads its mode-store location at import time; isolate it before the
// import so a test never writes to the operator's real $DSH_HOME.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-spawn-home-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')
const { Tower } = await import('../host/tower.js')
const { buildActivationSpec, resolveSpawnProvider, usesNestedActivation } = await import('../app/host-contract.js')
const { validateState } = await import('../domain/state.js')
const { stateShapeError } = await import('../domain/state/schema.js')
const { STALLED_RESERVATION_GRACE_MS } = await import('../app/roster.js')
const { applySpawnOutcome } = await import('../domain/collab/spawn.js')
const { selectAgentActivity } = await import('../domain/read/views.js')

after(() => removeTemp(home))

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
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

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Windows may keep a transient handle on a just-removed git worktree; retry. */
/**
 * Fake `subagents` service. `startActivation` resolves immediately with the
 * shape the real service returns, and every input is recorded so a case can
 * assert provider/preset/request.cwd.
 */
function fakeSubagents(ids = null) {
  const activations = []
  const queue = Array.isArray(ids) ? [...ids] : null
  return {
    activations,
    list: () => ['spawn'],
    async startActivation(input) {
      activations.push(input)
      return {
        childId: queue ? (queue.shift() ?? `child-${activations.length}`) : 'child-1',
        result: Promise.resolve({
          stopReason: 'completed',
          output: [{ type: 'text', text: 'done' }],
          diagnostic: null,
        }),
      }
    },
    async sendMessage() {},
    async listDescendants() {
      return []
    },
  }
}

function fakeAgentPresets(ids = ['tower-worker', 'tower-reviewer']) {
  return {
    list: async () => ids.map((id) => ({ id })),
  }
}

/**
 * DSH 0.2.2-rc.3 `subagents` Service: no `list()`, providers are resolved with
 * `getProvider(name)`, and `startActivation` takes the child request flat. This
 * mirrors the live Service closely enough that sending the old nested shape
 * would leave `parent`/`prompt` undefined, exactly like the real host.
 */
function fakeSubagentsRc3(providers = { spawn: {} }) {
  const activations = []
  return {
    activations,
    getProvider(name) {
      return providers[name]
    },
    async startActivation(input) {
      activations.push(input)
      return {
        childId: 'child-1',
        result: Promise.resolve({
          stopReason: 'completed',
          output: [{ type: 'text', text: 'done' }],
          diagnostic: null,
        }),
      }
    },
    async sendMessage() {},
    async listDescendants() {
      return []
    },
  }
}

/**
 * Minimal Cordis context, mirroring tests/plugin.test.mjs: `effect(fn)` runs the
 * callback immediately and collects its dispose, `tools.register` collects the
 * definitions, and `get(name)` serves the fake services.
 */
function makeHarness(options = {}) {
  const subagents = options.subagents === undefined ? fakeSubagents() : options.subagents
  const agentPresets = options.agentPresets === undefined ? fakeAgentPresets() : options.agentPresets
  const services = { subagents, agentPresets, goals: undefined }
  const tools = new Map()
  const effects = []
  const sections = []
  const guards = []
  const commands = new Map()
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    get(name) {
      return services[name]
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
      guard(fn) {
        guards.push(fn)
        return () => {}
      },
    },
    systemPrompt: {
      section(definition) {
        sections.push(definition)
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => {}
      },
    },
  }
  apply(ctx, {})
  return { ctx, tools, subagents, agentPresets, effects, sections, guards, commands }
}

async function callTool(tools, name, args, exec = {}) {
  const definition = tools.get(name)
  assert.ok(definition, `${name} must be registered`)
  return definition.execute(args, {
    agent: { id: 'tower-agent' },
    signal: undefined,
    ...exec,
  })
}

function spawn(harness, args) {
  return callTool(harness.tools, 'tower_spawn', args)
}

/** Let the fire-and-forget `recordSpawnOutcome` chain settle before cleanup. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 50))
}

/**
 * Restore a spawn row to the F73 shape the sweep detects: the fake activation
 * resolves immediately, so the row is already closed; this reopens it and
 * backdates it past spawn.staleMs. The row's own git facts decide the residue.
 */
async function ageLiveRow(tower, name) {
  const state = await tower.load()
  const live = state.roster.find((entry) => entry.name === name)
  assert.ok(live, `roster row ${name} must exist before it can age`)
  live.state = 'active'
  live.outcome = undefined
  live.outcomeAt = undefined
  live.spawnedAt = Date.now() - 10 * 60_000
  fs.writeFileSync(tower.paths.state, JSON.stringify(state, null, 2))
}

/**
 * Backdate a reservation past the reap grace window, the way the shell of a
 * dispatch that never returned ages. Tests do not wait a real minute.
 */
async function ageReservation(tower, name) {
  const state = await tower.load()
  const row = (state.roster ?? []).find((entry) => entry.name === name)
  assert.ok(row, `reservation ${name} must exist before it can age`)
  row.reservedAt = Date.now() - (STALLED_RESERVATION_GRACE_MS + 1_000)
  fs.writeFileSync(tower.paths.state, JSON.stringify(state, null, 2))
}

async function initAndPlan(repo, missions) {
  const tower = await Tower.open(repo)
  const initialized = await tower.init({ towerAgentId: 'tower-agent' })
  assert.equal(initialized.created, true)
  const planned = await tower.plan({ missions })
  assert.equal(planned.missions[0].id, 'M1')
  return { tower, planned }
}

function assertRejectsWith(promiseFactory, patterns) {
  return assert.rejects(promiseFactory, (error) => {
    const message = String(error?.message ?? error)
    for (const pattern of patterns) assert.match(message, pattern)
    return true
  })
}

test('worker spawn: tower-worker preset, roster entry, worktree and briefing', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-worker-')
  const harness = makeHarness()
  try {
    await initAndPlan(repo, [
      { title: 'Worker case', scope: ['src/**'], tasks: ['write it'] },
    ])

    const report = await spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker' })

    assert.equal(report.role, 'worker')
    assert.equal(report.preset, 'tower-worker')
    assert.equal(report.agentId, 'child-1')
    assert.equal(report.missionId, 'M1')
    assert.equal(report.name, 'worker-m1')
    assert.equal(report.created, true)

    // The activation input is what the Host actually starts the child with.
    assert.equal(harness.subagents.activations.length, 1)
    const activation = harness.subagents.activations[0]
    assert.equal(activation.provider, 'spawn')
    assert.equal(activation.label, 'worker-m1')
    assert.equal(activation.delivery, 'parent')
    assert.equal(activation.request.agentPreset, 'tower-worker')
    assert.equal(activation.request.cwd, report.worktree.path)

    // <repo-parent>/.dsh-tower-worktrees/<hash>/M1 exists and is the cwd.
    const worktreeBase = path.join(root, '.dsh-tower-worktrees')
    assert.ok(fs.existsSync(report.worktree.path), `worktree must exist: ${report.worktree.path}`)
    const canonicalPath = (value) => fs.realpathSync.native(value)
    assert.ok(
      isInside(canonicalPath(worktreeBase), canonicalPath(report.worktree.path)),
      `${report.worktree.path} must be inside ${worktreeBase}`,
    )
    assert.equal(path.resolve(activation.request.cwd), path.resolve(report.worktree.path))
    assert.match(report.worktree.branch, /^tower\/m1-/)

    // The briefing is self-contained: mission id, the real worktree path, tasks.
    const briefing = activation.request.prompt.map((block) => block.text).join('\n')
    assert.ok(briefing.includes('M1'))
    assert.ok(briefing.includes(report.worktree.path))
    assert.match(briefing, /Tower mission M1/)
    assert.match(briefing, /write it/)
    assert.equal(report.briefingChars, briefing.length)
    assert.ok(report.briefingChars > 0)

    // Roster: the tool recorded the worker through the real state store.
    const roster = await callTool(harness.tools, 'tower_inspect', { view: 'roster', repoRoot: repo })
    const entry = roster.roster.find((candidate) => candidate.agentId === 'child-1')
    assert.ok(entry, 'roster must contain the spawned agent')
    assert.equal(entry.name, 'worker-m1')
    assert.equal(entry.role, 'worker')
    assert.equal(entry.missionId, 'M1')
    assert.equal(entry.parentSessionId, 'tower-agent')
    assert.equal(path.resolve(entry.cwd), path.resolve(report.worktree.path))
    assert.equal(entry.branch, report.worktree.branch)

    // Spawning a worker moves the mission from planned to active and sets owner.
    const status = await callTool(harness.tools, 'tower_inspect', { view: 'status', repoRoot: repo })
    const mission = status.missions.find((candidate) => candidate.id === 'M1')
    assert.equal(mission.status, 'active')
    assert.equal(mission.owner, 'worker-m1')

    await settle()
  } finally {
    removeTemp(root)
  }
})

test('worker spawn honors an explicit worktreeRoot argument', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-root-')
  const harness = makeHarness()
  const customRoot = path.join(root, 'custom-worktrees')
  try {
    await initAndPlan(repo, [{ title: 'Custom root case', scope: ['src/**'] }])

    const report = await spawn(harness, {
      repoRoot: repo,
      missionId: 'M1',
      role: 'worker',
      worktreeRoot: customRoot,
    })

    assert.ok(fs.existsSync(report.worktree.path), `worktree must exist: ${report.worktree.path}`)
    const canonicalRoot = (value) => fs.realpathSync.native(value)
    assert.ok(
      isInside(canonicalRoot(customRoot), canonicalRoot(report.worktree.path)),
      `${report.worktree.path} must be inside the configured ${customRoot}`,
    )
    assert.equal(harness.subagents.activations[0].request.cwd, report.worktree.path)

    await settle()
  } finally {
    removeTemp(root)
  }
})

test('reviewer spawn: rejected before completion, tower-reviewer afterwards', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-reviewer-')
  const harness = makeHarness()
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-agent' })
    await tower.plan({
      missions: [{ title: 'Reviewer case', scope: ['src/**'], tasks: ['write the file'] }],
    })

    // Give the mission a real worktree first, so the *status* prerequisite is
    // the one being exercised (a planned mission with no worktree fails earlier).
    const provisioned = await tower.provision({ missionId: 'M1' })
    const wt = provisioned.worktree.path

    await assertRejectsWith(
      () => spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'reviewer' }),
      [/reviewer/i, /completed/i],
    )

    await tower.mission({ id: 'M1', status: 'active' })
    await assertRejectsWith(
      () => spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'reviewer' }),
      [/reviewer/i, /completed/i],
    )
    assert.equal(harness.subagents.activations.length, 0, 'a rejected reviewer must not start an activation')

    // Finish the mission through the real domain: commit in the worktree,
    // record the worker, close every task, then complete.
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'a\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'M1 work'])
    await tower.recordSpawn({
      missionId: 'M1',
      name: 'worker-m1',
      role: 'worker',
      agentId: 'worker-1',
      parentSessionId: 'session-test',
      cwd: wt,
      branch: provisioned.worktree.branch,
    })
    await tower.mission({ id: 'M1', task_done: 'write the file' })
    const completed = await tower.complete({ missionId: 'M1', agentId: 'worker-1', report: 'done' })
    assert.equal(completed.mission.status, 'completed')

    const report = await spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'reviewer' })
    assert.equal(report.role, 'reviewer')
    assert.equal(report.preset, 'tower-reviewer')
    assert.equal(report.agentId, 'child-1')

    assert.equal(harness.subagents.activations.length, 1)
    const activation = harness.subagents.activations[0]
    assert.equal(activation.request.agentPreset, 'tower-reviewer')
    const briefing = activation.request.prompt.map((block) => block.text).join('\n')
    assert.match(briefing, /Tower review/)
    assert.ok(briefing.includes('M1'))
    assert.ok(briefing.includes(report.worktree.path))

    await settle()
  } finally {
    removeTemp(root)
  }
})

test('preset precheck: a missing tower-worker preset rejects with "not registered"', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-preset-')
  const harness = makeHarness({ agentPresets: fakeAgentPresets(['tower-reviewer']) })
  try {
    await initAndPlan(repo, [{ title: 'Preset case', scope: ['src/**'] }])

    await assert.rejects(
      () => spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker' }),
      (error) => {
        const message = String(error?.message ?? error)
        assert.match(message, /not registered/i)
        assert.match(message, /Tower Worker preset/)
        assert.doesNotMatch(message, /tower-worker/, 'user-visible copy must not leak the internal preset id')
        return true
      },
    )
    assert.equal(harness.subagents.activations.length, 0, 'no activation may start when the preset is missing')
  } finally {
    removeTemp(root)
  }
})

test('missing subagents service rejects with "unavailable"', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-unavailable-')
  const harness = makeHarness({ subagents: null })
  try {
    await initAndPlan(repo, [{ title: 'Unavailable case', scope: ['src/**'] }])

    await assertRejectsWith(
      () => spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker' }),
      [/unavailable/i],
    )
  } finally {
    removeTemp(root)
  }
})

test('wait:true returns the child output text and stopReason', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-wait-')
  const harness = makeHarness()
  try {
    const { tower } = await initAndPlan(repo, [{ title: 'Wait case', scope: ['src/**'] }])

    const report = await spawn(harness, {
      repoRoot: repo,
      missionId: 'M1',
      role: 'worker',
      wait: true,
    })

    assert.equal(report.stopReason, 'completed')
    assert.equal(report.output, 'done')
    assert.equal(report.diagnostic, null)
    assert.equal(report.timedOut, undefined)

    // The wait path writes the terminal spawn outcome before it returns.
    const view = await tower.rosterView()
    const entry = view.roster.find((candidate) => candidate.agentId === 'child-1')
    assert.ok(entry, 'the roster entry must exist')
    assert.equal(entry.state, 'inactive')
  } finally {
    removeTemp(root)
  }
})

test('host contract: rc.3 getProvider resolves the spawn provider and the spec is flat', () => {
  const service = { getProvider: (name) => (name === 'spawn' ? { name } : undefined) }
  assert.equal(usesNestedActivation(service), false)
  assert.equal(resolveSpawnProvider(service, { spawn: {} }), 'spawn')

  const parent = { id: 'tower-agent' }
  const signal = { aborted: false }
  const request = {
    cwd: 'C:\\worktrees\\M1',
    agentPreset: 'tower-worker',
    prompt: [{ type: 'text', text: 'briefing' }],
    parent,
    maxDepth: 1,
  }
  const spec = buildActivationSpec(service, {
    provider: 'spawn',
    label: 'worker-m1',
    name: 'worker-m1',
    request,
    signal,
  })
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, 'worker-m1')
  assert.equal(spec.name, 'worker-m1')
  assert.equal(spec.cwd, request.cwd)
  assert.equal(spec.agentPreset, 'tower-worker')
  assert.deepEqual(spec.prompt, request.prompt)
  assert.equal(spec.parent, parent, 'rc.3 requires the exact live parent Agent')
  assert.equal(spec.maxDepth, 1)
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.signal, signal)
  assert.equal('request' in spec, false, 'the flat contract must not nest the request')
})

test('host contract: rc.1/rc.2 list() still receives the nested request', () => {
  const legacy = { list: () => ['custom', 'spawn'] }
  assert.equal(usesNestedActivation(legacy), true)
  assert.equal(resolveSpawnProvider(legacy, { spawn: {} }), 'spawn')
  assert.equal(resolveSpawnProvider({ list: () => ['only'] }, { spawn: {} }), 'only')
  assert.equal(
    resolveSpawnProvider({ list: () => ['spawn'], getProvider: () => ({}) }, { spawn: { provider: 'explicit' } }),
    'explicit',
    'an explicit spawn.provider wins over capability discovery',
  )

  const signal = { aborted: false }
  const request = {
    cwd: 'C:\\worktrees\\M1',
    agentPreset: 'tower-worker',
    prompt: [{ type: 'text', text: 'briefing' }],
    parent: { id: 'tower-agent' },
    maxDepth: 1,
  }
  const spec = buildActivationSpec(legacy, { provider: 'spawn', label: 'worker-m1', request, signal })
  assert.equal(spec.request, request)
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.signal, signal)
  assert.equal('prompt' in spec, false, 'the nested contract keeps the request nested')
})

test('host contract: no provider names spawn.provider and never an unregistered tool', () => {
  for (const service of [{ getProvider: () => undefined }, { list: () => [] }]) {
    assert.throws(
      () => resolveSpawnProvider(service, { spawn: {} }),
      (error) => {
        assert.equal(error.code, 'provider-missing')
        assert.match(error.message, /spawn\.provider/)
        assert.match(error.message, /registered by your Host bundle/i)
        return true
      },
    )
  }
})

test('worker spawn: rc.3 Service without list() starts a flat activation', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-rc3-')
  const subagents = fakeSubagentsRc3()
  const harness = makeHarness({ subagents })
  try {
    await initAndPlan(repo, [{ title: 'rc.3 case', scope: ['src/**'] }])

    const agent = { id: 'tower-agent' }
    const signal = { aborted: false }
    const report = await callTool(
      harness.tools,
      'tower_spawn',
      { repoRoot: repo, missionId: 'M1', role: 'worker' },
      { agent, signal },
    )

    assert.equal(report.agentId, 'child-1')
    assert.equal(report.provider, 'spawn')
    assert.equal(subagents.activations.length, 1)
    const activation = subagents.activations[0]
    assert.equal(activation.provider, 'spawn')
    assert.equal(activation.label, 'worker-m1')
    assert.equal(activation.parent, agent, 'the exact live parent Agent must reach the host')
    assert.equal(activation.cwd, report.worktree.path)
    assert.equal(activation.agentPreset, 'tower-worker')
    assert.equal(activation.delivery, 'parent')
    assert.equal(activation.signal, signal)
    assert.equal('request' in activation, false, 'rc.3 must receive the request flat')
    assert.equal(activation.prompt.length, 1)
    assert.equal(activation.prompt[0].type, 'text')
    assert.match(activation.prompt[0].text, /Tower mission M1/)

    await settle()
  } finally {
    removeTemp(root)
  }
})

// F57: a failed dispatch may leave `{ state: 'reserved', agentId: null }`. No
// child exists behind that row, so it must not count as a live worker forever.
test('F57: a stalled reservation left by a failed dispatch does not wedge the mission', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-f57-')
  // A pending activation result keeps the row `active` while the assertions run:
  // the outcome write is fire-and-forget once the child reports back.
  const subagents = fakeSubagents()
  const start = subagents.startActivation.bind(subagents)
  subagents.startActivation = async (input) => {
    const activation = await start(input)
    return { ...activation, result: new Promise(() => {}) }
  }
  const harness = makeHarness({ subagents })
  try {
    const { tower } = await initAndPlan(repo, [{ title: 'Wedge recovery', scope: ['src/**'] }])
    await tower.reserveRoster({
      missionId: 'M1',
      name: 'worker-m1',
      role: 'worker',
      parentSessionId: 'tower-agent',
    })
    // The failed dispatch happened long enough ago that its name claim is
    // abandoned; a just-written reservation is intentionally left alone.
    await ageReservation(tower, 'worker-m1')

    const report = await spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker' })
    assert.equal(report.agentId, 'child-1')
    // The stale name is already taken by the reservation, so the new worker gets
    // a fresh name; what matters is that it is not blocked.
    assert.match(report.name, /^worker-m1/)

    const state = await tower.load()
    assert.equal(stateShapeError(state), null)
    validateState(state, tower.paths.state)
    assert.equal(state.roster.filter((row) => row.state === 'reserved').length, 0, 'the stalled row is gone')
    assert.equal(state.roster.length, 1)
    assert.equal(state.roster[0].agentId, 'child-1')
    assert.equal(state.roster[0].state, 'active')
    await settle()
  } finally {
    removeTemp(root)
  }
})

// #210/#211: the roster view can be narrowed to one agent and to the last N
// rows instead of always returning the whole roster (once 182 KB).
// #231/#232: a successor spawn must carry what the dead predecessor left
// behind, in the response and in the briefing text — and say nothing at all
// when the predecessor left a clean tree.
test('#231: a successor spawn carries the dead predecessor residue and the briefing names it', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-residue-')
  const harness = makeHarness({ subagents: fakeSubagents(['child-1', 'child-2']) })
  try {
    const { tower } = await initAndPlan(repo, [{ title: 'Residue case', scope: ['src/**'], tasks: ['land it'] }])
    const first = await spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker' })
    assert.equal(first.name, 'worker-m1')

    // The predecessor dies mid-edit: one committed file, one dirty file.
    fs.mkdirSync(path.join(first.worktree.path, 'src'), { recursive: true })
    fs.writeFileSync(path.join(first.worktree.path, 'src', 'a.txt'), 'a\n')
    git(first.worktree.path, ['add', '-A'])
    git(first.worktree.path, ['commit', '-m', 'partial'])
    fs.writeFileSync(path.join(first.worktree.path, 'src', 'b.txt'), 'b\n')

    // The fake activation resolves immediately, so the row would already be
    // closed. Put it back into the exact F73 shape — a live worker whose child
    // stopped answering — age it past spawn.staleMs, and sweep.
    await settle()
    const aged = await tower.load()
    const live = aged.roster.find((entry) => entry.name === 'worker-m1')
    live.state = 'active'
    live.outcome = undefined
    live.outcomeAt = undefined
    live.spawnedAt = Date.now() - 10 * 60_000
    fs.writeFileSync(tower.paths.state, JSON.stringify(aged, null, 2))
    const swept = await tower.sweepRoster({
      staleMs: 30_000,
      activity: { 'agent-unrelated': 'running' },
      authoritative: true,
    })
    assert.deepEqual(swept.marked, ['worker-m1'])

    const successor = await spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker', op: 'takeover' })
    assert.notEqual(successor.name, 'worker-m1')

    // The response carries the predecessor's record.
    assert.ok(successor.rosterEntry?.predecessorResidue, 'the spawn response must carry the predecessor residue')
    assert.equal(successor.rosterEntry.predecessorResidue.name, 'worker-m1')
    assert.equal(successor.rosterEntry.predecessorResidue.filesChanged, 1)
    assert.equal(successor.rosterEntry.predecessorResidue.branch, first.worktree.branch)

    // The briefing says so, with the real count.
    const briefing = harness.subagents.activations.at(-1).request.prompt.map((block) => block.text).join('\n')
    assert.match(briefing, /A previous worker on this mission died before completing/)
    assert.match(briefing, /worker-m1 left 1 file\(s\) changed/)
    assert.ok(briefing.includes(first.worktree.branch), 'the briefing names the branch')
    await settle()
  } finally {
    removeTemp(root)
  }
})

test('#231: a successor spawn says nothing when the predecessor left a clean tree', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-residue-clean-')
  const harness = makeHarness({ subagents: fakeSubagents(['child-1', 'child-2']) })
  try {
    const { tower } = await initAndPlan(repo, [{ title: 'Clean case', scope: ['src/**'] }])
    const first = await spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker' })
    await settle()
    const aged = await tower.load()
    const live = aged.roster.find((entry) => entry.name === 'worker-m1')
    live.state = 'active'
    live.outcome = undefined
    live.outcomeAt = undefined
    live.spawnedAt = Date.now() - 10 * 60_000
    fs.writeFileSync(tower.paths.state, JSON.stringify(aged, null, 2))
    await tower.sweepRoster({ staleMs: 30_000, activity: { 'agent-unrelated': 'running' }, authoritative: true })

    const successor = await spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker', op: 'takeover' })
    assert.equal(successor.rosterEntry?.predecessorResidue, undefined, 'a clean predecessor is not worth a record')
    const briefing = harness.subagents.activations.at(-1).request.prompt.map((block) => block.text).join('\n')
    assert.doesNotMatch(briefing, /A previous worker on this mission died before completing/)
    assert.doesNotMatch(briefing, /file\(s\) changed/)
    await settle()
  } finally {
    removeTemp(root)
  }
})

// R198: the mission record is the most recent worker death, not a museum. A
// dirty death followed by a clean one must not keep describing the first
// worker: the clean successor already resolved what the record warned about.
test('#231: a clean successor death erases the earlier residue record', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-residue-chain-')
  const harness = makeHarness({ subagents: fakeSubagents(['child-1', 'child-2', 'child-3']) })
  try {
    const { tower } = await initAndPlan(repo, [{ title: 'Two deaths', scope: ['src/**'] }])
    const first = await spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker' })
    // First death is dirty: one committed file, one uncommitted file.
    fs.mkdirSync(path.join(first.worktree.path, 'src'), { recursive: true })
    fs.writeFileSync(path.join(first.worktree.path, 'src', 'a.txt'), 'a\n')
    git(first.worktree.path, ['add', '-A'])
    git(first.worktree.path, ['commit', '-m', 'partial'])
    fs.writeFileSync(path.join(first.worktree.path, 'src', 'b.txt'), 'b\n')
    await settle()
    await ageLiveRow(tower, 'worker-m1')
    await tower.sweepRoster({ staleMs: 30_000, activity: { 'agent-unrelated': 'running' }, authoritative: true })
    let state = await tower.load()
    assert.equal(state.missions[0].predecessorResidue.name, 'worker-m1', 'the dirty death is recorded')

    // The successor inherits the sentence, commits everything, then dies clean.
    const second = await spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker', op: 'takeover' })
    assert.equal(second.rosterEntry?.predecessorResidue?.name, 'worker-m1')
    git(second.worktree.path, ['add', '-A'])
    git(second.worktree.path, ['commit', '-m', 'finish the work'])
    await settle()
    await ageLiveRow(tower, second.name)
    const swept = await tower.sweepRoster({ staleMs: 30_000, activity: { 'agent-unrelated': 'running' }, authoritative: true })
    assert.deepEqual(swept.marked, [second.name])
    state = await tower.load()
    assert.equal(state.roster.find((entry) => entry.name === second.name).residue.filesChanged, 0)
    assert.equal(state.missions[0].predecessorResidue, undefined, 'a clean death erases the earlier record')

    // The third spawn hears nothing about the first worker's death.
    const third = await spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker', op: 'takeover' })
    assert.equal(third.rosterEntry?.predecessorResidue, undefined, 'the new successor gets no stale death story')
    const briefing = harness.subagents.activations.at(-1).request.prompt.map((block) => block.text).join('\n')
    assert.doesNotMatch(briefing, /A previous worker on this mission died before completing/)
    assert.doesNotMatch(briefing, /worker-m1 left 1 file\(s\) changed/)
    await settle()
  } finally {
    removeTemp(root)
  }
})

// #231 task 3: the residue is diagnostic detail for the agent-scoped read. It
// must never widen the default roster table or the status page, or a long
// mission makes every listing grow.
test('#231: residue is visible per-agent and absent from the default roster page', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-residue-scope-')
  const harness = makeHarness({ subagents: fakeSubagents(['child-1', 'child-2']) })
  try {
    const { tower } = await initAndPlan(repo, [{ title: 'Scoped residue', scope: ['src/**'] }])
    const first = await spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker' })
    fs.mkdirSync(path.join(first.worktree.path, 'src'), { recursive: true })
    fs.writeFileSync(path.join(first.worktree.path, 'src', 'a.txt'), 'a\n')
    await settle()
    const aged = await tower.load()
    const live = aged.roster.find((entry) => entry.name === 'worker-m1')
    live.state = 'active'
    live.outcome = undefined
    live.outcomeAt = undefined
    live.spawnedAt = Date.now() - 10 * 60_000
    fs.writeFileSync(tower.paths.state, JSON.stringify(aged, null, 2))
    await tower.sweepRoster({ staleMs: 30_000, activity: { 'agent-unrelated': 'running' }, authoritative: true })

    // Per-agent: the record is there.
    const one = await callTool(harness.tools, 'tower_inspect', { view: 'roster', repoRoot: repo, agent: 'worker-m1' })
    assert.ok(one.agent.residue, 'the agent-scoped read reports the residue')
    assert.equal(one.agent.residue.filesChanged, 1)

    // Default roster page: no row carries the field, so the page cannot grow.
    const all = await callTool(harness.tools, 'tower_inspect', { view: 'roster', repoRoot: repo })
    for (const row of all.roster) {
      assert.equal(row.residue, undefined, `default roster row ${row.name} must not carry the residue`)
      assert.equal(row.predecessorResidue, undefined, `default roster row ${row.name} must not carry the carry-over field`)
    }

    // Status page: neither the dashboard nor the agent status view grows.
    const status = await callTool(harness.tools, 'tower_inspect', { view: 'status', repoRoot: repo })
    assert.equal(JSON.stringify(status).includes('filesChanged'), false, 'status must not carry residue counts')

    // `compact` keeps the identity only, as before.
    const compact = await callTool(harness.tools, 'tower_inspect', {
      view: 'roster',
      repoRoot: repo,
      agent: 'worker-m1',
      compact: true,
    })
    assert.equal(compact.agent.residue, undefined, 'compact keeps identity only')
    await settle()
  } finally {
    removeTemp(root)
  }
})

test('roster view: agent selects one row, tail keeps the newest rows', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-roster-projection-')
  const harness = makeHarness()
  try {
    const { tower } = await initAndPlan(repo, [
      { title: 'Projection one', scope: ['src/**'] },
      { title: 'Projection two', scope: ['lib/**'] },
    ])
    const first = await spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker' })
    assert.equal(first.name, 'worker-m1')
    await tower.recordSpawn({
      missionId: 'M2',
      name: 'worker-m2',
      role: 'worker',
      agentId: 'child-2',
      parentSessionId: 'tower-agent',
    })
    // The catalog observed the first agent: the observation timestamp is
    // persisted and shown on the row.
    const observedAt = Date.now()
    await tower.recordRosterObservations({ present: [first.agentId] })

    const all = await callTool(harness.tools, 'tower_inspect', { view: 'roster', repoRoot: repo })
    assert.deepEqual(all.roster.map((row) => row.name), ['worker-m1', 'worker-m2'])
    assert.ok(Number.isFinite(all.roster[0].lastObservedAt), 'observation time is visible')
    assert.ok(all.roster[0].lastObservedAt >= observedAt, 'observation time is the observation clock')

    const one = await callTool(harness.tools, 'tower_inspect', { view: 'roster', repoRoot: repo, agent: 'worker-m2' })
    // #207: a single-agent roster view is the row plus its bounded activity
    // tail, never the roster table.
    assert.equal(one.agent.name, 'worker-m2')
    assert.equal(one.roster, undefined, 'the single-agent view never returns the whole table')
    assert.ok(Array.isArray(one.activity), 'the single-agent view carries the activity tail')
    assert.ok(one.activity.length <= 5, 'the activity tail is bounded')

    const tail = await callTool(harness.tools, 'tower_inspect', { view: 'roster', repoRoot: repo, tail: 1 })
    assert.deepEqual(tail.roster.map((row) => row.name), ['worker-m2'], 'tail keeps the newest roster row')
    await settle()
  } finally {
    removeTemp(root)
  }
})

// R185 P1: attribution matches a roster name/agent id as a whole token, so
// `worker-m1` never inherits a mission-level line about `worker-m10`.
// R186 P2-2: `-` is part of a generated name (`role-mission-suffix`), so
// `worker-m1` must also not match `worker-m1-2` in either direction.
test('roster activity: a name is a whole token, never a prefix', () => {
  const log = [
    { at: 1, type: 'spawn', missionId: 'M1', text: 'reserved worker worker-m10' },
    { at: 2, type: 'spawn', missionId: 'M1', text: 'reserved worker worker-m1' },
    { at: 3, type: 'spawn', missionId: 'M1', text: 'worker-m1 reported completion' },
    { at: 4, type: 'spawn', missionId: 'M1', text: 'worker-m10 reported completion' },
    { at: 5, type: 'spawn', missionId: 'M1', text: 'reserved worker worker-m1-2' },
    { at: 6, type: 'spawn', missionId: 'M1', text: 'worker-m1-2 reported completion' },
  ]
  const one = selectAgentActivity(log, { name: 'worker-m1', agentId: 'child-1', missionId: 'M1' }, 50)
  assert.deepEqual(one.map((entry) => entry.text), ['reserved worker worker-m1', 'worker-m1 reported completion'])
  const ten = selectAgentActivity(log, { name: 'worker-m10', agentId: 'child-10', missionId: 'M1' }, 50)
  assert.deepEqual(ten.map((entry) => entry.text), ['reserved worker worker-m10', 'worker-m10 reported completion'])
  // The suffixed row is a different agent on the same mission: its text-only
  // hits belong to it alone, and the base name does not claim them.
  const suffixed = selectAgentActivity(
    log,
    { name: 'worker-m1-2', agentId: 'child-1-2', missionId: 'M1' },
    50,
  )
  assert.deepEqual(suffixed.map((entry) => entry.text), [
    'reserved worker worker-m1-2',
    'worker-m1-2 reported completion',
  ])
})

// F57 root cause: the failed-spawn cleanup writes `state: 'failed', agentId:
// null`. That is the truthful terminal record, so it must validate — otherwise
// the cleanup is swallowed and the reservation stays `reserved` forever.
test('F57: an activation failure is recorded as a failed row, not a corrupt state', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-f57-fail-')
  const subagents = fakeSubagents()
  const start = subagents.startActivation.bind(subagents)
  let failNext = true
  subagents.startActivation = async (input) => {
    if (failNext) {
      failNext = false
      throw new Error('activation channel closed')
    }
    return start(input)
  }
  const harness = makeHarness({ subagents })
  try {
    const { tower } = await initAndPlan(repo, [{ title: 'Failed dispatch', scope: ['src/**'] }])
    await assertRejectsWith(
      () => spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker' }),
      [/activation channel closed/],
    )

    const failed = await tower.load()
    assert.equal(stateShapeError(failed), null)
    validateState(failed, tower.paths.state)
    const row = failed.roster.find((entry) => entry.name === 'worker-m1')
    assert.equal(row.state, 'failed')
    assert.equal(row.agentId, null)
    assert.match(String(row.outcome), /spawn failed before activation/)
    // #210: the failure reason is a durable diagnostic field, not only the
    // human-readable activity text.
    assert.match(String(row.failureReason), /spawn failed before activation/)
    assert.match(String(row.failureReason), /activation channel closed/)

    // The truthful terminal row releases the mission: a retry spawns at once.
    const report = await spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker' })
    assert.equal(report.agentId, 'child-1')

    // Replacing the failed row overwrites `outcome` with "replaced by ...". The
    // diagnostic must survive: failureReason stays, and the overwritten outcome
    // is preserved as previousOutcome.
    const replaced = await tower.load()
    const retired = replaced.roster.find((entry) => entry.name === 'worker-m1')
    assert.equal(retired.state, 'retired')
    assert.match(String(retired.outcome), /replaced by/)
    assert.match(String(retired.failureReason), /activation channel closed/)
    assert.match(String(retired.previousOutcome), /spawn failed before activation/)
    assert.match(String(retired.previousOutcome), /activation channel closed/)
    await settle()
  } finally {
    removeTemp(root)
  }
})

// #215: spawn is refused on a checkout that is not `state.base`, before any
// provisioning or child activation. The error names both sides and both fixes.
test('spawn refuses a checkout that is not state.base before provisioning', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-base-')
  const harness = makeHarness()
  try {
    const { tower } = await initAndPlan(repo, [{ title: 'Base check', scope: ['src/**'], tasks: ['write it'] }])
    const base = (await tower.load()).base
    git(repo, ['checkout', '-b', 'spawn-side'])

    await assert.rejects(
      () => spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker' }),
      (error) => {
        assert.equal(error.code, 'base-mismatch')
        assert.match(error.message, new RegExp(`state\\.base is "${base}"`))
        assert.match(error.message, /spawn-side/)
        assert.match(error.message, new RegExp(`check out "${base}"`))
        assert.match(error.message, /tower_init/)
        assert.match(error.message, /reanchor:true/)
        return true
      },
    )
    assert.equal(harness.subagents.activations.length, 0, 'no child is started on a mismatched checkout')
  } finally {
    removeTemp(root)
  }
})
// #210: `failureReason` is a diagnostic of the *current* dead attempt. A live
// agent that later reports a non-failed outcome must not keep reporting the
// old failure, while a failed outcome without detail keeps the previous reason.
test('applySpawnOutcome: a non-failed outcome clears the dead-agent diagnostic', () => {
  const now = 1_700_000_000_000
  const entry = { state: 'failed', outcome: 'old', outcomeAt: now - 2000, failureReason: 'activation channel closed' }
  applySpawnOutcome(entry, { state: 'inactive', detail: 'idle' }, now)
  assert.equal(entry.state, 'inactive')
  assert.equal(entry.outcome, 'idle')
  assert.equal(entry.outcomeAt, now)
  assert.equal(Object.hasOwn(entry, 'failureReason'), false, 'a non-failed outcome clears failureReason')

  applySpawnOutcome(entry, { state: 'failed' }, now + 1000)
  assert.equal(entry.failureReason, null, 'a failed outcome without detail records no reason')
  entry.failureReason = 'first reason'
  applySpawnOutcome(entry, { state: 'failed' }, now + 2000)
  assert.equal(entry.failureReason, 'first reason', 'a failed outcome without detail keeps the last reason')
})
