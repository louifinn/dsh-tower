// tower_interrupt and interrupt-before-send delivery: interrupt the exact child
// session, record the roster state, stay idempotent, and never let a non-tower
// actor stop agents.
// Run with: node --test tests/interrupt.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { registerTowerTools } from '../lib/tool-registry.js'
import { Tower } from '../lib/tower.js'
import { configureRuntime } from '../lib/config.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-interrupt-') {
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
 * Fake subagents with a controllable "running" set. Interrupting a child
 * removes it from the running set, like a real interrupted turn going idle.
 */
function fakeSubagents(options = {}) {
  let seq = 0
  const state = {
    running: new Set(),
    activations: [],
    interrupts: [],
    sends: [],
    order: [],
  }
  const service = {
    ...state,
    list: () => ['spawn'],
    async startActivation(input) {
      seq += 1
      const childId = `child-${seq}`
      state.activations.push({ ...input, childId })
      return {
        childId,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }], diagnostic: null }),
      }
    },
    async sendMessage(...args) {
      state.order.push('send')
      state.sends.push(args)
      return { ok: true }
    },
    async listDescendants() {
      return [...state.running].map((id) => ({ id, activity: 'running' }))
    },
  }
  if (options.withInterrupt !== false) {
    service.interrupt = (id, interruptOptions) => {
      state.order.push('interrupt')
      state.interrupts.push({ id, options: interruptOptions })
      state.running.delete(id)
    }
  }
  return service
}

function makeCtx(options = {}) {
  const tools = new Map()
  const subagents = options.subagents ?? fakeSubagents()
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

function call(tools, name, args, agentId = 'tower-agent') {
  const tool = tools.get(name)
  assert.ok(tool, `${name} is registered`)
  return tool.execute(args, { agent: { id: agentId }, signal: undefined })
}

/** Init + plan + spawn one worker; returns its roster name and child id. */
async function spawnWorker(repo, tools) {
  await call(tools, 'tower_init', { repoRoot: repo })
  await call(tools, 'tower_plan', {
    repoRoot: repo,
    missions: [{ title: 'Interrupt case', scope: ['src/**'], tasks: ['work'] }],
  })
  const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId: 'M1', role: 'worker' })
  return { spawned, name: spawned.name, childId: spawned.agentId }
}

/** Init + plan + record a worker directly (no activation, no worktree). */
async function rosterWorker(repo, tools, { name = 'worker-m1', agentId = 'agent-interrupt-worker' } = {}) {
  await call(tools, 'tower_init', { repoRoot: repo })
  await call(tools, 'tower_plan', {
    repoRoot: repo,
    missions: [{ title: 'Interrupt case', scope: ['src/**'], tasks: ['work'] }],
  })
  const tower = await Tower.open(repo)
  await tower.recordSpawn({
    missionId: 'M1',
    name,
    role: 'worker',
    agentId,
    parentSessionId: 'tower-agent',
    cwd: null,
    branch: null,
  })
  return { name, childId: agentId }
}

test('tower_interrupt: interrupts the running child, records the roster and is idempotent', async () => {
  const { root, repo } = seedRepo()
  const { tools, subagents } = makeCtx()
  try {
    const { name, childId } = await spawnWorker(repo, tools)
    subagents.running.add(childId)

    const first = await call(tools, 'tower_interrupt', { repoRoot: repo, to: name, reason: 'runaway loop' })
    assert.equal(first.ok, true)
    assert.equal(first.interrupted, true)
    assert.equal(first.previousActivity, 'running')
    assert.equal(first.entry.state, 'interrupted')
    assert.equal(first.entry.outcome, 'runaway loop')
    assert.equal(subagents.interrupts.length, 1)
    assert.equal(subagents.interrupts[0].id, childId)
    assert.equal(subagents.interrupts[0].options.kind, 'ancestor')
    assert.equal(subagents.interrupts[0].options.agent.id, 'tower-agent')

    const roster = await call(tools, 'tower_roster', { repoRoot: repo })
    const entry = roster.roster.find((candidate) => candidate.agentId === childId)
    assert.equal(entry.state, 'interrupted')
    assert.equal(entry.outcome, 'runaway loop')

    const status = await call(tools, 'tower_status', { repoRoot: repo })
    assert.ok(status.activity.some((line) => /interrupted: runaway loop/.test(line.text ?? '')))

    // Second call: the child is no longer running, so nothing is interrupted.
    const second = await call(tools, 'tower_interrupt', { repoRoot: repo, to: name, reason: 'again' })
    assert.equal(second.interrupted, false)
    assert.match(second.reason, /not running/)
    assert.equal(subagents.interrupts.length, 1, 'an idle agent must not be interrupted twice')
  } finally {
    removeTemp(root)
  }
})

test('tower_send interrupt:true interrupts the running recipient before delivering', async () => {
  const { root, repo } = seedRepo('dsh-tower-interrupt-send-')
  const { tools, subagents } = makeCtx()
  try {
    const { name, childId } = await spawnWorker(repo, tools)
    subagents.running.add(childId)

    const sent = await call(tools, 'tower_send', {
      repoRoot: repo,
      to: name,
      subject: 'stop current work',
      body: 'please switch tasks',
      interrupt: true,
    })
    assert.deepEqual(subagents.order, ['interrupt', 'send'], 'the interrupt must precede the delivery')
    assert.equal(subagents.sends.length, 1)
    assert.equal(subagents.sends[0][1], childId, 'sendMessage must target the child session id')
    const deliveredText = subagents.sends[0][2].map((block) => block.text).join('\n')
    assert.match(deliveredText, /\[tower inbox msg-1\] stop current work/)
    assert.match(deliveredText, /please switch tasks/)
    assert.deepEqual(sent.deliveries, [{ target: name, pushed: true, interrupted: true }])

    // Without interrupt the message is delivered without stopping the turn.
    subagents.running.add(childId)
    await call(tools, 'tower_send', { repoRoot: repo, to: name, subject: 'queued', body: 'next step' })
    assert.deepEqual(subagents.order, ['interrupt', 'send', 'send'])
    assert.equal(subagents.interrupts.length, 1)

    // send.interruptDefault:true makes interrupt the default when omitted...
    configureRuntime({ send: { interruptDefault: true } })
    try {
      subagents.running.add(childId)
      const defaulted = await call(tools, 'tower_send', {
        repoRoot: repo,
        to: name,
        subject: 'default interrupt',
        body: 'stop first',
      })
      assert.deepEqual(subagents.order, ['interrupt', 'send', 'send', 'interrupt', 'send'])
      assert.equal(subagents.interrupts.length, 2)
      assert.deepEqual(defaulted.deliveries, [{ target: name, pushed: true, interrupted: true }])

      // ...and an explicit interrupt:false still wins over the config default.
      subagents.running.add(childId)
      const explicit = await call(tools, 'tower_send', {
        repoRoot: repo,
        to: name,
        subject: 'queue only',
        body: 'no interrupt',
        interrupt: false,
      })
      assert.equal(explicit.deliveries[0].interrupted, false)
      assert.equal(subagents.interrupts.length, 2)
    } finally {
      configureRuntime({})
    }
  } finally {
    removeTemp(root)
  }
})

test('tower_interrupt: tower-only target validation and agentId alias', async () => {
  const { root, repo } = seedRepo('dsh-tower-interrupt-validate-')
  const { tools, subagents } = makeCtx()
  try {
    const { name, childId } = await rosterWorker(repo, tools)

    // A roster worker may not interrupt anyone.
    await assert.rejects(
      () => call(tools, 'tower_interrupt', { repoRoot: repo, to: name }, childId),
      (error) => {
        assert.equal(error.code, 'not-authorized', error.message)
        return true
      },
    )
    assert.equal(subagents.interrupts.length, 0)

    // Unknown or missing targets are argument errors, not internal failures.
    await assert.rejects(
      () => call(tools, 'tower_interrupt', { repoRoot: repo, to: 'ghost' }),
      (error) => {
        assert.equal(error.code, 'invalid-argument', error.message)
        assert.match(error.message, /unknown roster agent "ghost"/)
        return true
      },
    )
    await assert.rejects(
      () => call(tools, 'tower_interrupt', { repoRoot: repo }),
      (error) => {
        assert.equal(error.code, 'invalid-argument', error.message)
        return true
      },
    )

    // The agentId alias resolves the same child.
    subagents.running.add(childId)
    const byId = await call(tools, 'tower_interrupt', { repoRoot: repo, agentId: childId })
    assert.equal(byId.interrupted, true)
    assert.equal(subagents.interrupts.at(-1).id, childId)
  } finally {
    removeTemp(root)
  }
})

test('interrupt fails with spawn-unavailable when the subagents service cannot interrupt', async () => {
  const { root, repo } = seedRepo('dsh-tower-interrupt-unavailable-')
  const { tools } = makeCtx({ subagents: fakeSubagents({ withInterrupt: false }) })
  try {
    const { name } = await rosterWorker(repo, tools)
    await assert.rejects(
      () => call(tools, 'tower_interrupt', { repoRoot: repo, to: name }),
      (error) => {
        assert.equal(error.code, 'spawn-unavailable', error.message)
        return true
      },
    )
  } finally {
    removeTemp(root)
  }
})
