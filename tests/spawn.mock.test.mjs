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

// index.js reads its mode-store location at import time; isolate it before the
// import so a test never writes to the operator's real $DSH_HOME.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-spawn-home-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')
const { Tower } = await import('../lib/tower.js')

after(() => fs.rmSync(home, { recursive: true, force: true }))

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
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

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
    assert.ok(
      isInside(worktreeBase, report.worktree.path),
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
    const roster = await callTool(harness.tools, 'tower_roster', { repoRoot: repo })
    const entry = roster.roster.find((candidate) => candidate.agentId === 'child-1')
    assert.ok(entry, 'roster must contain the spawned agent')
    assert.equal(entry.name, 'worker-m1')
    assert.equal(entry.role, 'worker')
    assert.equal(entry.missionId, 'M1')
    assert.equal(entry.parentSessionId, 'tower-agent')
    assert.equal(path.resolve(entry.cwd), path.resolve(report.worktree.path))
    assert.equal(entry.branch, report.worktree.branch)

    // Spawning a worker moves the mission from planned to active and sets owner.
    const status = await callTool(harness.tools, 'tower_status', { repoRoot: repo })
    const mission = status.missions.find((candidate) => candidate.id === 'M1')
    assert.equal(mission.status, 'active')
    assert.equal(mission.owner, 'worker-m1')

    await settle()
  } finally {
    cleanup(root)
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
    assert.ok(
      isInside(customRoot, report.worktree.path),
      `${report.worktree.path} must be inside the configured ${customRoot}`,
    )
    assert.equal(harness.subagents.activations[0].request.cwd, report.worktree.path)

    await settle()
  } finally {
    cleanup(root)
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
    cleanup(root)
  }
})

test('preset precheck: a missing tower-worker preset rejects with "not registered"', async () => {
  const { root, repo } = seedRepo('dsh-tower-spawn-preset-')
  const harness = makeHarness({ agentPresets: fakeAgentPresets(['tower-reviewer']) })
  try {
    await initAndPlan(repo, [{ title: 'Preset case', scope: ['src/**'] }])

    await assertRejectsWith(
      () => spawn(harness, { repoRoot: repo, missionId: 'M1', role: 'worker' }),
      [/not registered/i, /tower-worker/],
    )
    assert.equal(harness.subagents.activations.length, 0, 'no activation may start when the preset is missing')
  } finally {
    cleanup(root)
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
    cleanup(root)
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
    cleanup(root)
  }
})
