// #202: a reviewer can produce verifiable run evidence instead of restating the
// worker's prose. These tests pin the whitelist boundary (there is no shell and
// no arbitrary command), the path rule, the timeout contract, and the recorded
// runIds that tower_complete/tower_review checks cite.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { registerTowerTools } from '../host/tool-registry.js'
import { killProcessTree } from '../adapters/process-tree.js'
import { roleAllowsTool } from '../host/tool-profiles.js'
import { PRESET_ALLOWS } from '../domain/exposure.js'
import { Tower } from '../host/tower.js'

// The slow fixture sleeps this long *before* writing its sentinel. The timeout
// case kills it with a 5s limit, so a descendant that survived the kill reveals
// itself about 3s into the assertion window that follows the call.
const SLOW_SLEEP_MS = 8000
const TIMEOUT_MS = 5000

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-verify-'))
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

function makeCtx() {
  const tools = new Map()
  let childSeq = 0
  const subagents = {
    list: () => ['spawn'],
    startActivation: async () => {
      childSeq += 1
      return {
        childId: `child-${childSeq}`,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }], diagnostic: null }),
      }
    },
    sendMessage: async () => {},
    listDescendants: async () => [],
  }
  const agentPresets = {
    list: async () => [
      { id: 'tower-worker' },
      { id: 'tower-reviewer' },
      { id: 'tower-survey' },
      { id: 'tower-survey-sandbox' },
    ],
  }
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

/**
 * A completed mission with a committed `tests/pass.test.mjs`, a slow test for
 * the timeout case, and a live reviewer session — the only actor the capability
 * table admits to tower_verify.
 */
async function makeVerificationFixture() {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  const towerExec = { agent: { id: 'tower-agent' } }
  const call = (name, args, exec = towerExec) => {
    const tool = tools.get(name)
    assert.ok(tool, `${name} is registered`)
    return tool.execute(args, exec)
  }

  await call('tower_init', { repoRoot: repo })
  const planned = await call('tower_plan', {
    repoRoot: repo,
    missions: [
      { title: 'Verification surface', scope: ['tests/**'], tasks: ['write a test'], kind: 'build' },
      // F104 needs a second live mission: the guard under test is "this actor is
      // recorded on *that* mission", which is only observable when two exist.
      { title: 'A neighbouring mission', scope: ['tests/**'], tasks: ['write another test'], kind: 'build' },
    ],
  })
  const missionId = planned.missions[0].id
  const otherMissionId = planned.missions[1].id
  const worker = await call('tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
  const workerExec = { agent: { id: worker.agentId } }
  const worktree = worker.worktree.path
  const otherWorker = await call('tower_spawn', { repoRoot: repo, missionId: otherMissionId, role: 'worker' })
  const otherWorkerExec = { agent: { id: otherWorker.agentId } }
  const otherWorktree = otherWorker.worktree.path
  fs.mkdirSync(path.join(otherWorktree, 'tests'), { recursive: true })
  fs.writeFileSync(
    path.join(otherWorktree, 'tests', 'pass.test.mjs'),
    "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('two plus two', () => assert.equal(2 + 2, 4))\n",
  )
  git(otherWorktree, ['add', '-A'])
  git(otherWorktree, ['commit', '-m', 'add the neighbour mission test'])
  await call('tower_mission', { repoRoot: repo, missionId: otherMissionId, taskDone: 'write another test' })
  await call('tower_complete', { repoRoot: repo, missionId: otherMissionId, report: 'neighbour completed' }, otherWorkerExec)
  const otherReviewer = await call('tower_spawn', { repoRoot: repo, missionId: otherMissionId, role: 'reviewer' })
  const otherReviewerExec = { agent: { id: otherReviewer.agentId } }
  fs.mkdirSync(path.join(worktree, 'tests'), { recursive: true })
  fs.writeFileSync(
    path.join(worktree, 'tests', 'pass.test.mjs'),
    "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('one plus one', () => assert.equal(1 + 1, 2))\n",
  )
  // R191 P1: the timeout receipt is only honest if the whole tree died. A plain
  // sleeping test is not evidence, because Windows tears a child down with its
  // parent's stdio pipes. So the fixture detaches a grandchild from every pipe
  // and lets *it* write the sentinel: a direct kill of the orchestrator leaves
  // that grandchild running, and only a real tree kill ends it. The sentinel
  // sits beside the repository, not inside it, so a survivor leaves evidence
  // without dirtying the worktree under test.
  const sentinel = path.join(root, 'orphan-sentinel.txt')
  const grandchild = path.join(root, 'orphan-grandchild.mjs')
  fs.writeFileSync(
    grandchild,
    `import fs from 'node:fs'\nawait new Promise((resolve) => setTimeout(resolve, ${SLOW_SLEEP_MS}))\nfs.writeFileSync(${JSON.stringify(sentinel)}, 'a descendant survived the timeout kill')\n`,
  )
  fs.writeFileSync(
    path.join(worktree, 'tests', 'slow.test.mjs'),
    `import { spawn } from 'node:child_process'\nimport test from 'node:test'\ntest('leaves a detached grandchild behind', async () => {\n  spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore', detached: true, windowsHide: true }).unref()\n  await new Promise((resolve) => setTimeout(resolve, 60000))\n})\n`,
  )
  git(worktree, ['add', '-A'])
  git(worktree, ['commit', '-m', 'add verification fixture tests'])
  await call('tower_mission', { repoRoot: repo, missionId, taskDone: 'write a test' })
  await call('tower_complete', { repoRoot: repo, missionId, report: 'fixture completed' }, workerExec)
  const reviewer = await call('tower_spawn', { repoRoot: repo, missionId, role: 'reviewer' })
  const reviewerExec = { agent: { id: reviewer.agentId } }

  return {
    root,
    repo,
    ctx,
    tools,
    call,
    towerExec,
    workerExec,
    reviewerExec,
    missionId,
    worktree,
    sentinel,
    otherMissionId,
    otherWorktree,
    otherReviewerExec,
  }
}

async function readMission(repo, missionId) {
  const tower = await Tower.open(repo)
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === missionId)
  return { ...mission, testRuns: mission.testRuns ?? [] }
}

test('a reviewer runs the whitelist and every check records its own runId', async () => {
  const fixture = await makeVerificationFixture()
  try {
    const value = await fixture.call(
      'tower_verify',
      {
        repoRoot: fixture.repo,
        missionId: fixture.missionId,
        checks: [
          { kind: 'tests', files: ['tests/pass.test.mjs'] },
          { kind: 'tsc' },
          { kind: 'shards', batch: 99 },
        ],
      },
      fixture.reviewerExec,
    )
    assert.equal(value.missionId, fixture.missionId)
    assert.equal(value.ok, false, 'the unavailable tsc and missing shard batch make the whole call not ok')
    assert.equal(value.checks.length, 3)
    const [testsCheck, tscCheck, shardCheck] = value.checks
    assert.equal(testsCheck.check, 'tests tests/pass.test.mjs')
    assert.equal(testsCheck.kind, 'tests')
    assert.equal(testsCheck.status, 'passed')
    assert.equal(testsCheck.exitCode, 0)
    assert.equal(testsCheck.command, 'node --test tests/pass.test.mjs')
    assert.match(testsCheck.summary, /1 passed/)
    assert.equal(testsCheck.truncated, false)
    assert.match(testsCheck.runId, /^run-\d+$/)
    assert.equal(tscCheck.status, 'unavailable')
    assert.match(tscCheck.summary, /spawn\.nodeModules: 'link'/, 'the remedy names the spawn link knob')
    assert.equal(shardCheck.kind, 'shards')
    assert.equal(shardCheck.check, 'shards:99')
    assert.equal(shardCheck.status, 'failed', 'a batch outside the plan fails without running anything')
    assert.match(shardCheck.summary, /does not exist/)

    const mission = await readMission(fixture.repo, fixture.missionId)
    assert.equal(mission.status, 'completed', 'verification never changes the mission status')
    assert.equal(mission.testRuns.length, 3)
    assert.deepEqual(mission.testRuns.map((run) => run.id), [testsCheck.runId, tscCheck.runId, shardCheck.runId])
    assert.equal(mission.testRuns[0].status, 'passed')
    assert.equal(mission.testRuns[0].ok, true)
    assert.equal(mission.testRuns[1].status, 'unavailable')
    assert.equal(mission.testRuns[1].ok, false)
    assert.equal(mission.testRuns[2].status, 'failed')
    assert.equal(mission.testRuns[2].batch, 99)
  } finally {
    removeTemp(fixture.root)
  }
})

test('anything outside the whitelist or the tests/ path rule is rejected before it runs', async () => {
  const fixture = await makeVerificationFixture()
  try {
    const verify = (checks, extra = {}) =>
      fixture.call('tower_verify', { repoRoot: fixture.repo, missionId: fixture.missionId, checks, ...extra }, fixture.reviewerExec)
    const rejected = (pattern) => (error) => error.code === 'invalid-argument' && pattern.test(error.message)

    await assert.rejects(verify([{ kind: 'shell', command: 'rm -rf /' }]), rejected(/unknown kind/), 'no shell kind exists')
    await assert.rejects(verify([{ kind: 'tests', files: ['../outside.test.mjs'] }]), rejected(/not a tests\/\*\.test\.mjs path/), 'no traversal')
    await assert.rejects(verify([{ kind: 'tests', files: [path.join(fixture.worktree, 'tests', 'pass.test.mjs')] }]), rejected(/not a tests\/\*\.test\.mjs path/), 'no absolute path')
    await assert.rejects(verify([{ kind: 'tests', files: ['tests/pass.test.mjs; rm -rf /'] }]), rejected(/not a tests\/\*\.test\.mjs path/), 'shell text is not a path')
    await assert.rejects(verify([{ kind: 'tests', files: ['tests/pass.test.mjs && touch evil'] }]), rejected(/not a tests\/\*\.test\.mjs path/), 'no command chaining')
    await assert.rejects(verify([{ kind: 'tests', files: ['src/out.test.mjs'] }]), rejected(/not a tests\/\*\.test\.mjs path/), 'only tests/ files')
    await assert.rejects(verify([{ kind: 'tests', files: ['tests/pass.test.mjs', 'tests/pass.test.mjs'] }]), rejected(/duplicate/))
    await assert.rejects(verify([{ kind: 'tsc', files: ['tests/pass.test.mjs'] }]), rejected(/takes no files/))
    await assert.rejects(verify([{ kind: 'shards', files: ['tests/pass.test.mjs'] }]), rejected(/takes no files/))
    await assert.rejects(verify([{ kind: 'shards', batch: 0 }]), rejected(/batch must be an integer 1-100/))
    await assert.rejects(verify([{ kind: 'shards', batch: 101 }]), rejected(/batch must be an integer 1-100/))
    await assert.rejects(verify([{ kind: 'tests', files: ['tests/pass.test.mjs'] }], { timeoutMs: 10 }), rejected(/timeoutMs/))
    await assert.rejects(verify([{ kind: 'tests', files: [] }]), rejected(/needs files/))

    const mission = await readMission(fixture.repo, fixture.missionId)
    assert.equal(mission.testRuns.length, 0, 'a rejected request never starts a check')
    assert.equal(fs.existsSync(path.join(fixture.repo, 'evil')), false)
  } finally {
    removeTemp(fixture.root)
  }
})

test('a timeout kills the tree and records status "timeout"', async () => {
  const fixture = await makeVerificationFixture()
  try {
    const started = Date.now()
    const value = await fixture.call(
      'tower_verify',
      {
        repoRoot: fixture.repo,
        missionId: fixture.missionId,
        checks: [{ kind: 'tests', files: ['tests/slow.test.mjs'] }],
        timeoutMs: TIMEOUT_MS,
      },
      fixture.reviewerExec,
    )
    assert.ok(Date.now() - started < 25000, 'the 30s test was killed by the 5s limit')
    assert.equal(value.ok, false)
    const check = value.checks[0]
    assert.equal(check.status, 'timeout')
    assert.match(check.summary, /timed out after 5000ms/)
    assert.equal(check.exitCode, null)
    const mission = await readMission(fixture.repo, fixture.missionId)
    assert.equal(mission.testRuns.length, 1)
    assert.equal(mission.testRuns[0].status, 'timeout')
    assert.equal(mission.testRuns[0].ok, false)

    // R191 P1: the receipt claiming "timeout" is only true if the descendant
    // died. The fixture writes its sentinel SLOW_SLEEP_MS after it starts, so a
    // surviving `node --test` child would surface it inside this window while
    // the parent call has already returned a timeout receipt.
    await new Promise((resolve) => setTimeout(resolve, SLOW_SLEEP_MS + 2000))
    assert.equal(
      fs.existsSync(fixture.sentinel),
      false,
      'a test process outlived the timeout kill and wrote its sentinel; the tree is not actually killed',
    )
  } finally {
    removeTemp(fixture.root)
  }
})

test('a verify runId is citable by tower_complete checks and a bogus one is refused', async () => {
  const fixture = await makeVerificationFixture()
  try {
    const verified = await fixture.call(
      'tower_verify',
      { repoRoot: fixture.repo, missionId: fixture.missionId, checks: [{ kind: 'tests', files: ['tests/pass.test.mjs'] }] },
      fixture.reviewerExec,
    )
    const runId = verified.checks[0].runId
    assert.equal(runId, `run-1`)

    // Reopen the completed mission and complete it again citing the reviewer's
    // run: normalizeChecks resolves runId against the recorded testRuns, so the
    // citation is a proof the run exists, not free text.
    await fixture.call('tower_mission', { repoRoot: fixture.repo, missionId: fixture.missionId, status: 'active' })
    await fixture.call(
      'tower_complete',
      {
        repoRoot: fixture.repo,
        missionId: fixture.missionId,
        report: 're-completed citing the reviewer run',
        checks: [{ name: 'reviewer verification', runId }],
      },
      fixture.workerExec,
    )
    const mission = await readMission(fixture.repo, fixture.missionId)
    assert.equal(mission.status, 'completed')
    assert.deepEqual(mission.completionReport.checks, [{ name: 'reviewer verification', runId }])

    // A review check is a string list, so the reviewer cites the same run id
    // textually; the record keeps it byte-for-byte (#202 / M163 model).
    const review = await fixture.call(
      'tower_review',
      {
        repoRoot: fixture.repo,
        missionId: fixture.missionId,
        status: 'clean',
        merge: 'hold',
        // A clean verdict must say exactly "none" (domain/missions/review.js);
        // the observable claim lives in the decision and the cited run id.
        findings: 'none',
        decision: 'the tests kind reproduces the worker claim, citing the recorded run',
        checks: [runId],
      },
      fixture.reviewerExec,
    )
    // tower_review returns { review, branchTip, missionStatus, round, ... }; the
    // verdict row carries the checks the reviewer cited.
    assert.deepEqual(review.review.checks, [runId])

    await fixture.call('tower_mission', { repoRoot: fixture.repo, missionId: fixture.missionId, status: 'active' })
    await assert.rejects(
      () =>
        fixture.call(
          'tower_complete',
          { repoRoot: fixture.repo, missionId: fixture.missionId, report: 'bogus citation', checks: [{ name: 'ghost', runId: 'run-99' }] },
          fixture.workerExec,
        ),
      (error) => error.code === 'invalid-argument' && /run-99/.test(error.message),
    )
  } finally {
    removeTemp(fixture.root)
  }
})

test('killProcessTree asks taskkill for the tree before any direct kill', async () => {
  // The injected seams record the order of operations. taskkill must be spawned
  // while the pid is still openable, and the direct kill must never come first:
  // on Windows `node --test` is an orchestrator whose per-file children die with
  // it only by accident, so a direct kill strands them (#202 R191 P1).
  const events = []

  const fakeSpawn = (command, args, options) => {
    events.push({ type: 'spawn', command, args, options })
    const emitter = {
      on(event, handler) {
        events.push({ type: `on:${event}` })
        if (event === 'close') setImmediate(() => handler(0))
        return emitter
      },
    }
    return emitter
  }

  await killProcessTree(
    { pid: 4321 },
    { platform: 'win32', spawn: fakeSpawn, kill: (pid, signal) => events.push({ type: 'kill', pid, signal }) },
  )

  assert.equal(events[0].type, 'spawn', 'taskkill is the first attempt')
  assert.equal(events[0].command, 'taskkill')
  assert.deepEqual(events[0].args, ['/pid', '4321', '/T', '/F'])
  assert.equal(events[0].options.windowsHide, true)
  assert.equal(events.some((event) => event.type === 'kill'), false, 'a successful taskkill needs no direct kill')

  // taskkill exiting non-zero (the pid was already gone: exit 128) must fall
  // back to the direct kill instead of trusting the failed attempt.
  const fallback = []
  const failingSpawn = () => ({
    on(event, handler) {
      if (event === 'close') setImmediate(() => handler(128))
      return this
    },
  })
  await killProcessTree(
    { pid: 99 },
    { platform: 'win32', spawn: failingSpawn, kill: (pid, signal) => fallback.push({ pid, signal }) },
  )
  assert.deepEqual(fallback, [{ pid: 99, signal: 'SIGKILL' }], 'a failed taskkill falls back to the direct kill')

  // A spawn that throws, and a taskkill that never reports, both hit the bound.
  const threw = []
  await killProcessTree(
    { pid: 7 },
    {
      platform: 'win32',
      spawn: () => {
        throw new Error('taskkill is not on PATH')
      },
      kill: (pid, signal) => threw.push({ pid, signal }),
    },
  )
  assert.deepEqual(threw, [{ pid: 7, signal: 'SIGKILL' }], 'a throw falls back to the direct kill')

  const hung = []
  await killProcessTree(
    { pid: 8 },
    { platform: 'win32', boundMs: 20, spawn: () => ({ on: () => {} }), kill: (pid, signal) => hung.push({ pid, signal }) },
  )
  assert.deepEqual(hung, [{ pid: 8, signal: 'SIGKILL' }], 'a taskkill that never settles hits the bound')
})

test('killProcessTree keeps the POSIX group kill and its direct fallback', async () => {
  // F107 gives POSIX a `ps` enumeration before it signals, so the injected
  // spawn seam now answers the table read. The group-kill contract is
  // unchanged: the group signal is the first attempt and the direct kill is
  // the fallback when the group cannot be signalled.
  const psSpawn = () => ({
    stdout: { on: (_event, handler) => setImmediate(() => handler(Buffer.from('500 1\n'))) },
    on(event, handler) {
      if (event === 'close') setImmediate(() => handler(0))
      return this
    },
  })
  const groupKilled = []
  await killProcessTree(
    { pid: 500 },
    { platform: 'linux', spawn: psSpawn, kill: (pid, signal) => groupKilled.push({ pid, signal }) },
  )
  assert.deepEqual(groupKilled, [{ pid: -500, signal: 'SIGKILL' }], 'the detached child leads its own process group')

  const direct = []
  await killProcessTree(
    { pid: 501 },
    {
      platform: 'darwin',
      spawn: psSpawn,
      kill: (pid, signal) => {
        if (pid < 0) throw new Error('no such process group')
        direct.push({ pid, signal })
      },
    },
  )
  assert.deepEqual(direct, [{ pid: 501, signal: 'SIGKILL' }], 'a missing group falls back to the direct kill')
})

test('a reviewer recorded on one mission cannot verify another mission', async () => {
  // F104: the role gate says "a reviewer"; the roster binding says *which*
  // mission's reviewer. Before the fix any assigned reviewer could run the
  // whitelist in any worktree and stamp receipts onto a mission it never saw.
  const fixture = await makeVerificationFixture()
  try {
    await assert.rejects(
      () =>
        fixture.call(
          'tower_verify',
          {
            repoRoot: fixture.repo,
            missionId: fixture.otherMissionId,
            checks: [{ kind: 'tests', files: ['tests/pass.test.mjs'] }],
          },
          fixture.reviewerExec,
        ),
      (error) =>
        error.code === 'not-authorized' &&
        /does not participate in mission/.test(error.message) &&
        // Both ids are named, so the refusal explains the confusion.
        error.message.includes(fixture.otherMissionId) &&
        error.message.includes(fixture.missionId),
      'a reviewer bound to another mission is refused, not silently admitted',
    )
    const neighbour = await readMission(fixture.repo, fixture.otherMissionId)
    assert.equal(neighbour.testRuns.length, 0, 'the refused call took no receipt on the other mission')
    const own = await readMission(fixture.repo, fixture.missionId)
    assert.equal(own.testRuns.length, 0, 'the refused call took no receipt on its own mission either')
  } finally {
    removeTemp(fixture.root)
  }
})

test('an assigned reviewer still verifies, and its receipt lands on its own mission', async () => {
  // The binding must not lock out the legitimate caller. A receipt is stored
  // inside `mission.testRuns`, so its mission is structural rather than a field
  // on the receipt (tower_test receipts are shaped the same way): the proof is
  // that the run shows up under the reviewer's own mission and nowhere else.
  const fixture = await makeVerificationFixture()
  try {
    const value = await fixture.call(
      'tower_verify',
      {
        repoRoot: fixture.repo,
        missionId: fixture.missionId,
        checks: [{ kind: 'tests', files: ['tests/pass.test.mjs'] }],
      },
      fixture.reviewerExec,
    )
    assert.equal(value.ok, true)
    assert.equal(value.missionId, fixture.missionId)

    const mission = await readMission(fixture.repo, fixture.missionId)
    assert.equal(mission.testRuns.length, 1)
    const [receipt] = mission.testRuns
    assert.equal(receipt.id, value.checks[0].runId, 'the returned runId is the stored receipt id')
    assert.equal(receipt.status, 'passed')
    assert.equal((await readMission(fixture.repo, fixture.otherMissionId)).testRuns.length, 0, 'the run did not land on a neighbouring mission')

    // The neighbour's own reviewer is confined to its own mission in exactly the
    // same way, so the guard is a binding and not a single-mission special case.
    const neighbour = await fixture.call(
      'tower_verify',
      {
        repoRoot: fixture.repo,
        missionId: fixture.otherMissionId,
        checks: [{ kind: 'tests', files: ['tests/pass.test.mjs'] }],
      },
      fixture.otherReviewerExec,
    )
    assert.equal(neighbour.missionId, fixture.otherMissionId)
    assert.equal(neighbour.checks[0].runId, 'run-1', 'run ids are minted per mission')
    assert.equal((await readMission(fixture.repo, fixture.missionId)).testRuns.length, 1)
    assert.equal((await readMission(fixture.repo, fixture.otherMissionId)).testRuns.length, 1)
  } finally {
    removeTemp(fixture.root)
  }
})

test('the capability table admits the reviewer role only', async () => {
  const fixture = await makeVerificationFixture()
  try {
    assert.ok(PRESET_ALLOWS['tower-reviewer'].includes('tower_verify'))
    assert.equal(PRESET_ALLOWS['tower-worker'].includes('tower_verify'), false)
    assert.equal(roleAllowsTool({ session: { header: { agentPreset: 'tower-reviewer' } } }, 'tower_verify'), true)
    assert.equal(roleAllowsTool({ session: { header: { agentPreset: 'tower-worker' } } }, 'tower_verify'), false)

    await assert.rejects(
      () =>
        fixture.call(
          'tower_verify',
          { repoRoot: fixture.repo, missionId: fixture.missionId, checks: [{ kind: 'tests', files: ['tests/pass.test.mjs'] }] },
          fixture.workerExec,
        ),
      (error) => error.code === 'not-authorized' && /assigned reviewer/.test(error.message),
      'a worker session cannot run reviewer verification',
    )
    await assert.rejects(
      () =>
        fixture.call('tower_verify', { repoRoot: fixture.repo, missionId: fixture.missionId, checks: [{ kind: 'tsc' }] }, fixture.towerExec),
      (error) => error.code === 'not-authorized',
      'an ordinary tower session is not a reviewer either',
    )
    const mission = await readMission(fixture.repo, fixture.missionId)
    assert.equal(mission.testRuns.length, 0, 'denied calls record nothing')
  } finally {
    removeTemp(fixture.root)
  }
})
