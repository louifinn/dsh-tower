// Survey shape (#148): a survey reads one commit in the shared checkout, makes
// no commits, is never merged, is terminal-success at `completed`, and its
// read-only guarantee is a completion invariant rather than a merge gate.
// Everything here drives the real Tower class against a temporary git repo.
// Run with: node --test tests/survey-lifecycle.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { Tower } from '../host/tower.js'
import { defaultDeps } from '../adapters/default.js'
import { DAY_MS, selectForArchive } from '../domain/state/archive.js'
import { reanchorBlockedMessage } from '../domain/integration/init.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-survey-') {
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

async function setup(prefix) {
  const { root, repo } = seedRepo(prefix)
  const tower = await Tower.open(repo)
  await tower.init({})
  return { root, repo, tower }
}

async function planSurvey(tower, extra = {}) {
  const planned = await tower.plan({ missions: [{ title: 'Inspect the seed commit', kind: 'survey', ...extra }] })
  return planned.missions[0]
}

async function activate(tower, missionId, agentId = 'agent-survey') {
  await tower.recordSpawn({
    missionId,
    name: `worker-${missionId.toLowerCase()}`,
    role: 'worker',
    agentId,
    parentSessionId: 'session-survey',
    cwd: tower.root,
    branch: null,
  })
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === missionId)
  if (mission.status !== 'active') await tower.mission({ id: missionId, status: 'active' })
  return agentId
}

test('survey planning records the commit it reads, owns no scope and no worktree', async () => {
  const { root, repo, tower } = await setup('dsh-tower-survey-plan-')
  try {
    const mission = await planSurvey(tower, { tasks: ['read'] })
    const state = await tower.load()
    const stored = state.missions.find((entry) => entry.id === mission.id)
    assert.equal(stored.kind, 'survey')
    assert.equal(stored.status, 'planned')
    assert.deepEqual(stored.scope, [])
    assert.equal(stored.readCommit, git(repo, ['rev-parse', 'HEAD']))
    assert.deepEqual(stored.readDirty, [])
    assert.equal('worktree' in stored, false)
    assert.equal('branch' in stored, false)
    assert.equal('baseCommit' in stored, false)

    await assert.rejects(
      () => tower.plan({ missions: [{ title: 'Scoped survey', kind: 'survey', scope: ['src/**'] }] }),
      (error) =>
        error.code === 'invalid-argument' && /is a survey: it reads a commit and does not own a write scope/.test(error.message),
    )

    await assert.rejects(
      () => tower.plan({ missions: [{ title: 'Unknown kind', kind: 'review' }] }),
      (error) => error.code === 'invalid-argument' && /unknown mission kind "review"|kind must be one of build\|survey/.test(error.message),
    )
  } finally {
    removeTemp(root)
  }
})

test('survey provisioning is the shared checkout: no worktree, no branch, no commit budget', async () => {
  const { root, repo, tower } = await setup('dsh-tower-survey-shared-')
  try {
    const mission = await planSurvey(tower)
    const before = git(repo, ['worktree', 'list', '--porcelain'])
    const provisioned = await tower.provision({ missionId: mission.id })
    assert.equal(provisioned.worktree, null)
    assert.equal(provisioned.provisioning, 'shared')
    assert.equal(provisioned.created, false)
    assert.equal(provisioned.cwd, tower.root)
    assert.equal(git(repo, ['worktree', 'list', '--porcelain']), before, 'no worktree is created')
    assert.equal(git(repo, ['branch', '--list', 'tower/*']), '', 'no mission branch is created')
    const state = await tower.load()
    assert.equal('worktree' in state.missions.find((entry) => entry.id === mission.id), false)
    const status = await tower.status({})
    assert.equal(status.missions.find((entry) => entry.id === mission.id).worktree, null)
  } finally {
    removeTemp(root)
  }
})

test('a survey completes with zero commits and leaves HEAD and tracked files untouched', async () => {
  const { root, tower } = await setup('dsh-tower-survey-complete-')
  try {
    const mission = await planSurvey(tower)
    const agentId = await activate(tower, mission.id)
    const headBefore = git(tower.root, ['rev-parse', 'HEAD'])
    const countBefore = Number(git(tower.root, ['rev-list', '--count', 'HEAD']))

    const result = await tower.complete({
      missionId: mission.id,
      agentId,
      report: 'Read the seed commit; nothing to change.',
      result: { paths: ['README.md'], notes: 'seed only' },
    })
    assert.equal(result.mission.status, 'completed')
    assert.equal(result.commits, 0)
    assert.equal(git(tower.root, ['rev-parse', 'HEAD']), headBefore, 'completion never moves HEAD')
    assert.equal(Number(git(tower.root, ['rev-list', '--count', 'HEAD'])), countBefore, 'completion never commits')
    const state = await tower.load()
    const stored = state.missions.find((entry) => entry.id === mission.id)
    assert.equal(stored.status, 'completed')
    assert.deepEqual(stored.result, { paths: ['README.md'], notes: 'seed only' })

    // The evidence result is survey-only: a build completion may not carry one.
    const build = await tower.plan({ missions: [{ title: 'Build mission', scope: ['src/**'] }] })
    const buildId = build.missions[0].id
    const provisioned = await tower.provision({ missionId: buildId })
    fs.mkdirSync(path.join(provisioned.worktree.path, 'src'), { recursive: true })
    fs.writeFileSync(path.join(provisioned.worktree.path, 'src', 'a.js'), 'a\n')
    git(provisioned.worktree.path, ['add', '-A'])
    git(provisioned.worktree.path, ['commit', '-m', 'work'])
    await tower.recordSpawn({
      missionId: buildId,
      name: 'worker-build',
      role: 'worker',
      agentId: 'agent-build',
      parentSessionId: 'session-build',
      cwd: provisioned.worktree.path,
      branch: provisioned.worktree.branch,
    })
    await assert.rejects(
      () => tower.complete({ missionId: buildId, agentId: 'agent-build', report: 'done', result: { paths: ['src/a.js'] } }),
      (error) => error.code === 'invalid-argument' && /completion result is survey evidence only/.test(error.message),
    )
    const completed = await tower.complete({ missionId: buildId, agentId: 'agent-build', report: 'done' })
    assert.equal(completed.commits, 1, 'build completion still requires a commit')
  } finally {
    removeTemp(root)
  }
})

test('survey completion enforces HEAD and the tracked-status fingerprint', async () => {
  const { root, tower } = await setup('dsh-tower-survey-invariant-')
  try {
    const mission = await planSurvey(tower)
    const agentId = await activate(tower, mission.id)

    // Untracked files are ignored: node_modules and scratch output are not state.
    fs.writeFileSync(path.join(tower.root, 'scratch.tmp'), 'ignored\n')
    fs.mkdirSync(path.join(tower.root, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(tower.root, 'node_modules', 'pkg', 'index.js'), 'ignored\n')
    await tower.complete({ missionId: mission.id, agentId, report: 'read-only' })

    const moved = await planSurvey(tower, { title: 'Moved head survey' })
    const movedAgent = await activate(tower, moved.id, 'agent-moved')
    git(tower.root, ['commit', '--allow-empty', '-m', 'move head'])
    await assert.rejects(
      () => tower.complete({ missionId: moved.id, agentId: movedAgent, report: 'read-only' }),
      (error) => error.code === 'invalid-argument' && /moved HEAD from/.test(error.message),
    )

    const dirty = await planSurvey(tower, { title: 'Dirty survey' })
    const dirtyAgent = await activate(tower, dirty.id, 'agent-dirty')
    fs.writeFileSync(path.join(tower.root, 'README.md'), 'changed\n')
    await assert.rejects(
      () => tower.complete({ missionId: dirty.id, agentId: dirtyAgent, report: 'read-only' }),
      (error) => error.code === 'invalid-argument' && /changed tracked files/.test(error.message),
    )
    // Restore the tracked file: completion is still available afterwards.
    fs.writeFileSync(path.join(tower.root, 'README.md'), 'seed\n')
    const done = await tower.complete({ missionId: dirty.id, agentId: dirtyAgent, report: 'read-only' })
    assert.equal(done.commits, 0)
  } finally {
    removeTemp(root)
  }
})

test('survey refuses merge, rebase, preflight and diff with invalid-transition', async () => {
  const { root, tower } = await setup('dsh-tower-survey-refuse-')
  try {
    const mission = await planSurvey(tower)
    await assert.rejects(
      () => tower.merge({ missionId: mission.id }),
      (error) => error.code === 'invalid-transition' && /has no branch to merge and is never merged/.test(error.message),
    )
    await assert.rejects(
      () => tower.rebase({ missionId: mission.id }),
      (error) => error.code === 'invalid-transition' && /has no branch to rebase/.test(error.message),
    )
    await assert.rejects(
      () => tower.evaluateGate({ missionId: mission.id, action: 'preflight' }),
      (error) => error.code === 'invalid-transition' && /has no merge gate/.test(error.message),
    )
    await assert.rejects(
      () => tower.diff({ missionId: mission.id }),
      (error) => error.code === 'invalid-transition' && /has no branch diff/.test(error.message),
    )
  } finally {
    removeTemp(root)
  }
})

test('survey off refuses planning with an actionable code and leaves builds alone', async () => {
  const { root, repo } = await setup('dsh-tower-survey-component-')
  try {
    const offDeps = {
      ...defaultDeps,
      components: {
        enabled: (id) => id !== 'tower-survey',
        reason: (id) => `disabled by component ${id}`,
      },
    }
    const tower = await Tower.open(repo, offDeps)
    await assert.rejects(
      () => tower.plan({ missions: [{ title: 'Survey with the row off', kind: 'survey' }] }),
      (error) =>
        error.code === 'invalid-argument' &&
        /the tower-survey component is off: surveys cannot be planned; build missions are unaffected/.test(error.message) &&
        typeof error.nextAction === 'string',
    )
    const build = await tower.plan({ missions: [{ title: 'Build with the row off', scope: ['src/**'] }] })
    assert.equal(build.missions[0].kind, 'build', 'build planning is unaffected')
  } finally {
    removeTemp(root)
  }
})

test('a completed survey is terminal for archive, reanchor and open work', async () => {
  const { root, repo, tower } = await setup('dsh-tower-survey-terminal-')
  try {
    const mission = await planSurvey(tower)
    const agentId = await activate(tower, mission.id)
    await tower.complete({ missionId: mission.id, agentId, report: 'read-only' })
    const state = await tower.load()
    const stored = state.missions.find((entry) => entry.id === mission.id)

    // Archive eligibility: a survey has no worktree to keep alive, so a completed
    // survey is reclaimable (and counts toward archive.maxMissions).
    const now = Date.now() + 2 * DAY_MS
    assert.deepEqual(selectForArchive([stored], { afterDays: 1 }, { now }).map((entry) => entry.id), [mission.id])
    const surveys = ['M1', 'M2', 'M3'].map((id, index) => ({
      id,
      kind: 'survey',
      status: 'completed',
      readCommit: `read-${index}`,
      updatedAt: index,
    }))
    const reclaimed = selectForArchive(surveys, { maxMissions: 2, afterDays: 30 }, { now: 0 })
    assert.equal(reclaimed.length, 1, 'maxMissions reclaims the oldest completed survey')

    // Reanchor is refused only by live work; a completed survey does not block it.
    assert.equal(reanchorBlockedMessage([stored]), null)
    assert.match(reanchorBlockedMessage([{ id: 'M9', kind: 'build', status: 'completed' }]), /cannot reanchor base/)
    git(repo, ['branch', 'next', state.base])
    const reanchored = await tower.init({ reanchor: true, base: 'next' })
    assert.equal(reanchored.reanchored, true)
    assert.equal((await tower.load()).base, 'next')

    // The survey stays terminal-success in the vocabulary used by planning.
    assert.equal((await tower.load()).missions[0].status, 'completed')
  } finally {
    removeTemp(root)
  }
})
