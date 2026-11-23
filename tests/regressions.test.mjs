// Regression tests for bugs found during the 2.0 review round.
// Run with: node --test "tests/*.test.mjs"
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { registerTowerTools } from '../host/tool-registry.js'
import { __testResetComponentRegistry, registerComponent } from '../host/capability-registry.js'
import { Tower } from '../host/tower.js'
import { loadModes, saveModes } from '../host/modeStore.js'

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

afterEach(() => {
  __testResetComponentRegistry()
})

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
    removeTemp(root)
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
    removeTemp(root)
  }
})

test('regression: actionable refusals carry explicit stable codes', async () => {
  const { classifyError, TowerToolError } = await import('../domain/errors.js')
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
    removeTemp(root)
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
    const takeover = await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker', op: 'takeover' })
    assert.equal(takeover.name, 'worker-m1-3')
    const after = await (await Tower.open(repo)).rosterView()
    assert.equal(after.roster.filter((entry) => entry.missionId === missionId && entry.role === 'worker' && entry.state !== 'retired').length, 1)
  } finally {
    removeTemp(root)
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
    const preflight = await call(tools, 'tower_inspect', { view: 'preflight', repoRoot: repo, missionId }, { agent: { id: 'tower-agent' } })
    assert.ok(preflight.blockers.some((blocker) => blocker.code === 'no-check-evidence'))
  } finally {
    removeTemp(root)
  }
})

test('regression: the tower-board row suppresses MISSIONS.md; the removed docs.board key is rejected (#133)', async () => {
  // Row off: the board file is never written, exactly as docs.board:false used to.
  const offRepo = makeRepo()
  const offCtx = makeCtx()
  registerTowerTools(offCtx.ctx)
  try {
    await call(offCtx.tools, 'tower_init', { repoRoot: offRepo.repo })
    await call(offCtx.tools, 'tower_plan', {
      repoRoot: offRepo.repo,
      missions: [{ title: 'No board', scope: ['src/**'] }],
    })
    assert.equal(
      fs.existsSync(path.join(offRepo.repo, '.git', 'dsh-tower', 'MISSIONS.md')),
      false,
      'a disabled tower-board row must suppress the board file',
    )
    // Row on: the same tool call refreshes the board.
    const onRepo = makeRepo()
    registerComponent('tower-board')
    const onCtx = makeCtx()
    registerTowerTools(onCtx.ctx)
    try {
      await call(onCtx.tools, 'tower_init', { repoRoot: onRepo.repo })
      await call(onCtx.tools, 'tower_plan', {
        repoRoot: onRepo.repo,
        missions: [{ title: 'Board', scope: ['src/**'] }],
      })
      assert.equal(fs.existsSync(path.join(onRepo.repo, '.git', 'dsh-tower', 'MISSIONS.md')), true)
    } finally {
      removeTemp(onRepo.root)
    }
    // Upgrade path: a legacy config fails as unknown with a pointer to the row.
    const legacyRepo = makeRepo()
    writeRepoConfig(legacyRepo.repo, { docs: { board: false } })
    await assert.rejects(
      () => call(onCtx.tools, 'tower_init', { repoRoot: legacyRepo.repo }),
      (error) =>
        error.code === 'config-unknown-key' &&
        /docs\.board/.test(error.message) &&
        /tower-board/.test(error.message) &&
        /docs\/adr\/0005-component-surface\.md/.test(error.message),
    )
    removeTemp(legacyRepo.root)
  } finally {
    removeTemp(offRepo.root)
  }
})

test('regression: user-paused resume can require authorization', async () => {
  const { root, repo } = makeRepo()
  writeRepoConfig(repo, { mode: { requireResumeAuthorization: true } })
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Pause rule', scope: ['src/**'] }],
    })
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
    removeTemp(root)
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
    removeTemp(dir)
  }
})

test('regression: mode store reclaims a lock whose PID is dead', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-modes-lock-'))
  try {
    fs.writeFileSync(path.join(dir, 'modes.lock'), JSON.stringify({ pid: 999999, token: 'dead', at: 1 }))
    assert.equal(saveModes(new Map([['s', { on: true, at: 1 }]]), dir), true)
    assert.equal(fs.existsSync(path.join(dir, 'modes.lock')), false)
  } finally {
    removeTemp(dir)
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
    removeTemp(dir)
  }
})

// #217: tower_plan could only create. A dry run must answer "what would this
// plan do" without creating missions, bumping the revision, or writing
// activity; keys let one plan refer to its own siblings before ids exist.
function makePlanRepo() {
  const { root, repo } = makeRepo()
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'export const a = 1\n')
  fs.mkdirSync(path.join(repo, 'lib'))
  fs.writeFileSync(path.join(repo, 'lib', 'b.js'), 'export const b = 2\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'more tracked files'])
  return { root, repo }
}

test('regression: tower_plan dry_run previews per-mission ids and keys without writing state', async () => {
  const { root, repo } = makePlanRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    const before = await tower.load()
    const preview = await call(tools, 'tower_plan', {
      repoRoot: repo,
      dry_run: true,
      missions: [
        { title: 'Foundation', key: 'foundation', scope: ['src/**'], tasks: ['write it'] },
        { title: 'Follower', key: 'follower', scope: ['src/a.js'], deps: ['foundation'] },
      ],
    })
    assert.equal(preview.dry_run, true)
    assert.equal(preview.ok, true)
    assert.equal(preview.revision, before.revision)
    assert.deepEqual(preview.missions.map((mission) => mission.wouldBeId), ['M1', 'M2'])
    assert.deepEqual(preview.missions.map((mission) => mission.key), ['foundation', 'follower'])
    assert.deepEqual(preview.missions[1].deps, ['M1'])
    assert.deepEqual(preview.missions[1].overlaps, ['M1'])
    const after = await (await Tower.open(repo)).load()
    assert.equal(after.revision, before.revision, 'a dry run must not bump the revision')
    assert.equal(after.missions.length, 0, 'a dry run must not create missions')
    const rejected = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Only explicit', scope: ['lib/**'] }],
    })
    assert.equal(rejected.missions[0].id, 'M1', 'the preview ids must not be reserved')
  } finally {
    removeTemp(root)
  }
})

test('regression: tower_plan resolves plan-local keys to the ids it assigns', async () => {
  const { root, repo } = makePlanRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [
        { title: 'Foundation', key: 'foundation', scope: ['src/**'] },
        { title: 'Follower', key: 'follower', scope: ['lib/**'], deps: ['foundation'] },
      ],
    })
    assert.deepEqual(planned.missions.map((mission) => mission.id), ['M1', 'M2'])
    assert.deepEqual(planned.missions[1].deps, ['M1'])
    assert.equal(planned.missions[0].key, undefined, 'the plan-local key is not persisted')
    assert.equal(planned.missions[1].key, undefined)
  } finally {
    removeTemp(root)
  }
})

test('regression: tower_plan reports every invalid entry instead of stopping at the first', async () => {
  const { root, repo } = makePlanRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    const before = await tower.load()
    await assert.rejects(
      () =>
        call(tools, 'tower_plan', {
          repoRoot: repo,
          missions: [
            { title: '', scope: ['src/missing.js'] },
            { title: 'Second', scope: ['src/**'], deps: ['M9'] },
            { title: 'Third', scope: ['lib/**'], deps: ['missing-key'] },
          ],
        }),
      (error) => {
        assert.equal(error.code, 'invalid-argument')
        assert.ok(Array.isArray(error.details?.problems), 'the complete problem set travels in details.problems')
        assert.ok(error.details.problems.length >= 4, `expected at least four problems, saw ${error.details.problems.length}: ${JSON.stringify(error.details.problems)}`)
        return true
      },
    )
    const after = await (await Tower.open(repo)).load()
    assert.equal(after.revision, before.revision, 'a rejected plan must not bump the revision')
    assert.equal(after.missions.length, 0, 'a rejected plan must not create a prefix of the batch')
  } finally {
    removeTemp(root)
  }
})

test('regression: tower_plan dry_run reports all problems and never throws', async () => {
  const { root, repo } = makePlanRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const preview = await call(tools, 'tower_plan', {
      repoRoot: repo,
      dry_run: true,
      missions: [
        { title: '', scope: ['src/missing.js'] },
        { title: 'Bad key', key: 'M7', scope: ['src/**'] },
        { title: 'Duplicate key', key: 'base', scope: ['src/**'] },
        { title: 'Duplicate key again', key: 'base', scope: ['lib/**'] },
      ],
    })
    assert.equal(preview.dry_run, true)
    assert.equal(preview.ok, false)
    assert.ok(preview.problems.length >= 4, `expected the full problem list, saw ${preview.problems.length}`)
    const kinds = new Set(preview.problems.map((problem) => problem.kind))
    assert.ok(kinds.has('key'), `the key problems must be reported: ${JSON.stringify(preview.problems)}`)
    assert.ok(kinds.has('scope'), 'the scope problem must be reported')
    assert.ok(kinds.has('mission'), 'the invalid title must be reported')
    assert.equal((await (await Tower.open(repo)).load()).missions.length, 0)
  } finally {
    removeTemp(root)
  }
})

// #218: `spawn.nodeModules: "link"` gives a worktree the baseline checkout's
// installed dependencies as a recorded junction. Teardown relies on that record
// to unlink only the link, so the link must be visible in both mission.worktree
// and the roster row, and the default must stay "none".
function seedNodeModules(repo) {
  const target = path.join(repo, 'node_modules')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'sentinel.txt'), 'keep\n')
  return target
}

test('regression: spawn.nodeModules link creates and records a worktree junction', async () => {
  const { root, repo } = makeRepo()
  const target = seedNodeModules(repo)
  writeRepoConfig(repo, { spawn: { nodeModules: 'link' } })
  const { ctx, tools, activations } = makeCtx()
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    await call(tools, 'tower_plan', { repoRoot: repo, missions: [{ title: 'Linked worktree', scope: ['README.md'] }] })
    const report = await call(tools, 'tower_spawn', {
      repoRoot: repo,
      missionId: 'M1',
      role: 'worker',
      worktreeRoot: path.join(root, 'worktrees'),
    })

    assert.equal(activations.length, 1)
    assert.equal(report.nodeModulesLink.target, target)
    const linkPath = path.join(report.worktree.path, 'node_modules')
    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true, 'the worktree node_modules is a junction')
    assert.equal(fs.readFileSync(path.join(linkPath, 'sentinel.txt'), 'utf8'), 'keep\n', 'the linked dependencies are readable')

    const tower = await Tower.open(repo)
    const state = await tower.load()
    assert.equal(state.missions[0].worktree.nodeModulesLink.target, target)
    assert.equal(state.missions[0].worktree.nodeModulesLink.path, linkPath)
    const row = state.roster.find((entry) => entry.name === 'worker-m1')
    assert.equal(row.nodeModulesLink.target, target, 'the roster row records the same link for teardown')
  } finally {
    removeTemp(root)
  }
})

test('regression: spawn.nodeModules defaults to none and creates no link', async () => {
  const { root, repo } = makeRepo()
  seedNodeModules(repo)
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    await call(tools, 'tower_plan', { repoRoot: repo, missions: [{ title: 'Plain worktree', scope: ['README.md'] }] })
    const report = await call(tools, 'tower_spawn', {
      repoRoot: repo,
      missionId: 'M1',
      role: 'worker',
      worktreeRoot: path.join(root, 'worktrees'),
    })

    assert.equal(report.nodeModulesLink, null)
    assert.equal(fs.existsSync(path.join(report.worktree.path, 'node_modules')), false)
    const state = await (await Tower.open(repo)).load()
    assert.equal(state.missions[0].worktree.nodeModulesLink, undefined)
  } finally {
    removeTemp(root)
  }
})

test('regression: spawn.nodeModules link refuses a baseline with no installed dependencies', async () => {
  const { root, repo } = makeRepo()
  writeRepoConfig(repo, { spawn: { nodeModules: 'link' } })
  const { ctx, tools, activations } = makeCtx()
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    await call(tools, 'tower_plan', { repoRoot: repo, missions: [{ title: 'No dependencies', scope: ['README.md'] }] })
    await assert.rejects(
      () =>
        call(tools, 'tower_spawn', {
          repoRoot: repo,
          missionId: 'M1',
          role: 'worker',
          worktreeRoot: path.join(root, 'worktrees'),
        }),
      (error) => {
        assert.equal(error.code, 'invalid-argument')
        assert.match(error.message, /no installed dependencies at/)
        assert.match(error.message, /install dependencies in/)
        assert.match(error.message, /spawn\.nodeModules to "none"/)
        return true
      },
    )
    assert.equal(activations.length, 0, 'a refused link must not start the child')
    const state = await (await Tower.open(repo)).load()
    assert.equal((state.roster ?? []).length, 0, 'a refused link must not record a reservation')
  } finally {
    removeTemp(root)
  }
})

test('regression: tower_plan key dependencies detect cycles before creating missions', async () => {
  const { root, repo } = makePlanRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    const before = await tower.load()
    await assert.rejects(
      () =>
        call(tools, 'tower_plan', {
          repoRoot: repo,
          missions: [
            { title: 'One', key: 'one', scope: ['src/**'], deps: ['two'] },
            { title: 'Two', key: 'two', scope: ['lib/**'], deps: ['one'] },
          ],
        }),
      (error) => {
        assert.equal(error.code, 'invalid-argument')
        assert.ok(error.details.problems.some((problem) => problem.kind === 'cycle'))
        assert.match(error.details.problems.find((problem) => problem.kind === 'cycle').message, /cycle/)
        return true
      },
    )
    assert.equal((await (await Tower.open(repo)).load()).missions.length, 0)
  } finally {
    removeTemp(root)
  }
})
