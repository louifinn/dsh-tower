// Protocol end-to-end test through the Tower domain class: real git repository,
// real worktree, no DSH runtime and no model calls.
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Tower } from '../lib/tower.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

test('tower protocol: init → plan → complete → review → merge → teardown', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-protocol-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])

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
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('tower plan: overlapping scopes auto-add a dependency and cycles are rejected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-plan-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])

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
    fs.rmSync(root, { recursive: true, force: true })
  }
})
