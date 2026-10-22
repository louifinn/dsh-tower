// Integration coverage for the 2.1 additions: test discovery/admission,
// batches, leases, legacy import/map, doctor, references/review policy,
// stale-worker gating, board location and delivery acknowledgements.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { registerTowerTools } from '../lib/tool-registry.js'
import { Tower } from '../lib/tower.js'
import { Config, resolveTowerConfig } from '../lib/config.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-21-'))
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
  let seq = 0
  const subagents = {
    list: () => ['spawn'],
    startActivation: async (input) => {
      seq += 1
      const childId = options.childId ?? `child-${seq}`
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
    interrupt: () => {},
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
      if (name === 'hmr') return undefined
      return undefined
    },
    emit() {},
    tools: { register: (definition) => (tools.set(definition.name, definition), () => {}), guard: () => () => {}, restrict() {} },
    systemPrompt: { section() {} },
    inject(_deps, callback) { callback(ctx) },
  }
  return { ctx, tools, activations }
}

const towerExec = { agent: { id: 'tower-agent' } }
const call = (tools, name, args, exec = towerExec) => tools.get(name).execute(args, exec)

async function initPlan(tools, repo, missions = [{ title: 'M one', scope: ['src/**'] }]) {
  await call(tools, 'tower_init', { repoRoot: repo })
  return call(tools, 'tower_plan', { repoRoot: repo, missions })
}

test('2.1 plan: references and review exemption fields round-trip and validate', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{
        title: 'Exempt',
        scope: ['src/**'],
        references: ['docs/spec.md', 'README.md'],
        reviewPolicy: 'none',
        reviewExemptionReason: 'user-approved documentation-only change',
      }],
    })
    assert.deepEqual(planned.missions[0].references, ['docs/spec.md', 'README.md'])
    assert.equal(planned.missions[0].reviewPolicy, 'none')
    await assert.rejects(
      () => call(tools, 'tower_plan', { repoRoot: repo, missions: [{ title: 'Bad', scope: ['src/**'], reviewPolicy: 'none' }] }),
      /reviewExemptionReason/,
    )
  } finally {
    removeTemp(root)
  }
})

test('2.1 discovery: tower_test records a receipt, completion adds the tests check, batch closes', async () => {
  const { root, repo } = makeRepo()
  writeRepoConfig(repo, { tests: { admission: 'complete' } })
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const planned = await initPlan(tools, repo)
    const missionId = planned.missions[0].id
    const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    const pkg = {
      name: 'fixture',
      version: '1.0.0',
      tower: {
        testDiscovery: {
          version: 1,
          commands: [{ id: 'smoke', command: "node -e \"console.log('ok 1 - pass'); console.log('1..1')\"", format: 'node-tap' }],
        },
      },
    }
    fs.writeFileSync(path.join(spawned.worktree.path, 'package.json'), JSON.stringify(pkg))
    fs.mkdirSync(path.join(spawned.worktree.path, 'src'), { recursive: true })
    fs.writeFileSync(path.join(spawned.worktree.path, 'src', 'a.txt'), 'a\n')
    git(spawned.worktree.path, ['add', '-A'])
    git(spawned.worktree.path, ['commit', '-m', 'work'])

    const tested = await call(tools, 'tower_test', { repoRoot: repo, missionId })
    assert.equal(tested.configured, true)
    assert.equal(tested.ok, true)
    assert.equal(tested.tests.length, 1)

    const workerExec = { agent: { id: spawned.agentId } }
    await call(tools, 'tower_mission', { repoRoot: repo, missionId, taskDone: 'do it' }, workerExec).catch(() => {})
    const towerView = await (await Tower.open(repo)).missionDetail(missionId)
    for (const task of towerView.mission.tasks.filter((item) => item.status === 'open')) {
      await call(tools, 'tower_mission', { repoRoot: repo, missionId, taskDone: task.text }, workerExec)
    }
    const completed = await call(tools, 'tower_complete', { repoRoot: repo, missionId, report: 'done' }, workerExec)
    assert.ok(completed.mission.completionReport.checks.some((check) => check.name === 'tests'))

    const created = await call(tools, 'tower_batch', {
      repoRoot: repo,
      action: 'create',
      missionIds: [missionId],
      requiredChecks: ['tests'],
    })
    assert.equal(created.ok, true)
    assert.equal(created.batch.status, 'open')
    const closed = await call(tools, 'tower_batch', {
      repoRoot: repo,
      action: 'close',
      batchId: created.batch.id,
      receiptPaths: [],
    })
    assert.equal(closed.ok, true)
    assert.equal(closed.batch.status, 'closed')
  } finally {
    removeTemp(root)
  }
})

test('2.1 discovery: a failing command blocks completion with tests-failed', async () => {
  const { root, repo } = makeRepo()
  writeRepoConfig(repo, { tests: { admission: 'complete' } })
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const planned = await initPlan(tools, repo)
    const missionId = planned.missions[0].id
    const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    fs.writeFileSync(
      path.join(spawned.worktree.path, 'package.json'),
      JSON.stringify({ name: 'x', version: '1.0.0', tower: { testDiscovery: { version: 1, commands: [{ id: 'fail', command: 'node -e "process.exit(3)"', format: 'node-tap' }] } } }),
    )
    git(spawned.worktree.path, ['add', '-A'])
    git(spawned.worktree.path, ['commit', '-m', 'failing tests'])
    const failed = await call(tools, 'tower_test', { repoRoot: repo, missionId })
    assert.equal(failed.ok, false)
    assert.match(String(failed.error), /fail|exit/i)
    const workerExec = { agent: { id: spawned.agentId } }
    await assert.rejects(
      () => call(tools, 'tower_complete', { repoRoot: repo, missionId, report: 'done' }, workerExec),
      /\[tower:tests-failed\]/,
    )
  } finally {
    removeTemp(root)
  }
})

test('2.1 leases: acquire/status/release, conflict, and spawn.requireLease', async () => {
  const { root, repo } = makeRepo()
  writeRepoConfig(repo, { spawn: { requireLease: 'heavy-ci' } })
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const planned = await initPlan(tools, repo)
    const missionId = planned.missions[0].id
    await assert.rejects(
      () => call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' }),
      /\[tower:lease-busy\]/,
    )
    const acquired = await call(tools, 'tower_resource', { repoRoot: repo, action: 'acquire', name: 'heavy-ci' })
    assert.equal(acquired.ok, true)
    const token = acquired.lease.token
    await assert.rejects(
      () => call(tools, 'tower_resource', { repoRoot: repo, action: 'acquire', name: 'heavy-ci', token: 'other' }),
      /\[tower:lease-busy\]/,
    )
    const status = await call(tools, 'tower_resource', { repoRoot: repo, action: 'status' })
    assert.equal(status.leases.length, 1)
    await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    const released = await call(tools, 'tower_resource', { repoRoot: repo, action: 'release', name: 'heavy-ci', token })
    assert.equal(released.released, true)
  } finally {
    removeTemp(root)
  }
})

test('2.1 legacy: import a Codex-shaped snapshot and audit-map it to a mission', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const planned = await initPlan(tools, repo)
    const legacyFile = path.join(root, 'legacy-state.json')
    fs.writeFileSync(legacyFile, JSON.stringify({
      schemaVersion: 1,
      repoRoot: repo,
      baseBranch: 'main',
      revision: 3,
      nextMissionId: 2,
      missions: [{
        id: 'T0001',
        title: 'Legacy mission',
        kind: 'build',
        status: 'paused',
        scope: ['src/**'],
        deps: [],
        tasks: [],
        reviews: [],
        notes: [],
        resources: [],
        reviewPolicy: 'required-clean',
        branch: 'tower/legacy',
        worktree: null,
      }],
      events: [],
      legacySnapshots: [],
    }))
    const imported = await call(tools, 'tower_import_legacy', { repoRoot: repo, sourcePath: legacyFile })
    assert.equal(imported.ok, true)
    assert.equal(imported.summary.missionCount, 1)
    assert.ok(imported.summary.sourceHash)
    const mapped = await call(tools, 'tower_legacy_map', {
      repoRoot: repo,
      action: 'map',
      sourceHash: imported.summary.sourceHash,
      oldId: 'T0001',
      newMissionId: planned.missions[0].id,
    })
    assert.equal(mapped.ok, true)
    assert.equal(mapped.map.oldId, 'T0001')
    const listed = await call(tools, 'tower_legacy_map', { repoRoot: repo, action: 'status' })
    assert.equal(listed.maps.length, 1)
  } finally {
    removeTemp(root)
  }
})

test('2.1 doctor: reports repository, state and worktree checks without writing', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await initPlan(tools, repo)
    const doctor = await call(tools, 'tower_doctor', { repoRoot: repo })
    assert.equal(doctor.ok, true)
    assert.ok(doctor.checks.some((check) => check.id === 'state' && check.status === 'pass'))
    assert.ok(doctor.checks.some((check) => check.id === 'git'))
    assert.equal(doctor.environmentContract.repoRoot, repo)
    // #86: the field is populated on every runner (Linux and Windows), not only
    // on the platform the suite was written on.
    assert.equal(doctor.environmentContract.platform, process.platform)
  } finally {
    removeTemp(root)
  }
})

test('2.1 governance: watchdog marks a quiet worker stale and the gate blocks merge', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx({ pending: true })
  registerTowerTools(ctx)
  try {
    const planned = await initPlan(tools, repo)
    const missionId = planned.missions[0].id
    await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    const tower = await Tower.open(repo)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const swept = await tower.sweepRoster({ staleMs: 1, activity: {}, authoritative: true })
    assert.equal(swept.marked.length, 1)
    const preflight = await call(tools, 'tower_preflight', { repoRoot: repo, missionId })
    assert.ok(preflight.blockers.some((blocker) => blocker.code === 'worker-stale'))
  } finally {
    removeTemp(root)
  }
})

test('2.1 board/docs: boardLocation repo writes MISSIONS.md at the repository root', async () => {
  const { root, repo } = makeRepo()
  writeRepoConfig(repo, { docs: { boardLocation: 'repo' } })
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await initPlan(tools, repo)
    assert.equal(fs.existsSync(path.join(repo, 'MISSIONS.md')), true)
    assert.equal(fs.existsSync(path.join(repo, '.git', 'dsh-tower', 'MISSIONS.md')), false)
  } finally {
    removeTemp(root)
  }
})

test('2.1 review exemption: gate blocks by default and honors the opt-in with a reason', async () => {
  const { root, repo } = makeRepo()
  // Reviews are optional by default; enable the global gate to test exemption.
  writeRepoConfig(repo, { review: { requireReview: true } })
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'No review', scope: ['src/**'], reviewPolicy: 'none', reviewExemptionReason: 'user approved' }],
    })
    const missionId = planned.missions[0].id
    const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    fs.mkdirSync(path.join(spawned.worktree.path, 'src'), { recursive: true })
    fs.writeFileSync(path.join(spawned.worktree.path, 'src', 'a.txt'), 'a\n')
    git(spawned.worktree.path, ['add', '-A'])
    git(spawned.worktree.path, ['commit', '-m', 'work'])
    const workerExec = { agent: { id: spawned.agentId } }
    for (const task of (await (await Tower.open(repo)).missionDetail(missionId)).mission.tasks) {
      await call(tools, 'tower_mission', { repoRoot: repo, missionId, taskDone: task.text }, workerExec)
    }
    await call(tools, 'tower_complete', { repoRoot: repo, missionId, report: 'done' }, workerExec)
    const before = await (await Tower.open(repo)).evaluateGate({ missionId, activity: {} })
    assert.ok(before.blockers.some((blocker) => blocker.code === 'review-exemption-invalid'))
    writeRepoConfig(repo, { review: { requireReview: true }, gates: { allowReviewExemption: true } })
    const after = await (await Tower.open(repo)).evaluateGate({ missionId, activity: {} })
    assert.equal(after.blockers.some((blocker) => blocker.code === 'review-exemption-invalid'), false)
    assert.equal(after.blockers.some((blocker) => blocker.code === 'no-review'), false)
  } finally {
    removeTemp(root)
  }
})

test('2.1 test admission: a failing spawn-time discovery starts no child', async () => {
  const { root, repo } = makeRepo()
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'x', version: '1.0.0', tower: { testDiscovery: { version: 1, commands: [{ id: 'fail', command: 'node -e "process.exit(2)"', format: 'node-tap' }] } } }),
  )
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'failing discovery'])
  writeRepoConfig(repo, { tests: { admission: 'spawn' } })
  const { ctx, tools, activations } = makeCtx()
  registerTowerTools(ctx)
  try {
    const planned = await initPlan(tools, repo)
    await assert.rejects(
      () => call(tools, 'tower_spawn', { repoRoot: repo, missionId: planned.missions[0].id, role: 'worker' }),
      /\[tower:tests-failed\]/,
    )
    assert.equal(activations.length, 0)
  } finally {
    removeTemp(root)
  }
})

test('2.1 gates.requireTests: a completed mission without a test run is blocked', async () => {
  const { root, repo } = makeRepo()
  writeRepoConfig(repo, { gates: { requireTests: true } })
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const planned = await initPlan(tools, repo)
    const missionId = planned.missions[0].id
    const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    fs.mkdirSync(path.join(spawned.worktree.path, 'src'), { recursive: true })
    fs.writeFileSync(path.join(spawned.worktree.path, 'src', 'a.txt'), 'a\n')
    git(spawned.worktree.path, ['add', '-A'])
    git(spawned.worktree.path, ['commit', '-m', 'work'])
    const workerExec = { agent: { id: spawned.agentId } }
    for (const task of (await (await Tower.open(repo)).missionDetail(missionId)).mission.tasks) {
      await call(tools, 'tower_mission', { repoRoot: repo, missionId, taskDone: task.text }, workerExec)
    }
    await call(tools, 'tower_complete', { repoRoot: repo, missionId, report: 'done' }, workerExec)
    const gate = await (await Tower.open(repo)).evaluateGate({ missionId, activity: {} })
    assert.ok(gate.blockers.some((blocker) => blocker.code === 'tests-missing'))
  } finally {
    removeTemp(root)
  }
})

test('2.1 doctor: an uninitialized repository reports state failure instead of throwing', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const doctor = await call(tools, 'tower_doctor', { repoRoot: repo })
    assert.equal(doctor.ok, false)
    assert.ok(doctor.checks.some((check) => check.id === 'state' && check.status === 'fail'))
  } finally {
    removeTemp(root)
  }
})

test('2.1 batch: close returns structured blockers when evidence is missing', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const planned = await initPlan(tools, repo)
    const missionId = planned.missions[0].id
    const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    fs.mkdirSync(path.join(spawned.worktree.path, 'src'), { recursive: true })
    fs.writeFileSync(path.join(spawned.worktree.path, 'src', 'a.txt'), 'a\n')
    git(spawned.worktree.path, ['add', '-A'])
    git(spawned.worktree.path, ['commit', '-m', 'work'])
    const workerExec = { agent: { id: spawned.agentId } }
    for (const task of (await (await Tower.open(repo)).missionDetail(missionId)).mission.tasks) {
      await call(tools, 'tower_mission', { repoRoot: repo, missionId, taskDone: task.text }, workerExec)
    }
    await call(tools, 'tower_complete', { repoRoot: repo, missionId, report: 'done' }, workerExec)
    const created = await call(tools, 'tower_batch', {
      repoRoot: repo,
      action: 'create',
      missionIds: [missionId],
      requiredChecks: ['missing-check'],
    })
    const closed = await call(tools, 'tower_batch', { repoRoot: repo, action: 'close', batchId: created.batch.id })
    assert.equal(closed.ok, false)
    assert.ok(closed.blockers.length > 0)
    assert.ok(closed.blockers.every((blocker) => typeof blocker.code === 'string' && typeof blocker.detail === 'string'))
    assert.equal(closed.batch.status, 'open')
  } finally {
    removeTemp(root)
  }
})

test('2.1 merge intent: a crash intent that created no commit is cleared by tower_merge', async () => {
  const { root, repo } = makeRepo()
  writeRepoConfig(repo, { gates: { allowReviewExemption: true } })
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Exempt merge', scope: ['src/**'], reviewPolicy: 'none', reviewExemptionReason: 'user approved' }],
    })
    const missionId = planned.missions[0].id
    const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    fs.mkdirSync(path.join(spawned.worktree.path, 'src'), { recursive: true })
    fs.writeFileSync(path.join(spawned.worktree.path, 'src', 'a.txt'), 'a\n')
    git(spawned.worktree.path, ['add', '-A'])
    git(spawned.worktree.path, ['commit', '-m', 'work'])
    const workerExec = { agent: { id: spawned.agentId } }
    for (const task of (await (await Tower.open(repo)).missionDetail(missionId)).mission.tasks) {
      await call(tools, 'tower_mission', { repoRoot: repo, missionId, taskDone: task.text }, workerExec)
    }
    await call(tools, 'tower_complete', { repoRoot: repo, missionId, report: 'done' }, workerExec)
    const tower = await Tower.open(repo)
    const statePath = tower.paths.state
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    state.mergeIntent = {
      missionId,
      baseTip: git(repo, ['rev-parse', 'HEAD']),
      branchTip: git(spawned.worktree.path, ['rev-parse', 'HEAD']),
      startedAt: Date.now(),
    }
    state.revision += 1
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
    const merged = await call(tools, 'tower_merge', { repoRoot: repo, missionId }, towerExec)
    assert.equal(merged.ok, true, JSON.stringify(merged.blockers ?? []))
    const after = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    assert.equal(after.mergeIntent ?? null, null)
    assert.equal(after.missions.find((mission) => mission.id === missionId).status, 'merged')
  } finally {
    removeTemp(root)
  }
})

test('2.0.1 config: explicit legacy allowAgentControl survives Cordis schema defaults', () => {
  const parsed = Config({ allowAgentControl: true, mode: { workspaceLock: true } })
  assert.equal(parsed.allowAgentControl, true)
  assert.equal(parsed.mode.allowAgentControl, undefined)
  assert.equal(resolveTowerConfig(parsed).mode.allowAgentControl, true)
  assert.equal(resolveTowerConfig({}).mode.allowAgentControl, true)
  assert.equal(resolveTowerConfig({ mode: { allowAgentControl: false } }).mode.allowAgentControl, false)
  assert.equal(resolveTowerConfig({}).review.requireReview, false)
  assert.equal(resolveTowerConfig({ review: { requireReview: true } }).review.requireReview, true)
})

test('2.0.1 preflight: an unknown mission returns a lossless blocker shape', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const result = await call(tools, 'tower_preflight', { repoRoot: repo, missionId: 'M99' })
    assert.equal(result.ok, false)
    assert.equal(result.missionId, 'M99')
    assert.equal(result.branchTip, null)
    assert.equal(result.baseTip, null)
    assert.deepEqual(result.changedFiles, [])
    assert.equal(result.review, null)
    assert.ok(result.blockers.some((blocker) => blocker.code === 'mission-missing'))
  } finally {
    removeTemp(root)
  }
})

test('2.0.1 plan: an unknown dependency is an actionable invalid-argument', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    await assert.rejects(
      () => call(tools, 'tower_plan', {
        repoRoot: repo,
        missions: [{ title: 'Dependent', scope: ['dep.txt'], deps: ['M42'] }],
      }),
      (error) => {
        assert.equal(error.code, 'invalid-argument')
        assert.match(error.message, /depends on unknown mission/)
        return true
      },
    )
  } finally {
    removeTemp(root)
  }
})

test('2.0.1 spawn: a worker cannot be spawned on a merged or abandoned mission', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools, activations } = makeCtx()
  registerTowerTools(ctx)
  try {
    const planned = await initPlan(tools, repo)
    const missionId = planned.missions[0].id
    const tower = await Tower.open(repo)
    const state = await tower.load()
    state.missions[0].status = 'merged'
    fs.writeFileSync(tower.paths.state, JSON.stringify(state, null, 2))
    await assert.rejects(
      () => call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' }),
      /\[tower:invalid-transition\].*merged/,
    )
    assert.equal(activations.length, 0)
  } finally {
    removeTemp(root)
  }
})

test('2.0.1 batch: close accepts a merged member and abandon retires a stale batch', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const planned = await initPlan(tools, repo)
    const missionId = planned.missions[0].id
    const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    fs.mkdirSync(path.join(spawned.worktree.path, 'src'), { recursive: true })
    fs.writeFileSync(path.join(spawned.worktree.path, 'src', 'a.txt'), 'a\n')
    git(spawned.worktree.path, ['add', '-A'])
    git(spawned.worktree.path, ['commit', '-m', 'work'])
    const workerExec = { agent: { id: spawned.agentId } }
    for (const task of (await (await Tower.open(repo)).missionDetail(missionId)).mission.tasks) {
      await call(tools, 'tower_mission', { repoRoot: repo, missionId, taskDone: task.text }, workerExec)
    }
    await call(tools, 'tower_complete', { repoRoot: repo, missionId, report: 'done' }, workerExec)
    const created = await call(tools, 'tower_batch', {
      repoRoot: repo,
      action: 'create',
      missionIds: [missionId],
      requiredChecks: ['check'],
    })
    const tower = await Tower.open(repo)
    const state = await tower.load()
    state.missions[0].status = 'merged'
    state.missions[0].mergedCommit = 'f'.repeat(40)
    fs.writeFileSync(tower.paths.state, JSON.stringify(state, null, 2))
    const closed = await call(tools, 'tower_batch', {
      repoRoot: repo,
      action: 'close',
      batchId: created.batch.id,
      checks: [{ name: 'check', exitCode: 0, evidence: 'ok' }],
    })
    assert.equal(closed.ok, true, JSON.stringify(closed.blockers))
    assert.equal(closed.batch.status, 'closed')

    const stale = await call(tools, 'tower_batch', {
      repoRoot: repo,
      action: 'create',
      missionIds: [missionId],
    })
    const abandoned = await call(tools, 'tower_batch', {
      repoRoot: repo,
      action: 'abandon',
      batchId: stale.batch.id,
      reason: 'superseded',
    })
    assert.equal(abandoned.ok, true)
    assert.equal(abandoned.batch.status, 'abandoned')
    assert.equal(abandoned.batch.abandonReason, 'superseded')
  } finally {
    removeTemp(root)
  }
})

test('2.0.1 doctor: an intentionally removed worktree is not a failure', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const planned = await initPlan(tools, repo)
    const tower = await Tower.open(repo)
    const state = await tower.load()
    state.missions[0].worktree = {
      path: path.join(root, 'removed-worktree'),
      branch: 'tower/removed',
      baseCommit: 'a'.repeat(40),
    }
    state.missions[0].worktreeRemovedAt = Date.now()
    fs.writeFileSync(tower.paths.state, JSON.stringify(state, null, 2))
    const doctor = await call(tools, 'tower_doctor', { repoRoot: repo })
    const worktrees = doctor.checks.find((check) => check.id === 'worktrees')
    assert.equal(worktrees.status, 'pass')
    assert.match(worktrees.detail, /removed by teardown/)
  } finally {
    removeTemp(root)
  }
})

test('2.0.3 review toggle: review.requireReview:false allows a merge without a reviewer', async () => {
  const { root, repo } = makeRepo()
  writeRepoConfig(repo, { review: { requireReview: false } })
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const planned = await initPlan(tools, repo)
    const missionId = planned.missions[0].id
    const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    fs.mkdirSync(path.join(spawned.worktree.path, 'src'), { recursive: true })
    fs.writeFileSync(path.join(spawned.worktree.path, 'src', 'a.txt'), 'a\n')
    git(spawned.worktree.path, ['add', '-A'])
    git(spawned.worktree.path, ['commit', '-m', 'work'])
    const workerExec = { agent: { id: spawned.agentId } }
    for (const task of (await (await Tower.open(repo)).missionDetail(missionId)).mission.tasks) {
      await call(tools, 'tower_mission', { repoRoot: repo, missionId, taskDone: task.text }, workerExec)
    }
    await call(tools, 'tower_complete', { repoRoot: repo, missionId, report: 'done' }, workerExec)
    const preflight = await call(tools, 'tower_preflight', { repoRoot: repo, missionId })
    assert.equal(preflight.blockers.some((blocker) => blocker.code === 'no-review'), false)
    const merged = await call(tools, 'tower_merge', { repoRoot: repo, missionId })
    assert.equal(merged.ok, true, JSON.stringify(merged.blockers))
    assert.ok(merged.mergedCommit)
  } finally {
    removeTemp(root)
  }
})

test('2.1 delivery: inbox records an acknowledgement timestamp', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    const planned = await initPlan(tools, repo)
    const spawned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId: planned.missions[0].id, role: 'worker' })
    await call(tools, 'tower_send', { repoRoot: repo, to: spawned.name, subject: 'hello', body: 'read me' })
    const inbox = await call(
      tools,
      'tower_inbox',
      { repoRoot: repo, agent: spawned.name },
      { agent: { id: spawned.agentId } },
    )
    assert.equal(inbox.messages.length, 1)
    assert.ok(inbox.messages[0].ackAt)
  } finally {
    removeTemp(root)
  }
})
