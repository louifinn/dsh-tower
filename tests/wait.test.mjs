// #201: the one bounded blocking wait (`tower_wait`).
//
// The contract under test: the call returns exactly one conclusion — reached,
// timeout or unknown — never a fake timeout for a missing target, never an
// unbounded block, and never a write. The tests use the real registered tool
// over a temporary git repository, so the authorization row, the repository
// resolution and the app load path are exercised together.
//
// Run with: node --test tests/wait.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'
import { registerTowerTools } from '../host/tool-registry.js'
import { Tower } from '../host/tower.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-wait-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo }
}

/** The tool surface a tower session registers, recorded by name. */
function makeCtx() {
  const tools = new Map()
  const subagents = {
    list: () => ['spawn'],
    startActivation: async () => {
      throw new Error('wait tests never activate a child')
    },
    sendMessage: async () => {},
    listDescendants: async () => [],
  }
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
      restrict() {},
    },
    systemPrompt: { section() {} },
    inject(_deps, callback) {
      callback(ctx)
    },
  }
  return { ctx, tools }
}

const towerExec = { agent: { id: 'tower-agent' } }

/** A real Tower over a temp repository with one planned build mission. */
async function seeded() {
  const { root, repo } = makeRepo()
  const tower = await Tower.open(repo)
  await tower.init({ towerAgentId: 'tower-agent' })
  await tower.plan({ missions: [{ title: 'Wait target', scope: ['src/**'], tasks: ['wait for it'] }] })
  return { root, repo, tower }
}

/**
 * Rewrite `state.json` atomically, the way a concurrent writer would: a wait
 * that happens to poll during the write must never see a torn file.
 */
async function mutateState(tower, mutate) {
  const state = await tower.load()
  mutate(state)
  state.revision += 1
  state.updatedAt = Date.now()
  const temporary = `${tower.paths.state}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2))
  fs.renameSync(temporary, tower.paths.state)
}

/** Target one roster row through the real spawn records. */
async function attachWorker(tower, name = 'worker-m1') {
  await tower.reserveRoster({ missionId: 'M1', name, role: 'worker', parentSessionId: 'tower-agent' })
  await tower.recordSpawn({ missionId: 'M1', name, role: 'worker', agentId: 'child-1', parentSessionId: 'tower-agent' })
}

function waitTool(tools) {
  const tool = tools.get('tower_wait')
  assert.ok(tool, 'tower_wait is registered')
  return tool
}

test('reached: completion returns the bound fact instead of the table', async () => {
  const { root, repo, tower } = await seeded()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await attachWorker(tower)
    // Record the target row once, then let the wait observe the lifecycle flip.
    const started = Date.now()
    const pending = waitTool(tools).execute({ repoRoot: repo, agent: 'worker-m1', until: 'inactive', timeoutMs: 5000 }, towerExec)
    await new Promise((resolve) => setTimeout(resolve, 700))
    await tower.recordSpawnOutcome({ missionId: 'M1', name: 'worker-m1', state: 'inactive', detail: 'finished the mission' })
    const result = await pending
    assert.equal(result.status, 'reached')
    assert.equal(result.target.agent, 'worker-m1')
    assert.ok(Date.now() - started >= 700, 'the wait covered the settle window the test injected')
    assert.equal(result.detail.until, 'inactive')
    assert.equal(result.detail.agent.state, 'inactive')
    assert.equal(result.detail.agent.name, 'worker-m1')
    assert.equal(result.last, undefined, 'a reached wait carries no timeout observation')
  } finally {
    removeTemp(root)
  }
})

test('reached: a completed mission satisfies until:"completed"', async () => {
  const { root, repo, tower } = await seeded()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const started = Date.now()
    const pending = waitTool(tools).execute({ repoRoot: repo, missionId: 'M1', until: 'completed', timeoutMs: 5000 }, towerExec)
    await new Promise((resolve) => setTimeout(resolve, 700))
    await mutateState(tower, (state) => {
      const mission = state.missions.find((entry) => entry.id === 'M1')
      mission.status = 'completed'
      mission.completedAt = Date.now()
    })
    const result = await pending
    assert.equal(result.status, 'reached')
    assert.equal(result.target.missionId, 'M1')
    assert.equal(result.detail.mission.status, 'completed')
    assert.equal(result.detail.mission.id, 'M1')
    assert.ok(Date.now() - started >= 700, 'the wait covered the settle window the test injected')
  } finally {
    removeTemp(root)
  }
})

// R185 P1: an agent's `settled` is the row's state, never the bound mission's.
// A completed mission can still have a live reviewer row; waiting on that agent
// must not report it settled.
test('agent settled: a completed mission never settles a live row', async () => {
  const { root, repo, tower } = await seeded()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  const call = (args) => waitTool(tools).execute({ repoRoot: repo, ...args }, towerExec)
  try {
    await attachWorker(tower)
    await mutateState(tower, (state) => {
      const mission = state.missions.find((entry) => entry.id === 'M1')
      mission.status = 'completed'
      mission.completedAt = Date.now()
    })
    const started = Date.now()
    const timedOut = await call({ agent: 'worker-m1', timeoutMs: 1000 })
    const elapsed = Date.now() - started
    assert.equal(timedOut.status, 'timeout', 'a completed mission with a live row is not agent-settled')
    assert.ok(elapsed >= 1000, `the wait stayed bounded and timed out (${elapsed}ms)`)
    assert.equal(timedOut.last.agent.state, 'active')
    // For an agent target, `completed` still means its bound mission.
    const completed = await call({ agent: 'worker-m1', until: 'completed', timeoutMs: 5000 })
    assert.equal(completed.status, 'reached')
    assert.equal(completed.detail.mission.status, 'completed')
    assert.equal(completed.detail.agent.state, 'active')
    // Settle the row itself and the default settled wait reaches on the next poll.
    await mutateState(tower, (state) => {
      state.roster.find((row) => row.name === 'worker-m1').state = 'inactive'
    })
    const reached = await call({ agent: 'worker-m1', timeoutMs: 5000 })
    assert.equal(reached.status, 'reached')
    assert.equal(reached.detail.until, 'settled')
    assert.equal(reached.detail.agent.state, 'inactive')
  } finally {
    removeTemp(root)
  }
})

// R185 P1: `paused` is a settled mission status, but it says nothing about a
// live worker row on that mission — the agent wait must still time out.
test('agent settled: a paused mission with a live row still times out', async () => {
  const { root, repo, tower } = await seeded()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await attachWorker(tower)
    await mutateState(tower, (state) => {
      const mission = state.missions.find((entry) => entry.id === 'M1')
      mission.status = 'paused'
      mission.pauseCause = 'user'
      mission.blockers = []
    })
    const started = Date.now()
    const result = await waitTool(tools).execute({ repoRoot: repo, agent: 'worker-m1', timeoutMs: 1000 }, towerExec)
    const elapsed = Date.now() - started
    assert.equal(result.status, 'timeout', 'a paused mission does not settle its live worker')
    assert.ok(elapsed >= 1000, `the wait stayed bounded (${elapsed}ms)`)
    assert.equal(result.last.agent.state, 'active')
    assert.equal(result.last.mission.status, 'paused')
  } finally {
    removeTemp(root)
  }
})

// R185 P1: a mission with no roster rows is inactive; the old predicate
// required at least one row and made these waits time out forever.
test('mission inactive: a completed mission with no roster rows is inactive at once', async () => {
  const { root, repo, tower } = await seeded()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await mutateState(tower, (state) => {
      const mission = state.missions.find((entry) => entry.id === 'M1')
      mission.status = 'completed'
      mission.completedAt = Date.now()
    })
    const started = Date.now()
    const result = await waitTool(tools).execute({ repoRoot: repo, missionId: 'M1', until: 'inactive', timeoutMs: 1000 }, towerExec)
    const elapsed = Date.now() - started
    assert.equal(result.status, 'reached')
    assert.equal(result.detail.until, 'inactive')
    assert.equal(result.detail.mission.status, 'completed')
    assert.ok(elapsed < 1000, `a zero-row inactive mission reaches on the first poll (${elapsed}ms)`)
  } finally {
    removeTemp(root)
  }
})

test('mission inactive: a planned mission with no roster rows is inactive at once', async () => {
  const { root, repo } = await seeded()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const started = Date.now()
    const result = await waitTool(tools).execute({ repoRoot: repo, missionId: 'M1', until: 'inactive', timeoutMs: 1000 }, towerExec)
    const elapsed = Date.now() - started
    assert.equal(result.status, 'reached')
    assert.equal(result.detail.until, 'inactive')
    assert.equal(result.detail.mission.status, 'planned')
    assert.ok(elapsed < 1000, `a zero-row planned mission is inactive, not a timeout (${elapsed}ms)`)
  } finally {
    removeTemp(root)
  }
})

// The settled mission vocabulary is table-driven so a new status cannot be
// silently omitted from the default wait.
test('mission settled: every settled status reaches the default wait', async () => {
  const { root, repo, tower } = await seeded()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    for (const status of ['completed', 'merged', 'blocked', 'paused', 'abandoned']) {
      await mutateState(tower, (state) => {
        const mission = state.missions.find((entry) => entry.id === 'M1')
        mission.status = status
        mission.blockers = status === 'blocked' ? ['waiting for review'] : []
        mission.completedAt = Date.now()
      })
      const result = await waitTool(tools).execute({ repoRoot: repo, missionId: 'M1', timeoutMs: 1000 }, towerExec)
      assert.equal(result.status, 'reached', `${status} is a settled mission status`)
      assert.equal(result.detail.mission.status, status)
      assert.equal(result.detail.until, 'settled')
    }
  } finally {
    removeTemp(root)
  }
})

// The settled agent vocabulary is table-driven for the same reason: each of the
// five resting row states must reach the default wait on its own.
test('agent settled: every settled row state reaches the default wait', async () => {
  const { root, repo, tower } = await seeded()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await attachWorker(tower)
    for (const state of ['inactive', 'retired', 'failed', 'interrupted', 'missing']) {
      await mutateState(tower, (stateDoc) => {
        stateDoc.roster.find((row) => row.name === 'worker-m1').state = state
        stateDoc.missions.find((entry) => entry.id === 'M1').status = 'active'
      })
      const result = await waitTool(tools).execute({ repoRoot: repo, agent: 'worker-m1', timeoutMs: 1000 }, towerExec)
      assert.equal(result.status, 'reached', `${state} is a settled agent state`)
      assert.equal(result.detail.agent.state, state)
      assert.equal(result.detail.until, 'settled')
    }
  } finally {
    removeTemp(root)
  }
})

// R185 P1: the reviewer's live case — the row vanishes mid-wait. It existed
// when the wait began, so its disappearance is the target's final `missing`
// state (settled), not an unknown target.
test('agent settled: a row that vanishes mid-wait is reached as missing', async () => {
  const { root, repo, tower } = await seeded()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await attachWorker(tower)
    const pending = waitTool(tools).execute({ repoRoot: repo, agent: 'worker-m1', timeoutMs: 5000 }, towerExec)
    await new Promise((resolve) => setTimeout(resolve, 700))
    await mutateState(tower, (state) => {
      state.roster = state.roster.filter((row) => row.name !== 'worker-m1')
    })
    const result = await pending
    assert.equal(result.status, 'reached')
    assert.equal(result.detail.until, 'settled')
    assert.equal(result.detail.agent.name, 'worker-m1')
    assert.equal(result.detail.agent.state, 'missing')
  } finally {
    removeTemp(root)
  }
})

test('timeout: a bounded wait returns the last observation, not the whole table', async () => {
  const { root, repo } = await seeded()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const started = Date.now()
    const result = await waitTool(tools).execute({ repoRoot: repo, missionId: 'M1', until: 'completed', timeoutMs: 1000 }, towerExec)
    const elapsed = Date.now() - started
    assert.equal(result.status, 'timeout')
    assert.ok(elapsed >= 1000 && elapsed < 10000, `bounded wait took ${elapsed}ms`)
    assert.equal(result.target.missionId, 'M1')
    assert.equal(result.last.mission.status, 'planned')
    assert.equal(typeof result.last.revision, 'number')
    assert.equal(result.detail, undefined, 'a timeout carries no reached detail')
    // A timeout summary may carry the bounded roster slice, never full tables.
    assert.equal(result.last.missions, undefined, 'no full mission table')
    if (result.last.roster !== undefined) assert.ok(result.last.roster.length <= 5)
  } finally {
    removeTemp(root)
  }
})

test('unknown: the target is absent, and that is not reported as a timeout', async () => {
  const { root, repo } = await seeded()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const mission = await waitTool(tools).execute({ repoRoot: repo, missionId: 'M999', timeoutMs: 5000 }, towerExec)
    assert.equal(mission.status, 'unknown')
    assert.match(mission.reason, /M999/)
    assert.equal(mission.last, undefined)
    const agent = await waitTool(tools).execute({ repoRoot: repo, agent: 'worker-ghost', timeoutMs: 5000 }, towerExec)
    assert.equal(agent.status, 'unknown')
    assert.match(agent.reason, /worker-ghost/)
  } finally {
    removeTemp(root)
  }
})

test('unknown: state that disappears mid-wait is a reason, never a fake timeout', async () => {
  const { root, repo, tower } = await seeded()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const pending = waitTool(tools).execute({ repoRoot: repo, missionId: 'M1', until: 'completed', timeoutMs: 5000 }, towerExec)
    await new Promise((resolve) => setTimeout(resolve, 700))
    fs.rmSync(tower.paths.state)
    const result = await pending
    assert.equal(result.status, 'unknown')
    assert.match(result.reason, /not initialized/i)
    assert.equal(result.last, undefined)
  } finally {
    removeTemp(root)
  }
})

test('unreadable state fails closed before the handler instead of masquerading as timeout', async () => {
  const { root, repo, tower } = await seeded()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    fs.writeFileSync(tower.paths.state, '{"schemaVersion": 1, torn')
    await assert.rejects(
      () => waitTool(tools).execute({ repoRoot: repo, missionId: 'M1', timeoutMs: 5000 }, towerExec),
      (error) => error.code === 'state-corrupt',
      'the authorization kernel must refuse a corrupt catalog before any wait starts',
    )
  } finally {
    removeTemp(root)
  }
})

test('any-change: returns on the first observed change after the baseline poll', async () => {
  const { root, repo, tower } = await seeded()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const pending = waitTool(tools).execute({ repoRoot: repo, missionId: 'M1', until: 'any-change', timeoutMs: 8000 }, towerExec)
    // Keep changing the title until the wait resolves; a slow first poll may
    // already include an earlier mutation, so a single fixed race would flake.
    let change = 0
    const timer = setInterval(() => {
      change += 1
      void mutateState(tower, (state) => {
        state.missions[0].title = `Changed while waiting ${change}`
      }).catch(() => {})
    }, 400)
    const result = await pending
    clearInterval(timer)
    assert.equal(result.status, 'reached')
    assert.match(String(result.detail.mission.title), /^Changed while waiting \d+$/)
    assert.equal(result.detail.until, 'any-change')
  } finally {
    removeTemp(root)
  }
})

test('input validation: exactly one target and a bounded integer timeout', async () => {
  const { root, repo } = await seeded()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  const call = (args) => waitTool(tools).execute({ repoRoot: repo, ...args }, towerExec)
  try {
    await assert.rejects(() => call({}), (error) => error.code === 'invalid-argument' && /exactly one of missionId or agent/.test(error.message))
    await assert.rejects(
      () => call({ missionId: 'M1', agent: 'worker-m1' }),
      (error) => error.code === 'invalid-argument' && /exactly one of missionId or agent/.test(error.message),
    )
    for (const timeoutMs of [0, 999, 600001, 1500.5, true]) {
      await assert.rejects(
        () => call({ missionId: 'M1', timeoutMs }),
        (error) => error.code === 'invalid-argument' && /between 1000 and 600000/.test(error.message),
        `timeoutMs ${JSON.stringify(timeoutMs)} must be rejected`,
      )
    }
    await assert.rejects(
      () => call({ missionId: 'M1', until: 'finished' }),
      (error) => error.code === 'invalid-argument' && /until must be one of/.test(error.message),
    )
  } finally {
    removeTemp(root)
  }
})

test('a wait writes nothing and never blocks the event loop while it polls', async () => {
  const { root, repo, tower } = await seeded()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const stateBefore = fs.readFileSync(tower.paths.state)
    const activityBefore = fs.existsSync(tower.paths.activity) ? fs.readFileSync(tower.paths.activity) : null
    let ticked = false
    const tick = setTimeout(() => {
      ticked = true
    }, 150)
    const result = await waitTool(tools).execute({ repoRoot: repo, missionId: 'M1', until: 'completed', timeoutMs: 1000 }, towerExec)
    clearTimeout(tick)
    assert.equal(result.status, 'timeout')
    assert.equal(ticked, true, 'the poll loop must yield to the event loop')
    assert.deepEqual(fs.readFileSync(tower.paths.state), stateBefore, 'state.json is byte-identical after a wait')
    const activityAfter = fs.existsSync(tower.paths.activity) ? fs.readFileSync(tower.paths.activity) : null
    assert.deepEqual(activityAfter, activityBefore, 'a wait appends no activity')
  } finally {
    removeTemp(root)
  }
})
