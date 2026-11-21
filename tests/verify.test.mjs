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
import { roleAllowsTool } from '../host/tool-profiles.js'
import { PRESET_ALLOWS } from '../domain/exposure.js'
import { Tower } from '../host/tower.js'

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
    missions: [{ title: 'Verification surface', scope: ['tests/**'], tasks: ['write a test'], kind: 'build' }],
  })
  const missionId = planned.missions[0].id
  const worker = await call('tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
  const workerExec = { agent: { id: worker.agentId } }
  const worktree = worker.worktree.path
  fs.mkdirSync(path.join(worktree, 'tests'), { recursive: true })
  fs.writeFileSync(
    path.join(worktree, 'tests', 'pass.test.mjs'),
    "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('one plus one', () => assert.equal(1 + 1, 2))\n",
  )
  fs.writeFileSync(
    path.join(worktree, 'tests', 'slow.test.mjs'),
    "import test from 'node:test'\ntest('never finishes in five seconds', async () => {\n  await new Promise((resolve) => setTimeout(resolve, 30000))\n})\n",
  )
  git(worktree, ['add', '-A'])
  git(worktree, ['commit', '-m', 'add verification fixture tests'])
  await call('tower_mission', { repoRoot: repo, missionId, taskDone: 'write a test' })
  await call('tower_complete', { repoRoot: repo, missionId, report: 'fixture completed' }, workerExec)
  const reviewer = await call('tower_spawn', { repoRoot: repo, missionId, role: 'reviewer' })
  const reviewerExec = { agent: { id: reviewer.agentId } }

  return { root, repo, ctx, tools, call, towerExec, workerExec, reviewerExec, missionId, worktree }
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
        timeoutMs: 5000,
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
