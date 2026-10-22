// Plan-mode / Tower-mode mutual exclusion (2.1).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-plan-mode-'))
process.env.DSH_HOME = TEST_HOME
test.after(() => removeTemp(TEST_HOME))

const { apply } = await import('../index.js')

function makeCtx(modePolicy = 'clear') {
  const tools = new Map()
  const commands = new Map()
  const listeners = new Map()
  const plan = { active: true, pending: false, calls: [] }
  const planMode = {
    get: () => ({ active: plan.active, pending: plan.pending }),
    set: (agent, active) => {
      plan.calls.push({ agent: agent.id, active })
      plan.active = active
      return 'committed'
    },
  }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'planMode') return planMode
      if (name === 'commands') return { register: (definition) => commands.set(definition.name, definition) }
      return undefined
    },
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    tools: {
      register: (definition) => (tools.set(definition.name, definition), () => {}),
      guard: () => () => {},
      restrict() {},
    },
    systemPrompt: { section() {} },
    inject(_deps, callback) {
      callback({ commands: { register: (definition) => commands.set(definition.name, definition) } })
    },
    emit() {},
  }
  return { ctx, tools, commands, listeners, plan }
}

const agent = { id: 'session-plan-test', steer() {}, inject() {} }

test('plan/tower: entering Tower clears an active plan by default', async () => {
  const { ctx, commands, plan } = makeCtx()
  apply(ctx, { mode: { planModePolicy: 'clear' } })
  const reply = await commands.get('tower').handler({ agent, rawInput: 'on', attachments: [] })
  assert.equal(reply.kind, 'success')
  assert.equal(plan.active, false)
  assert.deepEqual(plan.calls.map((call) => call.active), [false])
})

test('plan/tower: planModePolicy refuse rejects Tower entry while plan is active', async () => {
  const { ctx, commands } = makeCtx()
  apply(ctx, { mode: { planModePolicy: 'refuse' } })
  await assert.rejects(
    () => commands.get('tower').handler({ agent, rawInput: 'on', attachments: [] }),
    /plan mode is active/,
  )
})

test('plan/tower: a pre-step clears a plan re-activated while Tower mode is on', async () => {
  const { ctx, commands, listeners, plan } = makeCtx()
  apply(ctx, { mode: { planModePolicy: 'clear' } })
  await commands.get('tower').handler({ agent, rawInput: 'on', attachments: [] })
  plan.active = true
  const listener = listeners.get('agent/pre-step')
  assert.equal(typeof listener, 'function')
  const decision = await listener({ agent }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(plan.active, false)
  assert.equal(decision.kind, 'enter')
})
