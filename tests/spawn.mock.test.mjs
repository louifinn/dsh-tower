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
function fakeSubagents() {
  const activations = []
  return {
    activations,
    list: () => ['spawn'],
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

    // The truthful terminal row releases the mission: a retry spawns at once.
    const report = await spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker' })
    assert.equal(report.agentId, 'child-1')
    await settle()
  } finally {
    removeTemp(root)
  }
})
