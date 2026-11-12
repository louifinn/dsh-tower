// #160: the read-only `/tasks` roster command (and its `/tower tasks` alias).
//
// The panel answers the cheapest human question — which roster agents are
// live, what did they last do, how long have they been silent — without a
// model turn and without a single write. These tests pin:
//
// - D1: `/tasks` is registered only when the host profile has no other
//   `tasks` command; the descriptions name which surface was claimed;
// - D2: one line per live roster entry (mission, role, name, branch, state,
//   silence, last recorded event), sorted by silence, bounded, with the
//   counts + `tower_interrupt` footer;
// - the stale flag comes from the same spawn.staleMs rule tower_roster uses
//   (flip the config, both views follow);
// - D3/zero-write: the handler writes neither state.json nor the activity
//   log nor the mode store, and never touches Tower mode.
//
// Run with: node --test tests/tasks-command.test.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

// index.js reads its mode-store location at import time; isolate it before the
// import so a test never writes to the operator's real $DSH_HOME.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-tasks-home-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')
const { Tower } = await import('../host/tower.js')

after(() => removeTemp(home))

const MINUTE = 60_000

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

/**
 * Fake `subagents` service: activations never settle (a live worker stays
 * live), and `listDescendants` returns only the catalog rows a case injects.
 */
function fakeSubagents(rows = []) {
  let sequence = 0
  return {
    list: () => ['spawn'],
    async startActivation() {
      // Deterministic fixture ids: test inputs must stay replayable (#130).
      sequence += 1
      return { childId: `child-fixture-${sequence}`, result: new Promise(() => {}) }
    },
    async sendMessage() {},
    async listDescendants() {
      return rows
    },
  }
}

function fakeAgentPresets() {
  return {
    list: async () => [{ id: 'tower-worker' }, { id: 'tower-reviewer' }],
  }
}

/**
 * Minimal Cordis context, mirroring tests/spawn.mock.test.mjs, with a commands
 * service whose optional `list()` lets a case simulate a host-owned name.
 */
function makeHarness(options = {}) {
  const subagents = options.subagents === undefined ? fakeSubagents(options.catalogRows ?? []) : options.subagents
  const agentPresets = options.agentPresets === undefined ? fakeAgentPresets() : options.agentPresets
  const services = { subagents, agentPresets, goals: undefined }
  const tools = new Map()
  const sections = []
  const commands = new Map()
  const commandsService = {
    register(definition) {
      commands.set(definition.name, definition)
      return () => {}
    },
  }
  if (options.hostTasksCommand) commandsService.list = () => [{ name: 'tasks' }]
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
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
      guard() {
        return () => {}
      },
    },
    systemPrompt: {
      section(definition) {
        sections.push(definition)
      },
    },
    commands: commandsService,
  }
  apply(ctx, {})
  return { ctx, tools, subagents, agentPresets, sections, commands }
}

function makeAgent(id, cwd) {
  return { id, ...(cwd ? { session: { header: { cwd } } } : {}) }
}

async function callCommand(commands, name, agent, rawInput = '') {
  const definition = commands.get(name)
  assert.ok(definition, `the /${name} command must be registered`)
  return definition.handler({ agent, rawInput, attachments: [] })
}

async function callTool(tools, name, args) {
  const definition = tools.get(name)
  assert.ok(definition, `${name} must be registered`)
  return definition.execute(args, { agent: { id: 'tower-agent' } })
}

/**
 * A repository with two recorded roster rows:
 *
 * - M1/child-1: active, last mission activity 12m ago, present in the catalog;
 * - M2/child-2: absent from the catalog, spawned 50m ago (its spawn activity
 *   entry is aged to the same timestamp), so the shared spawn.staleMs rule
 *   flags it stale under the default 15s window.
 */
async function seedRosterFixture(prefix) {
  const { root, repo } = seedRepo(prefix)
  const harness = makeHarness({ catalogRows: [{ id: 'child-1', activity: 'running' }] })
  const tower = await Tower.open(repo)
  await tower.init({ towerAgentId: 'tower-agent' })
  await tower.plan({
    missions: [
      { title: 'Auth case', scope: ['src/**'], tasks: ['write it'] },
      { title: 'Login case', scope: ['docs/**'], tasks: ['write it'] },
    ],
  })
  const now = Date.now()
  await tower.recordSpawn({
    missionId: 'M1',
    name: 'worker-m1',
    role: 'worker',
    agentId: 'child-1',
    parentSessionId: 'tower-agent',
    cwd: repo,
    branch: 'tower/m1-fixture',
  })
  await tower.recordSpawn({
    missionId: 'M2',
    name: 'worker-m2',
    role: 'worker',
    agentId: 'child-2',
    parentSessionId: 'tower-agent',
    cwd: repo,
    branch: 'tower/m2-fixture',
    now: now - 50 * MINUTE,
  })

  // Age the recorded rows so the panel sees 13m/50m-old spawns, then add the
  // mission event M1's worker last performed 12m ago.
  const state = JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
  for (const entry of state.roster ?? []) {
    if (entry.agentId === 'child-1') entry.spawnedAt = now - 13 * MINUTE
    if (entry.agentId === 'child-2') entry.spawnedAt = now - 50 * MINUTE
  }
  fs.writeFileSync(tower.paths.state, `${JSON.stringify(state, null, 2)}\n`)
  const activityPath = tower.paths.activity
  const lines = fs.readFileSync(activityPath, 'utf8').split('\n').filter(Boolean)
  for (const [index, line] of lines.entries()) {
    const entry = JSON.parse(line)
    if (entry.missionId === 'M1') entry.at = now - 13 * MINUTE
    if (entry.missionId === 'M2') entry.at = now - 50 * MINUTE
    lines[index] = JSON.stringify(entry)
  }
  lines.push(JSON.stringify({ at: now - 12 * MINUTE, type: 'mission', missionId: 'M1', text: 'task_done="auth"' }))
  fs.writeFileSync(activityPath, `${lines.join('\n')}\n`)

  harness.tower = tower
  return { root, repo, harness, tower }
}

test('D1: /tasks is claimed only when the host profile has no tasks command', () => {
  const free = makeHarness()
  assert.ok(free.commands.has('tower'), 'the /tower command stays registered')
  assert.ok(free.commands.has('tasks'), '/tasks must be registered when the name is free')
  const tasks = free.commands.get('tasks')
  assert.match(tasks.description, /\/tasks/)
  assert.match(tasks.description, /\/tower tasks/, 'the description names the alias')

  const owned = makeHarness({ hostTasksCommand: true })
  assert.equal(owned.commands.has('tasks'), false, 'a host-owned tasks name must not be re-registered')
  assert.ok(owned.commands.has('tower'), '/tower still registers')
  assert.match(
    owned.commands.get('tower').description,
    /\/tower tasks/,
    'the /tower description names the tower-scoped tasks surface',
  )
  assert.match(owned.commands.get('tower').input.hint, /tasks/, 'the input hint lists the tasks subcommand')
})

test('D2: /tasks renders one line per live roster entry sorted by silence', async () => {
  const { root, repo, harness } = await seedRosterFixture('dsh-tower-tasks-render-')
  try {
    const reply = await callCommand(harness.commands, 'tasks', makeAgent('human', repo))
    assert.equal(reply.kind, 'success')
    const lines = reply.text.split('\n').filter(Boolean)
    assert.equal(lines.length, 3, `exactly two rows plus the footer: ${JSON.stringify(lines)}`)
    assert.match(lines[0], /^M2\s+worker\s+worker-m2\s+m2-fixture\s+stale\s+50m\s+last: worker worker-m2 \(child-2\)$/)
    assert.match(lines[1], /^M1\s+worker\s+worker-m1\s+m1-fixture\s+active\s+12m\s+last: task_done="auth"$/)
    assert.equal(
      lines[2],
      '2 live, 1 stale; tower_interrupt <name> to stop, /tower status for the full board',
    )
  } finally {
    removeTemp(root)
  }
})

test('D3 + acceptance: /tasks performs zero writes to state.json, the activity log and the mode store', async () => {
  const { root, repo, harness } = await seedRosterFixture('dsh-tower-tasks-readonly-')
  try {
    const before = {
      state: fs.readFileSync(harness.tower.paths.state, 'utf8'),
      stateMtime: fs.statSync(harness.tower.paths.state).mtimeMs,
      activity: fs.readFileSync(harness.tower.paths.activity, 'utf8'),
      activityMtime: fs.statSync(harness.tower.paths.activity).mtimeMs,
      towerDir: fs.readdirSync(path.dirname(harness.tower.paths.state)).sort().join(','),
      homeTree: fs.readdirSync(home, { recursive: true }).sort().join(','),
    }

    const reply = await callCommand(harness.commands, 'tasks', makeAgent('human', repo))
    assert.equal(reply.kind, 'success')

    const after = {
      state: fs.readFileSync(harness.tower.paths.state, 'utf8'),
      stateMtime: fs.statSync(harness.tower.paths.state).mtimeMs,
      activity: fs.readFileSync(harness.tower.paths.activity, 'utf8'),
      activityMtime: fs.statSync(harness.tower.paths.activity).mtimeMs,
      towerDir: fs.readdirSync(path.dirname(harness.tower.paths.state)).sort().join(','),
      homeTree: fs.readdirSync(home, { recursive: true }).sort().join(','),
    }
    assert.deepEqual(after, before, 'the read-only panel must not touch any durable store')
  } finally {
    removeTemp(root)
  }
})

test('acceptance: stale comes from the same spawn.staleMs rule tower_roster uses', async () => {
  const { root, repo, harness } = await seedRosterFixture('dsh-tower-tasks-stale-')
  try {
    const agent = makeAgent('human', repo)
    // Default window (15s): both views flag M2's 50m-silent row stale.
    const rosterBefore = await callTool(harness.tools, 'tower_roster', { repoRoot: repo })
    const m2Before = rosterBefore.roster.find((entry) => entry.agentId === 'child-2')
    assert.equal(m2Before.stale, true, 'tower_roster flags the 50m-silent row stale')
    const panelBefore = await callCommand(harness.commands, 'tasks', agent)
    assert.match(panelBefore.text.split('\n')[0], /stale/)

    // Flip the one knob: raise the repo's spawn.staleMs past the row's age.
    fs.writeFileSync(
      path.join(path.dirname(harness.tower.paths.state), 'config.json'),
      `${JSON.stringify({ spawn: { staleMs: 120 * MINUTE } })}\n`,
    )
    const rosterAfter = await callTool(harness.tools, 'tower_roster', { repoRoot: repo })
    const m2After = rosterAfter.roster.find((entry) => entry.agentId === 'child-2')
    assert.equal(m2After.stale, false, 'tower_roster follows the raised window')
    const panelAfter = await callCommand(harness.commands, 'tasks', agent)
    assert.doesNotMatch(panelAfter.text.split('\n')[0], /stale/, 'the panel follows the same raised window')
    assert.match(panelAfter.text, /M2\s+worker\s+worker-m2\s+m2-fixture\s+active/)
  } finally {
    removeTemp(root)
  }
})

test('D1 alias: /tower tasks renders the same panel without entering Tower mode', async () => {
  const { root, repo, harness } = await seedRosterFixture('dsh-tower-tasks-alias-')
  try {
    const agent = makeAgent('human', repo)
    const alias = await callCommand(harness.commands, 'tower', agent, 'tasks')
    assert.equal(alias.kind, 'success')
    assert.match(alias.text, /M1\s+worker\s+worker-m1/)

    const direct = await callCommand(harness.commands, 'tasks', agent)
    assert.equal(direct.kind, 'success')

    // The alias is a read, not a mode transition: no mode-store file appears.
    const modesFile = path.join(home, 'tower-mode', 'modes.json')
    assert.equal(fs.existsSync(modesFile), false, '/tower tasks must not enter Tower mode')
  } finally {
    removeTemp(root)
  }
})

test('empty roster: the panel reports zero live agents', async () => {
  const { root, repo } = seedRepo('dsh-tower-tasks-empty-')
  const harness = makeHarness()
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-agent' })
    const reply = await callCommand(harness.commands, 'tasks', makeAgent('human', repo))
    assert.equal(reply.kind, 'success')
    assert.match(reply.text, /0 live, 0 stale/)
    assert.match(reply.text, /tower_interrupt <name> to stop/)
  } finally {
    removeTemp(root)
  }
})

test('uninitialized repository: the panel fails closed with the tower_init remedy', async () => {
  const { root, repo } = seedRepo('dsh-tower-tasks-uninit-')
  const harness = makeHarness()
  try {
    const reply = await callCommand(harness.commands, 'tasks', makeAgent('human', repo))
    assert.equal(reply.kind, 'error')
    assert.match(reply.text, /not-initialized/)
    assert.match(reply.text, /tower_init/)
  } finally {
    removeTemp(root)
  }
})

test('a session without a working directory is refused', async () => {
  const harness = makeHarness()
  const reply = await callCommand(harness.commands, 'tasks', makeAgent('no-cwd'))
  assert.equal(reply.kind, 'error')
  assert.match(reply.text, /working directory/)
})
