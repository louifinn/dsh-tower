// Regression tests for bugs found during the 2.0 review round.
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { registerTowerTools } from '../lib/tools.js'
import { Tower } from '../lib/tower.js'
import { loadModes, saveModes } from '../lib/modeStore.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-regress-'))
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

function writeRepoConfig(repo, value) {
  const file = path.join(repo, '.git', 'dsh-tower', 'config.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

function makeCtx(options = {}) {
  const tools = new Map()
  const activations = []
  const interrupts = []
  let childSeq = 0
  const subagents = {
    list: () => ['spawn'],
    startActivation: async (input) => {
      childSeq += 1
      const childId = `child-${childSeq}`
      activations.push({ ...input, childId })
      return {
        childId,
        result: options.pending
          ? new Promise(() => {})
          : Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }], diagnostic: null }),
      }
    },
    sendMessage: async () => {},
    listDescendants: async () => options.descendants ?? [],
    interrupt: (agentId, authority) => interrupts.push({ agentId, authority }),
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
    emit() {},
    tools: { register: (definition) => (tools.set(definition.name, definition), () => {}), guard: () => () => {}, restrict() {} },
    systemPrompt: { section() {} },
    inject(_deps, callback) {
      callback(ctx)
    },
  }
  return { ctx, tools, activations, interrupts }
}

async function call(tools, name, args, exec = { agent: { id: 'tower-agent' } }) {
  return tools.get(name).execute(args, exec)
}

test('regression: a worker-limit rejection happens before any activation or worktree', async () => {
  const { root, repo } = makeRepo()
  writeRepoConfig(repo, { spawn: { maxLiveWorkers: 1 } })
  const { ctx, tools, activations } = makeCtx({ pending: true })
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [
        { title: 'First', scope: ['src/**'] },
        { title: 'Second', scope: ['lib/**'] },
      ],
    })
    await call(tools, 'tower_spawn', { repoRoot: repo, missionId: planned.missions[0].id, role: 'worker' })
    assert.equal(activations.length, 1)
    await assert.rejects(
      () =>
        call(tools, 'tower_spawn', {
          repoRoot: repo,
          missionId: planned.missions[1].id,
          role: 'worker',
          name: 'worker-second',
        }),
      /\[tower:worker-limit\]/,
    )
    assert.equal(activations.length, 1, 'no child may be started when the limit rejects the spawn')
    const tower = await Tower.open(repo)
    const second = await tower.missionDetail(planned.missions[1].id)
    assert.equal(second.mission.worktree, null, 'no worktree may be provisioned for the rejected spawn')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('regression: repo config send.interruptDefault and init.snapshotDirty are honored', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools, interrupts } = makeCtx({ descendants: [{ id: 'child-1', activity: 'running' }] })
  registerTowerTools(ctx)
  try {
    // Dirty a tracked file before init so snapshotDirty has something to capture.
    fs.appendFileSync(path.join(repo, 'README.md'), 'wip\n')
    writeRepoConfig(repo, { init: { snapshotDirty: true }, send: { interruptDefault: true } })
    const initialized = await call(tools, 'tower_init', { repoRoot: repo })
    assert.ok(initialized.snapshotCommit, 'repo config init.snapshotDirty must be honored')
    const snapshotRefs = git(repo, ['for-each-ref', '--format=%(refname)', 'refs/tower/snapshot/'])
    assert.ok(snapshotRefs.includes(initialized.snapshotCommit), 'the snapshot commit must stay reachable through a ref')
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Interrupt default', scope: ['src/**'] }],
    })
    const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId: planned.missions[0].id, role: 'worker' })
    await call(
      tools,
      'tower_send',
      { repoRoot: repo, to: spawned.name, subject: 'note', body: 'please read' },
      { agent: { id: 'tower-agent' } },
    )
    assert.equal(interrupts.length, 1, 'repo config send.interruptDefault must interrupt before delivery')
    assert.equal(interrupts[0].agentId, spawned.agentId)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('regression: actionable refusals carry explicit stable codes', async () => {
  const { classifyError, TowerToolError } = await import('../lib/errors.js')
  const cases = [
    ['cannot reanchor base while 2 mission(s) are not merged or abandoned', 'invalid-transition'],
    ['snapshotDirty was requested but no snapshot commit could be created', 'invalid-argument'],
    ['worktree is missing: D:/tmp/x', 'invalid-transition'],
    ['refusing to send a message to yourself', 'invalid-argument'],
    ['agent reviewer-1 is a reviewer; only an assigned reviewer or the tower (break-glass) may review', 'not-authorized'],
    ['mission M1 already has a live worker "worker-m1"', 'invalid-transition'],
    ['worker worker-1 does not own mission M1 (owner: worker-2)', 'not-authorized'],
    ['agent worker-1 is interrupted; a stopped worker cannot report completion', 'invalid-transition'],
    ['roster name already used: worker-m1', 'invalid-argument'],
    ['agent child-1 is already in the roster', 'invalid-argument'],
    ['mission M1 is merged; a blocker cannot reopen a terminal mission', 'invalid-transition'],
  ]
  for (const [message, code] of cases) {
    const error = new TowerToolError(code, message)
    assert.equal(classifyError(error), error)
  }
})

test('regression: a duplicate live worker is rejected before any activation', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools, activations } = makeCtx({ pending: true })
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'One owner', scope: ['src/**'] }],
    })
    await call(tools, 'tower_spawn', { repoRoot: repo, missionId: planned.missions[0].id, role: 'worker' })
    assert.equal(activations.length, 1)
    await assert.rejects(
      () => call(tools, 'tower_spawn', { repoRoot: repo, missionId: planned.missions[0].id, role: 'worker', name: 'second' }),
      /\[tower:invalid-transition\].*live worker/,
    )
    assert.equal(activations.length, 1, 'a duplicate worker must be rejected before activation')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('regression: rework rounds can spawn again with unique default names and takeover', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools, activations } = makeCtx()
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Rework', scope: ['src/**'] }],
    })
    const missionId = planned.missions[0].id
    const first = await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    assert.equal(first.name, 'worker-m1')
    await new Promise((resolve) => setTimeout(resolve, 50)) // let recordSpawnOutcome mark it inactive
    const second = await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    assert.equal(second.name, 'worker-m1-2')
    assert.equal(activations.length, 2)
    const tower = await Tower.open(repo)
    const view = await tower.rosterView()
    const workers = view.roster.filter((entry) => entry.missionId === missionId && entry.role === 'worker')
    assert.equal(workers.filter((entry) => entry.state !== 'retired').length, 1)
    const takeover = await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker', takeover: true })
    assert.equal(takeover.name, 'worker-m1-3')
    const after = await (await Tower.open(repo)).rosterView()
    assert.equal(after.roster.filter((entry) => entry.missionId === missionId && entry.role === 'worker' && entry.state !== 'retired').length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('regression: gates.requireChecks blocks a completion without evidence', async () => {
  const { root, repo } = makeRepo()
  writeRepoConfig(repo, { gates: { requireChecks: true } })
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Checks', scope: ['src/**'], tasks: ['do it'] }],
    })
    const missionId = planned.missions[0].id
    const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    const worktree = spawned.worktree.path
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true })
    fs.writeFileSync(path.join(worktree, 'src', 'a.txt'), 'a\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-m', 'work'])
    const workerExec = { agent: { id: spawned.agentId } }
    await call(tools, 'tower_mission', { repoRoot: repo, missionId, taskDone: 'do it' }, workerExec)
    await call(tools, 'tower_complete', { repoRoot: repo, missionId, report: 'done' }, workerExec)
    const tower = await Tower.open(repo)
    const gate = await tower.evaluateGate({ missionId, activity: {} })
    assert.ok(gate.blockers.some((blocker) => blocker.code === 'no-check-evidence'))
    const reviewed = await call(
      tools,
      'tower_review',
      {
        repoRoot: repo,
        missionId,
        status: 'clean',
        merge: 'merge',
        findings: 'none',
        decision: 'ok',
        breakGlassReason: 'regression test has no independent reviewer',
      },
      { agent: { id: 'tower-agent' } },
    )
    assert.equal(reviewed.missionStatus, 'completed')
    const preflight = await call(tools, 'tower_preflight', { repoRoot: repo, missionId }, { agent: { id: 'tower-agent' } })
    assert.ok(preflight.blockers.some((blocker) => blocker.code === 'no-check-evidence'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('regression: docs.board:false suppresses MISSIONS.md; user-paused resume can require authorization', async () => {
  const { root, repo } = makeRepo()
  writeRepoConfig(repo, { docs: { board: false }, mode: { requireResumeAuthorization: true } })
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Pause rule', scope: ['src/**'] }],
    })
    const board = path.join(repo, '.git', 'dsh-tower', 'MISSIONS.md')
    assert.equal(fs.existsSync(board), false, 'docs.board:false must suppress the board file')
    const id = planned.missions[0].id
    await call(tools, 'tower_mission', { repoRoot: repo, id, status: 'active' })
    await call(tools, 'tower_mission', { repoRoot: repo, id, status: 'paused', pause_cause: 'user' })
    await assert.rejects(
      () => call(tools, 'tower_mission', { repoRoot: repo, id, status: 'active' }),
      /authorization/i,
    )
    const resumed = await call(tools, 'tower_mission', {
      repoRoot: repo,
      id,
      status: 'active',
      authorization: 'human-approval-123',
    })
    assert.equal(resumed.mission.status, 'active')
    assert.equal(resumed.mission.authorizationRef, 'human-approval-123')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('regression: mode persistence keeps workspace lock tokens across a reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-modes-'))
  try {
    const modes = new Map([
      ['session-a', { on: true, lock: { token: 'token-a', commonDir: 'C:/repo/.git' }, baseBranch: 'main', at: 1000 }],
      ['session-b', { on: true, lock: null, at: 900 }],
    ])
    assert.equal(saveModes(modes, dir), true)
    const loaded = loadModes(dir)
    assert.deepEqual(loaded.get('session-a').lock, { token: 'token-a', commonDir: 'C:/repo/.git' })
    assert.equal(loaded.get('session-a').baseBranch, 'main')
    assert.equal(loaded.get('session-b').lock, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('regression: mode store reclaims a lock whose PID is dead', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-modes-lock-'))
  try {
    fs.writeFileSync(path.join(dir, 'modes.lock'), JSON.stringify({ pid: 999999, token: 'dead', at: 1 }))
    assert.equal(saveModes(new Map([['s', { on: true, at: 1 }]]), dir), true)
    assert.equal(fs.existsSync(path.join(dir, 'modes.lock')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('regression: mode store waits with a bounded timeout for a live lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-modes-live-'))
  try {
    fs.writeFileSync(path.join(dir, 'modes.lock'), JSON.stringify({ pid: process.pid, token: 'live', at: Date.now() }))
    const started = Date.now()
    assert.equal(saveModes(new Map([['s', { on: true, at: 1 }]]), dir, 200, { timeoutMs: 30 }), false)
    assert.ok(Date.now() - started >= 25)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
