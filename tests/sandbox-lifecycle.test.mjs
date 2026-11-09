// Detached survey sandboxes (#148 W2): a `survey.sandbox: 'detached'` survey
// reads in a disposable `git worktree add --detach` checkout with no branch and
// no baseCommit. Writes and commands inside it are expected and absorbed; only
// HEAD === readCommit and zero commits are enforced. The shared placement keeps
// its strictly read-only tracked-status invariant.
// Run with: node --test tests/sandbox-lifecycle.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { Tower } from '../host/tower.js'
import { resolveTowerConfig } from '../domain/config/schema.js'
import { cleanupSandbox } from '../app/sandbox.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-sandbox-') {
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

function writeRepoConfig(repo, config) {
  const dir = path.join(repo, '.git', 'dsh-tower')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
}

async function setup(prefix, config = null) {
  const { root, repo } = seedRepo(prefix)
  if (config) writeRepoConfig(repo, config)
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
    parentSessionId: 'session-sandbox',
    cwd: tower.root,
    branch: null,
  })
  const state = await tower.load()
  if (state.missions.find((entry) => entry.id === missionId).status !== 'active') {
    await tower.mission({ id: missionId, status: 'active' })
  }
}

async function stored(tower, missionId) {
  return (await tower.load()).missions.find((entry) => entry.id === missionId)
}

/** Write a valid state document directly, the way a crashed writer would. */
function editState(tower, mutate) {
  const state = JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
  mutate(state)
  state.revision += 1
  state.updatedAt = Date.now()
  fs.writeFileSync(tower.paths.state, `${JSON.stringify(state, null, 2)}\n`)
}

test('survey.sandbox is tuning: shared default, detached opt-in, invalid values refused', () => {
  assert.equal(resolveTowerConfig({}).survey.sandbox, 'none')
  assert.equal(resolveTowerConfig({ survey: { sandbox: 'detached' } }).survey.sandbox, 'detached')
  assert.throws(() => resolveTowerConfig({ survey: { sandbox: 'worktree' } }))
})

test('detached provisioning creates no branch and pins the sandbox at readCommit', async () => {
  const { root, repo, tower } = await setup('dsh-tower-sandbox-provision-', { survey: { sandbox: 'detached' } })
  try {
    const mission = await planSurvey(tower)
    const readCommit = git(repo, ['rev-parse', 'HEAD'])
    const provisioned = await tower.provision({ missionId: mission.id })

    assert.equal(provisioned.provisioning, 'detached')
    assert.equal(provisioned.worktree, null)
    assert.equal(provisioned.created, true)
    const sandboxRoot = path.join(path.dirname(repo), '.dsh-tower-worktrees')
    assert.ok(provisioned.sandbox.startsWith(`${sandboxRoot}${path.sep}`))
    assert.equal(path.basename(provisioned.sandbox), `${mission.id}-sandbox`)

    const storedMission = await stored(tower, mission.id)
    assert.equal(storedMission.sandbox, provisioned.sandbox)
    assert.equal(storedMission.readCommit, readCommit)
    assert.equal('worktree' in storedMission, false)
    assert.equal('branch' in storedMission, false)
    assert.equal('baseCommit' in storedMission, false)

    // No mission branch was created: `--detach` only checks out the commit.
    assert.equal(git(repo, ['branch', '--list', 'tower/*']), '')
    assert.equal(git(provisioned.sandbox, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD')
    assert.equal(git(provisioned.sandbox, ['rev-parse', 'HEAD']), readCommit)

    const again = await tower.provision({ missionId: mission.id })
    assert.equal(again.provisioning, 'detached')
    assert.equal(again.created, false)
    assert.equal(again.sandbox, provisioned.sandbox)
  } finally {
    removeTemp(root)
  }
})

test('sandbox writes and commands are absorbed and completion removes the sandbox', async () => {
  const { root, repo, tower } = await setup('dsh-tower-sandbox-complete-', { survey: { sandbox: 'detached' } })
  try {
    const mission = await planSurvey(tower)
    const provisioned = await tower.provision({ missionId: mission.id })
    const sandbox = provisioned.sandbox
    await activate(tower, mission.id)

    // Real side effects a survey may produce while reading: edit a tracked file,
    // add untracked output, run a command in the sandbox. None of it is committed.
    fs.writeFileSync(path.join(sandbox, 'README.md'), 'changed inside the disposable sandbox\n')
    fs.writeFileSync(path.join(sandbox, 'notes.md'), 'scratch\n')
    assert.match(git(sandbox, ['status', '--porcelain']), /README\.md/)

    const result = await tower.complete({
      missionId: mission.id,
      agentId: 'agent-survey',
      report: 'read the seed commit and wrote scratch notes',
      result: { paths: ['README.md'], symbols: ['seed'], plan: ['follow up on the flag'], notes: 'scratch only' },
    })
    assert.equal(result.mission.status, 'completed')
    assert.equal(result.commits, 0)
    assert.equal(result.sandboxCleanup.ok, true)
    assert.equal(result.sandboxCleanup.removed, true)
    assert.equal(result.mission.sandbox, undefined)
    assert.equal(fs.existsSync(sandbox), false)

    const after = await stored(tower, mission.id)
    assert.equal('sandbox' in after, false)
    assert.equal(typeof after.sandboxRemovedAt, 'number')
    assert.deepEqual(after.result, {
      paths: ['README.md'],
      symbols: ['seed'],
      plan: ['follow up on the flag'],
      notes: 'scratch only',
    })
  } finally {
    removeTemp(root)
  }
})

test('a commit in the sandbox is refused until the sandbox is reset to readCommit', async () => {
  const { root, repo, tower } = await setup('dsh-tower-sandbox-commit-', { survey: { sandbox: 'detached' } })
  try {
    const mission = await planSurvey(tower)
    const provisioned = await tower.provision({ missionId: mission.id })
    const sandbox = provisioned.sandbox
    await activate(tower, mission.id)
    git(sandbox, ['config', 'user.email', 'sandbox@test'])
    git(sandbox, ['config', 'user.name', 'Sandbox Test'])
    git(sandbox, ['commit', '--allow-empty', '-m', 'sandbox work'])

    await assert.rejects(
      () => tower.complete({ missionId: mission.id, agentId: 'agent-survey', report: 'done' }),
      (error) => error.code === 'invalid-argument' && /made 1 commit\(s\) in its detached sandbox/.test(error.message),
    )
    // The refusal left the sandbox and the mission untouched.
    assert.equal((await stored(tower, mission.id)).sandbox, sandbox)

    git(sandbox, ['reset', '--hard', (await stored(tower, mission.id)).readCommit])
    const result = await tower.complete({ missionId: mission.id, agentId: 'agent-survey', report: 'reset and done' })
    assert.equal(result.mission.status, 'completed')
    assert.equal(fs.existsSync(sandbox), false)
    assert.equal('sandbox' in (await stored(tower, mission.id)), false)
  } finally {
    removeTemp(root)
  }
})

test('a failed cleanup is reported with the retained path and never corrupts the completed state', async () => {
  const { root, repo, tower } = await setup('dsh-tower-sandbox-cleanup-fail-', { survey: { sandbox: 'detached' } })
  try {
    const mission = await planSurvey(tower)
    const provisioned = await tower.provision({ missionId: mission.id })
    const sandbox = provisioned.sandbox
    await activate(tower, mission.id)

    const realGit = tower.git.bind(tower)
    tower.git = async (cwd, args, options) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('simulated busy sandbox')
      return realGit(cwd, args, options)
    }

    const result = await tower.complete({ missionId: mission.id, agentId: 'agent-survey', report: 'read it' })
    assert.equal(result.mission.status, 'completed')
    assert.equal(result.sandboxCleanup.ok, false)
    assert.equal(result.sandboxCleanup.attempts, 3)
    assert.match(result.sandboxCleanup.error, /simulated busy sandbox/)

    // The transition is durable; the sandbox record stays visible with an
    // actionable error so a later teardown can retry instead of losing the path.
    const after = await stored(tower, mission.id)
    assert.equal(after.status, 'completed')
    assert.equal(after.sandbox, sandbox)
    assert.match(after.sandboxCleanupError, /simulated busy sandbox/)
    assert.equal(fs.existsSync(sandbox), true)
    const activity = fs
      .readFileSync(tower.paths.activity, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const cleanupEntry = activity.find((entry) => entry.type === 'sandbox' && entry.missionId === mission.id && entry.text.includes('cleanup failed'))
    assert.ok(cleanupEntry)
    assert.match(cleanupEntry.text, /sandbox cleanup failed after 3 attempt\(s\): simulated busy sandbox/)
    assert.ok(cleanupEntry.text.includes(`git worktree remove --force ${sandbox}`))

    // The retained record is still readable and teardown can retry it.
    tower.git = realGit
    const retry = await cleanupSandbox(tower, mission.id)
    assert.equal(retry.ok, true)
    assert.equal(fs.existsSync(sandbox), false)
    assert.equal('sandbox' in (await stored(tower, mission.id)), false)
  } finally {
    removeTemp(root)
  }
})

test('abandoning a detached survey removes its sandbox', async () => {
  const { root, repo, tower } = await setup('dsh-tower-sandbox-abandon-', { survey: { sandbox: 'detached' } })
  try {
    const mission = await planSurvey(tower)
    const provisioned = await tower.provision({ missionId: mission.id })
    const result = await tower.mission({ id: mission.id, status: 'abandoned', note: 'no longer needed' })
    assert.equal(result.mission.status, 'abandoned')
    assert.equal(result.sandboxCleanup.ok, true)
    assert.equal(result.mission.sandbox, undefined)
    assert.equal(fs.existsSync(provisioned.sandbox), false)
    assert.equal('sandbox' in (await stored(tower, mission.id)), false)
  } finally {
    removeTemp(root)
  }
})

test('tower_teardown retries a terminal sandbox left behind by a failed cleanup', async () => {
  const { root, repo, tower } = await setup('dsh-tower-sandbox-teardown-', { survey: { sandbox: 'detached' } })
  try {
    const mission = await planSurvey(tower)
    const provisioned = await tower.provision({ missionId: mission.id })
    const sandbox = provisioned.sandbox

    // Simulate a crash after the state transition, before cleanup: the mission is
    // terminal but still records the disposable checkout.
    editState(tower, (state) => {
      const record = state.missions.find((entry) => entry.id === mission.id)
      record.status = 'abandoned'
      state.roster = []
    })

    const result = await tower.teardown({})
    assert.deepEqual(result.sandboxesRemoved, [mission.id])
    assert.ok(result.decisions.some((decision) => decision.missionId === mission.id && decision.action === 'removed'))
    assert.equal(fs.existsSync(sandbox), false)
    const after = await stored(tower, mission.id)
    assert.equal('sandbox' in after, false)
    assert.equal(typeof after.sandboxRemovedAt, 'number')
  } finally {
    removeTemp(root)
  }
})

test('archival defers a terminal mission whose sandbox is still present', async () => {
  const { root, repo, tower } = await setup('dsh-tower-sandbox-archive-', {
    survey: { sandbox: 'detached' },
    archive: { afterDays: 0, maxMissions: 0 },
  })
  try {
    const mission = await planSurvey(tower)
    const provisioned = await tower.provision({ missionId: mission.id })
    editState(tower, (state) => {
      const record = state.missions.find((entry) => entry.id === mission.id)
      record.status = 'completed'
      record.updatedAt = 0
    })

    const planned = await tower.plan({ missions: [{ title: 'A second read', kind: 'survey' }] })
    assert.equal(planned.missions.length, 1)

    // The only record of the leaked path must stay hot for teardown to retry.
    const after = await stored(tower, mission.id)
    assert.ok(after, 'the mission with a pending sandbox is not archived')
    assert.equal(after.sandbox, provisioned.sandbox)
    assert.equal(fs.existsSync(provisioned.sandbox), true)
    const activity = fs.readFileSync(tower.paths.activity, 'utf8')
    assert.match(activity, /deferred: detached sandbox at .* is still present; cleanup retries on tower_teardown/)
  } finally {
    removeTemp(root)
  }
})

test('the default shared survey stays strictly read-only and rejects tracked writes', async () => {
  const { root, repo, tower } = await setup('dsh-tower-sandbox-shared-')
  try {
    const mission = await planSurvey(tower)
    await activate(tower, mission.id)
    fs.writeFileSync(path.join(repo, 'README.md'), 'the shared checkout is not a sandbox\n')
    await assert.rejects(
      () => tower.complete({ missionId: mission.id, agentId: 'agent-survey', report: 'done' }),
      (error) =>
        error.code === 'invalid-argument' &&
        /changed tracked files: README\.md; a survey is read-only/.test(error.message),
    )
  } finally {
    removeTemp(root)
  }
})
