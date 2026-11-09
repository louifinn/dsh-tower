// Survey dependency freshness (#148 W2 / D5): a build whose survey dependency
// read a commit that is not ancestor-or-equal of the build base gets a
// `survey-stale` warning at plan/preflight time. It blocks only when
// `gates.requireFreshSurvey` is explicitly enabled.
// Run with: node --test tests/survey-freshness.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { Tower } from '../host/tower.js'
import { isAncestor } from '../adapters/git.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-freshness-') {
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

async function setup(prefix) {
  const { root, repo } = seedRepo(prefix)
  const tower = await Tower.open(repo)
  await tower.init({})
  return { root, repo, tower }
}

async function completeSurvey(tower, repo) {
  const planned = await tower.plan({ missions: [{ title: 'Read the current commit', kind: 'survey' }] })
  const mission = planned.missions[0]
  await tower.recordSpawn({
    missionId: mission.id,
    name: `worker-${mission.id.toLowerCase()}`,
    role: 'worker',
    agentId: 'agent-survey',
    parentSessionId: 'session-freshness',
    cwd: tower.root,
    branch: null,
  })
  if ((await tower.load()).missions.find((entry) => entry.id === mission.id).status !== 'active') {
    await tower.mission({ id: mission.id, status: 'active' })
  }
  await tower.complete({ missionId: mission.id, agentId: 'agent-survey', report: 'read it' })
  return mission
}

test('isAncestor covers equal, ancestor, descendant and unrelated histories', async () => {
  const { root, repo } = seedRepo('dsh-tower-freshness-ancestor-')
  try {
    const baseBranch = git(repo, ['symbolic-ref', '--short', 'HEAD'])
    const c1 = git(repo, ['rev-parse', 'HEAD'])
    fs.writeFileSync(path.join(repo, 'second.txt'), 'second\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-m', 'second'])
    const c2 = git(repo, ['rev-parse', 'HEAD'])

    // Equal commits count as ancestor-or-equal.
    assert.equal(await isAncestor(repo, c1, c1), true)
    assert.equal(await isAncestor(repo, c1, c2), true)
    assert.equal(await isAncestor(repo, c2, c1), false)

    // An unrelated orphan history shares no ancestry in either direction.
    git(repo, ['checkout', '--orphan', 'orphan'])
    git(repo, ['rm', '-rf', '--cached', '.'])
    fs.writeFileSync(path.join(repo, 'orphan.txt'), 'orphan\n')
    git(repo, ['add', 'orphan.txt'])
    git(repo, ['commit', '-m', 'orphan root'])
    const orphan = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['checkout', '-f', baseBranch])
    assert.equal(await isAncestor(repo, orphan, c2), false)
    assert.equal(await isAncestor(repo, c2, orphan), false)
  } finally {
    removeTemp(root)
  }
})

test('survey-stale warns by default at plan and preflight and blocks only when required', async () => {
  const { root, repo, tower } = await setup('dsh-tower-freshness-gate-')
  try {
    const oldBase = git(repo, ['rev-parse', 'HEAD'])
    fs.writeFileSync(path.join(repo, 'newer.txt'), 'newer\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-m', 'newer base'])
    const surveyRead = git(repo, ['rev-parse', 'HEAD'])

    const survey = await completeSurvey(tower, repo)
    assert.equal((await tower.load()).missions.find((entry) => entry.id === survey.id).readCommit, surveyRead)

    // While the build base is the survey's commit the dependency is fresh
    // (equal commits are ancestor-or-equal), so planning reports no warning.
    const freshPlan = await tower.plan({
      missions: [{ title: 'Build on the survey', scope: ['src/**'], deps: [survey.id] }],
    })
    const build = freshPlan.missions[0]
    assert.equal(freshPlan.warnings, undefined)

    // The base is rewound to the commit before the survey's read: the evidence
    // may no longer describe the code the build starts from.
    git(repo, ['reset', '--hard', oldBase])

    const planning = await tower.plan({
      missions: [{ title: 'Another build on the survey', scope: ['src/**'], deps: [survey.id] }],
    })
    const stale = planning.warnings?.find((warning) => warning.code === 'survey-stale')
    assert.ok(stale, 'plan reports the stale dependency')
    assert.deepEqual(
      {
        code: stale.code,
        missionId: stale.missionId,
        depId: stale.depId,
        readCommit: stale.readCommit,
        baseCommit: stale.baseCommit,
      },
      {
        code: 'survey-stale',
        missionId: planning.missions[0].id,
        depId: survey.id,
        readCommit: surveyRead,
        baseCommit: oldBase,
      },
    )
    assert.match(stale.message, /not an ancestor of M\d+'s base/)

    // Preflight reports the same stable warning shape and does not block: the
    // only blockers are the unrelated missing-worktree evidence.
    const gate = await tower.evaluateGate({ missionId: build.id, activity: {} })
    const warning = gate.warnings.find((entry) => entry.code === 'survey-stale')
    assert.ok(warning, 'preflight reports the stale dependency')
    assert.equal(warning.depId, survey.id)
    assert.equal(warning.readCommit, surveyRead)
    assert.equal(warning.baseCommit, oldBase)
    assert.equal(gate.blockers.some((blocker) => blocker.code === 'survey-stale'), false)
    assert.ok(gate.blockers.some((blocker) => blocker.code === 'branch-missing'))

    // `gates.requireFreshSurvey` promotes the same code to a merge blocker.
    writeRepoConfig(repo, { gates: { requireFreshSurvey: true } })
    const strict = await Tower.open(repo)
    const strictGate = await strict.evaluateGate({ missionId: build.id, activity: {} })
    const blocker = strictGate.blockers.find((entry) => entry.code === 'survey-stale')
    assert.ok(blocker, 'requireFreshSurvey promotes the same code to a blocker')
    assert.equal(blocker.missionId, build.id)
    assert.equal(blocker.depId, survey.id)
    assert.equal(blocker.detail, blocker.message)
    assert.match(blocker.message, /re-plan the survey against the current base/)
  } finally {
    removeTemp(root)
  }
})
