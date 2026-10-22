// Actor-role enforcement: the roster decides whether the calling agent is the
// tower, a worker, or a reviewer. The real tools run against a real temporary
// repository with fake `subagents` / `agentPresets` services.
// Run with: node --test tests/roles.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { registerTowerTools } from '../lib/tool-registry.js'
import { Tower } from '../lib/tower.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-roles-') {
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

function fakeSubagents() {
  let seq = 0
  const activations = []
  return {
    activations,
    list: () => ['spawn'],
    async startActivation(input) {
      seq += 1
      const childId = `child-${seq}`
      activations.push({ ...input, childId })
      return {
        childId,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }], diagnostic: null }),
      }
    },
    async sendMessage() {},
    async listDescendants() {
      return []
    },
  }
}

function makeCtx() {
  const tools = new Map()
  const subagents = fakeSubagents()
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

function execFor(agentId) {
  return { agent: { id: agentId }, signal: undefined }
}

function call(tools, name, args, agentId = 'tower-agent') {
  const tool = tools.get(name)
  assert.ok(tool, `${name} is registered`)
  return tool.execute(args, execFor(agentId))
}

function assertCode(error, code, pattern) {
  assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
  if (pattern) assert.match(error.message, pattern)
  return true
}

/** Init + plan + record a worker directly in the roster (no worktree needed). */
async function rosterWorker(repo, tools, { name = 'worker-m1', agentId = 'agent-worker-1' } = {}) {
  await call(tools, 'tower_init', { repoRoot: repo })
  await call(tools, 'tower_plan', {
    repoRoot: repo,
    missions: [{ title: 'Role case', scope: ['src/**'], tasks: ['write it', 'verify it'] }],
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
  return { workerAgentId: agentId, name }
}

/** Init + plan + spawn a worker through the real tool surface. */
async function spawnWorker(repo, tools, missions = [{ title: 'Role case', scope: ['src/**'], tasks: ['write it', 'verify it'] }]) {
  await call(tools, 'tower_init', { repoRoot: repo })
  const planned = await call(tools, 'tower_plan', { repoRoot: repo, missions })
  const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId: planned.missions[0].id, role: 'worker' })
  return { planned, spawned, workerAgentId: spawned.agentId }
}

test('role enforcement: workers cannot change mission status, scope, blockers or pause metadata', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    const { workerAgentId } = await rosterWorker(repo, tools)
    const tower = await Tower.open(repo)
    const base = await tower.load()
    assert.equal(base.missions[0].status, 'active')

    const deniedPatches = [
      ['status', { status: 'completed' }],
      ['scope', { scope: ['src/**'] }],
      ['clear_blockers', { clear_blockers: true }],
      ['pause_cause', { pause_cause: 'failure' }],
      ['abandon', { status: 'abandoned', note: 'worker cannot abandon' }],
      ['authorization', { authorization: 'ref-1' }],
    ]
    for (const [label, patch] of deniedPatches) {
      const before = await tower.load()
      await assert.rejects(
        () =>
          call(tools, 'tower_mission', { repoRoot: repo, id: 'M1', ...patch }, workerAgentId),
        (error) => assertCode(error, 'not-authorized'),
        `worker ${label} patch must be rejected`,
      )
      const after = await tower.load()
      assert.equal(after.revision, before.revision, `worker ${label} patch must not bump the revision`)
      assert.equal(after.missions[0].status, before.missions[0].status, `worker ${label} patch must not change status`)
      assert.deepEqual(after.missions[0].scope, before.missions[0].scope)
    }
  } finally {
    removeTemp(root)
  }
})

test('workers update tasks, blockers and notes; the tower owns lifecycle; reviewers read findings only', async () => {
  const { root, repo } = seedRepo('dsh-tower-roles-matrix-')
  const { tools, subagents } = makeCtx()
  try {
    const { spawned, workerAgentId } = await spawnWorker(repo, tools)

    const taskDone = await call(tools, 'tower_mission', { repoRoot: repo, id: 'M1', task_done: 'write it' }, workerAgentId)
    assert.equal(taskDone.mission.tasks.find((task) => task.text === 'write it').status, 'done')

    const noted = await call(tools, 'tower_mission', { repoRoot: repo, id: 'M1', note: 'worker note' }, workerAgentId)
    assert.ok(noted.mission.notes.includes('worker note'))

    const blocked = await call(tools, 'tower_mission', { repoRoot: repo, id: 'M1', blocker: 'waiting on input' }, workerAgentId)
    assert.equal(blocked.mission.status, 'blocked')
    assert.deepEqual(blocked.mission.blockers, ['waiting on input'])

    // Only the tower may clear blockers and move the lifecycle forward.
    const resumed = await call(tools, 'tower_mission', { repoRoot: repo, id: 'M1', status: 'active', clear_blockers: true })
    assert.equal(resumed.mission.status, 'active')
    assert.deepEqual(resumed.mission.blockers, [])

    // Reviewer spawn is refused until the mission is completed.
    await assert.rejects(
      () => call(tools, 'tower_spawn', { repoRoot: repo, missionId: 'M1', role: 'reviewer' }),
      (error) => assertCode(error, 'reviewer-prerequisite'),
    )

    // Finish the mission through the worker path.
    const wt = spawned.worktree.path
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'a\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'role case work'])
    await call(tools, 'tower_mission', { repoRoot: repo, id: 'M1', task_done: 'verify it' }, workerAgentId)
    const completed = await call(tools, 'tower_complete', { repoRoot: repo, missionId: 'M1', report: 'done' }, workerAgentId)
    assert.equal(completed.mission.status, 'completed')

    // Now a reviewer can be spawned for the completed mission.
    const reviewer = await call(tools, 'tower_spawn', { repoRoot: repo, missionId: 'M1', role: 'reviewer' })
    assert.equal(reviewer.role, 'reviewer')
    assert.equal(reviewer.preset, 'tower-reviewer')
    assert.equal(subagents.activations.length, 2)
    const reviewerAgentId = reviewer.agentId

    // A worker may not review its own branch.
    await assert.rejects(
      () =>
        call(
          tools,
          'tower_review',
          {
            repoRoot: repo,
            missionId: 'M1',
            status: 'clean',
            merge: 'merge',
            findings: 'none',
            decision: 'self review',
          },
          workerAgentId,
        ),
      /only an assigned reviewer or the tower/,
    )

    const finding = await call(tools, 'tower_finding', {
      repoRoot: repo,
      type: 'bug',
      title: 'role finding',
      summary: 'reviewer read-only check',
      details: 'details',
      suggested_fix: 'fix it',
      missionId: 'M1',
    })

    // Reviewers may read findings but never mutate them.
    const read = await call(tools, 'tower_findings', { repoRoot: repo, id: finding.id }, reviewerAgentId)
    assert.equal(read.finding.id, finding.id)
    await assert.rejects(
      () => call(tools, 'tower_findings', { repoRoot: repo, id: finding.id, status: 'fixed' }, reviewerAgentId),
      (error) => {
        assert.ok(
          ['invalid-transition', 'not-authorized'].includes(error.code),
          `reviewer finding mutation must be a stable denial code, got ${error.code}`,
        )
        assert.match(error.message, /reviewers may list and read/)
        return true
      },
    )
    const untouched = await call(tools, 'tower_findings', { repoRoot: repo, id: finding.id }, reviewerAgentId)
    assert.equal(untouched.finding.status, 'open')

    // A reviewer cannot report completion for the mission.
    await assert.rejects(
      () => call(tools, 'tower_complete', { repoRoot: repo, missionId: 'M1', report: 'nope' }, reviewerAgentId),
      /not a worker/,
    )

    // The reviewer submits the formal verdict; the mission becomes reviewable.
    const review = await call(
      tools,
      'tower_review',
      {
        repoRoot: repo,
        missionId: 'M1',
        status: 'clean',
        merge: 'merge',
        findings: 'none',
        decision: 'role matrix clean',
        checks: ['diff', 'tests'],
      },
      reviewerAgentId,
    )
    assert.equal(review.review.status, 'clean')
    assert.equal(review.missionStatus, 'completed')
    assert.equal(review.review.reviewerRole, 'reviewer')
  } finally {
    removeTemp(root)
  }
})

test('tower-only tools reject a roster worker and start no activations', async () => {
  const { root, repo } = seedRepo('dsh-tower-roles-toweronly-')
  const { tools, subagents } = makeCtx()
  try {
    const { workerAgentId } = await rosterWorker(repo, tools)
    assert.equal(subagents.activations.length, 0)

    const towerOnlyCalls = [
      ['tower_plan', { missions: [{ title: 'Worker plan', scope: ['x/**'] }] }],
      ['tower_spawn', { missionId: 'M1', role: 'worker' }],
      ['tower_merge', { missionId: 'M1' }],
      ['tower_teardown', {}],
      ['tower_adopt', {}],
      ['tower_interrupt', { to: 'worker-m1' }],
      ['tower_init', {}],
    ]
    for (const [name, args] of towerOnlyCalls) {
      await assert.rejects(
        () => call(tools, name, { repoRoot: repo, ...args }, workerAgentId),
        (error) => assertCode(error, 'not-authorized', /only the tower/),
        `${name} must be tower-only`,
      )
    }

    // None of the denied calls ran an activation or created work.
    assert.equal(subagents.activations.length, 0, 'denied tower-only calls must not spawn agents')
    const tower = await Tower.open(repo)
    const state = await tower.load()
    assert.equal(state.missions.length, 1)
    assert.equal(state.roster.filter((entry) => entry.role === 'worker').length, 1)

    // And the tower itself can still plan and tear down.
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Tower plan', scope: ['y/**'] }],
    })
    assert.equal(planned.missions[0].id, 'M2')
    const torn = await call(tools, 'tower_teardown', { repoRoot: repo })
    assert.equal(torn.ok, true)
  } finally {
    removeTemp(root)
  }
})
