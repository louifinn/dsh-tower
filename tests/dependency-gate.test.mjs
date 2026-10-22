// #107: the dependency gate is kind-aware. A build dependency must be merged
// (or abandoned), but a survey is terminal-success at `completed` — it is
// read-only and has no branch to merge, so requiring `merged` would keep the
// dependent mission blocked forever. Archived entries carry `kind` for the same
// decision.
//
// The first test is pure; the other two drive the real preflight core against a
// temporary git repository so the archive-index wiring is covered too.
// Run with: node --test tests/dependency-gate.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { Tower } from '../lib/tower.js'
import { dependencyBlockers } from '../domain/integration/gate.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-dependency-gate-') {
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

async function driveTo(tower, missionId, status) {
  const chains = {
    active: ['active'],
    completed: ['active', 'completed'],
  }
  for (const step of chains[status]) await tower.mission({ id: missionId, status: step })
}

function unmerged(blockers) {
  return blockers.filter((blocker) => blocker.code === 'deps-unmerged')
}

test('dependency satisfaction is kind-aware: a completed survey passes, a build still needs merged', () => {
  const state = {
    missions: [
      { id: 'M1', kind: 'survey', status: 'completed' },
      { id: 'M2', kind: 'build', status: 'completed' },
      { id: 'M3', kind: 'build', status: 'merged' },
      { id: 'M4', kind: 'survey', status: 'active' },
    ],
  }
  assert.deepEqual(dependencyBlockers({ deps: ['M1', 'M3'], state }), [])
  assert.deepEqual(unmerged(dependencyBlockers({ deps: ['M2'], state })), [
    { code: 'deps-unmerged', detail: 'M2 is completed' },
  ])
  assert.deepEqual(unmerged(dependencyBlockers({ deps: ['M4'], state })), [
    { code: 'deps-unmerged', detail: 'M4 is active' },
  ])

  // Archived missions arrive through the compact index; `kind` must be enough
  // to make the same decision without loading the year file.
  const archived = new Map([
    ['M20', { id: 'M20', kind: 'survey', status: 'completed' }],
    ['M21', { id: 'M21', kind: 'build', status: 'completed' }],
  ])
  assert.deepEqual(dependencyBlockers({ deps: ['M20'], state: { missions: [] }, archived }), [])
  assert.deepEqual(unmerged(dependencyBlockers({ deps: ['M21'], state: { missions: [] }, archived })), [
    { code: 'deps-unmerged', detail: 'M21 is completed' },
  ])
})

test('preflight accepts a completed survey dependency and still blocks a completed build dependency', async () => {
  const { root, repo } = seedRepo()
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({
      missions: [
        { title: 'Survey the area', kind: 'survey' },
        { title: 'Build from the survey', scope: ['src/**'], deps: ['M1'] },
        { title: 'Build after the build', scope: ['other/**'], deps: ['M2'] },
      ],
    })
    await driveTo(tower, 'M1', 'completed')
    await driveTo(tower, 'M2', 'completed')
    await driveTo(tower, 'M3', 'completed')

    const surveyDependent = await tower.evaluateGate({ missionId: 'M2', activity: {} })
    assert.deepEqual(unmerged(surveyDependent.blockers), [])

    const buildDependent = await tower.evaluateGate({ missionId: 'M3', activity: {} })
    assert.deepEqual(unmerged(buildDependent.blockers), [
      { code: 'deps-unmerged', detail: 'M2 is completed' },
    ])
  } finally {
    removeTemp(root)
  }
})

test('preflight accepts an archived completed survey dependency', async () => {
  const { root, repo } = seedRepo()
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    const now = Date.now()
    const archiveDir = path.join(tower.paths.dir, 'archive')
    fs.mkdirSync(archiveDir, { recursive: true })
    fs.writeFileSync(
      path.join(archiveDir, 'index.json'),
      JSON.stringify({
        archiveVersion: 1,
        updatedAt: now,
        missions: [
          {
            id: 'M30',
            title: 'Archived survey',
            status: 'completed',
            kind: 'survey',
            scope: [],
            deps: [],
            owner: null,
            branch: null,
            mergedCommit: null,
            mergedAt: null,
            updatedAt: now,
            archivedAt: now,
            archivedYear: new Date(now).getUTCFullYear(),
          },
        ],
      }),
    )
    await tower.plan({
      missions: [{ title: 'Build after the archived survey', scope: ['src/**'], deps: ['M30'] }],
    })
    const gate = await tower.evaluateGate({ missionId: 'M1', activity: {} })
    assert.deepEqual(unmerged(gate.blockers), [])
  } finally {
    removeTemp(root)
  }
})
