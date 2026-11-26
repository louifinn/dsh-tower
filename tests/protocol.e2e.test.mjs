// Protocol end-to-end test through the Tower domain class: real git repository,
// real worktree, no DSH runtime and no model calls.
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'
import { Tower } from '../host/tower.js'
import { registerTowerTools } from '../host/tool-registry.js'
import { validateJsonSchema } from './schema-validator.mjs'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A fresh repository with deterministic line endings (F29: a global
 * core.autocrlf=true rewrites the seed README and makes it look out of scope). */
function initRepo(repo) {
  git(repo, ['init'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
}

/** True when `file` exists at `commit` — a probe, not a command that throws. */
function atCommit(cwd, commit, file) {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}:${file}`], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

/** Minimal `subagents` stand-in: records activations, never calls a model. */
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

/** Register the real tool surface on a minimal host context. */
function makeCtx(services = {}) {
  const tools = new Map()
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      return services[name]
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
  return { ctx, tools }
}

async function call(tools, name, args, exec = { agent: { id: 'tower-e2e' } }) {
  const tool = tools.get(name)
  assert.ok(tool, `${name} is registered`)
  const value = await tool.execute(args, exec)
  const violations = validateJsonSchema(tool.output.schema, value)
  assert.deepEqual(violations, [], `${name}: ${violations.join('; ')}`)
  return value
}

test('tower protocol: init → plan → complete → review → merge → teardown', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-protocol-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)

  try {
    const tower = await Tower.open(repo)
    const initialized = await tower.init({})
    assert.equal(initialized.created, true)
    assert.ok(initialized.base)

    const planned = await tower.plan({
      missions: [
        { title: 'Feature A', scope: ['src/a/**'], tasks: ['write a', 'commit a'] },
        { title: 'Feature B', scope: ['src/b/**'], tasks: ['write b'] },
      ],
    })
    assert.equal(planned.missions.length, 2)
    const mission = planned.missions[0]

    const provisioned = await tower.provision({ missionId: mission.id })
    const wt = provisioned.worktree.path
    assert.ok(fs.existsSync(wt))
    fs.mkdirSync(path.join(wt, 'src', 'a'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'src', 'a', 'out.txt'), 'a\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'M1 feature a'])

    await tower.mission({ id: mission.id, status: 'active' })
    await tower.mission({ id: mission.id, task_done: 'write a' })
    await tower.mission({ id: mission.id, task_done: 'commit a' })

    const fakeAgent = 'agent-e2e'
    await tower.recordSpawn({
      missionId: mission.id,
      name: 'worker-e2e',
      role: 'worker',
      agentId: fakeAgent,
      parentSessionId: 'session-e2e',
      cwd: wt,
      branch: provisioned.worktree.branch,
    })

    // Unread inbox messages block completion; reading them unblocks it.
    await tower.recordMessage({ from: 'tower', to: 'all', subject: 'gate', body: 'read me before completing' })
    await assert.rejects(
      () => tower.complete({ missionId: mission.id, agentId: fakeAgent, report: 'premature' }),
      /unread inbox/,
    )
    const page = await tower.inbox({ reader: 'worker-e2e' })
    assert.equal(page.unreadRemaining, 0)
    const completed = await tower.complete({ missionId: mission.id, agentId: fakeAgent, report: 'done' })
    assert.equal(completed.mission.status, 'completed')
    assert.equal(completed.commits, 1)

    const finding = await tower.addFinding({
      type: 'improve',
      title: 'trailing newline',
      summary: 'missing newline',
      details: 'cosmetic',
      suggested_fix: 'add one',
      reportedBy: 'reviewer-e2e',
      missionId: mission.id,
    })
    assert.equal(finding.id, 'F1')

    const review = await tower.submitReview({
      missionId: mission.id,
      agentId: 'not-in-roster',
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'single in-scope file',
      actor: { name: 'tower', role: 'tower' },
      breakGlassReason: 'protocol e2e has no independent reviewer',
    })
    assert.equal(review.missionStatus, 'completed')
    assert.equal(review.review.reviewedCommit.length, 40)
    assert.equal(review.branchTip, review.review.reviewedCommit)

    const gate = await tower.evaluateGate({ missionId: mission.id, activity: {} })
    assert.equal(gate.ok, true, JSON.stringify(gate.blockers))

    const merged = await tower.merge({ missionId: mission.id, activity: {} })
    assert.equal(merged.ok, true, JSON.stringify(merged))
    assert.equal(merged.parents.length, 2)

    const torn = await tower.teardown({ activity: {} })
    assert.deepEqual(torn.removed, [mission.id])
    assert.equal(fs.existsSync(wt), false)

    const status = await tower.status()
    assert.equal(status.counts.merged, 1)
    assert.ok(status.reviews >= 1)
  } finally {
    removeTemp(root)
  }
})

test('tower plan: overlapping scopes auto-add a dependency and cycles are rejected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-plan-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)

  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    const planned = await tower.plan({
      missions: [
        { title: 'Overlap one', scope: ['src/shared/**'] },
        { title: 'Overlap two', scope: ['src/shared/deep/**'] },
      ],
    })
    assert.deepEqual(planned.missions[1].deps, [planned.missions[0].id])

    await assert.rejects(
      () =>
        tower.plan({
          missions: [{ title: 'Bad dependency', scope: ['c/**'], deps: ['M99'] }],
        }),
      /unknown mission/,
    )
  } finally {
    removeTemp(root)
  }
})

/** Build a repository with one completed, clean-reviewed mission. */
async function reviewedMission(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)

  const tower = await Tower.open(repo)
  await tower.init({})
  await tower.plan({
    missions: [{ title: 'Merge case', scope: ['src/**'], tasks: ['write file', 'commit'] }],
  })
  const provisioned = await tower.provision({ missionId: 'M1' })
  const wt = provisioned.worktree.path
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
  fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'a\n')
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-m', 'M1 a'])

  await tower.mission({ id: 'M1', status: 'active' })
  await tower.mission({ id: 'M1', task_done: 'write file' })
  await tower.mission({ id: 'M1', task_done: 'commit' })
  const agentId = 'agent-merge-e2e'
  await tower.recordSpawn({
    missionId: 'M1',
    name: 'worker-merge-e2e',
    role: 'worker',
    agentId,
    parentSessionId: 'session-e2e',
    cwd: wt,
    branch: provisioned.worktree.branch,
  })
  await tower.complete({ missionId: 'M1', agentId, report: 'done' })
  await tower.submitReview({
    missionId: 'M1',
    agentId: 'reviewer-not-in-roster',
    status: 'clean',
    merge: 'merge',
    findings: 'none',
    decision: 'single in-scope file',
    actor: { name: 'tower', role: 'tower' },
    breakGlassReason: 'protocol e2e has no independent reviewer',
  })
  return { root, repo, tower, wt, branch: provisioned.worktree.branch }
}

test('merge reconciles a merge commit that landed before the tool recorded it', async () => {
  const ctx = await reviewedMission('dsh-tower-reconcile-')
  try {
    git(ctx.repo, ['merge', '--no-ff', ctx.branch, '-m', 'manual merge'])
    const manualTip = git(ctx.repo, ['rev-parse', 'HEAD'])
    const result = await ctx.tower.merge({ missionId: 'M1', activity: {} })
    assert.equal(result.ok, true)
    assert.equal(result.reconciled, true)
    assert.equal(result.mergedCommit, manualTip)
    assert.equal(git(ctx.repo, ['rev-parse', 'HEAD']), manualTip, 'must not create a second merge commit')
    const status = await ctx.tower.status()
    assert.equal(status.counts.merged, 1)
    assert.equal(status.missions[0].status, 'merged')
    assert.equal(status.missions[0].mergedCommit, manualTip)
  } finally {
    removeTemp(ctx.root)
  }
})

test('rebase leaves an already-landed branch untouched and merge records it', async () => {
  const ctx = await reviewedMission('dsh-tower-rebase-landed-')
  try {
    git(ctx.repo, ['merge', '--no-ff', ctx.branch, '-m', 'manual merge'])
    const manualTip = git(ctx.repo, ['rev-parse', 'HEAD'])
    const reviewedTip = git(ctx.wt, ['rev-parse', 'HEAD'])

    const rebase = await ctx.tower.rebase({ missionId: 'M1', activity: {} })
    assert.equal(rebase.ok, true)
    assert.equal(rebase.alreadyMerged, true)
    assert.equal(rebase.skipped, true)
    assert.equal(rebase.newTip, reviewedTip)
    assert.equal(git(ctx.wt, ['rev-parse', 'HEAD']), reviewedTip, 'branch tip must not be fast-forwarded to base')

    // The exact shape from the report: the branch was fast-forwarded to the base tip.
    git(ctx.wt, ['reset', '--hard', manualTip])
    const result = await ctx.tower.merge({ missionId: 'M1', activity: {} })
    assert.equal(result.ok, true)
    assert.equal(result.reconciled, true)
    assert.equal(result.mergedCommit, manualTip)
    const status = await ctx.tower.status()
    assert.equal(status.missions[0].status, 'merged')
  } finally {
    removeTemp(ctx.root)
  }
})

test('merge hook failure aborts cleanly and leaves the mission retryable', async () => {
  const ctx = await reviewedMission('dsh-tower-hook-')
  try {
    const hooks = path.join(ctx.repo, '.git', 'hooks')
    fs.mkdirSync(hooks, { recursive: true })
    const hook = path.join(hooks, 'pre-merge-commit')
    fs.writeFileSync(hook, '#!/bin/sh\necho "pre-merge hook failure" >&2\nexit 1\n')
    try {
      fs.chmodSync(hook, 0o755)
    } catch {
      // Windows has no executable bit; Git for Windows still runs shell hooks.
    }

    const before = git(ctx.repo, ['rev-parse', 'HEAD'])
    const result = await ctx.tower.merge({ missionId: 'M1', activity: {} })
    assert.equal(result.ok, false)
    assert.equal(result.blockers[0].code, 'merge-hook-failed')
    assert.equal(['aborted', 'aborted-after-lock-cleanup', 'none'].includes(result.blockers[0].cleanup), true)
    assert.equal(git(ctx.repo, ['rev-parse', 'HEAD']), before, 'HEAD must be unchanged')
    assert.equal(git(ctx.repo, ['status', '--porcelain']), '', 'index/worktree must be restored')
    assert.equal(fs.existsSync(path.join(ctx.repo, '.git', 'MERGE_HEAD')), false, 'MERGE_HEAD must be gone')
    const status = await ctx.tower.status()
    assert.equal(status.missions[0].status, 'completed', 'mission must stay retryable')
  } finally {
    removeTemp(ctx.root)
  }
})

test('merge hook timeout is reported as merge-hook-failed and leaves a clean repo', async () => {
  const ctx = await reviewedMission('dsh-tower-hook-timeout-')
  const stopFile = path.join(ctx.root, 'stop-hook')
  try {
    const hooks = path.join(ctx.repo, '.git', 'hooks')
    fs.mkdirSync(hooks, { recursive: true })
    const hook = path.join(hooks, 'pre-merge-commit')
    // The hook waits for a marker file so the killed git process does not leave
    // an unkillable `sleep` holding the temporary directory on Windows.
    fs.writeFileSync(
      hook,
      `#!/bin/sh\nwhile [ ! -f "${stopFile.replace(/\\/g, '/')}" ]; do sleep 1; done\nexit 0\n`,
    )
    try {
      fs.chmodSync(hook, 0o755)
    } catch {
      // Windows has no executable bit; Git for Windows still runs shell hooks.
    }

    const before = git(ctx.repo, ['rev-parse', 'HEAD'])
    const result = await ctx.tower.merge({ missionId: 'M1', activity: {}, timeoutMs: 1000 })
    assert.equal(result.ok, false)
    assert.equal(result.blockers[0].code, 'merge-hook-failed')
    assert.equal(result.blockers[0].timeout, true)
    assert.equal(git(ctx.repo, ['rev-parse', 'HEAD']), before, 'HEAD must be unchanged')
    assert.equal(git(ctx.repo, ['status', '--porcelain']), '', 'index/worktree must be restored')
    assert.equal(fs.existsSync(path.join(ctx.repo, '.git', 'MERGE_HEAD')), false, 'MERGE_HEAD must be gone')
    assert.equal(fs.existsSync(path.join(ctx.repo, '.git', 'index.lock')), false, 'stale index.lock must be gone')
    const status = await ctx.tower.status()
    assert.equal(status.missions[0].status, 'completed', 'mission must stay retryable')
  } finally {
    fs.writeFileSync(stopFile, 'stop\n')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    removeTemp(ctx.root)
  }
})

test('registered tower_mission edits a planned mission scope and keeps it planned', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-protocol-planned-edit-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Planning edit', scope: ['src/**'] }],
    })
    const id = planned.missions[0].id
    const edited = await call(tools, 'tower_mission', { repoRoot: repo, id, scope: ['src/lib/**'] })
    assert.equal(edited.mission.status, 'planned')
    assert.equal(edited.mission.scopeGeneration, 2)
    assert.deepEqual(edited.mission.scope, ['src/lib/**'])
  } finally {
    removeTemp(root)
  }
})

test('registered tower_mission forwards allowMissingScope on a widen', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-protocol-hatch-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  // A tracked directory makes docs/future a dead end until the hatch is passed.
  fs.mkdirSync(path.join(repo, 'docs', 'guide'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'docs', 'guide', 'one.md'), 'guide\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'guide'])
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Hatch widen', scope: ['src/**'] }],
    })
    const id = planned.missions[0].id
    await call(tools, 'tower_mission', { repoRoot: repo, id, status: 'active' })

    await assert.rejects(
      () => call(tools, 'tower_mission', { repoRoot: repo, id, scope: ['docs/new-page.md'] }),
      (error) =>
        error.code === 'invalid-argument' &&
        error.details?.operation === 'widen' &&
        /no tracked file matches/.test(error.message),
    )

    const widened = await call(tools, 'tower_mission', {
      repoRoot: repo,
      id,
      scope: ['docs/new-page.md'],
      allowMissingScope: true,
    })
    assert.equal(widened.mission.status, 'active')
    assert.equal(widened.mission.scopeGeneration, 2)
    assert.deepEqual(widened.mission.scope, ['docs/new-page.md'])
    // The hatch is an input decision, not a stored mission field: prove that on
    // the raw state document instead of trusting the returned mission view.
    const raw = JSON.parse(fs.readFileSync(path.join(repo, '.git', 'dsh-tower', 'state.json'), 'utf8'))
    const stored = raw.missions.find((mission) => mission.id === id)
    assert.ok(stored)
    assert.equal(Object.hasOwn(stored, 'allowMissingScope'), false)
    assert.equal(stored.scopeGeneration, 2)
    assert.deepEqual(stored.scope, ['docs/new-page.md'])

    // A trailing directory entry is a tree the mission will create, and the
    // hatch stays reachable for it too.
    const future = await call(tools, 'tower_mission', {
      repoRoot: repo,
      id,
      scope: ['docs/future/'],
      allowMissingScope: true,
    })
    assert.equal(future.mission.scopeGeneration, 3)
    assert.ok(future.mission.scope[0].startsWith('docs/future'), JSON.stringify(future.mission.scope))
  } finally {
    removeTemp(root)
  }
})

test('tower_inspect status shows the deferred flag on the dashboard and mission detail', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-protocol-deferred-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Deferred visibility', scope: ['src/**'] }],
    })
    const id = planned.missions[0].id
    await call(tools, 'tower_mission', { repoRoot: repo, id, deferred: true })

    const shown = await call(tools, 'tower_inspect', { repoRoot: repo, view: 'status', missionId: id })
    assert.equal(shown.missions[0].deferred, true)
    assert.equal(shown.detail.mission.deferred, true)
    // `deferred` is a mission field, unlike the `allowMissingScope` input
    // hatch: the raw state document carries it.
    const raw = JSON.parse(fs.readFileSync(path.join(repo, '.git', 'dsh-tower', 'state.json'), 'utf8'))
    const stored = raw.missions.find((mission) => mission.id === id)
    assert.equal(stored.deferred, true)

    await call(tools, 'tower_mission', { repoRoot: repo, id, deferred: false })
    const cleared = await call(tools, 'tower_inspect', { repoRoot: repo, view: 'status', missionId: id })
    assert.equal(cleared.missions[0].deferred, false)
    assert.equal(cleared.detail.mission.deferred, false)
    const clearedRaw = JSON.parse(fs.readFileSync(path.join(repo, '.git', 'dsh-tower', 'state.json'), 'utf8'))
    const clearedStored = clearedRaw.missions.find((mission) => mission.id === id)
    assert.equal(Object.hasOwn(clearedStored, 'deferred'), false)
  } finally {
    removeTemp(root)
  }
})

test('registered tower_mission appends tasks and refuses them on a terminal mission', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-protocol-task-add-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Task appends', scope: ['src/**'], tasks: ['write code'] }],
    })
    const id = planned.missions[0].id
    const before = await call(tools, 'tower_inspect', { repoRoot: repo, view: 'status', missionId: id })
    const appended = await call(tools, 'tower_mission', {
      repoRoot: repo,
      missionId: id,
      taskAdd: ['appended one', 'appended two'],
    })
    assert.equal(appended.revision, before.revision + 1)
    assert.deepEqual(
      appended.mission.tasks.map((task) => ({ text: task.text, status: task.status })),
      [
        { text: 'write code', status: 'open' },
        { text: 'appended one', status: 'open' },
        { text: 'appended two', status: 'open' },
      ],
    )
    assert.equal(appended.mission.tasks.filter((task) => task.status === 'open').length, 3)

    // Complete directly through tower_mission (not tower_complete) to reach a
    // terminal status without satisfying the completion gate.
    await call(tools, 'tower_mission', { repoRoot: repo, id, status: 'active' })
    await call(tools, 'tower_mission', { repoRoot: repo, id, status: 'completed' })
    const rawBefore = fs.readFileSync(path.join(repo, '.git', 'dsh-tower', 'state.json'), 'utf8')
    await assert.rejects(
      () => call(tools, 'tower_mission', { repoRoot: repo, id, task_add: ['too late'] }),
      (error) => error.code === 'invalid-transition' && /terminal mission cannot append tasks/.test(error.message),
    )
    const rawAfter = fs.readFileSync(path.join(repo, '.git', 'dsh-tower', 'state.json'), 'utf8')
    assert.equal(rawAfter, rawBefore, 'a refused append must not change state')
  } finally {
    removeTemp(root)
  }
})

test('registered tower_inspect preflight orders dependency merges before a stale-base rebase', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-protocol-resolution-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [
        { title: 'Dependency work', scope: ['src/a/**'] },
        { title: 'Dependent work', scope: ['src/b/**'], deps: ['M1'] },
      ],
    })
    const tower = await Tower.open(repo)
    const first = await tower.provision({ missionId: planned.missions[0].id })
    fs.mkdirSync(path.join(first.worktree.path, 'src', 'a'), { recursive: true })
    fs.writeFileSync(path.join(first.worktree.path, 'src', 'a', 'a.txt'), 'a\n')
    git(first.worktree.path, ['add', '-A'])
    git(first.worktree.path, ['commit', '-m', 'dependency work'])

    const second = await tower.provision({ missionId: planned.missions[1].id })
    fs.mkdirSync(path.join(second.worktree.path, 'src', 'b'), { recursive: true })
    fs.writeFileSync(path.join(second.worktree.path, 'src', 'b', 'b.txt'), 'b\n')
    git(second.worktree.path, ['add', '-A'])
    git(second.worktree.path, ['commit', '-m', 'dependent work'])

    await tower.mission({ id: 'M1', status: 'active' })
    await tower.mission({ id: 'M1', status: 'completed' })
    await tower.mission({ id: 'M2', status: 'active' })
    // Move the base after both branches were cut: M2 is now stale.
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base moved\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-m', 'base moves'])

    const preflight = await call(tools, 'tower_inspect', { repoRoot: repo, view: 'preflight', missionId: 'M2' })
    assert.equal(preflight.cycle, null)
    assert.equal(preflight.order[0].action, 'merge-dependency')
    assert.equal(preflight.order[0].missionId, 'M1')
    assert.equal(preflight.order[1].action, 'rebase')
    for (const blocker of preflight.blockers) {
      assert.ok(blocker.resolution.length > 0, `${blocker.code} has no resolution`)
    }
    const stale = preflight.blockers.find((blocker) => blocker.code === 'stale-base')
    assert.ok(stale, JSON.stringify(preflight.blockers))
    assert.deepEqual(stale.resolution, [{ step: 1, action: 'rebase' }])
    const dependency = preflight.blockers.find((blocker) => blocker.code === 'deps-unmerged')
    assert.ok(dependency, JSON.stringify(preflight.blockers))
    assert.deepEqual(dependency.resolution, [{ step: 1, action: 'merge-dependency', missionId: 'M1' }])
  } finally {
    removeTemp(root)
  }
})

test('registered tower_inspect preflight completes a survey dependency instead of merging it (#208 R182)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-protocol-survey-resolution-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [
        { title: 'Survey the area', kind: 'survey' },
        { title: 'Build from the survey', scope: ['src/**'], deps: ['M1'] },
      ],
    })
    const tower = await Tower.open(repo)
    await tower.mission({ id: 'M1', status: 'active' })

    const preflight = await call(tools, 'tower_inspect', { repoRoot: repo, view: 'preflight', missionId: 'M2' })
    assert.equal(preflight.cycle, null)
    const dependencyStep = preflight.order.find((step) => step.missionId === 'M1')
    assert.ok(dependencyStep, JSON.stringify(preflight.order))
    assert.equal(dependencyStep.action, 'complete-mission')
    assert.equal(
      preflight.order.some((step) => step.action === 'merge-dependency' && step.missionId === 'M1'),
      false,
      JSON.stringify(preflight.order),
    )
    const dependency = preflight.blockers.find((blocker) => blocker.code === 'deps-unmerged')
    assert.ok(dependency, JSON.stringify(preflight.blockers))
    assert.deepEqual(dependency.resolution, [{ step: 1, action: 'complete-mission', missionId: 'M1' }])
  } finally {
    removeTemp(root)
  }
})

test('registered tower_plan warns about a ** mission while other work is in flight', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-protocol-broad-scope-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const first = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Feature work', scope: ['src/**'] }],
    })
    const id = first.missions[0].id

    // A whole-repository mission is legal but fences every later widen, so the
    // plan warns without blocking and names the ordering fix.
    const broad = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Release prep', scope: ['**'] }],
    })
    assert.equal(broad.missions[0].status, 'planned')
    const warning = broad.warnings?.find((entry) => entry.code === 'broad-scope')
    assert.ok(warning, JSON.stringify(broad.warnings))
    assert.equal(warning.missionId, broad.missions[0].id)
    assert.deepEqual(warning.missionIds, [id])
    assert.match(warning.message, /claims the whole repository/)
    assert.match(warning.message, /plan the release-preparation mission last/)
    assert.match(warning.message, /deferred|pause/)

    // Clearing the ordering (defer the open mission, abandon the broad one) makes
    // the same broad scope quiet: the warning is advisory, never a standing flag.
    await call(tools, 'tower_mission', { repoRoot: repo, id, deferred: true })
    await call(tools, 'tower_mission', {
      repoRoot: repo,
      id: broad.missions[0].id,
      status: 'abandoned',
      note: 'ordered after the feature work',
    })
    const quiet = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Release prep later', scope: ['**'] }],
    })
    assert.equal(quiet.missions[0].status, 'planned')
    assert.equal(quiet.warnings, undefined)
  } finally {
    removeTemp(root)
  }
})

test('a same-batch broad-scope warning names a companion mission once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-protocol-broad-scope-batch-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    // Both missions are created by the same call, so the warning runs after
    // applyPlan has already pushed them onto state.missions (F98).
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [
        { title: 'Release prep', scope: ['**'] },
        { title: 'Feature work', scope: ['src/**'] },
      ],
    })
    const [broad, companion] = planned.missions
    assert.deepEqual(broad.scope, ['**'])
    const warning = planned.warnings?.find((entry) => entry.code === 'broad-scope')
    assert.ok(warning, JSON.stringify(planned.warnings))
    assert.equal(warning.missionId, broad.id)
    // The companion is one mission even though applyPlan already appended it to
    // the state array the warning reads: its id must appear once in the list
    // and once in the prose, not once per copy.
    assert.deepEqual(warning.missionIds, [companion.id])
    assert.equal(warning.message.split(companion.id).length - 1, 1)
    assert.match(warning.message, new RegExp(`while ${companion.id} is still planned or active`))
  } finally {
    removeTemp(root)
  }
})

// #215: plan/spawn must refuse a checkout that is not `state.base`. The check
// runs before any state write, so a refused plan leaves state.json byte-identical.
test('tower_plan refuses a checkout that is not state.base and writes no state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-base-mismatch-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    const statePath = tower.paths.state
    const before = fs.readFileSync(statePath)
    const base = (await tower.load()).base
    git(repo, ['checkout', '-b', 'side-branch'])

    await assert.rejects(
      () => tower.plan({ missions: [{ title: 'Feature', scope: ['src/feature/**'] }] }),
      (error) => {
        assert.equal(error.code, 'base-mismatch')
        assert.match(error.message, new RegExp(`state\\.base is "${base}"`))
        assert.match(error.message, /side-branch/)
        assert.match(error.message, new RegExp(`check out "${base}"`))
        assert.match(error.message, /tower_init/)
        assert.match(error.message, /reanchor:true/)
        return true
      },
    )
    assert.deepEqual(fs.readFileSync(statePath), before, 'a refused plan must not write state.json')

    // The status view shows both sides and warns about the mismatch.
    const status = await tower.status()
    assert.equal(status.base, base)
    assert.equal(status.head, 'side-branch')
    assert.match(status.baseWarning, /state\.base/)
    assert.match(status.baseWarning, /side-branch/)

    // On the base branch the same plan succeeds.
    git(repo, ['checkout', base])
    const planned = await tower.plan({ missions: [{ title: 'Feature', scope: ['src/feature/**'] }] })
    assert.equal(planned.missions.length, 1)
  } finally {
    removeTemp(root)
  }
})

// #215: the reanchor refusal names the missions that block the move, so the
// operator knows which ones must be closed first.
test('tower_init reanchor refusal lists the blocking mission ids', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-reanchor-ids-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    const base = (await tower.load()).base
    git(repo, ['branch', 'release'])
    await tower.plan({ missions: [{ title: 'Open mission', scope: ['src/**'] }] })

    await assert.rejects(
      () => tower.init({ base: 'release', reanchor: true }),
      (error) => {
        assert.equal(error.code, 'invalid-transition')
        assert.match(error.message, /cannot reanchor base while 1 mission\(s\) are not merged or abandoned/)
        assert.match(error.message, /M1/)
        return true
      },
    )
    const state = await tower.load()
    assert.equal(state.base, base, 'a refused reanchor leaves the base alone')
    assert.equal(state.missions[0].status, 'planned')
  } finally {
    removeTemp(root)
  }
})

// #216: bulk tower_mission. `ids` is the pure-lifecycle shorthand; every mission
// gets its own activity record and the call keeps exactly one bulk record.
test('tower_mission bulk abandon records one activity per mission plus one bulk record', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-bulk-abandon-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({
      missions: [
        { title: 'First', scope: ['src/first/**'] },
        { title: 'Second', scope: ['src/second/**'] },
        { title: 'Third', scope: ['src/third/**'] },
      ],
    })
    const beforeRevision = (await tower.load()).revision
    const result = await tower.mission({ ids: ['M1', 'M2', 'M3'], status: 'abandoned', note: 'cleanup after plan' })

    assert.equal(result.atomic, true)
    assert.equal(result.revision, beforeRevision + 1)
    assert.deepEqual(result.missions.map((mission) => mission.id), ['M1', 'M2', 'M3'])
    assert.ok(result.missions.every((mission) => mission.status === 'abandoned'))

    const activity = await tower.deps.store.readActivityTail(tower.paths.activity, 20)
    const perMission = activity.filter((entry) => entry.type === 'mission' && entry.missionId !== undefined)
    assert.deepEqual(perMission.map((entry) => entry.missionId).sort(), ['M1', 'M2', 'M3'])
    const bulk = activity.filter((entry) => entry.type === 'mission.bulk')
    assert.equal(bulk.length, 1)
    assert.match(bulk[0].text, /M1, M2, M3/)
    assert.match(bulk[0].text, /atomic/)
  } finally {
    removeTemp(root)
  }
})

// #216: atomic:true is all-or-nothing — an unknown id rolls the whole batch back
// before the single state write.
test('tower_mission bulk is all-or-nothing on an unknown id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-bulk-atomic-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({
      missions: [
        { title: 'First', scope: ['src/first/**'] },
        { title: 'Second', scope: ['src/second/**'] },
      ],
    })
    const statePath = tower.paths.state
    const before = fs.readFileSync(statePath)
    await assert.rejects(
      () => tower.mission({ missions: [{ id: 'M1', status: 'abandoned', note: 'gone' }, { id: 'M99', note: 'unknown' }] }),
      (error) => error.code === 'mission-not-found' && /M99/.test(error.message),
    )
    assert.deepEqual(fs.readFileSync(statePath), before, 'a rolled-back batch must not write state.json')
    const state = await tower.load()
    assert.equal(state.missions.find((mission) => mission.id === 'M1').status, 'planned')
  } finally {
    removeTemp(root)
  }
})

// #216: the bulk item form mixes lifecycle and scope; the shorthand stays
// lifecycle-only and points at the per-mission form for anything else.
test('tower_mission bulk applies status and scope per mission', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-bulk-mixed-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({
      missions: [
        { title: 'First', scope: ['src/first/**'] },
        { title: 'Second', scope: ['src/second/**'] },
      ],
    })
    const result = await tower.mission({
      missions: [
        { id: 'M1', status: 'active', scope: ['src/first/deep/**'] },
        { id: 'M2', deferred: true, note: 'wait for M1' },
      ],
    })
    const [first, second] = result.missions
    assert.equal(first.status, 'active')
    assert.deepEqual(first.scope, ['src/first/deep/**'])
    assert.equal(second.deferred, true)

    await assert.rejects(
      () => tower.mission({ ids: ['M1'], task_done: 'write it' }),
      (error) => error.code === 'invalid-argument' && /missions/.test(error.message),
    )
  } finally {
    removeTemp(root)
  }
})

// #216: atomic:false applies items in order, keeps going after a failure, and
// reports each item instead of rolling the successful ones back.
test('tower_mission bulk partial mode reports each item and keeps successes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-bulk-partial-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({
      missions: [
        { title: 'First', scope: ['src/first/**'] },
        { title: 'Second', scope: ['src/second/**'] },
      ],
    })
    const beforeRevision = (await tower.load()).revision
    const result = await tower.mission({
      missions: [
        { id: 'M1', status: 'active' },
        { id: 'M99', status: 'active' },
      ],
      atomic: false,
    })
    assert.equal(result.atomic, false)
    assert.deepEqual(result.results.map((entry) => entry.ok), [true, false])
    assert.equal(result.results[1].code, 'mission-not-found')
    assert.match(result.results[1].error, /M99/)
    assert.equal(result.revision, beforeRevision + 1)
    assert.deepEqual(result.missions.map((mission) => mission.id), ['M1'])
    const state = await tower.load()
    assert.equal(state.missions.find((mission) => mission.id === 'M1').status, 'active')
    const activity = await tower.deps.store.readActivityTail(tower.paths.activity, 20)
    const bulk = activity.filter((entry) => entry.type === 'mission.bulk')
    assert.equal(bulk.length, 1)
    assert.match(bulk[0].text, /partial/)
    assert.match(bulk[0].text, /M1/)
    assert.match(bulk[0].text, /M99/)
  } finally {
    removeTemp(root)
  }
})

/** Tracked seed directories make a widened fence match real files (#200). */
function seedTracked(repo, files) {
  for (const file of files) {
    const target = path.join(repo, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${file}\n`)
  }
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'fixtures'])
}

// #219: one call defers the planned neighbours a widen collides with, under the
// same single revision bump, with one activity record per neighbour so the
// deferral is visible on the neighbour's own timeline.
test('#219 a widen defers planned neighbours in one call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-widen-one-call-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  seedTracked(repo, ['src/a/a.txt', 'src/shared/s.txt', 'other/o.txt'])
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [
        { title: 'Receiver', scope: ['src/a/**'] },
        { title: 'Neighbour', scope: ['src/shared/**'] },
        { title: 'Bystander', scope: ['other/**'] },
      ],
    })
    const [receiver, neighbour] = planned.missions.map((mission) => mission.id)
    await call(tools, 'tower_mission', { repoRoot: repo, id: receiver, status: 'active' })
    const tower = await Tower.open(repo)
    const beforeRevision = (await tower.load()).revision

    const widened = await call(tools, 'tower_mission', {
      repoRoot: repo,
      id: receiver,
      scope: ['src/**'],
      widen: { mode: 'defer-conflicts' },
    })
    assert.equal(widened.revision, beforeRevision + 1, 'one call adds exactly one revision')
    assert.equal(widened.mission.status, 'active')
    assert.equal(widened.mission.scopeGeneration, 2)
    assert.deepEqual(widened.mission.scope, ['src/**'])
    assert.deepEqual(widened.widen, { mode: 'defer-conflicts', deferred: [neighbour], restored: [], statusKept: false })

    const state = await tower.load()
    const stored = state.missions.find((mission) => mission.id === neighbour)
    assert.equal(stored.status, 'planned', 'a deferred neighbour keeps its status')
    assert.equal(stored.deferred, true)
    assert.deepEqual(state.missions.find((mission) => mission.id === receiver).deferralsCreated, [neighbour])

    const activity = await tower.deps.store.readActivityTail(tower.paths.activity, 20)
    const perMission = activity.filter((entry) => entry.type === 'mission' && entry.missionId !== undefined)
    // The widening writes the receiver record plus one record per neighbour, in
    // that order, and nothing else.
    const widening = perMission.slice(-2)
    assert.deepEqual(widening.map((entry) => entry.missionId), [receiver, neighbour])
    assert.match(widening[0].text, /scope widened/)
    assert.equal(widening[1].text, `deferred by widen of ${receiver}`)
  } finally {
    removeTemp(root)
  }
})

// #219 task 5: keepStatus leaves a completed mission completed, so the reviewer
// can be spawned immediately instead of the tower patching the status back.
test('#219 keepStatus keeps a completed mission completed for its reviewer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-widen-keep-status-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  seedTracked(repo, ['src/a/a.txt', 'other/o.txt'])
  const { tools } = makeCtx({
    subagents: fakeSubagents(),
    agentPresets: { list: async () => [{ id: 'tower-worker' }, { id: 'tower-reviewer' }] },
  })
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [
        { title: 'Finished', scope: ['src/a/**'], tasks: ['work'] },
        { title: 'Other', scope: ['other/**'] },
      ],
    })
    const id = planned.missions[0].id
    const tower = await Tower.open(repo)
    const provisioned = await tower.provision({ missionId: id })
    const wt = provisioned.worktree.path
    fs.mkdirSync(path.join(wt, 'src', 'a'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'src', 'a', 'work.txt'), 'work\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', `${id} work`])
    await tower.mission({ id, status: 'active' })
    await tower.mission({ id, task_done: 'work' })
    await tower.recordSpawn({
      missionId: id,
      name: `worker-${id.toLowerCase()}`,
      role: 'worker',
      agentId: `agent-${id}`,
      parentSessionId: 'session-e2e',
      cwd: wt,
      branch: provisioned.worktree.branch,
    })
    await tower.complete({ missionId: id, agentId: `agent-${id}`, report: 'done' })

    const kept = await call(tools, 'tower_mission', {
      repoRoot: repo,
      id,
      scope: ['src/**'],
      widen: { keepStatus: true },
    })
    assert.equal(kept.mission.status, 'completed', 'keepStatus must not return the mission to active')
    assert.equal(kept.mission.scopeGeneration, 2)
    assert.deepEqual(kept.mission.scope, ['src/**'])
    assert.equal(kept.widen.statusKept, true)

    // The reviewer prerequisite is a status check, so no intermediate patch.
    const reviewer = await call(tools, 'tower_spawn', { repoRoot: repo, missionId: id, role: 'reviewer' })
    assert.equal(reviewer.role, 'reviewer')
    assert.ok(reviewer.agentId)
    const after = await tower.load()
    assert.equal(after.missions.find((mission) => mission.id === id).status, 'completed')
  } finally {
    removeTemp(root)
  }
})

// #219 tasks 2 and 3: the default mode is the historical refusal, but it names
// every conflicting neighbour with its status and kind; an in-flight neighbour
// is never auto-deferred.
test('#219 a widen refuses by default and never strands an active neighbour', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-widen-refusal-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  seedTracked(repo, ['src/a/a.txt', 'src/shared/s.txt', 'src/deep/d.txt'])
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [
        { title: 'Receiver', scope: ['src/a/**'] },
        { title: 'Planned neighbour', scope: ['src/shared/**'] },
        { title: 'Active neighbour', scope: ['src/deep/**'] },
      ],
    })
    const [receiver, plannedId, activeId] = planned.missions.map((mission) => mission.id)
    await call(tools, 'tower_mission', { repoRoot: repo, id: receiver, status: 'active' })
    await call(tools, 'tower_mission', { repoRoot: repo, id: activeId, status: 'active' })
    const tower = await Tower.open(repo)
    const before = await tower.load()

    await assert.rejects(
      () => call(tools, 'tower_mission', { repoRoot: repo, id: receiver, scope: ['src/**'] }),
      (error) =>
        error.code === 'invalid-argument' &&
        /widened scope overlaps mission /.test(error.message) &&
        new RegExp(`widened scope overlaps mission [^;]*${plannedId}`).test(error.message) &&
        new RegExp(`widened scope overlaps mission [^;]*${activeId}`).test(error.message) &&
        /: planned build/.test(error.message) &&
        /: active build/.test(error.message),
    )

    await assert.rejects(
      () =>
        call(tools, 'tower_mission', {
          repoRoot: repo,
          id: receiver,
          scope: ['src/**'],
          widen: { mode: 'defer-conflicts' },
        }),
      (error) =>
        error.code === 'invalid-argument' &&
        /a deferral would strand in-flight work/.test(error.message) &&
        new RegExp(`${activeId}: active build`).test(error.message),
    )

    const after = await tower.load()
    assert.equal(after.revision, before.revision, 'a refused widen writes nothing')
    for (const missionId of [plannedId, activeId]) {
      const stored = after.missions.find((mission) => mission.id === missionId)
      assert.equal(Object.hasOwn(stored, 'deferred'), false, `${missionId} must not be deferred`)
    }
  } finally {
    removeTemp(root)
  }
})

// #222: a completion must record the files the worker actually touched. The
// branch diff is the authority: a worker that never declares a single file
// still leaves evidence, and a commit outside its fence is named rather than
// passing silently.
test('#222 completion records a footprint derived from the branch diff', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-footprint-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Footprint case', scope: ['src/a/**'], tasks: ['write a'] }] })
    const provisioned = await tower.provision({ missionId: 'M1' })
    const wt = provisioned.worktree.path
    fs.mkdirSync(path.join(wt, 'src', 'a'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'src', 'a', 'in.txt'), 'in\n')
    fs.mkdirSync(path.join(wt, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'docs', 'stray.md'), 'stray\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'M1 in and out'])
    await tower.mission({ id: 'M1', status: 'active' })
    await tower.mission({ id: 'M1', task_done: 'write a' })
    await tower.recordSpawn({
      missionId: 'M1',
      name: 'worker-m1',
      role: 'worker',
      agentId: 'agent-m1',
      parentSessionId: 'session-m1',
      cwd: wt,
      branch: provisioned.worktree.branch,
    })

    const completed = await tower.complete({ missionId: 'M1', agentId: 'agent-m1', report: 'done' })
    assert.equal(completed.mission.status, 'completed', 'an out-of-fence commit never fails the completion')
    const footprint = completed.mission.completionReport.footprint
    assert.ok(footprint, 'a completion always records the derived footprint')
    assert.deepEqual(footprint.insideScope, ['src/a/in.txt'])
    assert.deepEqual(footprint.outsideScope, ['docs/stray.md'])
    assert.deepEqual(footprint.changed, ['docs/stray.md', 'src/a/in.txt'])
    assert.deepEqual(footprint.scope, ['src/a/**'])
    assert.equal(footprint.scopeGeneration, 1)
    assert.equal(footprint.widenAt, null)
    assert.equal(footprint.widenedTo, null)
    assert.deepEqual(footprint.declared, [], 'the worker declared nothing')
    assert.deepEqual(footprint.mismatch, [], 'nothing was declared, so nothing is contradicted')
  } finally {
    removeTemp(root)
  }
})

// #222 task 2: a declared file the diff does not contain is a contradicted
// claim, not a failure. The union is reported and a mismatch note rides the
// completion, so the tower can see both what was claimed and what happened.
test('#222 a declared file the diff lacks becomes a mismatch note, never a failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-footprint-mismatch-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Mismatch case', scope: ['src/a/**'], tasks: ['write a'] }] })
    const provisioned = await tower.provision({ missionId: 'M1' })
    const wt = provisioned.worktree.path
    fs.mkdirSync(path.join(wt, 'src', 'a'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'src', 'a', 'in.txt'), 'in\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'M1 only in'])
    await tower.mission({ id: 'M1', status: 'active' })
    await tower.mission({ id: 'M1', task_done: 'write a' })
    await tower.recordSpawn({
      missionId: 'M1',
      name: 'worker-m1',
      role: 'worker',
      agentId: 'agent-m1',
      parentSessionId: 'session-m1',
      cwd: wt,
      branch: provisioned.worktree.branch,
    })

    const completed = await tower.complete({
      missionId: 'M1',
      agentId: 'agent-m1',
      report: 'done',
      files: ['src/a/in.txt', 'src/a/imaginary.txt'],
    })
    assert.equal(completed.mission.status, 'completed', 'a contradicted declaration never fails the completion')
    const footprint = completed.mission.completionReport.footprint
    assert.deepEqual(footprint.declared, ['src/a/imaginary.txt', 'src/a/in.txt'])
    assert.deepEqual(footprint.changed, ['src/a/imaginary.txt', 'src/a/in.txt'], 'the union is reported')
    assert.deepEqual(footprint.insideScope, ['src/a/imaginary.txt', 'src/a/in.txt'])
    assert.deepEqual(footprint.mismatch, [
      'src/a/imaginary.txt (declared, absent from the branch diff)',
    ])
    assert.match(
      footprint.mismatchNote,
      /declaration and the branch diff disagree: src\/a\/imaginary\.txt \(declared, absent from the branch diff\)/,
    )
  } finally {
    removeTemp(root)
  }
})

// #222 task 3: the preflight blocker names the outside-scope files it found and
// carries them as an array, because the human-readable detail truncates at 8.
test('#222 preflight carries the outside-scope files as an array in the blocker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-footprint-gate-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Gate case', scope: ['src/a/**'], tasks: ['write a'] }] })
    const provisioned = await tower.provision({ missionId: 'M1' })
    const wt = provisioned.worktree.path
    for (const file of ['docs/one.md', 'docs/two.md', 'src/a/in.txt']) {
      const target = path.join(wt, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, `${file}\n`)
    }
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'M1 in and out'])

    const gate = await tower.evaluateGate({ missionId: 'M1', activity: {} })
    const blocker = gate.blockers.find((entry) => entry.code === 'out-of-scope')
    assert.ok(blocker, JSON.stringify(gate.blockers))
    assert.deepEqual(blocker.details.outsideScope, ['docs/one.md', 'docs/two.md'], 'every outside path, not just the first 8')
    assert.match(blocker.detail, /docs\/one\.md/)
  } finally {
    removeTemp(root)
  }
})

// #222 task 4: a later reader must be able to tell a planned fence from a
// widened one. The footprint keeps the split as of completion plus the widen
// provenance the lifecycle already records.
test('#222 the footprint keeps inside/outside plus widenAt and widenedTo', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-footprint-widen-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  seedTracked(repo, ['src/a/a.txt', 'docs/guide/quickstart.md'])
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Widen case', scope: ['src/a/**'], tasks: ['write a'] }] })
    const provisioned = await tower.provision({ missionId: 'M1' })
    const wt = provisioned.worktree.path
    await tower.mission({ id: 'M1', status: 'active' })
    await tower.mission({ id: 'M1', scope: ['src/a/**', 'docs/guide/**'] })
    const widenedAt = Date.now()
    for (const file of ['src/a/a.txt', 'docs/guide/quickstart.md']) {
      fs.writeFileSync(path.join(wt, file), `${file} edited\n`)
    }
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'M1 edited in the widened fence'])
    await tower.mission({ id: 'M1', task_done: 'write a' })
    await tower.recordSpawn({
      missionId: 'M1',
      name: 'worker-m1',
      role: 'worker',
      agentId: 'agent-m1',
      parentSessionId: 'session-m1',
      cwd: wt,
      branch: provisioned.worktree.branch,
    })

    const completed = await tower.complete({ missionId: 'M1', agentId: 'agent-m1', report: 'done' })
    const footprint = completed.mission.completionReport.footprint
    assert.equal(footprint.scopeGeneration, 2, 'the widen bumped the generation')
    assert.deepEqual(footprint.scope, ['src/a/**', 'docs/guide/**'])
    assert.deepEqual(footprint.widenedTo, ['src/a/**', 'docs/guide/**'], 'the widened fence is recorded verbatim')
    assert.equal(typeof footprint.widenAt, 'number', 'the widen timestamp is recorded')
    assert.ok(footprint.widenAt <= widenedAt + 60_000, 'the timestamp is the widen activity record')
    assert.deepEqual(footprint.insideScope, ['docs/guide/quickstart.md', 'src/a/a.txt'])
    assert.deepEqual(footprint.outsideScope, [], 'both files are inside the widened fence')
  } finally {
    removeTemp(root)
  }
})

test('mission transitions: blocked resumes through clear_blockers and can complete again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-transition-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Transition case', scope: ['src/**'] }] })
    await tower.mission({ id: 'M1', status: 'active' })
    // #149 W3: blocked is derived from open blockers; the mission resumes by
    // clearing them, never by a status patch that skips the blocker record.
    await tower.mission({ id: 'M1', blocker: 'test block' })
    const resumed = await tower.mission({ id: 'M1', clear_blockers: true })
    assert.equal(resumed.mission.status, 'active')
    assert.deepEqual(resumed.mission.blockers, [])
    const completed = await tower.mission({ id: 'M1', status: 'completed' })
    assert.equal(completed.mission.status, 'completed')
  } finally {
    removeTemp(root)
  }
})

// #222 task 6: the footprint inputs must be reachable from the advertised tool
// surface. `tower_complete` sets additionalProperties:false, so an undeclared
// argument is refused before it runs — this proves `files` is in the contract
// and that the schema the registry publishes accepts it.
test('#222 tower_complete accepts the declared files argument and records the union', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-footprint-tool-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  const { tools } = makeCtx({ subagents: fakeSubagents() })
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Footprint tool case', scope: ['src/a/**'], tasks: ['write a'] }],
    })
    const provisioned = await call(tools, 'tower_spawn', { repoRoot: repo, missionId: 'M1', role: 'worker' })
    const wt = provisioned.worktree.path
    fs.mkdirSync(path.join(wt, 'src', 'a'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'src', 'a', 'in.txt'), 'in\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'M1 in'])
    await call(tools, 'tower_mission', { repoRoot: repo, id: 'M1', task_done: 'write a' })
    const exec = { agent: { id: provisioned.agentId } }
    const completed = await call(
      tools,
      'tower_complete',
      { repoRoot: repo, missionId: 'M1', report: 'done', files: ['src/a/in.txt', 'src/a/ghost.txt'] },
      exec,
    )
    const footprint = completed.mission.completionReport.footprint
    assert.deepEqual(footprint.declared, ['src/a/ghost.txt', 'src/a/in.txt'])
    assert.deepEqual(footprint.changed, ['src/a/ghost.txt', 'src/a/in.txt'])
    assert.deepEqual(footprint.mismatch, ['src/a/ghost.txt (declared, absent from the branch diff)'])
    assert.match(footprint.mismatchNote, /declared, absent from the branch diff/)
  } finally {
    removeTemp(root)
  }
})

// R211: the recorded footprint must read the same split as the merge gate, or a
// case-only path can be accepted at preflight and then reported to the reviewer
// as an out-of-scope change — a false accusation. This pins the whole chain on a
// case-insensitive checkout: gate accepts, footprint says inside, briefing stays
// silent. It asserts the two agree in one test so a future drift reddens here.
test('#222 on a case-insensitive checkout the gate and the footprint agree on a case-only path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-footprint-case-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    // The mode a real Windows/macOS checkout detects at `tower_init`, injected so
    // the case-insensitive branch runs on a case-sensitive CI filesystem too.
    const statePath = path.join(repo, '.git', 'dsh-tower', 'state.json')
    const seeded = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    seeded.caseInsensitive = true
    fs.writeFileSync(statePath, JSON.stringify(seeded, null, 2))

    await tower.plan({ missions: [{ title: 'Case-only footprint', scope: ['src/Api/**'], tasks: ['write api'] }] })
    const provisioned = await tower.provision({ missionId: 'M1' })
    const wt = provisioned.worktree.path
    // The file differs from the fence only by case: on this checkout, in scope.
    fs.mkdirSync(path.join(wt, 'src', 'api'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'src', 'api', 'x.js'), 'x\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'M1 case-only path'])

    // The gate is the authority on permission: it accepts the case-only path,
    // and rejects an unrelated one, on the same state the footprint will read.
    const gate = await tower.evaluateGate({ missionId: 'M1', activity: {} })
    assert.equal(
      gate.blockers.some((blocker) => blocker.code === 'out-of-scope'),
      false,
      `the gate must accept src/api/x.js under src/Api/** on a case-insensitive checkout: ${JSON.stringify(gate.blockers)}`,
    )

    await tower.mission({ id: 'M1', status: 'active' })
    await tower.mission({ id: 'M1', task_done: 'write api' })
    await tower.recordSpawn({
      missionId: 'M1',
      name: 'worker-m1',
      role: 'worker',
      agentId: 'agent-m1',
      parentSessionId: 'session-m1',
      cwd: wt,
      branch: provisioned.worktree.branch,
    })
    const completed = await tower.complete({ missionId: 'M1', agentId: 'agent-m1', report: 'done' })
    assert.equal(completed.mission.status, 'completed')
    const footprint = completed.mission.completionReport.footprint
    assert.deepEqual(footprint.insideScope, ['src/api/x.js'], 'the footprint reads the same split the gate accepted')
    assert.deepEqual(footprint.outsideScope, [], 'a case-only path is never an out-of-scope accusation')

    // And the reviewer briefing, which renders outsideScope verbatim, stays quiet.
    const { buildSpawnBriefing } = await import('../app/spawn-support.js')
    const context = buildSpawnBriefing({
      role: 'reviewer',
      towerRoot: repo,
      context: {
        base: 'main',
        mission: completed.mission,
        deps: [],
        reviews: [],
        findings: [],
        completionReport: completed.mission.completionReport,
      },
      worktree: { path: wt, branch: provisioned.worktree.branch, baseCommit: provisioned.worktree.baseCommit },
      review: null,
      instructions: undefined,
    })
    assert.doesNotMatch(context, /Outside the mission scope/, 'the briefing must not accuse a gate-approved path')
  } finally {
    removeTemp(root)
  }
})

// R212: the footprint and the merge gate must diff from the same anchor, not
// merely with the same comparison mode. `worktree.baseCommit` is written once at
// provisioning and `tower_rebase` records only `mission.rebase`
// (app/rebase.js:284), so after a rebase a diff from that stale anchor lists
// every path the BASE changed since provisioning — other missions' files. This
// test drives the supported route (worker stops -> tower_rebase -> completion)
// and pins the recorded footprint and the reviewer prompt against that bug.
test('#222 a rebased branch records only its own files, anchored like the merge gate', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-footprint-rebase-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  initRepo(repo)
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Rebase footprint', scope: ['src/mine/**'], tasks: ['write mine'] }] })
    const provisioned = await tower.provision({ missionId: 'M1' })
    const wt = provisioned.worktree.path
    const provisionedBase = provisioned.worktree.baseCommit

    // 1. The mission commits one file inside its own fence.
    fs.mkdirSync(path.join(wt, 'src', 'mine'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'src', 'mine', 'own.txt'), 'mine\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'M1 own file'])

    // 2. Another mission lands on the base: a commit that touches a different
    // file. `git diff <stale baseCommit>..<rebased tip>` would report it.
    fs.mkdirSync(path.join(repo, 'src', 'theirs'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'src', 'theirs', 'landed.txt'), 'theirs\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-m', 'other mission lands'])
    const baseTip = git(repo, ['rev-parse', 'HEAD'])

    // 3. The worker has stopped, so the supported route lets the tower rebase.
    // `activity: {}` models the stopped worker: `liveAgentFor` refuses a rebase
    // only when the catalog reports the row's agent as 'running'.
    await tower.mission({ id: 'M1', status: 'active' })
    await tower.mission({ id: 'M1', task_done: 'write mine' })
    await tower.recordSpawn({
      missionId: 'M1',
      name: 'worker-m1',
      role: 'worker',
      agentId: 'agent-m1',
      parentSessionId: 'session-m1',
      cwd: wt,
      branch: provisioned.worktree.branch,
    })
    const rebased = await tower.rebase({ missionId: 'M1', activity: {} })
    assert.equal(rebased.ok, true, `tower_rebase must succeed: ${JSON.stringify(rebased)}`)

    // The precondition that makes the bug possible: the branch tip now contains
    // the base-side file, while the recorded provisioning anchor does not.
    const rebasedTip = await tower.branchTip({ id: 'M1', worktree: { branch: provisioned.worktree.branch } })
    assert.equal(
      atCommit(repo, rebasedTip, 'src/theirs/landed.txt'),
      true,
      'precondition: the rebased tip contains the base-side file',
    )
    assert.equal(
      atCommit(repo, provisionedBase, 'src/theirs/landed.txt'),
      false,
      'precondition: the provisioning anchor predates the base-side file',
    )
    // The red-first proof, asserted on real git: diffing from the stale anchor
    // reports the base-side path, which is the bug this test guards.
    const staleDiff = git(wt, ['diff', '--name-only', `${provisionedBase}..${rebasedTip}`])
      .split('\n')
      .filter(Boolean)
    assert.ok(
      staleDiff.includes('src/theirs/landed.txt'),
      `red-first: the old worktree.baseCommit anchor reports the base-side file (${JSON.stringify(staleDiff)})`,
    )

    // 4. Complete and inspect the derived footprint.
    // The gate on the same state resolves its own diff: it must name the same
    // set, so the record and the gate cannot disagree after a rebase.
    const gate = await tower.evaluateGate({ missionId: 'M1', activity: {} })
    assert.equal(
      gate.blockers.some((blocker) => blocker.code === 'out-of-scope'),
      false,
      `the gate accepts the rebased in-fence branch: ${JSON.stringify(gate.blockers)}`,
    )
    const completed = await tower.complete({ missionId: 'M1', agentId: 'agent-m1', report: 'done' })
    assert.equal(completed.mission.status, 'completed')
    const footprint = completed.mission.completionReport.footprint
    assert.deepEqual(
      footprint.changed,
      ['src/mine/own.txt'],
      `the footprint must exclude the base-side file: ${JSON.stringify(footprint.changed)}`,
    )
    assert.deepEqual(
      footprint.outsideScope,
      [],
      `a base-side file is never an out-of-scope accusation: ${JSON.stringify(footprint.outsideScope)}`,
    )
    assert.deepEqual(footprint.insideScope, ['src/mine/own.txt'])

    // And the reviewer briefing stays silent about a scope it never violated.
    const { buildSpawnBriefing } = await import('../app/spawn-support.js')
    const context = buildSpawnBriefing({
      role: 'reviewer',
      towerRoot: repo,
      context: {
        base: 'main',
        mission: completed.mission,
        deps: [],
        reviews: [],
        findings: [],
        completionReport: completed.mission.completionReport,
      },
      worktree: { path: wt, branch: provisioned.worktree.branch, baseCommit: provisioned.worktree.baseCommit },
      review: null,
      instructions: undefined,
    })
    assert.doesNotMatch(
      context,
      /Outside the mission scope/,
      'a rebased branch must not print a false out-of-scope accusation',
    )
    assert.equal(rebased.baseTip, baseTip, 'sanity: the rebase replayed onto the base tip the test advanced')
  } finally {
    removeTemp(root)
  }
})
