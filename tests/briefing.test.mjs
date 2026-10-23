// Mission briefing history injection: worker/reviewer briefings must carry the
// previous review rounds, related findings, the previous completion report and
// its checks, and truncate hostile lengths instead of growing without bound.
// Run with: node --test tests/briefing.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { workerBriefing, reviewerBriefing } from '../app/briefing.js'
import { Tower } from '../host/tower.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-briefing-') {
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

const BASE_COMMIT = 'a'.repeat(40)
const WORKTREE = { path: path.join(os.tmpdir(), 'tower-briefing-worktree'), branch: 'tower/m1-case', baseCommit: BASE_COMMIT }

function fixture(overrides = {}) {
  return {
    repoRoot: path.join(os.tmpdir(), 'tower-briefing-repo'),
    base: 'main',
    mission: {
      id: 'M1',
      title: 'Briefing case',
      kind: 'build',
      scope: ['src/**', 'docs/**'],
      tasks: [
        { text: 'write it', status: 'done' },
        { text: 'test it', status: 'open' },
      ],
      context: 'the user wants it small and correct',
    },
    deps: [{ id: 'M0', title: 'Foundation', status: 'merged' }],
    worktree: WORKTREE,
    instructions: 'keep the diff tiny',
    reviews: [
      {
        round: 3,
        reviewer: 'reviewer-m1',
        status: 'p1-2items',
        mergeVerdict: 'fix-then-merge',
        findings: 'F1: first issue\nF2: second issue',
        decision: 'needs a fix before merge',
        checks: ['diff'],
      },
    ],
    findings: [{ id: 'F7', status: 'open', severity: 'high', title: 'line too long' }],
    completionReport: {
      by: 'worker-m1',
      report: 'implemented the feature and ran the tests',
      checks: [{ name: 'unit tests', command: 'npm test', exitCode: 0, evidence: '42 passing' }],
    },
    ...overrides,
  }
}

test('worker briefing: prior reviews, findings, completion report and rules are all injected', () => {
  const text = workerBriefing(fixture())
  assert.match(text, /^# Tower mission M1 — Briefing case/)
  assert.ok(text.includes(WORKTREE.path))
  assert.ok(text.includes('src/**, docs/**'))
  assert.ok(text.includes('the user wants it small and correct'))
  assert.ok(text.includes('M0 Foundation (merged)'))
  assert.match(text, /Previous completion report \(by worker-m1\):/)
  assert.ok(text.includes('implemented the feature and ran the tests'))
  assert.match(text, /Previous checks:/)
  assert.match(text, /- unit tests \(exit 0\)/)
  assert.match(text, /Previous review rounds for this branch \(newest first\) — address every finding:/)
  assert.match(text, /- R3 by reviewer-m1: p1-2items \/ fix-then-merge/)
  assert.match(text, /findings: F1: first issue/)
  assert.match(text, /decision: needs a fix before merge/)
  assert.match(text, /Findings related to this mission:/)
  assert.match(text, /- F7 \[open\] high line too long/)
  // Rules must tell the worker which tools to use, with the concrete ids.
  assert.ok(text.includes('tower_mission({repoRoot:"'))
  assert.ok(text.includes('tower_complete({repoRoot:"'))
  assert.match(text, /Extra tower instructions:\nkeep the diff tiny/)
})

test('reviewer briefing: completion checks and prior rounds are injected with a read-only rule', () => {
  const text = reviewerBriefing(fixture())
  assert.match(text, /^# Tower review — mission M1 — Briefing case/)
  assert.ok(text.includes('Review branch: tower/m1-case'))
  assert.ok(text.includes('the user wants it small and correct'))
  assert.match(text, /Completion report \(by worker-m1\):/)
  assert.match(text, /Completion checks the worker ran:/)
  assert.match(text, /- unit tests \(exit 0\) — 42 passing/)
  assert.match(text, /Prior review rounds for this branch \(newest first\):/)
  assert.match(text, /- R3 by reviewer-m1: p1-2items \/ fix-then-merge/)
  assert.match(text, /Related findings:/)
  assert.match(text, /Read-only: do not modify files, commit, or merge\./)
  assert.ok(text.includes('tower_review({repoRoot:"'))
  assert.match(text, /Extra tower instructions:\nkeep the diff tiny/)
})

test('briefings truncate long review findings and long reports', () => {
  const longFindings = `start ${'x'.repeat(5000)} end`
  const longReport = `start ${'y'.repeat(5000)} end`
  const findingsFixture = fixture({
    reviews: [
      {
        round: 1,
        reviewer: 'reviewer-m1',
        status: 'p1-1items',
        mergeVerdict: 'fix-then-merge',
        findings: longFindings,
        decision: 'long one',
        checks: [],
      },
    ],
  })
  const workerText = workerBriefing(findingsFixture)
  assert.match(workerText, /… truncated/)
  assert.ok(workerText.length < 12000, `worker briefing should be bounded, was ${workerText.length}`)
  assert.ok(!workerText.includes('end\n\nFindings'), 'the tail of the long findings must be clipped')

  const reviewerText = reviewerBriefing(
    fixture({
      completionReport: { by: 'worker-m1', report: longReport, checks: [] },
    }),
  )
  assert.match(reviewerText, /… truncated/)
  assert.ok(reviewerText.length < 12000, `reviewer briefing should be bounded, was ${reviewerText.length}`)

  const workerReportText = workerBriefing(
    fixture({
      completionReport: { by: 'worker-m1', report: longReport, checks: [] },
    }),
  )
  assert.match(workerReportText, /… truncated/)
})

test('missionContext feeds the briefing with the real review and finding history', async () => {
  const { root, repo } = seedRepo()
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Context case', scope: ['src/**'], tasks: ['work'] }] })
    const provisioned = await tower.provision({ missionId: 'M1' })
    const wt = provisioned.worktree.path
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'a\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'M1 work'])
    await tower.mission({ id: 'M1', status: 'active' })
    await tower.mission({ id: 'M1', task_done: 'work' })
    await tower.recordSpawn({
      missionId: 'M1',
      name: 'worker-m1',
      role: 'worker',
      agentId: 'agent-context-worker',
      parentSessionId: 'session-context',
      cwd: wt,
      branch: provisioned.worktree.branch,
    })
    await tower.complete({
      missionId: 'M1',
      agentId: 'agent-context-worker',
      report: 'context report',
      checks: [{ name: 'unit tests', command: 'npm test', exitCode: 0, evidence: 'green' }],
    })
    await tower.addFinding({
      type: 'bug',
      title: 'context finding',
      severity: 'medium',
      summary: 'from the review',
      details: 'details',
      suggested_fix: 'fix it',
      reportedBy: 'reviewer-m1',
      missionId: 'M1',
    })
    await tower.submitReview({
      missionId: 'M1',
      agentId: 'reviewer-not-in-roster',
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'looks correct',
      checks: ['diff', 'tests'],
      actor: { name: 'tower', role: 'tower' },
      breakGlassReason: 'briefing fixture has no independent reviewer',
    })

    const context = await tower.missionContext('M1')
    assert.equal(context.reviews.length, 1)
    assert.equal(context.reviews[0].status, 'clean')
    assert.equal(context.reviews[0].round, 1)
    assert.equal(context.findings.length, 1)
    assert.equal(context.findings[0].id, 'F1')
    assert.equal(context.completionReport.report, 'context report')

    const briefing = workerBriefing({
      repoRoot: tower.root,
      base: context.base,
      mission: { ...context.mission, worktree: provisioned.worktree },
      deps: context.deps,
      worktree: provisioned.worktree,
      reviews: context.reviews,
      findings: context.findings,
      completionReport: context.completionReport,
    })
    assert.match(briefing, /Previous completion report \(by worker-m1\):/)
    assert.match(briefing, /Previous review rounds for this branch/)
    assert.match(briefing, /- R1 by tower: clean \/ merge/)
    assert.match(briefing, /Findings related to this mission:/)
    assert.match(briefing, /- F1 \[open\] medium context finding/)

    const reviewBriefing = reviewerBriefing({
      repoRoot: tower.root,
      base: context.base,
      mission: { ...context.mission, worktree: provisioned.worktree },
      deps: context.deps,
      worktree: provisioned.worktree,
      reviews: context.reviews,
      findings: context.findings,
      completionReport: context.completionReport,
    })
    assert.match(reviewBriefing, /Prior review rounds for this branch/)
    assert.match(reviewBriefing, /Completion checks the worker ran:/)
    assert.match(reviewBriefing, /unit tests/)
  } finally {
    removeTemp(root)
  }
})
