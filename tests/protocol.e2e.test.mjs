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

/** Register the real tool surface on a minimal host context. */
function makeCtx() {
  const tools = new Map()
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get() {
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
