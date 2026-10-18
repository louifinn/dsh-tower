// Finding lifecycle: tower_finding writes, tower_findings lists/reads/updates.
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Tower, FINDING_STATUSES, FINDING_TRANSITIONS } from '../lib/tower.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function makeTower() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-findings-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  const tower = await Tower.open(repo)
  await tower.init({})
  await tower.plan({ missions: [{ title: 'Finding lifecycle', scope: ['src/**'] }] })
  return { root, repo, tower }
}

async function fileFinding(tower, overrides = {}) {
  return tower.addFinding({
    type: 'bug',
    title: 'trailing newline',
    summary: 'missing newline at EOF',
    details: 'cosmetic but noisy in diffs',
    suggested_fix: 'add one newline',
    reportedBy: 'reviewer-1',
    missionId: 'M1',
    ...overrides,
  })
}

test('finding lifecycle: open → triaged → fixed → reopened, with notes', async () => {
  const { root, tower } = await makeTower()
  try {
    const finding = await fileFinding(tower)
    assert.equal(finding.status, 'open')
    assert.equal(finding.id, 'F1')

    const listing = await tower.findings({})
    assert.equal(listing.action, 'list')
    assert.equal(listing.total, 1)
    assert.deepEqual(listing.findings.map((entry) => entry.id), ['F1'])
    assert.deepEqual(listing.counts, { open: 1, triaged: 0, fixed: 0, wontfix: 0 })

    const read = await tower.findings({ id: 'F1' })
    assert.equal(read.action, 'read')
    assert.equal(read.finding.details, 'cosmetic but noisy in diffs')

    const triaged = await tower.findings({
      id: 'F1',
      status: 'triaged',
      note: 'confirmed on Windows',
      actor: { name: 'tower', role: 'tower' },
    })
    assert.equal(triaged.action, 'updated')
    assert.equal(triaged.finding.status, 'triaged')
    assert.equal(triaged.finding.notes.length, 1)
    assert.equal(triaged.finding.notes[0].text, 'confirmed on Windows')
    assert.equal(triaged.finding.closedAt, undefined)
    assert.deepEqual(triaged.counts, { open: 0, triaged: 1, fixed: 0, wontfix: 0 }, 'counts reflect the transition')
    assert.equal(fs.existsSync(tower.paths.lock), false, 'a transition must release the writer lock')
    await tower.findings({})
    await tower.findings({ id: 'F1' })
    assert.equal(fs.existsSync(tower.paths.lock), false, 'list/read must not create the writer lock')

    const fixed = await tower.findings({ id: 'F1', status: 'fixed', actor: { name: 'worker-1', role: 'worker' } })
    assert.equal(fixed.finding.status, 'fixed')
    assert.equal(typeof fixed.finding.closedAt, 'number')

    const reopened = await tower.findings({ id: 'F1', status: 'open', actor: { name: 'tower', role: 'tower' } })
    assert.equal(reopened.finding.status, 'open')
    assert.equal(reopened.finding.closedAt, undefined)

    const status = await tower.status()
    assert.equal(status.findings, 1)
    assert.deepEqual(status.findingsByStatus, { open: 1, triaged: 0, fixed: 0, wontfix: 0 })
    assert.equal(status.recentFindings[0].status, 'open')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('finding lifecycle: invalid transitions, statuses and reviewer mutations are rejected', async () => {
  const { root, tower } = await makeTower()
  try {
    await fileFinding(tower)

    await assert.rejects(
      () => tower.findings({ id: 'F1', status: 'triaged', actor: { name: 'reviewer-1', role: 'reviewer' } }),
      /reviewers may list and read findings/,
    )
    await assert.rejects(
      () => tower.findings({ id: 'F1', status: 'open', actor: { name: 'tower', role: 'tower' } }),
      /cannot move from open to open/,
    )
    await tower.findings({ id: 'F1', status: 'triaged', actor: { name: 'tower', role: 'tower' } })
    await assert.rejects(
      () => tower.findings({ id: 'F1', status: 'triaged', actor: { name: 'tower', role: 'tower' } }),
      /cannot move from triaged to triaged/,
    )
    await tower.findings({ id: 'F1', status: 'fixed', actor: { name: 'tower', role: 'tower' } })
    await assert.rejects(
      () => tower.findings({ id: 'F1', status: 'triaged', actor: { name: 'tower', role: 'tower' } }),
      /cannot move from fixed to triaged/,
    )
    await tower.findings({ id: 'F1', status: 'open', actor: { name: 'tower', role: 'tower' } })
    await assert.rejects(
      () => tower.findings({ id: 'F1', status: 'closed', actor: { name: 'tower', role: 'tower' } }),
      /status must be one of/,
    )
    await assert.rejects(() => tower.findings({ id: 'F9' }), /unknown finding/)
    await assert.rejects(
      () => tower.findings({ id: 'F1', status: 'all', actor: { name: 'tower', role: 'tower' } }),
      /only a list filter/,
    )
    await assert.rejects(() => tower.findings({ status: 'closed' }), /status must be one of/)
    await assert.rejects(() => tower.findings({ type: 'nit' }), /type must be one of/)
    await assert.rejects(() => tower.findings({ severity: 'urgent' }), /severity must be one of/)

    // Reviewer reads remain possible.
    const read = await tower.findings({ id: 'F1' })
    assert.equal(read.finding.status, 'open')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('finding lifecycle: filters, limit and status counts across findings', async () => {
  const { root, tower } = await makeTower()
  try {
    await fileFinding(tower, { title: 'bug one', severity: 'high' })
    await fileFinding(tower, { title: 'idea two', type: 'idea', severity: 'low', missionId: undefined })
    await fileFinding(tower, { title: 'vuln three', type: 'vuln', severity: 'critical' })
    await tower.findings({ id: 'F2', status: 'wontfix', actor: { name: 'tower', role: 'tower' } })

    const all = await tower.findings({})
    assert.equal(all.total, 3)
    assert.deepEqual(all.counts, { open: 2, triaged: 0, fixed: 0, wontfix: 1 })
    assert.deepEqual(all.findings.map((entry) => entry.id), ['F3', 'F2', 'F1'], 'newest first')

    const open = await tower.findings({ status: 'open' })
    assert.deepEqual(open.findings.map((entry) => entry.id), ['F3', 'F1'])
    assert.equal(open.filtered, 2)

    const openOnly = await tower.findings({ open: true })
    assert.equal(openOnly.filtered, 2)

    const bugs = await tower.findings({ type: 'bug' })
    assert.deepEqual(bugs.findings.map((entry) => entry.id), ['F1'])

    const critical = await tower.findings({ severity: 'critical' })
    assert.deepEqual(critical.findings.map((entry) => entry.id), ['F3'])

    const missionTwo = await tower.findings({ missionId: 'M1' })
    assert.equal(missionTwo.filtered, 2)

    const limited = await tower.findings({ limit: 1 })
    assert.equal(limited.findings.length, 1)
    assert.equal(limited.findings[0].id, 'F3')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('finding lifecycle: transitions table is a closed graph over the status set', () => {
  assert.deepEqual(FINDING_STATUSES, ['open', 'triaged', 'fixed', 'wontfix'])
  for (const status of FINDING_STATUSES) assert.ok(Array.isArray(FINDING_TRANSITIONS[status]), status)
  for (const targets of Object.values(FINDING_TRANSITIONS)) {
    for (const target of targets) assert.ok(FINDING_STATUSES.includes(target), target)
  }
})
