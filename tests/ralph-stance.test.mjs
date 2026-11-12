// Tower / Ralph mutual exclusion (#162): the command surface, entry
// reconciliation with a live loop, the round-agent refusal, the command-owner
// table and tower_doctor's environment fact.
//
// These run the real `apply()` against a minimal mock Cordis context and a
// throwaway git repository, and drive the sensor through the same listeners
// the host installs (workflow meta + the `subagent/catalog` session events
// both Ralph implementations emit), which is what a stub loop stands in for.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { removeTemp } from './helpers/cleanup.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-ralph-'))
process.env.DSH_HOME = home
test.after(() => removeTemp(home))

const { apply } = await import('../index.js')
const { DEFAULT_DENY_TOOLS } = await import('../domain/config/schema.js')
const { defaultDenyTools } = await import('../domain/deny-owners.js')
const { COMMAND_OWNERS, stanceDenyCommands } = await import('../domain/config/command-owners.js')
const { __testResetRalphSensor } = await import('../host/ralph-stance.js')

function makeCtx() {
  const tools = new Map()
  const guards = []
  const commands = new Map()
  const listeners = new Map()
  const effects = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    get(name) {
      if (name === 'planMode') {
        return { get: () => ({ active: false, pending: false }), set: () => 'committed' }
      }
      return undefined
    },
    provide() {},
    inject(_deps, callback) {
      callback({ commands: { register: (definition) => commands.set(definition.name, definition) } })
    },
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
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
    systemPrompt: { section() {} },
  }
  return { ctx, tools, guards, commands, listeners, effects }
}

/**
 * A fake live agent. `scoped` simulates the agent's own context: registrations
 * through it model the per-agent command shadowing the real DSH commands
 * service performs for `agent.ctx` registrations.
 */
function makeAgent(id, cwd = null) {
  const scopedCommands = new Map()
  const steered = []
  const agent = {
    id,
    ...(cwd ? { session: { header: { cwd } } } : {}),
    steer(message) {
      steered.push(message)
    },
    ctx: {
      inject(_deps, callback) {
        return callback({
          commands: {
            register: (definition) => {
              scopedCommands.set(definition.name, definition)
              return () => scopedCommands.delete(definition.name)
            },
          },
        })
      },
    },
  }
  return { agent, steered, scopedCommands }
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-ralph-repo-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  const run = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  run(['init'])
  run(['config', 'user.email', 'tower@test'])
  run(['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  run(['add', '-A'])
  run(['commit', '-m', 'seed'])
  return { root, repo }
}

async function callCommand(commands, agent, rawInput) {
  const definition = commands.get('tower')
  assert.ok(definition, 'the /tower command must be registered')
  return definition.handler({ agent, rawInput, attachments: [] })
}

/** Seed the sensor the way a live Ralph loop does: one accepted round child. */
function seedStubLoop(listeners, repo, { label = 'ralph #1 implement-login', childId = 'ralph-child-1', parent = 'ralph-parent-session' } = {}) {
  const handler = listeners.get('session/event')
  assert.ok(handler, 'the sensor must observe session events')
  handler({ id: parent, header: { cwd: repo } }, { type: 'subagent/catalog', data: { version: 0, childId, childCreatedAt: Date.now(), mode: 'one-shot', label } })
}

test.beforeEach(() => __testResetRalphSensor())

test('stance owners: tools stay #161-owned, commands come from the command table', () => {
  // #162 keeps no second tool list: the guard's default is #161's owner-derived
  // union (re-exported by the config schema), including the first-party ralph
  // tool. A renamed tool is covered by the loop sensor, not by this table.
  assert.deepEqual(DEFAULT_DENY_TOOLS, defaultDenyTools())
  assert.ok(DEFAULT_DENY_TOOLS.includes('ralph'))
  for (const owner of COMMAND_OWNERS) {
    assert.ok(owner.owner.length > 0, 'every row names its owning package')
    assert.ok(owner.stance.length > 0, 'every row names its stance')
    assert.ok(owner.commands.length > 0, `owner ${owner.owner} registers at least one command`)
    for (const name of owner.commands) assert.ok(typeof name === 'string' && name.length > 0)
  }
  assert.deepEqual(stanceDenyCommands(), ['ralph'])
  assert.equal(COMMAND_OWNERS.filter((owner) => owner.stance === 'ralph-loop').length, 1, 'the command surface of the Ralph stance has one owner')
  assert.equal('tools' in COMMAND_OWNERS[0], false, 'this table never duplicates the tool deny surface')
})

test('guard: the Ralph tool names are denied while Tower mode is active (D4)', async () => {
  const { ctx, guards, commands } = makeCtx()
  apply(ctx, {})
  const guard = guards[0]
  assert.ok(guard, 'the guard must be installed')
  const { agent } = makeAgent('agent-ralph-guard')
  await callCommand(commands, agent, 'on')
  // Tool denial itself is #161's contract (tests/deny-surface.test.mjs); this
  // asserts the #162 layers sit on top of the same live guard.
  for (const name of ['ralph', 'workflow']) {
    assert.match(guard({ agent, name, arguments: {} }), new RegExp(`tower mode: ${name} is disabled`))
  }
  await callCommand(commands, agent, 'off')
  assert.equal(guard({ agent, name: 'ralph', arguments: {} }), undefined)
})

test('commands: /ralph is refused with an actionable message while Tower mode is active (D1)', async () => {
  const { ctx, commands } = makeCtx()
  apply(ctx, {})
  const { agent, scopedCommands } = makeAgent('agent-ralph-command')
  await callCommand(commands, agent, 'on')
  const shadow = scopedCommands.get('ralph')
  assert.ok(shadow, 'the command-owner name is shadowed for the towered agent')
  const reply = shadow.handler({ agent, rawInput: '5', attachments: [] })
  assert.equal(reply.kind, 'error')
  assert.match(reply.text, /Tower mode is active/)
  assert.match(reply.text, /\/tower off/)
  // Mode off restores the surface: the shadow is unmounted.
  await callCommand(commands, agent, 'off')
  assert.equal(scopedCommands.size, 0)
})

test('commands: the shadow is re-mounted by the pre-step listener after a restart (D1)', async () => {
  const { ctx, commands, listeners } = makeCtx()
  apply(ctx, {})
  const { agent, scopedCommands } = makeAgent('agent-ralph-remount')
  await callCommand(commands, agent, 'on')
  // A process restart loses the mounted guard; the mode entry survives on
  // disk. Simulate by dropping the mounted guard and taking one more step.
  __testResetRalphSensor()
  assert.equal(scopedCommands.size, 0)
  const preStep = listeners.get('agent/pre-step')
  await preStep({ agent }, async () => ({ kind: 'enter', messages: [] }))
  assert.ok(scopedCommands.get('ralph'), 'the pre-step listener re-mounts the refusal')
  await callCommand(commands, agent, 'off')
  assert.equal(scopedCommands.size, 0)
})

test('entry: mode.ralphPolicy refuse rejects /tower on while a stub loop is live (D3)', async () => {
  const { ctx, commands, listeners } = makeCtx()
  apply(ctx, { mode: { ralphPolicy: 'refuse' } })
  const { repo } = makeRepo()
  const { agent } = makeAgent('agent-ralph-refuse', repo)
  seedStubLoop(listeners, repo)
  await assert.rejects(
    () => callCommand(commands, agent, 'on'),
    /a Ralph loop is live in this repository.*ralph #1/,
  )
})

test('entry: the default policy stops the loop and records the release in the activity log (D2)', async () => {
  const { ctx, tools, commands, listeners } = makeCtx()
  apply(ctx, {})
  const { repo } = makeRepo()
  const { agent } = makeAgent('agent-ralph-stop', repo)
  // The repository needs state before the activity log exists.
  await callCommand(commands, agent, 'on')
  await tools.get('tower_init').execute({ repoRoot: repo }, { agent })
  await callCommand(commands, agent, 'off')
  const activityFile = path.join(repo, '.git', 'dsh-tower', 'activity.jsonl')
  fs.rmSync(activityFile, { force: true })

  seedStubLoop(listeners, repo)
  const reply = await callCommand(commands, agent, 'on')
  assert.equal(reply.kind, 'success')
  assert.match(reply.text, /A live Ralph loop was released on entry/)
  const lines = fs.readFileSync(activityFile, 'utf8').trim().split('\n')
  const release = lines.map((line) => JSON.parse(line)).find((entry) => entry.type === 'mode')
  assert.ok(release, 'the release is recorded in the activity log')
  assert.match(release.text, /released a live Ralph loop on Tower entry/)
})

test('rounds: a Ralph round agent is refused while its repository is under Tower mode (criterion 5)', async () => {
  const { ctx, commands, listeners } = makeCtx()
  apply(ctx, {})
  const { repo } = makeRepo()
  const { agent } = makeAgent('agent-ralph-rounds', repo)
  seedStubLoop(listeners, repo, { childId: 'ralph-round-agent', label: 'ralph #2 polish-ui' })
  const roundAgent = { id: 'ralph-round-agent', session: { header: { cwd: repo } } }
  const preStep = listeners.get('agent/pre-step')
  const next = async () => ({ kind: 'enter', messages: [] })

  // Before the tower exists the round runs.
  assert.equal((await preStep({ agent: roundAgent }, next)).kind, 'enter')
  await callCommand(commands, agent, 'on')
  // The towered session's own steps are untouched…
  assert.equal((await preStep({ agent }, next)).kind, 'enter')
  // …while the round agent of the same repository is refused.
  const rejection = await preStep({ agent: roundAgent }, next)
  assert.deepEqual(rejection, { kind: 'reject' })
  // An unrelated workspace is untouched.
  const elsewhere = { id: 'ralph-round-elsewhere', session: { header: { cwd: path.join(repo, '..', 'other') } } }
  seedStubLoop(listeners, path.join(repo, '..', 'other'), { childId: 'ralph-round-elsewhere', label: 'ralph #1 other-repo' })
  assert.equal((await preStep({ agent: elsewhere }, next)).kind, 'enter')
  // Mode off ends the refusal.
  await callCommand(commands, agent, 'off')
  assert.equal((await preStep({ agent: roundAgent }, next)).kind, 'enter')
})

test('rounds: a renamed Ralph entry point cannot restart a loop under a live tower (D4)', async () => {
  // The stub loop renamed everything a name list could see: the tool and the
  // command are gone; only the round labels (not configurable in either
  // implementation) identify the stance.
  const { ctx, commands, listeners } = makeCtx()
  apply(ctx, {})
  const { repo } = makeRepo()
  const { agent } = makeAgent('agent-ralph-renamed', repo)
  await callCommand(commands, agent, 'on')
  seedStubLoop(listeners, repo, { childId: 'renamed-round-agent', label: 'ralph #1 renamed-entry' })
  const roundAgent = { id: 'renamed-round-agent', session: { header: { cwd: repo } } }
  const preStep = listeners.get('agent/pre-step')
  const decision = await preStep({ agent: roundAgent }, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(decision, { kind: 'reject' })
  await callCommand(commands, agent, 'off')
})

test('doctor: a live loop in this repository is an environment fact (D5)', async () => {
  const { ctx, tools, commands, listeners } = makeCtx()
  apply(ctx, {})
  const { repo } = makeRepo()
  const { agent } = makeAgent('agent-ralph-doctor', repo)
  const before = await tools.get('tower_doctor').execute({ repoRoot: repo }, { agent })
  assert.equal(before.environmentContract.ralphLoop.scopedRounds, 0)
  assert.ok(before.checks.some((item) => item.id === 'ralph-stance' && item.status === 'pass'))

  seedStubLoop(listeners, repo)
  const after = await tools.get('tower_doctor').execute({ repoRoot: repo }, { agent })
  const fact = after.environmentContract.ralphLoop
  assert.equal(fact.scopedRounds, 1)
  assert.match(fact.detail, /ralph #1/)
  const check = after.checks.find((item) => item.id === 'ralph-stance')
  assert.equal(check.status, 'warn')
  assert.match(check.detail, /Tower cannot co-own/)
})

test('tower_mode: reports the Ralph policy and the live-loop facts', async () => {
  const { ctx, tools, commands } = makeCtx()
  apply(ctx, {})
  const { agent } = makeAgent('agent-ralph-mode')
  await callCommand(commands, agent, 'on')
  const report = await tools.get('tower_mode').execute({}, { agent })
  assert.equal(report.ralph.policy, 'stop')
  assert.equal(report.ralph.rounds, 0)
  await callCommand(commands, agent, 'off')
})
