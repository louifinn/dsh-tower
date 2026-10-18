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
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }], diagnostic: null }),
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
  const { ctx, tools, activations } = makeCtx()
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

test('regression: actionable refusals classify into stable codes, not tool-internal', async () => {
  const { classifyError } = await import('../lib/errors.js')
  const cases = [
    ['cannot reanchor base while 2 mission(s) are not merged or abandoned', 'invalid-transition'],
    ['snapshotDirty was requested but no snapshot commit could be created', 'invalid-argument'],
    ['worktree is missing: D:/tmp/x', 'invalid-transition'],
    ['refusing to send a message to yourself', 'invalid-argument'],
    ['agent reviewer-1 is a reviewer; only an assigned reviewer or the tower (break-glass) may review', 'not-authorized'],
    ['mission M1 already has a live worker "worker-m1"', 'invalid-transition'],
  ]
  for (const [message, code] of cases) {
    assert.equal(classifyError(new Error(message)).code, code, message)
  }
})

test('regression: a duplicate live worker is rejected before any activation', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools, activations } = makeCtx()
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
