// #149 W4: scope ownership is one shape declaration (`reach`) and one fence.
//
// The gate, planning and mission-input rules all derive from the same reach;
// none of them compares a kind literal or re-reads `mission.scope` to decide
// whether a path change is permitted.
//
// F18 extends the same principle to directory-shaped scope entries: planning
// expands a directory into its explicit subtree glob, while an already stored
// literal fence keeps the exact text it recorded (see the end-to-end cases).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { Tower } from '../host/tower.js'
import { scopeFenceBlocker } from '../domain/scope.js'
import { outOfScopeBlocker } from '../domain/integration/gate.js'
import { normalizeMissionInput } from '../domain/missions/plan.js'
import { addAutoDeps } from '../domain/planning.js'
import { SHAPES } from '../domain/shapes/index.js'
import { removeTemp } from './helpers/cleanup.mjs'

test('a build fence accepts scope members and rejects everything else', () => {
  const mission = { id: 'M1', kind: 'build', scope: ['src/**', 'tests/**'] }
  const reach = SHAPES.build.reach
  assert.equal(scopeFenceBlocker({ mission, reach, changedFiles: ['src/a.js', 'tests/b.mjs'] }), null)
  const blocker = scopeFenceBlocker({ mission, reach, changedFiles: ['src/a.js', 'docs/x.md'] })
  assert.equal(blocker.code, 'out-of-scope')
  assert.match(blocker.detail, /docs\/x\.md/)
})

test('a read-only fence rejects any changed path and needs no scope', () => {
  const mission = { id: 'S1', kind: 'survey', scope: [] }
  const reach = SHAPES.survey.reach
  assert.equal(scopeFenceBlocker({ mission, reach, changedFiles: [] }), null)
  const blocker = scopeFenceBlocker({ mission, reach, changedFiles: ['src/a.js'] })
  assert.equal(blocker.code, 'out-of-scope')
  assert.match(blocker.detail, /read-only/)
  assert.match(blocker.detail, /src\/a\.js/)
})

test('the merge-gate enforcer derives reach from the mission kind, never from scope presence', () => {
  assert.equal(
    outOfScopeBlocker({ mission: { id: 'M1', kind: 'build', scope: ['src/**'] }, changedFiles: ['src/a.js'] }),
    null,
  )
  const survey = outOfScopeBlocker({ mission: { id: 'S1', kind: 'survey' }, changedFiles: ['src/a.js'] })
  assert.equal(survey.code, 'out-of-scope')
  assert.match(survey.detail, /read-only/)
})

test('mission input rejects a scope on a shape that does not own paths', () => {
  assert.throws(
    () => normalizeMissionInput({ title: 'Read it', kind: 'survey', scope: ['src/**'], readCommit: 'a'.repeat(40) }, 0, { commit: 'a'.repeat(40) }),
    /does not own/,
  )
  const survey = normalizeMissionInput({ title: 'Read it', kind: 'survey', readCommit: 'a'.repeat(40) }, 0, { commit: 'a'.repeat(40) })
  assert.deepEqual(survey.scope, [])
  const build = normalizeMissionInput({ title: 'Change it', kind: 'build', scope: ['src/**'] }, 0)
  assert.deepEqual(build.scope, ['src/**'])
})

test('auto-dependencies are added only between shapes that own paths', () => {
  const existing = [{ id: 'M1', kind: 'build', status: 'active', scope: ['src/**'], deps: [] }]
  const created = [
    { id: 'M2', kind: 'build', status: 'planned', scope: ['src/a.js'], deps: [] },
    { id: 'S1', kind: 'survey', status: 'planned', scope: [], deps: [] },
  ]
  addAutoDeps(created, existing)
  assert.deepEqual(created[0].deps, ['M1'])
  assert.deepEqual(created[1].deps, [])
})

// ---------------------------------------------------------------------------
// F18: directory-shaped scope entries expand at planning time
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(repo, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo }
}

function writeAndCommit(worktree, relative, content) {
  const target = path.join(worktree, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  git(worktree, ['add', '-A'])
  git(worktree, ['commit', '-m', `edit ${relative}`])
}

test('F18: planning a directory scope stores its explicit subtree and the gate accepts files below it', async () => {
  const { root, repo } = seedRepo('dsh-tower-scope-dir-', {
    'README.md': 'seed\n',
    'docs/guide/quickstart.md': 'start\n',
    'docs/outer.md': 'outer\n',
  })
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-scope-dir' })
    const planned = await tower.plan({
      missions: [
        { title: 'Guide', scope: ['docs/guide'] },
        { title: 'Fresh reports', scope: ['reports/'] },
        { title: 'Literal path', scope: ['no/such/dir'] },
        { title: 'Glob', scope: ['src/**'] },
        // F18 also unblocks an artifact mission: its deliverables are checked
        // against the stored scope, so the directory entry must already be the
        // subtree glob when the shape validates the plan.
        { title: 'Guide deliverable', kind: 'artifact', scope: ['docs/guide'], artifacts: ['docs/guide/quickstart.md'] },
        // A bare path that names an existing file is not a directory: it stays
        // exactly as written and keeps matching that file.
        { title: 'Readme', scope: ['README.md'] },
      ],
    })
    // The returned plan and the stored state both carry explicit globs: the
    // directory entry never reaches the fence matcher as a bare path.
    const expected = [
      ['docs/guide/**'],
      ['reports/**'],
      ['no/such/dir'],
      ['src/**'],
      ['docs/guide/**'],
      ['README.md'],
    ]
    assert.deepEqual(
      planned.missions.map((mission) => mission.scope),
      expected,
    )
    const state = JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
    assert.deepEqual(
      state.missions.map((mission) => mission.scope),
      expected,
    )

    const provisioned = await tower.provision({ missionId: 'M1' })
    const worktree = provisioned.worktree.path
    writeAndCommit(worktree, 'docs/guide/quickstart.md', 'edited below the directory\n')
    const accepted = await tower.evaluateGate({ missionId: 'M1', activity: {} })
    assert.equal(
      accepted.blockers.some((blocker) => blocker.code === 'out-of-scope'),
      false,
      JSON.stringify(accepted.blockers),
    )

    // A sibling stays outside the subtree glob: expansion widens to the
    // directory, not to the whole parent path.
    writeAndCommit(worktree, 'docs/outer.md', 'edited outside the directory\n')
    const rejected = await tower.evaluateGate({ missionId: 'M1', activity: {} })
    const blocker = rejected.blockers.find((entry) => entry.code === 'out-of-scope')
    assert.ok(blocker, JSON.stringify(rejected.blockers))
    assert.match(blocker.detail, /docs\/outer\.md/)
  } finally {
    removeTemp(root)
  }
})

test('F18: widening a scope through tower_mission expands a directory entry too', async () => {
  const { root, repo } = seedRepo('dsh-tower-scope-widen-dir-', {
    'README.md': 'seed\n',
    'docs/guide/quickstart.md': 'start\n',
  })
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-scope-widen-dir' })
    await tower.plan({ missions: [{ title: 'Guides', scope: ['lib/**'] }] })
    await tower.mission({ id: 'M1', status: 'active' })
    const widened = await tower.mission({ id: 'M1', scope: ['docs/guide'] })
    assert.deepEqual(widened.mission.scope, ['docs/guide/**'])
    assert.equal(widened.mission.scopeGeneration, 2, 'the widening still bumps the generation once')
    const state = JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
    assert.deepEqual(state.missions[0].scope, ['docs/guide/**'])
  } finally {
    removeTemp(root)
  }
})

test('F18: an already stored literal scope is never rewritten and still rejects files below it', async () => {
  const { root, repo } = seedRepo('dsh-tower-scope-stored-', {
    'README.md': 'seed\n',
    'docs/guide/quickstart.md': 'start\n',
  })
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-scope-stored' })
    await tower.plan({ missions: [{ title: 'Legacy fence', scope: ['docs/guide/**'] }] })

    // Simulate a fence recorded before F18: the expansion is planning-time only,
    // so this literal text must survive untouched and keep its old meaning.
    const state = JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
    state.missions[0].scope = ['docs/guide']
    fs.writeFileSync(tower.paths.state, JSON.stringify(state, null, 2))

    const provisioned = await tower.provision({ missionId: 'M1' })
    const worktree = provisioned.worktree.path
    writeAndCommit(worktree, 'docs/guide/quickstart.md', 'edited below a stored literal\n')
    const gate = await tower.evaluateGate({ missionId: 'M1', activity: {} })
    const blocker = gate.blockers.find((entry) => entry.code === 'out-of-scope')
    assert.ok(blocker, 'a stored literal fence must keep rejecting files below the directory')
    assert.match(blocker.detail, /docs\/guide\/quickstart\.md/)
    assert.match(blocker.detail, /docs\/guide/)
    // The stored text is still exactly what was recorded, not an expanded glob.
    assert.deepEqual(JSON.parse(fs.readFileSync(tower.paths.state, 'utf8')).missions[0].scope, ['docs/guide'])
  } finally {
    removeTemp(root)
  }
})
