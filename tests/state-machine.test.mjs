// Mission state machine: the documented transition table, the completion and
// merge entry points, and a deterministic fuzz run that must always leave a
// valid, revision-monotonic state file behind.
//
// Everything here drives the real `Tower` domain class against a real
// temporary git repository; no DSH runtime and no model calls.
// Run with: node --test tests/state-machine.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { Tower } from '../lib/tower.js'
import { MISSION_STATUSES, validateState } from '../app/tower.js'

// Independent copy of the documented table. Keep this explicit: the test must
// fail if the implementation quietly grows an extra transition.
const EXPECTED_TRANSITIONS = {
  planned: ['active', 'abandoned'],
  active: ['completed', 'blocked', 'paused', 'abandoned'],
  blocked: ['active', 'paused', 'completed', 'abandoned'],
  paused: ['active', 'abandoned'],
  completed: ['active', 'abandoned'],
  merged: [],
  abandoned: [],
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-machine-') {
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

/** Drive one mission from `planned` to the requested non-terminal status. */
async function driveTo(tower, missionId, status) {
  const chains = {
    planned: [],
    active: ['active'],
    blocked: ['active', 'blocked'],
    paused: ['active', 'paused'],
    completed: ['active', 'blocked', 'completed'],
  }
  if (status === 'abandoned') {
    await tower.mission({ id: missionId, status: 'abandoned', note: 'terminal fixture' })
    return
  }
  for (const step of chains[status]) await tower.mission({ id: missionId, status: step })
}

/** Build one completed, clean-reviewed, merged mission and return its id. */
async function mergedMission(tower, repo, title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const planned = await tower.plan({
    missions: [{ title, scope: [`${slug}/**`], tasks: ['work'] }],
  })
  const id = planned.missions[0].id
  const provisioned = await tower.provision({ missionId: id })
  const wt = provisioned.worktree.path
  fs.mkdirSync(path.join(wt, slug), { recursive: true })
  fs.writeFileSync(path.join(wt, slug, 'a.txt'), 'a\n')
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-m', `${id} work`])
  await tower.mission({ id, status: 'active' })
  await tower.mission({ id, task_done: 'work' })
  await tower.recordSpawn({
    missionId: id,
    name: `worker-${id.toLowerCase()}`,
    role: 'worker',
    agentId: `agent-${id}`,
    parentSessionId: 'session-machine',
    cwd: wt,
    branch: provisioned.worktree.branch,
  })
  await tower.complete({ missionId: id, agentId: `agent-${id}`, report: 'done' })
  await tower.submitReview({
    missionId: id,
    agentId: 'reviewer-not-in-roster',
    status: 'clean',
    merge: 'merge',
    findings: 'none',
    decision: 'fixture review',
    actor: { name: 'tower', role: 'tower' },
    breakGlassReason: 'state-machine fixture has no independent reviewer',
  })
  const merged = await tower.merge({ missionId: id, activity: {} })
  assert.equal(merged.ok, true, JSON.stringify(merged))
  return id
}

test('mission transitions: the full allowed/denied table matches the implementation', async () => {
  const { root, repo } = seedRepo()
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    const fromStatuses = ['planned', 'active', 'blocked', 'paused', 'completed']
    // One fresh mission per (from, to) pair, so an allowed transition can never
    // contaminate the next case.
    const pairs = []
    for (const from of fromStatuses) {
      for (const to of MISSION_STATUSES) pairs.push({ from, to })
    }
    const planned = await tower.plan({
      missions: pairs.map((pair, index) => ({
        title: `Case ${index}`,
        scope: [`case-${index}/**`],
      })),
    })
    const ids = planned.missions.map((mission) => mission.id)

    for (const [index, pair] of pairs.entries()) {
      const id = ids[index]
      await driveTo(tower, id, pair.from)
      const before = await tower.load()
      const beforeMission = before.missions.find((mission) => mission.id === id)
      assert.equal(beforeMission.status, pair.from, `${id} fixture status`)
      const beforeRevision = before.revision
      const allowed = EXPECTED_TRANSITIONS[pair.from].includes(pair.to)
      // Abandoning always needs a reason; supply it so the assertion is about
      // the transition, not about the note precondition.
      const patch = { id, status: pair.to, ...(pair.to === 'abandoned' ? { note: 'fuzz reason' } : {}) }
      if (allowed) {
        const updated = await tower.mission(patch)
        assert.equal(updated.mission.status, pair.to, `${pair.from} -> ${pair.to} must be allowed`)
      } else {
        await assert.rejects(
          () => tower.mission(patch),
          `expected ${pair.from} -> ${pair.to} to be rejected`,
        )
        const after = await tower.load()
        const mission = after.missions.find((entry) => entry.id === id)
        assert.equal(mission.status, pair.from, `denied ${pair.from} -> ${pair.to} must not change status`)
        assert.equal(after.revision, beforeRevision, `denied ${pair.from} -> ${pair.to} must not bump revision`)
      }
    }

    // Terminal statuses: merged and abandoned reject every direct patch.
    const mergedId = await mergedMission(tower, repo, 'Merged terminal')
    const abandoned = await tower.plan({ missions: [{ title: 'Abandoned terminal', scope: ['abandoned/**'] }] })
    const abandonedId = abandoned.missions[0].id
    await driveTo(tower, abandonedId, 'abandoned')
    for (const id of [mergedId, abandonedId]) {
      for (const to of MISSION_STATUSES) {
        await assert.rejects(() => tower.mission({ id, status: to }), `${id} is terminal; cannot move to ${to}`)
      }
    }
  } finally {
    removeTemp(root)
  }
})

test('tower_complete and tower_merge enforce their own state preconditions', async () => {
  const { root, repo } = seedRepo('dsh-tower-machine-entry-')
  try {
    // This test asserts the mandatory-review gate; opt back into it explicitly
    // because review is optional by default.
    fs.mkdirSync(path.join(repo, '.git', 'dsh-tower'), { recursive: true })
    fs.writeFileSync(
      path.join(repo, '.git', 'dsh-tower', 'config.json'),
      JSON.stringify({ review: { requireReview: true } }),
    )
    const tower = await Tower.open(repo)
    await tower.init({})
    const planned = await tower.plan({
      missions: [
        { title: 'Complete entry', scope: ['complete/**'], tasks: ['work'] },
        { title: 'Blocked entry', scope: ['blocked/**'] },
      ],
    })
    const [completeId, blockedId] = planned.missions.map((mission) => mission.id)

    const provisioned = await tower.provision({ missionId: completeId })
    const wt = provisioned.worktree.path
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'a\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'entry work'])
    await tower.mission({ id: completeId, status: 'active' })
    await tower.mission({ id: completeId, task_done: 'work' })
    await tower.recordSpawn({
      missionId: completeId,
      name: 'worker-entry',
      role: 'worker',
      agentId: 'agent-entry',
      parentSessionId: 'session-machine',
      cwd: wt,
      branch: provisioned.worktree.branch,
    })
    const completed = await tower.complete({ missionId: completeId, agentId: 'agent-entry', report: 'done' })
    assert.equal(completed.mission.status, 'completed')
    await assert.rejects(
      () => tower.complete({ missionId: completeId, agentId: 'agent-entry', report: 'again' }),
      /already completed/,
    )

    // A reviewer cannot report completion for a mission it did not work on.
    await tower.recordSpawn({
      missionId: completeId,
      name: 'reviewer-entry',
      role: 'reviewer',
      agentId: 'agent-reviewer-entry',
      parentSessionId: 'session-machine',
      cwd: null,
      branch: provisioned.worktree.branch,
    })
    await assert.rejects(
      () => tower.complete({ missionId: completeId, agentId: 'agent-reviewer-entry', report: 'nope' }),
      /not a worker/,
    )

    // A blocked mission with a worker cannot complete until it is active again.
    await tower.mission({ id: blockedId, status: 'active' })
    await tower.recordSpawn({
      missionId: blockedId,
      name: 'worker-blocked',
      role: 'worker',
      agentId: 'agent-blocked',
      parentSessionId: 'session-machine',
      cwd: null,
      branch: null,
    })
    await tower.mission({ id: blockedId, blocker: 'waiting on upstream' })
    await assert.rejects(
      () => tower.complete({ missionId: blockedId, agentId: 'agent-blocked', report: 'nope' }),
      /cannot be completed from that state/,
    )
    await tower.mission({ id: blockedId, clear_blockers: true, status: 'active' })

    // tower_merge: closed missions are idempotent, half-done missions return
    // blockers instead of merging.
    const merged = await tower.merge({ missionId: completeId, activity: {} })
    assert.equal(merged.ok, false)
    assert.ok(merged.blockers.some((blocker) => blocker.code === 'no-review'))
    const stillPlanned = await tower.plan({ missions: [{ title: 'Never merged', scope: ['never/**'] }] })
    const notReady = await tower.merge({ missionId: stillPlanned.missions[0].id, activity: {} })
    assert.equal(notReady.ok, false)
    assert.ok(notReady.blockers.some((blocker) => blocker.code === 'mission-not-completed'))
  } finally {
    removeTemp(root)
  }
})

test('fuzz: 200 deterministic mutations keep a valid, monotonic state file', async () => {
  const { root, repo } = seedRepo('dsh-tower-machine-fuzz-')
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    const planned = await tower.plan({
      missions: Array.from({ length: 6 }, (_, index) => ({
        title: `Fuzz ${index}`,
        scope: [`fuzz-${index}/**`],
        tasks: ['first', 'second'],
      })),
    })
    const ids = planned.missions.map((mission) => mission.id || `M${index + 1}`)
    const statePath = tower.paths.state

    // mulberry32: tiny deterministic PRNG so a failing sequence is reproducible.
    let seed = 0x2f6e2b1
    const random = () => {
      seed |= 0
      seed = (seed + 0x6d2b79f5) | 0
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296
    }
    const pick = (values) => values[Math.floor(random() * values.length)]

    const statuses = MISSION_STATUSES.filter((status) => status !== 'merged')
    const scopes = ['fuzz-a/**', 'fuzz-b/**', 'fuzz-0/**', 'fuzz-*/inner/**']
    let successes = 0
    let failures = 0

    for (let step = 0; step < 200; step += 1) {
      const id = pick(ids)
      const before = await tower.load()
      const beforeRevision = before.revision
      const operation = Math.floor(random() * 9)
      let success = false
      let revisionMayStay = false
      try {
        if (operation === 0) {
          await tower.mission({ id, status: pick(statuses) })
        } else if (operation === 1) {
          await tower.mission({ id, task_done: pick(['first', 'second', 'nope']) })
        } else if (operation === 2) {
          await tower.mission({ id, blocker: `fuzz blocker ${step}` })
        } else if (operation === 3) {
          await tower.mission({ id, clear_blockers: true })
        } else if (operation === 4) {
          await tower.mission({ id, note: `fuzz note ${step}` })
        } else if (operation === 5) {
          await tower.mission({ id, scope: [pick(scopes)] })
        } else if (operation === 6) {
          await tower.mission({ id, status: 'abandoned', note: `fuzz abandon ${step}` })
        } else if (operation === 7) {
          const result = await tower.complete({ missionId: id, agentId: `fuzz-agent-${id}`, report: 'fuzz' })
          success = result.mission.status === 'completed'
        } else {
          const result = await tower.merge({ missionId: id, activity: {} })
          success = result.ok === true
          revisionMayStay = true
        }
        if (success === false && operation !== 7 && operation !== 8) success = true
      } catch {
        success = false
      }
      const after = await tower.load()
      validateState(after, statePath)
      for (const mission of after.missions) {
        assert.ok(MISSION_STATUSES.includes(mission.status), `step ${step}: illegal status ${mission.status}`)
        assert.ok(Array.isArray(mission.tasks), `step ${step}: mission ${mission.id} lost its tasks array`)
        assert.ok(Array.isArray(mission.deps), `step ${step}: mission ${mission.id} lost its deps array`)
      }
      if (success && !revisionMayStay) {
        assert.equal(after.revision, beforeRevision + 1, `step ${step}: a successful mutation must bump revision by one`)
      } else {
        assert.ok(after.revision >= beforeRevision, `step ${step}: revision must never move backwards`)
      }
      if (success) successes += 1
      else failures += 1
    }

    // The sequence must exercise both outcomes, otherwise the fuzz proves little.
    assert.ok(successes > 20, `expected many successful mutations, saw ${successes}`)
    assert.ok(failures > 20, `expected many rejected mutations, saw ${failures}`)
    assert.ok(ids.length === 6)
  } finally {
    removeTemp(root)
  }
})
