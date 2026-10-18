// Plugin-level tests for the `/tower` command, the mode guard, the dynamic
// prompt section, goal pausing and `tower_control`.
//
// These run the real `apply()` from the package root against a minimal mock
// Cordis context, so they exercise the exact code the Host loads without
// touching the live profile or any running session. Run with:
//   node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Isolate the mode store before importing the plugin: index.js reads it at
// import time. Never write to the operator's real $DSH_HOME from a test.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-plugin-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')
const { loadModes } = await import('../lib/modeStore.js')
const { validateJsonSchema } = await import('./schema-validator.mjs')

function assertSchema(tool, value) {
  const violations = validateJsonSchema(tool.output.schema, value)
  assert.deepEqual(violations, [], `${tool.name}: ${violations.join('; ')}`)
}

function makeCtx(options = {}) {
  const tools = new Map()
  const guards = []
  const sections = []
  const commands = new Map()
  const effects = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    get(name) {
      return name === 'goals' ? options.goals : undefined
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
  return { ctx, tools, guards, sections, commands, effects }
}

function makeAgent(id) {
  const steered = []
  return {
    id,
    steered,
    steer(message) {
      steered.push(message)
    },
  }
}

async function callCommand(commands, agent, rawInput, attachments = []) {
  const definition = commands.get('tower')
  assert.ok(definition, 'the /tower command must be registered')
  return definition.handler({ agent, rawInput, attachments })
}

test('config surface: tools, command descriptor and unknown-key rejection', () => {
  const plain = makeCtx()
  apply(plain.ctx, {})
  assert.ok(plain.tools.has('tower_mode'))
  assert.equal(plain.tools.has('tower_control'), false, 'agent control is off by default')
  const command = plain.commands.get('tower')
  assert.equal(command.input.hint, '[on|off|reload] [message]')
  assert.equal(command.input.attachments, true)

  const controlled = makeCtx()
  apply(controlled.ctx, { allowAgentControl: true })
  assert.ok(controlled.tools.has('tower_control'))

  assert.throws(() => apply(makeCtx().ctx, { allowAgentToggle: true }), /unknown key/i)
})

test('/tower command: every variant, steering and persistence', async () => {
  const { ctx, tools, commands } = makeCtx()
  apply(ctx, {})
  const agent = makeAgent('agent-cmd')

  const bare = await callCommand(commands, agent, '')
  assert.equal(bare.kind, 'success')
  assert.match(bare.text, /Tower mode ON/)
  assert.equal(agent.steered.length, 0, 'bare /tower carries no message')
  assert.equal((await tools.get('tower_mode').execute({}, { agent })).mode, 'on')

  const again = await callCommand(commands, agent, '')
  assert.match(again.text, /remains on/)

  const storeFile = path.join(home, 'tower-mode', 'modes.json')
  assert.ok(fs.existsSync(storeFile), 'mode must be persisted')
  const persisted = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  assert.equal(persisted.modes['agent-cmd'].on, true)
  assert.equal(persisted.modes['agent-cmd'].lastChange.by, 'user')
  assert.ok(loadModes().has('agent-cmd'))

  const onWithMessage = await callCommand(commands, agent, 'on 继续')
  assert.match(onWithMessage.text, /remains on/)
  assert.match(onWithMessage.text, /Carried your instruction: 继续/)
  const steeredMessage = agent.steered.at(-1)
  assert.equal(steeredMessage.role, 'user', 'steer must receive a complete UserMessage')
  assert.match(String(steeredMessage.id), /^[0-9a-f-]{36}$/)
  assert.deepEqual(steeredMessage.content, [{ type: 'text', text: '继续' }])
  assert.deepEqual(steeredMessage.source, { kind: 'user' })

  const plainText = await callCommand(commands, agent, '继续')
  assert.match(plainText.text, /Carried your instruction: 继续/)

  const offWithMessage = await callCommand(commands, agent, 'off 继续')
  assert.match(offWithMessage.text, /Tower mode OFF/)
  assert.match(offWithMessage.text, /Carried your instruction: 继续/)
  assert.equal((await tools.get('tower_mode').execute({}, { agent })).mode, 'off')
  assert.equal(loadModes().has('agent-cmd'), false, 'leaving the mode drops the persisted entry')

  const alreadyOff = await callCommand(commands, agent, 'off')
  assert.match(alreadyOff.text, /already off/)

  // `/tower <anything that is not on/off>` means "ensure on, carry this text".
  const freeText = await callCommand(commands, makeAgent('agent-cmd-free'), '继续实现 P7')
  assert.equal(freeText.kind, 'success')
  assert.match(freeText.text, /Carried your instruction: 继续实现 P7/)

  // Case-insensitive on/off token.
  const upper = await callCommand(commands, makeAgent('agent-cmd-upper'), 'ON 大扫除')
  assert.match(upper.text, /Tower mode ON|remains on/)
  assert.match(upper.text, /大扫除/)
})

test('/tower on with attachments forwards them in order', async () => {
  const { ctx, commands } = makeCtx()
  apply(ctx, {})
  const agent = makeAgent('agent-attach')
  const image = { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }
  const result = await callCommand(commands, agent, '', [image])
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Carried your attachments/)
  const steeredMessage = agent.steered.at(-1)
  assert.equal(steeredMessage.role, 'user')
  assert.match(String(steeredMessage.id), /^[0-9a-f-]{36}$/)
  assert.deepEqual(steeredMessage.content, [image])
  assert.deepEqual(steeredMessage.source, { kind: 'user' })
})

test('regression: forwarded instruction is a complete UserMessage, never role-less', async () => {
  // A role-less `{content, source}` init inserted into the inbox produced the
  // 422 "messages[N]: missing field `role`" corruption on 2026-10-18.
  const { ctx, commands } = makeCtx()
  apply(ctx, {})
  const agent = makeAgent('agent-regression-role')
  await callCommand(commands, agent, '/tower 这是一条测试消息')
  const message = agent.steered.at(-1)
  assert.ok(message, 'the instruction must be forwarded')
  assert.equal(message.role, 'user')
  assert.ok(message.id, 'a complete UserMessage needs an identity')
  assert.ok(Array.isArray(message.content) && message.content.length > 0)
  assert.equal(typeof message.source, 'object')
  assert.equal(message.source.kind, 'user')
})

test('guard: denied tools while active, allowed again after /tower off', async () => {
  const { ctx, guards, commands } = makeCtx()
  apply(ctx, {})
  const guard = guards[0]
  assert.ok(guard, 'the guard must be installed')
  const agent = makeAgent('agent-guard')
  await callCommand(commands, agent, '')

  const denied = ['create_goal', 'todo_write', 'team_task_create', 'team_task_update', 'team_task_reopen', 'spawn_teammate']
  for (const name of denied) {
    const reason = guard({ agent, name, arguments: {} })
    assert.equal(typeof reason, 'string', `${name} must be denied while active`)
    assert.match(reason, /tower mode/)
  }
  assert.match(guard({ agent, name: 'update_goal', arguments: { action: 'resume' } }), /cannot be resumed/)
  assert.equal(guard({ agent, name: 'update_goal', arguments: { action: 'pause' } }), undefined)
  assert.equal(guard({ agent, name: 'tower_plan', arguments: {} }), undefined)
  assert.equal(guard({ agent: makeAgent('someone-else'), name: 'create_goal', arguments: {} }), undefined)

  await callCommand(commands, agent, 'off')
  assert.equal(guard({ agent, name: 'create_goal', arguments: {} }), undefined)
})

test('prompt section is dynamic per agent and mentions agent control when enabled', async () => {
  const plain = makeCtx()
  apply(plain.ctx, {})
  const section = plain.sections[0]
  assert.equal(section.name, 'tower:mode')
  assert.equal(section.order, 15000)
  const agent = makeAgent('agent-section')
  assert.equal(section.text({ agent }), '')
  await callCommand(plain.commands, agent, '')
  assert.match(section.text({ agent }), /Tower mode is active/)
  assert.doesNotMatch(section.text({ agent }), /tower_control/)
  assert.equal(section.text({ agent: makeAgent('other') }), '')

  const controlled = makeCtx()
  apply(controlled.ctx, { allowAgentControl: true })
  const agent2 = makeAgent('agent-section-2')
  await callCommand(controlled.commands, agent2, '')
  assert.match(controlled.sections[0].text({ agent: agent2 }), /tower_control/)
})

test('entering pauses an active goal exactly once', async () => {
  const calls = []
  const goal = { id: 'G1', revision: 2, phase: 'active', objective: 'ship the tower' }
  const goals = {
    get(agent) {
      return agent.id === 'agent-goal' ? goal : undefined
    },
    pause(agent, ref) {
      calls.push({ agent: agent.id, ref })
      return { ...goal, revision: ref.revision + 1, phase: 'paused' }
    },
  }
  const { ctx, tools, commands } = makeCtx({ goals })
  apply(ctx, {})
  const agent = makeAgent('agent-goal')

  const entered = await callCommand(commands, agent, '')
  assert.deepEqual(calls, [{ agent: 'agent-goal', ref: { id: 'G1', revision: 2 } }])
  assert.match(entered.text, /A goal was paused on entry/)
  assert.match(entered.text, /ship the tower/)

  const view = await tools.get('tower_mode').execute({}, { agent })
  assert.equal(view.pausedGoal.id, 'G1')
  assert.equal(view.pausedGoal.revision, 3)
  assert.equal(view.pausedGoal.phase, 'paused')

  await callCommand(commands, agent, 'on')
  assert.equal(calls.length, 1, 're-entering must not pause the same goal twice')
})

test('a goal that is not active is left alone and reported', async () => {
  const calls = []
  const goals = {
    get() {
      return { id: 'G2', revision: 1, phase: 'paused', objective: 'later' }
    },
    pause(_agent, ref) {
      calls.push(ref)
      return { id: 'G2', revision: 2, phase: 'paused', objective: 'later' }
    },
  }
  const { ctx, commands } = makeCtx({ goals })
  apply(ctx, {})
  const result = await callCommand(commands, makeAgent('agent-goal-paused'), '')
  assert.equal(calls.length, 0)
  assert.doesNotMatch(result.text, /A goal was paused on entry/)
  assert.match(result.text, /goal is paused/)
})

test('tower_control is gated by config and requires a reason', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, { allowAgentControl: true })
  const control = tools.get('tower_control')
  assert.ok(control)
  const agent = makeAgent('agent-control')

  await assert.rejects(() => control.execute({ action: 'enter', reason: '   ' }, { agent }), /non-empty reason/)

  const entered = await control.execute({ action: 'enter', reason: 'user asked for orchestration' }, { agent })
  assert.equal(entered.ok, true)
  assert.equal(entered.changed, true)
  assert.equal(entered.mode, 'on')
  assert.equal(entered.changedBy, 'agent')

  const again = await control.execute({ action: 'enter', reason: 'still meant' }, { agent })
  assert.equal(again.changed, false)

  const exited = await control.execute({ action: 'exit', reason: 'task is done' }, { agent })
  assert.equal(exited.changed, true)
  assert.equal(exited.mode, 'off')
  assert.equal((await tools.get('tower_mode').execute({}, { agent })).mode, 'off')

  // The read-only reporter must never fail when the mode is unknown.
  const anonymous = await tools.get('tower_mode').execute({}, { agent: undefined })
  assert.equal(anonymous.mode, 'unknown')
})

test('mode tool outputs satisfy their declared schemas, including null fields', async () => {
  // DSH validates every successful tool value against output.schema, so a
  // nullable field declared as `type: 'object'` would fail in the real runtime.
  const { ctx, tools, commands } = makeCtx()
  apply(ctx, { allowAgentControl: true })
  const agent = makeAgent('agent-schema')
  const modeTool = tools.get('tower_mode')
  const controlTool = tools.get('tower_control')

  const off = await modeTool.execute({}, { agent })
  assertSchema(modeTool, off)
  assert.equal(off.lastChange, null)
  assert.equal(off.pausedGoal, null)

  const anonymous = await modeTool.execute({}, {})
  assertSchema(modeTool, anonymous)
  assert.equal(anonymous.agentId, null)
  assert.equal(anonymous.mode, 'unknown')

  await callCommand(commands, agent, '')
  const on = await modeTool.execute({}, { agent })
  assertSchema(modeTool, on)
  assert.equal(on.mode, 'on')
  assert.equal(typeof on.lastChange, 'object')

  // Entering with no goals service leaves pausedGoal and goalNote null.
  const entered = await controlTool.execute({ action: 'enter', reason: 'schema check' }, { agent })
  assertSchema(controlTool, entered)
  assert.equal(entered.pausedGoal, null)
  assert.equal(entered.goalNote, null)

  const exited = await controlTool.execute({ action: 'exit', reason: 'schema check' }, { agent })
  assertSchema(controlTool, exited)

  const noAgent = await controlTool.execute({ action: 'exit', reason: 'schema check' }, {})
  assertSchema(controlTool, noAgent)
  assert.equal(noAgent.ok, false)
})
