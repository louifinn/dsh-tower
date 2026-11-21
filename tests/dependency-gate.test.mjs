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

import { Tower } from '../host/tower.js'
import { dependencyBlockers } from '../domain/integration/gate.js'
import { resolutionPlan } from '../domain/gate.js'

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

// #208: a blocker list is a diagnosis, not an order of operations. These are
// pure tests of the ordering helper that the preflight view calls.
test('resolution order merges dependencies ancestor-first, then rebases, then finishes the mission', () => {
  const mission = { id: 'M3', status: 'active', deps: ['M2'] }
  const missions = [
    { id: 'M1', kind: 'build', status: 'active', deps: [] },
    { id: 'M2', kind: 'build', status: 'completed', deps: ['M1'] },
    mission,
  ]
  const blockers = [
    { code: 'stale-base', detail: 'branch M3 does not contain base tip' },
    { code: 'deps-unmerged', detail: 'M2 is completed' },
    { code: 'mission-not-completed', detail: 'mission M3 is active' },
  ]
  const plan = resolutionPlan({ blockers, mission, missions, archived: [] })
  assert.deepEqual(plan.order, [
    { step: 1, action: 'merge-dependency', missionId: 'M1' },
    { step: 2, action: 'merge-dependency', missionId: 'M2' },
    { step: 3, action: 'rebase' },
    { step: 4, action: 'complete-mission' },
  ])
  assert.equal(plan.cycle, null)
  assert.deepEqual(
    plan.blockers.find((blocker) => blocker.code === 'deps-unmerged').resolution,
    [
      { step: 1, action: 'merge-dependency', missionId: 'M1' },
      { step: 2, action: 'merge-dependency', missionId: 'M2' },
    ],
  )
  assert.deepEqual(
    plan.blockers.find((blocker) => blocker.code === 'stale-base').resolution,
    [{ step: 1, action: 'rebase' }],
  )
  for (const blocker of plan.blockers) assert.ok(blocker.resolution.length > 0, `${blocker.code} has no resolution`)
})

test('resolution order reports a dependency cycle by name and never plans a merge inside it', () => {
  const mission = { id: 'M1', status: 'active', deps: ['M2'] }
  const missions = [
    mission,
    { id: 'M2', kind: 'build', status: 'completed', deps: ['M3'] },
    { id: 'M3', kind: 'build', status: 'active', deps: ['M2'] },
  ]
  const blockers = [{ code: 'deps-unmerged', detail: 'M2 is completed' }]
  const plan = resolutionPlan({ blockers, mission, missions, archived: [] })
  assert.equal(plan.cycle.code, 'dependency-cycle')
  assert.deepEqual([...plan.cycle.missionIds].sort(), ['M2', 'M3'])
  assert.match(plan.cycle.detail, /M2 -> M3 -> M2|M3 -> M2 -> M3/)
  assert.equal(plan.order[0].action, 'break-dependency-cycle')
  assert.deepEqual(plan.order[0].missionIds.sort(), ['M2', 'M3'])
  assert.equal(plan.order.some((step) => step.action === 'merge-dependency'), false)
  assert.equal(plan.blockers[0].resolution[0].action, 'break-dependency-cycle')
})

test('resolution order is empty without blockers and a single stale base only rebases', () => {
  const empty = resolutionPlan({
    blockers: [],
    mission: { id: 'M1', deps: [] },
    missions: [{ id: 'M1', kind: 'build', status: 'active', deps: [] }],
    archived: [],
  })
  assert.deepEqual(empty, { blockers: [], order: [], cycle: null })

  const stale = resolutionPlan({
    blockers: [{ code: 'stale-base', detail: 'stale' }],
    mission: { id: 'M1', deps: [] },
    missions: [{ id: 'M1', kind: 'build', status: 'active', deps: [] }],
    archived: [],
  })
  assert.deepEqual(stale.order, [{ step: 1, action: 'rebase' }])
  assert.deepEqual(stale.blockers[0].resolution, stale.order)
  assert.equal(stale.cycle, null)
})

// #208 R182: a survey has no branch to merge (`canMerge: false`), so a
// `merge-dependency` step names an operation the shape forbids and the gate can
// never satisfy. The plan asks to complete that dependency instead.
test('resolution order completes a survey dependency and still merges a build dependency', () => {
  const mission = { id: 'M2', kind: 'build', status: 'active', deps: ['M1'] }
  const surveyDependency = { id: 'M1', kind: 'survey', status: 'active', deps: [] }
  const surveyPlan = resolutionPlan({
    blockers: [{ code: 'deps-unmerged', detail: 'M1 is active' }],
    mission,
    missions: [surveyDependency, mission],
    archived: [],
  })
  assert.deepEqual(surveyPlan.order, [{ step: 1, action: 'complete-mission', missionId: 'M1' }])
  assert.equal(surveyPlan.order.some((step) => step.action === 'merge-dependency'), false)
  assert.deepEqual(surveyPlan.blockers[0].resolution, surveyPlan.order)

  // A completed survey satisfies the dependency, so the blocker and the plan disappear.
  const satisfied = resolutionPlan({
    blockers: [],
    mission,
    missions: [{ ...surveyDependency, status: 'completed' }, mission],
    archived: [],
  })
  assert.deepEqual(satisfied, { blockers: [], order: [], cycle: null })

  // Not a regression: a build dependency is still merged, ancestor-first.
  const buildPlan = resolutionPlan({
    blockers: [{ code: 'deps-unmerged', detail: 'M1 is completed' }],
    mission,
    missions: [{ id: 'M1', kind: 'build', status: 'completed', deps: [] }, mission],
    archived: [],
  })
  assert.deepEqual(buildPlan.order, [{ step: 1, action: 'merge-dependency', missionId: 'M1' }])
})

// End-to-end through a real plan/state snapshot: the mission kind a plan stores
// is what the preflight resolution reads, so the survey action survives wiring.
test('a planned survey dependency resolves by completing it, not merging it', async () => {
  const { root, repo } = seedRepo()
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({
      missions: [
        { title: 'Survey the area', kind: 'survey' },
        { title: 'Build from the survey', scope: ['src/**'], deps: ['M1'] },
      ],
    })
    await tower.mission({ id: 'M1', status: 'active' })

    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === 'M2')
    const blockers = dependencyBlockers({ deps: mission.deps, state })
    assert.deepEqual(unmerged(blockers), [{ code: 'deps-unmerged', detail: 'M1 is active' }])

    const plan = resolutionPlan({ blockers, mission, missions: state.missions, archived: [] })
    assert.deepEqual(plan.order, [{ step: 1, action: 'complete-mission', missionId: 'M1' }])
    assert.deepEqual(plan.blockers[0].resolution, plan.order)
  } finally {
    removeTemp(root)
  }
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
