// Dependency result handoff (#148 D6): a build briefing carries the recorded
// survey evidence (paths/symbols/plan/notes) alongside the dependency status, so
// the dependent worker sees what was found rather than only that it finished.
// Formatting stays bounded for pathological evidence.
// Run with: node --test tests/dependency-result.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { Tower } from '../host/tower.js'
import { workerBriefing } from '../app/briefing.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-dep-result-') {
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

test('a build briefing carries the survey dependency result with bounded formatting', async () => {
  const { root, repo, tower } = await setup('dsh-tower-dep-result-e2e-')
  try {
    const plannedSurvey = await tower.plan({ missions: [{ title: 'Survey the seed', kind: 'survey' }] })
    const survey = plannedSurvey.missions[0]
    await tower.recordSpawn({
      missionId: survey.id,
      name: `worker-${survey.id.toLowerCase()}`,
      role: 'worker',
      agentId: 'agent-survey',
      parentSessionId: 'session-dep-result',
      cwd: tower.root,
      branch: null,
    })
    if ((await tower.load()).missions.find((entry) => entry.id === survey.id).status !== 'active') {
      await tower.mission({ id: survey.id, status: 'active' })
    }
    await tower.complete({
      missionId: survey.id,
      agentId: 'agent-survey',
      report: 'read the seed commit',
      result: {
        paths: ['README.md', 'docs/reference/shapes.md'],
        symbols: ['seed', 'shapeFor'],
        plan: ['document the split', 'add a regression test'],
        notes: 'the seed commit is enough',
      },
    })

    const plannedBuild = await tower.plan({
      missions: [{ title: 'Build on the survey', scope: ['src/**'], deps: [survey.id] }],
    })
    const build = plannedBuild.missions[0]
    const context = await tower.missionContext(build.id)
    assert.deepEqual(context.deps, [
      {
        id: survey.id,
        title: 'Survey the seed',
        kind: 'survey',
        status: 'completed',
        readCommit: (await tower.load()).missions.find((entry) => entry.id === survey.id).readCommit,
        result: {
          paths: ['README.md', 'docs/reference/shapes.md'],
          symbols: ['seed', 'shapeFor'],
          plan: ['document the split', 'add a regression test'],
          notes: 'the seed commit is enough',
        },
      },
    ])

    const text = workerBriefing({
      repoRoot: tower.root,
      base: context.base,
      mission: context.mission,
      deps: context.deps,
      worktree: { path: path.join(tower.root, '..', 'M1'), branch: 'tower/m1-build', baseCommit: context.mission.baseCommit },
      instructions: 'use the survey evidence',
      reviews: context.reviews,
      findings: context.findings,
      completionReport: context.completionReport,
    })
    assert.match(text, /- M\d+ Survey the seed \(completed, survey\)/)
    assert.ok(text.includes('evidence: paths: README.md, docs/reference/shapes.md'))
    assert.ok(text.includes('symbols: seed, shapeFor'))
    assert.ok(text.includes('plan: document the split; add a regression test'))
    assert.ok(text.includes('notes: the seed commit is enough'))
  } finally {
    removeTemp(root)
  }
})

test('evidence lines clip long paths, plan and notes instead of growing without bound', () => {
  const longPlan = Array.from({ length: 200 }, (_, index) => `step ${index + 1} ${'x'.repeat(20)}`)
  const deps = [
    {
      id: 'M1',
      title: 'Big survey',
      kind: 'survey',
      status: 'completed',
      result: {
        paths: Array.from({ length: 200 }, (_, index) => `src/file-${index}.js`),
        symbols: ['only-one'],
        plan: longPlan,
        notes: 'n'.repeat(5000),
      },
    },
  ]
  const text = workerBriefing({
    repoRoot: path.join(os.tmpdir(), 'tower-dep-result-unit'),
    base: 'main',
    mission: { id: 'M2', title: 'Build', kind: 'build', scope: ['src/**'], tasks: [], context: null, references: [] },
    deps,
    worktree: null,
    instructions: '',
    reviews: [],
    findings: [],
    completionReport: null,
  })
  const evidence = text.split('\n').find((line) => line.trimStart().startsWith('evidence:'))
  assert.ok(evidence)
  // First 20 paths only, and the plan/notes are clipped to 1200 characters.
  assert.ok(evidence.includes('src/file-19.js'))
  assert.equal(evidence.includes('src/file-20.js'), false)
  assert.ok(evidence.length < 3200)
  assert.equal(evidence.includes('n'.repeat(1300)), false)
})
