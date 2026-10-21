// tower_status: paged mission lists, full mission detail, markdown board,
// includeGate digests and the MISSIONS.md artifact written by mutations.
// Run with: node --test tests/status.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { registerTowerTools } from '../tools/index.js'
import { Tower } from '../app/tower.js'
import { validateJsonSchema } from './schema-validator.mjs'

const exec = { agent: { id: 'tower-status' } }

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

function seedRepo(prefix = 'dsh-tower-status-') {
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

async function call(tools, name, args, execOverride = exec) {
  const tool = tools.get(name)
  assert.ok(tool, `${name} is registered`)
  const value = await tool.execute(args, execOverride)
  const violations = validateJsonSchema(tool.output.schema, value)
  assert.deepEqual(violations, [], `${name}: ${violations.join('; ')}`)
  return value
}

test('pagination: total/offset/limit/nextOffset page the mission list deterministically', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [
        { title: 'Page one', scope: ['a/**'] },
        { title: 'Page two', scope: ['b/**'] },
        { title: 'Page three', scope: ['c/**'] },
      ],
    })
    assert.deepEqual(planned.missions.map((mission) => mission.id), ['M1', 'M2', 'M3'])

    const all = await call(tools, 'tower_status', { repoRoot: repo })
    assert.equal(all.total, 3)
    assert.equal(all.offset, 0)
    assert.equal(all.missions.length, 3)
    assert.equal(all.nextOffset, null)
    assert.equal(all.missions[0].id, 'M1')
    assert.equal(path.resolve(all.boardPath), path.resolve(path.join(all.commonDir, 'dsh-tower', 'MISSIONS.md')))

    const first = await call(tools, 'tower_status', { repoRoot: repo, limit: 2 })
    assert.equal(first.total, 3)
    assert.equal(first.missions.length, 2)
    assert.equal(first.nextOffset, 2)
    assert.deepEqual(first.missions.map((mission) => mission.id), ['M1', 'M2'])

    const second = await call(tools, 'tower_status', { repoRoot: repo, offset: 2, limit: 2 })
    assert.equal(second.missions.length, 1)
    assert.equal(second.nextOffset, null)
    assert.deepEqual(second.missions.map((mission) => mission.id), ['M3'])

    // Past the end is an empty page, never an error.
    const past = await call(tools, 'tower_status', { repoRoot: repo, offset: 5, limit: 2 })
    assert.equal(past.missions.length, 0)
    assert.equal(past.nextOffset, null)

    // limit is clamped to the documented 1..100 range.
    const clamped = await call(tools, 'tower_status', { repoRoot: repo, limit: 1000 })
    assert.equal(clamped.missions.length, 3)

    // format:"markdown" returns the human-readable board in the same value.
    const markdown = await call(tools, 'tower_status', { repoRoot: repo, format: 'markdown' })
    assert.match(markdown.markdown, /^# Tower missions — /)
    assert.ok(markdown.markdown.includes('| Mission | Status | Kind | Title | Owner |'))
    assert.ok(markdown.markdown.includes('| M1 | planned |'))
    assert.ok(markdown.markdown.includes('| M2 | planned |'))

    // Mutations write MISSIONS.md next to state.json.
    const boardFile = all.boardPath
    assert.ok(fs.existsSync(boardFile), `MISSIONS.md must exist at ${boardFile}`)
    const board = fs.readFileSync(boardFile, 'utf8')
    assert.ok(board.includes('| M1 | planned |'))
    await call(tools, 'tower_mission', { repoRoot: repo, id: 'M1', note: 'board update' })
    assert.ok(fs.readFileSync(boardFile, 'utf8').includes('| M1 | planned |'))
  } finally {
    cleanup(root)
  }
})

test('includeGate: every paged mission carries a preflight-style digest', async () => {
  const { root, repo } = seedRepo('dsh-tower-status-gate-')
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [
        { title: 'Gate one', scope: ['a/**'] },
        { title: 'Gate two', scope: ['b/**'] },
      ],
    })
    const paged = await call(tools, 'tower_status', { repoRoot: repo, includeGate: true, limit: 1 })
    assert.equal(paged.missions.length, 1)
    assert.equal(typeof paged.missions[0].gate, 'object')
    assert.equal(paged.missions[0].gate.ok, false)
    const codes = paged.missions[0].gate.blockers.map((blocker) => blocker.code)
    assert.ok(codes.includes('mission-not-completed'), `expected mission-not-completed, saw ${codes.join(',')}`)
    // A digest is a summary, not the full gate object: no worktree/tip fields.
    assert.equal(paged.missions[0].gate.branchTip, undefined)
  } finally {
    cleanup(root)
  }
})

test('missionId detail returns tasks, notes, reviews, findings, completion report and activity', async () => {
  const { root, repo } = seedRepo('dsh-tower-status-detail-')
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Detail case', scope: ['src/**'], tasks: ['implement', 'verify'] }],
    })
    const tower = await Tower.open(repo)
    const provisioned = await tower.provision({ missionId: 'M1' })
    const wt = provisioned.worktree.path
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'a\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'M1 work'])

    await call(tools, 'tower_mission', { repoRoot: repo, id: 'M1', status: 'active' })
    await call(tools, 'tower_mission', { repoRoot: repo, id: 'M1', taskDone: 'implement' })
    await call(tools, 'tower_mission', { repoRoot: repo, id: 'M1', taskDone: 'verify' })
    await call(tools, 'tower_mission', { repoRoot: repo, id: 'M1', note: 'ready for review' })
    await tower.recordSpawn({
      missionId: 'M1',
      name: 'worker-m1',
      role: 'worker',
      agentId: 'agent-status-worker',
      parentSessionId: 'session-status',
      cwd: wt,
      branch: provisioned.worktree.branch,
    })
    await call(tools, 'tower_complete', {
      repoRoot: repo,
      missionId: 'M1',
      report: 'detail report',
      checks: [{ name: 'unit tests', command: 'npm test', exitCode: 0, evidence: 'green' }],
    }, { agent: { id: 'agent-status-worker' } })
    const finding = await call(tools, 'tower_finding', {
      repoRoot: repo,
      type: 'improve',
      title: 'detail finding',
      summary: 'status detail fixture',
      details: 'details',
      suggested_fix: 'fix it',
      missionId: 'M1',
    })
    await call(tools, 'tower_review', {
      repoRoot: repo,
      missionId: 'M1',
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'detail review',
      checks: ['diff'],
      breakGlassReason: 'status fixture has no independent reviewer',
    })

    const detail = await call(tools, 'tower_status', { repoRoot: repo, missionId: 'M1' })
    assert.equal(detail.missionId, 'M1')
    assert.equal(detail.detail.mission.id, 'M1')
    assert.equal(detail.detail.mission.status, 'completed')
    assert.deepEqual(
      detail.detail.mission.tasks.map((task) => [task.text, task.status]),
      [['implement', 'done'], ['verify', 'done']],
    )
    assert.ok(detail.detail.mission.notes.includes('ready for review'))
    assert.ok(detail.detail.mission.notes.some((note) => /review round 1 by tower: clean/.test(note)))
    assert.equal(detail.detail.reviews.length, 1)
    assert.equal(detail.detail.reviews[0].status, 'clean')
    assert.equal(detail.detail.reviews[0].mergeVerdict, 'merge')
    assert.equal(detail.detail.findings.length, 1)
    assert.equal(detail.detail.findings[0].id, finding.id)
    assert.equal(detail.detail.mission.completionReport.report, 'detail report')
    assert.equal(detail.detail.mission.completionReport.checks[0].name, 'unit tests')
    assert.ok(Array.isArray(detail.detail.activity) && detail.detail.activity.length > 0, 'activity must be included')
    assert.ok(detail.detail.activity.some((entry) => entry.type === 'complete'))
    assert.equal(detail.counts.completed, 1)
    assert.equal(detail.reviews, 1)
    assert.equal(detail.findings, 1)

    // Unknown ids still fail with the stable mission code.
    await assert.rejects(
      () => tools.get('tower_status').execute({ repoRoot: repo, missionId: 'M99' }, exec),
      /\[tower:mission-not-found\]/,
    )
  } finally {
    cleanup(root)
  }
})
