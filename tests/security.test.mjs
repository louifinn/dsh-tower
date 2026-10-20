// Security regression coverage for the 2026-10-21 audit and related issues.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { registerTowerTools } from '../lib/tools.js'
import { Tower } from '../lib/tower.js'
import { testProcessEnv } from '../lib/tests.js'
import { gitEnv } from '../lib/git.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-security-'))
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

function fakeSubagents() {
  let counter = 0
  return {
    list: () => ['spawn'],
    async startActivation() {
      counter += 1
      return { childId: `child-sec-${counter}`, result: Promise.resolve({ stopReason: 'completed', output: [] }) }
    },
    async sendMessage() {},
    async listDescendants() {
      return []
    },
    interrupt() {},
  }
}

function makeCtx(services = {}) {
  const tools = new Map()
  const resolved = { subagents: fakeSubagents(), ...services }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: () => () => {},
    inject(_deps, callback) {
      callback(ctx)
    },
    systemPrompt: { section() {} },
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
    get: (name) => resolved[name],
    emit: () => {},
  }
  registerTowerTools(ctx)
  return { ctx, tools, services: resolved }
}

const towerExec = { agent: { id: 'tower-sec' } }
const call = (tools, name, args, exec = towerExec) => tools.get(name).execute(args, exec)

async function initPlan(tools, repo) {
  await call(tools, 'tower_init', { repoRoot: repo })
  return call(tools, 'tower_plan', { repoRoot: repo, missions: [{ title: 'Security fixture', scope: ['src/**'], tasks: ['write'] }] })
}

test('security: unknown agents cannot use tower-only tools', async () => {
  const { root, repo } = makeRepo()
  const { tools } = makeCtx()
  try {
    const planned = await initPlan(tools, repo)
    const missionId = planned.missions[0].id
    const forged = { agent: { id: 'agent-not-in-roster' } }
    for (const [name, args] of [
      ['tower_spawn', { repoRoot: repo, missionId, role: 'worker' }],
      ['tower_merge', { repoRoot: repo, missionId }],
      ['tower_teardown', { repoRoot: repo }],
      ['tower_plan', { repoRoot: repo, missions: [{ title: 'Forged', scope: ['x/**'] }] }],
      ['tower_mission', { repoRoot: repo, id: missionId, note: 'forged' }],
      ['tower_test', { repoRoot: repo, missionId }],
      ['tower_finding', { repoRoot: repo, type: 'bug', title: 'forged', summary: 'x', details: 'x', suggested_fix: 'x' }],
    ]) {
      await assert.rejects(() => call(tools, name, args, forged), /not-authorized/i)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('security: an unregistered caller cannot break-glass a review', async () => {
  const { root, repo } = makeRepo()
  const { tools } = makeCtx()
  try {
    const planned = await initPlan(tools, repo)
    const missionId = planned.missions[0].id
    await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    await assert.rejects(
      () => call(tools, 'tower_review', {
        repoRoot: repo,
        missionId,
        status: 'clean',
        merge: 'merge',
        findings: 'none',
        decision: 'self review',
        breakGlassReason: 'forged',
      }, { agent: { id: 'agent-not-in-roster' } }),
      /not-authorized/i,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('security: completion rejects a dirty worktree', async () => {
  const { root, repo } = makeRepo()
  const { tools } = makeCtx()
  try {
    const planned = await initPlan(tools, repo)
    const missionId = planned.missions[0].id
    const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    fs.mkdirSync(path.join(spawned.worktree.path, 'src'), { recursive: true })
    fs.writeFileSync(path.join(spawned.worktree.path, 'src', 'a.txt'), 'a\n')
    git(spawned.worktree.path, ['add', '-A'])
    git(spawned.worktree.path, ['commit', '-m', 'work'])
    fs.writeFileSync(path.join(spawned.worktree.path, 'src', 'untracked.txt'), 'left behind\n')
    const workerExec = { agent: { id: spawned.agentId } }
    const detail = await call(tools, 'tower_mission', { repoRoot: repo, missionId, taskDone: 'write' }, workerExec)
    assert.equal(detail.mission.tasks[0].status, 'done')
    await assert.rejects(
      () => call(tools, 'tower_complete', { repoRoot: repo, missionId, report: 'done' }, workerExec),
      /worktree-dirty/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('security: retiring a stale worker clears the permanent stale flag', async () => {
  const { root, repo } = makeRepo()
  const { tools } = makeCtx()
  try {
    const planned = await initPlan(tools, repo)
    const missionId = planned.missions[0].id
    const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    const tower = await Tower.open(repo)
    const state = await tower.load()
    const entry = state.roster.find((row) => row.agentId === spawned.agentId)
    entry.state = 'stale'
    entry.stale = true
    entry.staleAt = Date.now()
    fs.writeFileSync(tower.paths.state, JSON.stringify(state, null, 2))
    await tower.markRetired([spawned.agentId])
    const after = await (await Tower.open(repo)).load()
    const retired = after.roster.find((row) => row.agentId === spawned.agentId)
    assert.equal(retired.state, 'retired')
    assert.equal(retired.stale, undefined)
    assert.equal(retired.staleAt, undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('security: adopt needs two observations before retiring an absent worker', async () => {
  const { root, repo } = makeRepo()
  const { tools } = makeCtx()
  try {
    const planned = await initPlan(tools, repo)
    const missionId = planned.missions[0].id
    await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    const first = await call(tools, 'tower_adopt', { repoRoot: repo })
    assert.deepEqual(first.retired, [])
    const second = await call(tools, 'tower_adopt', { repoRoot: repo })
    assert.equal(second.retired.length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('security: lease status never returns tokens', async () => {
  const { root, repo } = makeRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const acquired = await call(tools, 'tower_resource', { repoRoot: repo, action: 'acquire', name: 'secret-lease' })
    assert.ok(acquired.lease.token)
    const status = await call(tools, 'tower_resource', { repoRoot: repo, action: 'status' })
    assert.equal(status.leases.some((lease) => 'token' in lease), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('security: child process environments drop GIT_* redirects and secrets', () => {
  const env = testProcessEnv({ PATH: '/bin', SECRET_TOKEN: 'x', GIT_DIR: '/decoy/.git', HOME: '/home/u' })
  assert.equal(env.SECRET_TOKEN, undefined)
  assert.equal(env.GIT_DIR, undefined)
  assert.equal(env.PATH, '/bin')
  const git = gitEnv({ PATH: '/bin', GIT_DIR: '/decoy/.git', GIT_INDEX_FILE: '/tmp/i', SAFE: '1' })
  assert.equal(git.GIT_DIR, undefined)
  assert.equal(git.GIT_INDEX_FILE, undefined)
  assert.equal(git.SAFE, '1')
})
