// Completion-report size cap (#89).
//
// `report` is the only model-supplied string written into state.json without a
// bound, and every mutation rewrites the whole document. The cap is measured in
// UTF-8 bytes (so CJK is not silently favoured), reject-not-truncate, and
// `reportBytes` is persisted so the dashboard can page without the body.
//
// Run with: node --test tests/report-cap.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { removeTemp } from './helpers/cleanup.mjs'
import os from 'node:os'
import path from 'node:path'

import { registerTowerTools } from '../lib/tool-registry.js'
import { Tower } from '../app/tower.js'
import {
  DEFAULT_MAX_REPORT_BYTES,
  completionReport,
  completionReportBytes,
  utf8ByteLength,
} from '../domain/missions/completion.js'
import { resolveTowerConfig } from '../domain/config/schema.js'
import { missionSummary } from '../domain/summary.js'
import { validateJsonSchema } from './schema-validator.mjs'

const worker = {
  name: 'worker-m1',
  role: 'worker',
  state: 'active',
  agentId: 'agent-report',
  missionId: 'M1',
}

const NEXT_ACTION = 'write the full text to a file in the mission worktree and reference the path in the report'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

const cleanup = (root) => removeTemp(root)

function seedRepo(prefix = 'dsh-tower-report-') {
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

const workerExec = { agent: { id: 'agent-report' } }

async function call(tools, name, args, exec = workerExec) {
  const tool = tools.get(name)
  assert.ok(tool, `${name} is registered`)
  const value = await tool.execute(args, exec)
  const violations = validateJsonSchema(tool.output.schema, value)
  assert.deepEqual(violations, [], `${name}: ${violations.join('; ')}`)
  return value
}

/** init + plan one mission, provision it, make a commit, and spawn its worker. */
async function prepareMission(repo, tools) {
  await call(tools, 'tower_init', { repoRoot: repo })
  await call(tools, 'tower_plan', {
    repoRoot: repo,
    missions: [{ title: 'Report cap', scope: ['src/**'], tasks: ['implement'] }],
  })
  const tower = await Tower.open(repo)
  const provisioned = await tower.provision({ missionId: 'M1' })
  const worktree = provisioned.worktree.path
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true })
  fs.writeFileSync(path.join(worktree, 'src', 'a.txt'), 'a\n')
  git(worktree, ['add', '-A'])
  git(worktree, ['commit', '-m', 'M1 work'])
  await call(tools, 'tower_mission', { repoRoot: repo, id: 'M1', status: 'active' })
  await call(tools, 'tower_mission', { repoRoot: repo, id: 'M1', taskDone: 'implement' })
  await tower.recordSpawn({
    missionId: 'M1',
    name: worker.name,
    role: worker.role,
    agentId: worker.agentId,
    parentSessionId: 'session-report',
    cwd: worktree,
    branch: provisioned.worktree.branch,
  })
  return { tower, worktree }
}

function statePathOf(commonDir) {
  return path.join(commonDir, 'dsh-tower', 'state.json')
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

test('the report cap is 32 KiB measured in UTF-8 bytes: 40 KB rejected, 30 KB CJK accepted', () => {
  assert.equal(DEFAULT_MAX_REPORT_BYTES, 32 * 1024)

  const tooSmall = 'x'.repeat(40 * 1024)
  assert.throws(
    () => completionReport({ report: tooSmall, worker, checks: [], now: 1 }),
    (error) => {
      assert.equal(error.code, 'invalid-argument')
      assert.equal(error.nextAction, NEXT_ACTION)
      assert.match(error.message, /40960/)
      assert.match(error.message, /32768/)
      return true
    },
  )

  // 10 240 CJK characters are 30 720 UTF-8 bytes but far fewer "characters":
  // a character-count cap would accept them by accident, a byte cap does not.
  const cjk = '中'.repeat(10 * 1024)
  assert.equal(cjk.length, 10 * 1024)
  assert.equal(utf8ByteLength(cjk), 30 * 1024)
  const stored = completionReport({ report: cjk, worker, checks: [], now: 7 })
  assert.equal(stored.reportBytes, 30 * 1024)
  assert.equal(stored.report, cjk)

  // Exactly at the cap is accepted; one byte more is rejected.
  const atCap = completionReport({ report: 'y'.repeat(DEFAULT_MAX_REPORT_BYTES), worker, checks: [], now: 8 })
  assert.equal(atCap.reportBytes, DEFAULT_MAX_REPORT_BYTES)
  assert.throws(
    () => completionReport({ report: 'y'.repeat(DEFAULT_MAX_REPORT_BYTES + 1), worker, checks: [], now: 9 }),
    (error) => error.code === 'invalid-argument' && error.nextAction === NEXT_ACTION,
  )
})

test('a configured gates.maxReportBytes caps the report and is visible in the summary', () => {
  const config = resolveTowerConfig({ gates: { maxReportBytes: 2048 } })
  assert.equal(config.gates.maxReportBytes, 2048)
  assert.equal(resolveTowerConfig({}).gates.maxReportBytes, DEFAULT_MAX_REPORT_BYTES)
  assert.throws(
    () => completionReport({ report: 'z'.repeat(2049), worker, checks: [], now: 1, maxReportBytes: 2048 }),
    (error) => error.code === 'invalid-argument' && /2048/.test(error.message),
  )
  const summary = missionSummary({
    id: 'M1',
    title: 'M',
    kind: 'build',
    status: 'completed',
    scope: [],
    deps: [],
    tasks: [],
    completionReport: { report: 'hello', by: 'worker-m1', at: 1, checks: [] },
  })
  assert.equal(summary.reportBytes, 5)
  assert.equal('completionReport' in summary, false)
  assert.equal(completionReportBytes({ report: 'hello' }), 5)
  assert.equal(
    completionReportBytes({ report: 'hello', reportBytes: 99 }),
    99,
    'a stored reportBytes wins over recomputing from a legacy body',
  )
})

test('a 40 KB report is rejected with the nextAction and leaves state.json byte-identical', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await prepareMission(repo, tools)
    const status = await call(tools, 'tower_status', { repoRoot: repo })
    const statePath = statePathOf(status.commonDir)
    const before = sha256(statePath)

    await assert.rejects(
      () =>
        call(tools, 'tower_complete', {
          repoRoot: repo,
          missionId: 'M1',
          report: 'x'.repeat(40 * 1024),
        }),
      (error) => {
        assert.equal(error.code, 'invalid-argument')
        assert.equal(error.nextAction, NEXT_ACTION)
        assert.match(error.message, /worktree/)
        return true
      },
    )

    assert.equal(sha256(statePath), before, 'a rejected report must not mutate state.json')
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    assert.equal(state.missions[0].completionReport, undefined)
    assert.equal((await call(tools, 'tower_status', { repoRoot: repo })).counts.completed, 0)
  } finally {
    cleanup(root)
  }
})

test('a completion at the cap keeps state.json under a stated ceiling and status pages the size, not the body', async () => {
  const { root, repo } = seedRepo('dsh-tower-report-cap-')
  const { tools } = makeCtx()
  // Stated ceiling for one mission at the cap: the report itself plus bounded
  // mission/roster/state overhead. It must not scale with anything downstream.
  const stateCeiling = DEFAULT_MAX_REPORT_BYTES + 16 * 1024
  try {
    const { worktree } = await prepareMission(repo, tools)
    const report = 'r'.repeat(DEFAULT_MAX_REPORT_BYTES)
    const completed = await call(tools, 'tower_complete', { repoRoot: repo, missionId: 'M1', report })
    assert.equal(completed.mission.completionReport.reportBytes, DEFAULT_MAX_REPORT_BYTES)

    const status = await call(tools, 'tower_status', { repoRoot: repo })
    const statePath = statePathOf(status.commonDir)
    const stateBytes = fs.statSync(statePath).size
    assert.ok(stateBytes <= stateCeiling, `state.json is ${stateBytes} B, ceiling ${stateCeiling} B`)

    // The paged mission summary carries the size and never the body.
    const paged = status.missions.find((mission) => mission.id === 'M1')
    assert.equal(paged.reportBytes, DEFAULT_MAX_REPORT_BYTES)
    assert.equal('completionReport' in paged, false)
    assert.equal('report' in paged, false)

    // The full body is only in the missionId detail.
    const detail = await call(tools, 'tower_status', { repoRoot: repo, missionId: 'M1' })
    assert.equal(detail.detail.mission.completionReport.report, report)
    assert.equal(detail.detail.mission.completionReport.reportBytes, DEFAULT_MAX_REPORT_BYTES)
    assert.equal(detail.detail.mission.reportBytes, DEFAULT_MAX_REPORT_BYTES)

    // Doctor reports the largest report in the repository.
    const doctor = await call(tools, 'tower_doctor', { repoRoot: repo })
    const reports = doctor.checks.find((entry) => entry.id === 'reports')
    assert.ok(reports, 'doctor reports check is present')
    assert.match(reports.detail, /32768/)
    assert.match(reports.detail, /M1/)
    assert.deepEqual(doctor.reports, { count: 1, largest: { missionId: 'M1', bytes: DEFAULT_MAX_REPORT_BYTES }, capBytes: DEFAULT_MAX_REPORT_BYTES })

    // A later mutation rewrites the document but does not grow it with the
    // report again (the report is stored once and capped).
    await call(tools, 'tower_mission', { repoRoot: repo, id: 'M1', note: 'after completion' })
    const afterBytes = fs.statSync(statePath).size
    assert.ok(afterBytes <= stateCeiling, `state.json is ${afterBytes} B after a mutation, ceiling ${stateCeiling} B`)
    assert.ok(afterBytes - stateBytes < 4 * 1024, `mutation added ${afterBytes - stateBytes} B`)
    const stored = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    assert.equal(stored.missions[0].completionReport.report.length, DEFAULT_MAX_REPORT_BYTES)
    assert.equal(stored.missions[0].completionReport.reportBytes, DEFAULT_MAX_REPORT_BYTES)
  } finally {
    cleanup(root)
  }
})

test('sub-cap completions without reportBytes load unchanged and the size is derived on read', async () => {
  const { root, repo } = seedRepo('dsh-tower-report-legacy-')
  const { tools } = makeCtx()
  try {
    await prepareMission(repo, tools)
    const report = 'legacy report ✓'
    const completed = await call(tools, 'tower_complete', { repoRoot: repo, missionId: 'M1', report })
    assert.equal(completed.mission.status, 'completed')

    const status = await call(tools, 'tower_status', { repoRoot: repo })
    const statePath = statePathOf(status.commonDir)
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    // Simulate a completion written before #89: no reportBytes field.
    delete state.missions[0].completionReport.reportBytes
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
    const before = sha256(statePath)

    const paged = await call(tools, 'tower_status', { repoRoot: repo })
    const mission = paged.missions.find((entry) => entry.id === 'M1')
    assert.equal(mission.reportBytes, utf8ByteLength(report))
    assert.equal('completionReport' in mission, false)
    assert.equal(sha256(statePath), before, 'reads must not rewrite the state file')

    const detail = await call(tools, 'tower_status', { repoRoot: repo, missionId: 'M1' })
    assert.equal(detail.detail.mission.completionReport.report, report)
    assert.equal(detail.detail.mission.completionReport.reportBytes, undefined)
    assert.equal(detail.detail.mission.reportBytes, utf8ByteLength(report))
  } finally {
    cleanup(root)
  }
})

test('a repository config lowers the cap for tower_complete', async () => {
  const { root, repo } = seedRepo('dsh-tower-report-config-')
  const { tools } = makeCtx()
  try {
    await prepareMission(repo, tools)
    const status = await call(tools, 'tower_status', { repoRoot: repo })
    const configDir = path.join(status.commonDir, 'dsh-tower')
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ gates: { maxReportBytes: 2048 } }))

    await assert.rejects(
      () => call(tools, 'tower_complete', { repoRoot: repo, missionId: 'M1', report: 'q'.repeat(3000) }),
      (error) => error.code === 'invalid-argument' && /2048/.test(error.message) && error.nextAction === NEXT_ACTION,
    )
    const completed = await call(tools, 'tower_complete', { repoRoot: repo, missionId: 'M1', report: 'q'.repeat(2048) })
    assert.equal(completed.mission.completionReport.reportBytes, 2048)
  } finally {
    cleanup(root)
  }
})
