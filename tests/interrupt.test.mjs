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
import { fileURLToPath } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'

import { parseCordisPatch } from '../domain/component-surface.js'
import { registerTowerTools } from '../host/tool-registry.js'
import { Tower } from '../host/tower.js'
import { configureRuntime } from '../host/config.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The send block the bundled patch applies to the host row, as raw booleans. */
function shippedSendConfig() {
  const patch = parseCordisPatch(fs.readFileSync(path.join(rootDir, 'cordis.patch.yml'), 'utf8'))
  const host = patch.rows.find((row) => row.id === 'tower-host')
  const overrides = new Map((host?.configOverrides ?? []).map((override) => [override.key, override.value]))
  const value = overrides.get('send.interruptDefault')
  return { interruptDefault: value === 'true' }
}

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
    known: new Set(),
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
      state.known.add(childId)
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
      // A stopped child still has a catalog row; only rows are evidence of
      // activity, and an empty list is never proof that a child stopped (#F73).
      const ids = new Set([...state.known, ...state.running])
      return [...ids].map((id) => ({ id, activity: state.running.has(id) ? 'running' : 'inactive' }))
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

    const roster = await call(tools, 'tower_inspect', { view: 'roster', repoRoot: repo })
    const entry = roster.roster.find((candidate) => candidate.agentId === childId)
    assert.equal(entry.state, 'interrupted')
    assert.equal(entry.outcome, 'runaway loop')

    const status = await call(tools, 'tower_inspect', { view: 'status', repoRoot: repo })
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

test('tower_send: the shipped default delivers without interrupting the running recipient (#203)', async () => {
  const { root, repo } = seedRepo('dsh-tower-send-default-')
  const { tools, subagents } = makeCtx()
  try {
    const { name, childId } = await spawnWorker(repo, tools)
    subagents.running.add(childId)
    // The bundled patch is part of the deployment contract: a fresh profile runs
    // with this send block. It must not turn a plain tower_send into an interrupt.
    configureRuntime({ send: shippedSendConfig() })
    try {
      const sent = await call(tools, 'tower_send', {
        repoRoot: repo,
        to: name,
        subject: 'ordinary note',
        body: 'no need to stop',
      })
      assert.equal(subagents.interrupts.length, 0, 'the shipped default must not interrupt a running recipient')
      assert.deepEqual(subagents.order, ['send'], 'the message is delivered without an interrupt call')
      assert.deepEqual(sent.deliveries, [{ target: name, pushed: true, interrupted: false, woke: false }])
    } finally {
      configureRuntime({})
    }
  } finally {
    removeTemp(root)
  }
})

test('tower_send advertises the wake contract without undeclared parameters', () => {
  const { tools } = makeCtx()
  const send = tools.get('tower_send')
  assert.equal(send.parameters.additionalProperties, false)
  assert.deepEqual(Object.keys(send.parameters.properties).sort(), [
    'body',
    'consentRef',
    'interrupt',
    'scope',
    'subject',
    'to',
    'wake',
  ])
  assert.equal(send.parameters.properties.wake.type, 'boolean')
  assert.equal(send.parameters.properties.wake.description.includes('Default false'), true)
  assert.match(send.description, /wake:true/)
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
    assert.deepEqual(sent.deliveries, [{ target: name, pushed: true, interrupted: true, woke: false }])
    const rosterAfterSend = await call(tools, 'tower_inspect', { view: 'roster', repoRoot: repo })
    const interruptedEntry = rosterAfterSend.roster.find((row) => row.agentId === childId)
    assert.equal(interruptedEntry.state, 'interrupted', 'tower_send records the interrupt in the roster')
    assert.match(interruptedEntry.outcome, /tower_send msg-1: stop current work/)

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
      assert.deepEqual(defaulted.deliveries, [{ target: name, pushed: true, interrupted: true, woke: false }])

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

test('tower_send wake:true starts a turn for a stopped agent and reports it', async () => {
  const { root, repo } = seedRepo('dsh-tower-send-wake-')
  const { tools, subagents } = makeCtx()
  try {
    const { name, childId } = await spawnWorker(repo, tools)
    assert.equal(subagents.running.size, 0, 'the spawned child starts idle for this test')

    const sent = await call(tools, 'tower_send', {
      repoRoot: repo,
      to: name,
      subject: 'wake up',
      body: 'there is new work',
      wake: true,
    })
    assert.deepEqual(subagents.order, ['send'], 'wake delivers the persisted message to the idle child')
    assert.equal(subagents.sends.length, 1)
    assert.equal(subagents.sends[0][1], childId)
    assert.deepEqual(sent.deliveries, [{ target: name, pushed: true, interrupted: false, woke: true }])
  } finally {
    removeTemp(root)
  }
})

test('tower_send without wake keeps a stopped agent\'s message queued for its next turn', async () => {
  const { root, repo } = seedRepo('dsh-tower-send-queue-')
  const { tools, subagents } = makeCtx()
  try {
    const { name } = await spawnWorker(repo, tools)
    const sent = await call(tools, 'tower_send', {
      repoRoot: repo,
      to: name,
      subject: 'for later',
      body: 'no need to start now',
    })
    assert.deepEqual(subagents.order, [])
    assert.deepEqual(sent.deliveries, [
      {
        target: name,
        pushed: false,
        interrupted: false,
        woke: false,
        reason:
          "not running; the message is persisted in its inbox for the agent's next turn — pass wake:true to start a turn now",
      },
    ])
  } finally {
    removeTemp(root)
  }
})

test('tower_send wake:true fails honestly when the stopped agent cannot be resumed', async () => {
  const { root, repo } = seedRepo('dsh-tower-send-wake-fail-')
  const { tools, subagents } = makeCtx()
  try {
    const { name } = await spawnWorker(repo, tools)
    subagents.sendMessage = async (...args) => {
      subagents.order.push('send')
      subagents.sends.push(args)
      throw Object.assign(
        new Error(`subagent "child-1" has no supported continuation state and cannot be resumed; choose a different target`),
        { code: 'NOT_RESUMABLE' },
      )
    }

    await assert.rejects(
      () =>
        call(tools, 'tower_send', {
          repoRoot: repo,
          to: name,
          subject: 'wake up',
          body: 'nobody is listening',
          wake: true,
        }),
      (error) => {
        assert.equal(error.code, 'agent-not-resumable', error.message)
        assert.match(error.message, /cannot be resumed/)
        assert.deepEqual(error.details.targets, [name])
        assert.match(error.details.messageId, /^msg-/)
        assert.doesNotMatch(error.nextAction, /omit wake:true/)
        assert.match(error.nextAction, /will not be read until that agent can be resumed/)
        return true
      },
    )
    assert.equal(subagents.sends.length, 1, 'the wake attempt still tried to deliver')
  } finally {
    removeTemp(root)
  }
})

test('tower_send wake:true never claims a wake when the activity catalog is unreadable', async () => {
  const { root, repo } = seedRepo('dsh-tower-send-catalog-error-')
  const { tools, subagents } = makeCtx()
  try {
    const { name } = await spawnWorker(repo, tools)
    subagents.listDescendants = async () => {
      throw new Error('catalog offline')
    }

    const sent = await call(tools, 'tower_send', {
      repoRoot: repo,
      to: name,
      subject: 'wake through an unreadable catalog',
      body: 'the catalog cannot be observed',
      wake: true,
    })
    assert.equal(sent.deliveries.length, 1)
    const [delivery] = sent.deliveries
    assert.equal(delivery.pushed, true, 'the persisted message still reaches sendMessage')
    assert.equal(delivery.woke, false, 'an unreadable catalog must never be treated as stopped')
    assert.match(delivery.reason, /activity catalog unavailable \(catalog offline\)/)
    assert.match(delivery.reason, /cannot verify the recipient is stopped/)
    assert.match(delivery.reason, /no wake is claimed/)
    assert.equal(subagents.sends.length, 1)
  } finally {
    removeTemp(root)
  }
})

test('tower_send treats an empty activity catalog as unknown, never as stopped', async () => {
  const { root, repo } = seedRepo('dsh-tower-send-catalog-empty-wake-')
  const { tools, subagents } = makeCtx()
  try {
    const { name } = await spawnWorker(repo, tools)
    subagents.listDescendants = async () => []

    const sent = await call(tools, 'tower_send', {
      repoRoot: repo,
      to: name,
      subject: 'wake through an empty catalog',
      body: 'the catalog returned no rows',
      wake: true,
    })
    const [delivery] = sent.deliveries
    assert.equal(delivery.pushed, true)
    assert.equal(delivery.woke, false, 'an empty catalog is absence of evidence (#F73), not a stopped agent')
    assert.match(delivery.reason, /returned no descendants/)
    assert.match(delivery.reason, /no wake is claimed/)
    assert.equal(subagents.sends.length, 1)

    // Without wake the same unknown state must not be reported as "not running".
    const queued = await call(tools, 'tower_send', {
      repoRoot: repo,
      to: name,
      subject: 'queue through an empty catalog',
      body: 'no wake requested',
    })
    assert.equal(queued.deliveries[0].pushed, false)
    assert.match(queued.deliveries[0].reason, /activity is unknown/)
    assert.doesNotMatch(queued.deliveries[0].reason, /^not running/)
    assert.equal(subagents.sends.length, 1, 'a no-wake send must not deliver into an unobservable agent')
  } finally {
    removeTemp(root)
  }
})

test('tower_send reports an explicit interrupt when the activity catalog is empty', async () => {
  const { root, repo } = seedRepo('dsh-tower-send-catalog-empty-interrupt-')
  const { tools, subagents } = makeCtx()
  try {
    const { name, childId } = await spawnWorker(repo, tools)
    subagents.listDescendants = async () => []

    const sent = await call(tools, 'tower_send', {
      repoRoot: repo,
      to: name,
      subject: 'stop now',
      body: 'explicit interrupt through an empty catalog',
      interrupt: true,
    })
    const [delivery] = sent.deliveries
    assert.equal(subagents.interrupts.length, 1, 'an explicit interrupt must not be silently skipped')
    assert.equal(subagents.interrupts[0].id, childId)
    assert.equal(delivery.pushed, true)
    assert.equal(delivery.interrupted, true, 'the receipt must report the interrupt that was applied')
    assert.match(delivery.reason, /returned no descendants/)
    assert.match(delivery.reason, /interrupt:true was requested explicitly and was applied/)
  } finally {
    removeTemp(root)
  }
})

test('tower_send wake:true failure never tells the caller to pass wake:true again', async () => {
  const { root, repo } = seedRepo('dsh-tower-send-wake-generic-fail-')
  const { tools, subagents } = makeCtx()
  try {
    const { name } = await spawnWorker(repo, tools)
    subagents.sendMessage = async () => {
      throw new Error('transport exploded')
    }

    const sent = await call(tools, 'tower_send', {
      repoRoot: repo,
      to: name,
      subject: 'wake up',
      body: 'the transport is down',
      wake: true,
    })
    const [delivery] = sent.deliveries
    assert.equal(delivery.pushed, false)
    assert.equal(delivery.woke, false)
    assert.match(delivery.reason, /transport exploded/)
    assert.match(delivery.reason, /wake:true was requested but could not start a turn/)
    assert.doesNotMatch(delivery.reason, /pass wake:true to start a turn now/)
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
