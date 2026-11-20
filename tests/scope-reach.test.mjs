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
import { createDefaultDeps } from '../adapters/default.js'
import { SCHEMA_VERSION } from '../domain/mission.js'
import { scopeFenceBlocker } from '../domain/scope.js'
import { outOfScopeBlocker } from '../domain/integration/gate.js'
import { normalizeMissionInput } from '../domain/missions/plan.js'
import { addAutoDeps } from '../domain/planning.js'
import { SHAPES } from '../domain/shapes/index.js'
import { createMemoryStore } from './support/memory-store.js'
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

// ---------------------------------------------------------------------------
// #200: a plan scope entry must match a tracked file, or name a tree that does
// not exist yet. Before this, a typo such as `tests/teardown*.test.mjs` was
// accepted, and the mistake was only discoverable after a worker was spawned —
// a planned mission cannot widen, so the only recovery was abandon + replan.
// ---------------------------------------------------------------------------

test('#200: planning a scope that matches no tracked file fails before any mission is created', async () => {
  const { root, repo } = seedRepo('dsh-tower-scope-untracked-', {
    'README.md': 'seed\n',
    'tests/cleanup.test.mjs': 'cleanup\n',
  })
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-scope-untracked' })
    await assert.rejects(
      tower.plan({ missions: [{ title: 'Teardown tests', scope: ['tests/teardown*.test.mjs'] }] }),
      (error) => {
        assert.equal(error.code, 'invalid-argument')
        assert.match(error.message, /no tracked file matches "tests\/teardown\*\.test\.mjs"/)
        assert.match(error.message, /nearest existing prefix "tests"/)
        assert.match(error.message, /tests\/cleanup\.test\.mjs/)
        // A plan caller can actually carry the offered hatch.
        assert.match(error.nextAction, /allowMissingScope: true/)
        assert.equal(error.details.operation, 'plan')
        return true
      },
    )
    const state = JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
    assert.deepEqual(state.missions, [], 'a rejected plan must not create a mission')
  } finally {
    removeTemp(root)
  }
})

test('#200: planning a literal path that matches no tracked file names the closest candidates', async () => {
  const { root, repo } = seedRepo('dsh-tower-scope-untracked-literal-', {
    'README.md': 'seed\n',
    'scripts/generate-deny-surface.mjs': 'surface\n',
  })
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-scope-untracked-literal' })
    await assert.rejects(
      tower.plan({ missions: [{ title: 'Check deny surface', scope: ['scripts/check-deny.mjs'] }] }),
      (error) => {
        assert.equal(error.code, 'invalid-argument')
        assert.match(error.message, /no tracked file matches "scripts\/check-deny\.mjs"/)
        assert.match(error.message, /nearest existing prefix "scripts"/)
        assert.match(error.message, /scripts\/generate-deny-surface\.mjs/)
        assert.match(error.nextAction, /allowMissingScope: true/)
        assert.equal(error.details.operation, 'plan')
        return true
      },
    )
  } finally {
    removeTemp(root)
  }
})

test('#200: a glob that matches only ignored files is rejected, and the escape hatch accepts it', async () => {
  const { root, repo } = seedRepo('dsh-tower-scope-ignored-', {
    'README.md': 'seed\n',
    '.gitignore': 'dist/\n',
  })
  try {
    fs.mkdirSync(path.join(repo, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'dist', 'bundle.js'), 'built but ignored\n')
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-scope-ignored' })
    await assert.rejects(
      tower.plan({ missions: [{ title: 'Build output', scope: ['dist/*.js'] }] }),
      (error) => {
        assert.equal(error.code, 'invalid-argument')
        assert.match(error.message, /no tracked file matches "dist\/\*\.js"/)
        assert.match(error.message, /nearest existing prefix "dist"/)
        return true
      },
    )
    // The hatch is the explicit way to say "a mission will create this".
    const planned = await tower.plan({
      missions: [{ title: 'Build output', scope: ['dist/*.js'], allowMissingScope: true }],
    })
    assert.deepEqual(planned.missions[0].scope, ['dist/*.js'])
  } finally {
    removeTemp(root)
  }
})

test('#200: tracked files, existing directories, **, . and future trees stay planable', async () => {
  const { root, repo } = seedRepo('dsh-tower-scope-legal-', {
    'README.md': 'seed\n',
    'docs/guide/quickstart.md': 'start\n',
    'tests/cleanup.test.mjs': 'cleanup\n',
  })
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-scope-legal' })
    const planned = await tower.plan({
      missions: [
        { title: 'Real file', scope: ['tests/cleanup.test.mjs'] },
        { title: 'Real directory', scope: ['docs/guide'] },
        { title: 'Everything', scope: ['**'] },
        { title: 'Root', scope: ['.'] },
        // A top-level tree that does not exist yet is a mission's own work: it
        // has no known territory to contradict, so it stays legal.
        { title: 'Future tree', scope: ['src/**'] },
        // Root-level literal entries are unverifiable (no parent directory to
        // compare), and the existing unknown-dependency error still wins for
        // them; the gate fences them exactly as before.
        { title: 'Future root file', scope: ['dep.txt'] },
      ],
    })
    assert.deepEqual(
      planned.missions.map((mission) => mission.scope),
      [['tests/cleanup.test.mjs'], ['docs/guide/**'], ['**'], ['**'], ['src/**'], ['dep.txt']],
    )
  } finally {
    removeTemp(root)
  }
})

test('#200: allowMissingScope accepts a path the mission will create and records it', async () => {
  const { root, repo } = seedRepo('dsh-tower-scope-hatch-', {
    'README.md': 'seed\n',
    'tests/cleanup.test.mjs': 'cleanup\n',
  })
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-scope-hatch' })
    const planned = await tower.plan({
      missions: [{ title: 'Future test', scope: ['tests/new-case.test.mjs'], allowMissingScope: true }],
    })
    assert.deepEqual(planned.missions[0].scope, ['tests/new-case.test.mjs'])
    // The hatch is an input decision, not part of the stored mission.
    assert.equal(Object.hasOwn(planned.missions[0], 'allowMissingScope'), false)
    const state = JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
    assert.equal(Object.hasOwn(state.missions[0], 'allowMissingScope'), false)
    // One activity record names what was accepted without proof.
    const activity = await tower.deps.store.readActivityTail(tower.paths.activity, 10)
    const record = activity.find((entry) => entry.type === 'scope.unverified')
    assert.ok(record, JSON.stringify(activity))
    assert.equal(record.missionId, 'M1')
    assert.match(record.text, /accepted unverified scope: tests\/new-case\.test\.mjs/)
    // The same entry without the flag is still rejected.
    await assert.rejects(
      tower.plan({ missions: [{ title: 'No hatch', scope: ['tests/other-case.test.mjs'] }] }),
      /no tracked file matches/,
    )
    // A direct embedder may also skip the check for the whole plan call.
    const direct = await tower.plan({
      missions: [{ title: 'Top-level hatch', scope: ['tests/top-level.test.mjs'] }],
      allowMissingScope: true,
    })
    assert.deepEqual(direct.missions[0].scope, ['tests/top-level.test.mjs'])
    const after = await tower.deps.store.readActivityTail(tower.paths.activity, 10)
    assert.equal(after.filter((entry) => entry.type === 'scope.unverified').length, 2)
  } finally {
    removeTemp(root)
  }
})

test('#200: widening scope to a path that names no tracked file leaves the mission untouched', async () => {
  const { root, repo } = seedRepo('dsh-tower-scope-widen-miss-', {
    'README.md': 'seed\n',
    'tests/cleanup.test.mjs': 'cleanup\n',
  })
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-scope-widen-miss' })
    await tower.plan({ missions: [{ title: 'Base', scope: ['tests/cleanup.test.mjs'] }] })
    await tower.mission({ id: 'M1', status: 'active' })
    const before = JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
    await assert.rejects(
      tower.mission({ id: 'M1', scope: ['tests/teardown*.test.mjs'] }),
      (error) => {
        assert.equal(error.code, 'invalid-argument')
        assert.match(error.message, /no tracked file matches "tests\/teardown\*\.test\.mjs"/)
        assert.match(error.message, /tests\/cleanup\.test\.mjs/)
        // R170: tower_mission cannot carry the plan hatch, so the widen message
        // must not send the caller after a flag the tool has no field for.
        assert.doesNotMatch(error.nextAction, /allowMissingScope/)
        assert.doesNotMatch(error.message, /allowMissingScope/)
        assert.match(error.nextAction, /tracked path/)
        assert.match(error.nextAction, /existing directory/)
        assert.match(error.nextAction, /does not exist yet/)
        assert.match(error.nextAction, /original plan/)
        assert.equal(error.details.operation, 'widen')
        return true
      },
    )
    const after = JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
    assert.deepEqual(after.missions[0].scope, before.missions[0].scope)
    assert.equal(after.missions[0].scopeGeneration, before.missions[0].scopeGeneration)
  } finally {
    removeTemp(root)
  }
})

test('#200: a rejected plan reports every problem, with the plural matching the count', async () => {
  const { root, repo } = seedRepo('dsh-tower-scope-multi-', {
    'README.md': 'seed\n',
    'tests/cleanup.test.mjs': 'cleanup\n',
    'scripts/tool.mjs': 'tool\n',
    'docs/guide/quickstart.md': 'start\n',
  })
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-scope-multi' })
    // Two problems: one further entry.
    await assert.rejects(
      tower.plan({ missions: [{ title: 'Two typos', scope: ['tests/teardown*.test.mjs', 'scripts/missing.mjs'] }] }),
      (error) => {
        assert.equal(error.code, 'invalid-argument')
        assert.match(error.message, /1 more scope entry matches no tracked file/)
        assert.doesNotMatch(error.message, /entries match no tracked file/)
        assert.equal(error.details.operation, 'plan')
        assert.equal(error.details.problems.length, 2)
        assert.deepEqual(
          error.details.problems.map((problem) => problem.entry),
          ['tests/teardown*.test.mjs', 'scripts/missing.mjs'],
        )
        for (const problem of error.details.problems) {
          assert.equal(problem.reason, 'no tracked file matches')
          assert.equal(typeof problem.closestPrefix, 'string')
          assert.ok(problem.closestPrefix.length > 0)
          assert.ok(Array.isArray(problem.candidates))
          assert.ok(problem.candidates.length > 0)
        }
        return true
      },
    )
    // Three problems: two further entries.
    await assert.rejects(
      tower.plan({
        missions: [
          {
            title: 'Three typos',
            scope: ['tests/teardown*.test.mjs', 'scripts/missing.mjs', 'docs/guide/later.md'],
          },
        ],
      }),
      (error) => {
        assert.equal(error.code, 'invalid-argument')
        assert.match(error.message, /2 more scope entries match no tracked file/)
        assert.equal(error.details.operation, 'plan')
        assert.equal(error.details.problems.length, 3)
        assert.deepEqual(
          error.details.problems.map((problem) => problem.entry),
          ['tests/teardown*.test.mjs', 'scripts/missing.mjs', 'docs/guide/later.md'],
        )
        for (const problem of error.details.problems) {
          assert.equal(problem.reason, 'no tracked file matches')
          assert.equal(typeof problem.closestPrefix, 'string')
          assert.ok(problem.closestPrefix.length > 0)
          assert.ok(Array.isArray(problem.candidates))
          assert.deepEqual(problem.candidates[0], {
            'tests/teardown*.test.mjs': 'tests/cleanup.test.mjs',
            'scripts/missing.mjs': 'scripts/tool.mjs',
            'docs/guide/later.md': 'docs/guide/quickstart.md',
          }[problem.entry])
        }
        return true
      },
    )
    const state = JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
    assert.deepEqual(state.missions, [], 'neither rejected plan created a mission')
  } finally {
    removeTemp(root)
  }
})

test('#200: a legal widen still expands and bumps scopeGeneration, and the facade hatch accepts a future path', async () => {
  const { root, repo } = seedRepo('dsh-tower-scope-widen-hatch-', {
    'README.md': 'seed\n',
    'docs/guide/quickstart.md': 'start\n',
    'scripts/tool.mjs': 'tool\n',
  })
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-scope-widen-hatch' })
    await tower.plan({ missions: [{ title: 'Base', scope: ['lib/**'] }] })
    await tower.mission({ id: 'M1', status: 'active' })

    // A real path still expands and bumps the generation.
    const widened = await tower.mission({ id: 'M1', scope: ['docs/guide'] })
    assert.deepEqual(widened.mission.scope, ['docs/guide/**'])
    assert.equal(widened.mission.scopeGeneration, 2)

    // A future file under a tracked directory needs the explicit hatch; the
    // direct facade call is the only way to pass it until the tool wrapper
    // forwards the field (reported with the mission), and the widen rejection
    // does not offer a flag `tower_mission` cannot carry.
    await assert.rejects(tower.mission({ id: 'M1', scope: ['scripts/new-tool.mjs'] }), (error) => {
      assert.match(error.message, /no tracked file matches/)
      assert.doesNotMatch(error.nextAction, /allowMissingScope/)
      assert.match(error.nextAction, /tracked path/)
      assert.equal(error.details.operation, 'widen')
      return true
    })
    const accepted = await tower.mission({ id: 'M1', scope: ['scripts/new-tool.mjs'], allowMissingScope: true })
    assert.deepEqual(accepted.mission.scope, ['scripts/new-tool.mjs'])
    assert.equal(accepted.mission.scopeGeneration, 3)
    assert.equal(Object.hasOwn(accepted.mission, 'allowMissingScope'), false)
    const activity = await tower.deps.store.readActivityTail(tower.paths.activity, 10)
    const record = activity.find((entry) => entry.type === 'scope.unverified')
    assert.ok(record, JSON.stringify(activity))
    assert.match(record.text, /widened to unverified scope: scripts\/new-tool\.mjs/)
  } finally {
    removeTemp(root)
  }
})


// ---------------------------------------------------------------------------
// F70: the directory probe reads the StorePort stat contract, not a duck type
// ---------------------------------------------------------------------------

test('F70: the in-memory store expands a bare directory and keeps files/nonexistent paths literal', async () => {
  // The probe used to duck-type `info.isDirectory()` while StorePort declared
  // only `{mtimeMs}`. Both shipped implementations already return a
  // directory-aware stat; this pins the in-memory one to the same planning
  // behaviour as the filesystem case above, with no disk and no git.
  const store = createMemoryStore()
  const root = '/virtual/repo'
  const commonDir = `${root}/.git`
  const paths = store.pathsFor(commonDir)
  await store.ensureDir(paths.dir)
  await store.writeJsonAtomic(paths.state, {
    schemaVersion: SCHEMA_VERSION,
    repoRoot: root,
    commonDir,
    base: 'main',
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
    missions: [],
  })
  await store.ensureDir(`${root}/docs/guide`)
  await store.writeText(`${root}/README.md`, 'seed\n')
  const tower = new Tower(
    { root, commonDir, branch: 'main' },
    { mode: { lockTimeoutMs: 100 } },
    createDefaultDeps({ store }),
  )
  const planned = await tower.plan({
    missions: [
      { title: 'Guide', scope: ['docs/guide'] },
      { title: 'Literal', scope: ['README.md', 'no/such/dir'] },
    ],
  })
  assert.deepEqual(
    planned.missions.map((mission) => mission.scope),
    [['docs/guide/**'], ['README.md', 'no/such/dir']],
  )
  const stored = JSON.parse(store.inspect.readText(paths.state))
  assert.deepEqual(
    stored.missions.map((mission) => mission.scope),
    [['docs/guide/**'], ['README.md', 'no/such/dir']],
  )
})

