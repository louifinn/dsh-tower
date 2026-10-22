// Scope matching on case-insensitive filesystems (#90).
//
// Scope text is stored exactly as the operator wrote it. Whether comparison
// folds case is a property of the checkout, detected once at `tower_init` and
// recorded in state; the pure helpers take that decision as an argument so the
// case-insensitive branch runs on Linux CI too. The one probe that needs a real
// case-insensitive filesystem is declared with `skip:`, so Linux counts it as
// `# SKIP` instead of dropping it silently.
//
// Run with: node --test tests/scope-case.test.mjs
// TAP view: node --test --test-reporter=tap tests/scope-case.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Tower } from '../app/tower.js'
import { fileInScope, scopesOverlap } from '../domain/scope.js'
import { outOfScopeBlocker } from '../domain/integration/gate.js'
import { detectCaseSensitivity } from '../lib/caseSensitivity.js'
import { registerTowerTools } from '../lib/tool-registry.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

function seedRepo(prefix = 'dsh-tower-scope-case-') {
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

function makeCtx() {
  const tools = new Map()
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get() {
      return undefined
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
      guard() {
        return () => {}
      },
      restrict() {},
    },
    systemPrompt: { section() {} },
    inject(_deps, callback) {
      callback(ctx)
    },
  }
  registerTowerTools(ctx)
  return { ctx, tools }
}

const towerExec = { agent: { id: 'tower-scope-case' } }
const call = (tools, name, args, exec = towerExec) => tools.get(name).execute(args, exec)

/** Inject the detected mode the way a real case-insensitive checkout would have. */
async function patchState(repo, mutate) {
  const tower = await Tower.open(repo)
  const state = JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
  mutate(state)
  fs.writeFileSync(tower.paths.state, JSON.stringify(state, null, 2))
  return state
}

function errno(code) {
  const error = /** @type {Error & {code?: string}} */ (new Error(`synthetic ${code}`))
  error.code = code
  return error
}

// ---------------------------------------------------------------------------
// Pure matching helpers: folding is conditional, never global
// ---------------------------------------------------------------------------

test('fileInScope: case folding is opt-in, never global', () => {
  // Case-sensitive (the default) keeps today's byte-exact answer.
  assert.equal(fileInScope(['src/Api/**'], 'src/api/x.js'), false)
  assert.equal(fileInScope(['src/Api/**'], 'src/api/x.js', { caseInsensitive: false }), false)
  // A case-insensitive checkout folds both sides.
  assert.equal(fileInScope(['src/Api/**'], 'src/api/x.js', { caseInsensitive: true }), true)
  assert.equal(fileInScope(['src/api/**'], 'src/Api/x.js', { caseInsensitive: true }), true)
  assert.equal(fileInScope(['src/Api/**'], 'src/Api/x.js', { caseInsensitive: true }), true)
  // Folding case does not widen the scope to unrelated trees.
  assert.equal(fileInScope(['src/Api/**'], 'docs/x.js', { caseInsensitive: true }), false)
})

test('scopesOverlap: case-only trees overlap only in case-insensitive mode', () => {
  assert.equal(scopesOverlap(['src/Api/**'], ['src/api/**']), false, 'case-sensitive checkouts keep these disjoint')
  assert.equal(scopesOverlap(['src/Api/**'], ['src/api/**'], { caseInsensitive: true }), true)
  assert.equal(scopesOverlap(['src/Api/**'], ['src/api/deep/**'], { caseInsensitive: true }), true)
  assert.equal(scopesOverlap(['src/Api/**'], ['lib/**'], { caseInsensitive: true }), false)
})

test('out-of-scope blocker: accepts a case-only file when insensitive, explains it when sensitive', () => {
  const mission = { scope: ['src/Api/**'] }
  assert.equal(
    outOfScopeBlocker({ mission, changedFiles: ['src/api/x.js'], caseInsensitive: true }),
    null,
    'a case-insensitive checkout must not refuse a file that differs only by case',
  )

  const blocker = outOfScopeBlocker({ mission, changedFiles: ['src/api/x.js'] })
  assert.equal(blocker.code, 'out-of-scope')
  // The rejection stays, and the detail names the closest matching scope path
  // so the operator sees a case mistake rather than an inscrutable gate.
  assert.match(blocker.detail, /src\/api\/x\.js/)
  assert.match(blocker.detail, /src\/Api\/\*\*/)
  assert.match(blocker.detail, /case-sensitive/)
  assert.match(blocker.detail, /only when case is folded/)

  const unrelated = outOfScopeBlocker({ mission, changedFiles: ['docs/readme.md'] })
  assert.equal(unrelated.code, 'out-of-scope')
  assert.doesNotMatch(unrelated.detail, /case mismatch/, 'unrelated files get no case-mismatch hint')
})

// ---------------------------------------------------------------------------
// The probe: one real filesystem test, plus injected failures
// ---------------------------------------------------------------------------

test('case probe: reports a boolean for the real filesystem and leaves no probe file behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-case-probe-'))
  try {
    const detected = await detectCaseSensitivity(dir)
    assert.equal(typeof detected, 'boolean')
    assert.deepEqual(fs.readdirSync(dir), [], 'the probe must clean up its own file')
  } finally {
    cleanup(dir)
  }
})

test(
  'case probe: a real Windows filesystem is case-insensitive',
  { skip: process.platform === 'win32' ? false : 'requires a real case-insensitive filesystem (Windows)' },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-case-real-'))
    try {
      assert.equal(await detectCaseSensitivity(dir), true)
    } finally {
      cleanup(dir)
    }
  },
)

test('case probe: a filesystem that cannot be probed reports unknown instead of failing', async () => {
  // Read-only checkout: the write is refused (EPERM/EACCES/EROFS).
  const readOnly = {
    writeFile: async () => {
      throw errno('EACCES')
    },
    stat: async () => {
      throw errno('ENOENT')
    },
    unlink: async () => {},
  }
  assert.equal(await detectCaseSensitivity('/unwritable', { fs: readOnly }), null)

  // The write succeeded but the stat was refused: that is "unknown", not
  // "case-sensitive", because a failed lookup must not silently weaken matching.
  const opaque = {
    writeFile: async () => {},
    stat: async () => {
      throw errno('EACCES')
    },
    unlink: async () => {},
  }
  assert.equal(await detectCaseSensitivity('/opaque', { fs: opaque }), null)

  // The two decisive answers are distinguishable through the same seam.
  const caseSensitive = {
    writeFile: async () => {},
    stat: async () => {
      throw errno('ENOENT')
    },
    unlink: async () => {},
  }
  const caseInsensitive = { writeFile: async () => {}, stat: async () => ({}), unlink: async () => {} }
  assert.equal(await detectCaseSensitivity('/sensitive', { fs: caseSensitive }), false)
  assert.equal(await detectCaseSensitivity('/insensitive', { fs: caseInsensitive }), true)
})

// ---------------------------------------------------------------------------
// tower_init records the detection once
// ---------------------------------------------------------------------------

test('tower_init probes once, records caseInsensitive, and does not re-probe on the next call', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    const initialized = await call(tools, 'tower_init', { repoRoot: repo })
    assert.equal(initialized.created, true)
    assert.equal(typeof initialized.caseInsensitive, 'boolean', 'init reports the detected mode')

    const tower = await Tower.open(repo)
    const state = JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
    assert.equal(typeof state.caseInsensitive, 'boolean')
    assert.equal(initialized.caseInsensitive, state.caseInsensitive)
    assert.equal(
      state.caseInsensitive,
      await detectCaseSensitivity(tower.root),
      'the recorded value must be what this checkout actually reports',
    )

    // "Detect once": an existing state with a boolean is not re-probed, so a
    // later temp-file failure cannot silently flip the comparison mode.
    const second = await call(tools, 'tower_init', { repoRoot: repo })
    assert.equal(second.revision, initialized.revision)
    assert.equal(second.caseInsensitive, initialized.caseInsensitive)

    // Acceptance: tower_doctor reports the detected mode and the comparison it
    // activates, without probing or writing anything itself.
    const doctor = await call(tools, 'tower_doctor', { repoRoot: repo })
    assert.equal(doctor.environmentContract.caseInsensitive, state.caseInsensitive)
    assert.equal(
      doctor.environmentContract.comparisonMode,
      state.caseInsensitive ? 'case-insensitive' : 'case-sensitive',
    )
    const caseCheck = doctor.checks.find((entry) => entry.id === 'case-mode')
    assert.equal(caseCheck.status, 'pass')
    assert.match(caseCheck.detail, new RegExp(`caseInsensitive: ${state.caseInsensitive}`))
    assert.match(caseCheck.detail, new RegExp(doctor.environmentContract.comparisonMode))
  } finally {
    cleanup(root)
  }
})

test('tower_init skips a failed probe cleanly and leaves the mode unknown', async () => {
  const { root, repo } = seedRepo('dsh-tower-scope-skip-')
  try {
    const tower = await Tower.open(repo)
    // A probe seam rather than a chmod: the failure branch must run on every OS.
    tower.deps = { ...tower.deps, caseSensitivity: { detect: async () => null } }
    const initialized = await tower.init({ towerAgentId: 'tower-scope-case' })
    assert.equal(initialized.created, true, 'a skipped probe must not fail init')
    assert.equal(initialized.caseInsensitive, null)
    const state = JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
    assert.equal(state.caseInsensitive, null)

    // Acceptance: doctor reports the unknown result as a warning and names the
    // safe comparison it is actually using.
    const { tools } = makeCtx()
    const doctor = await call(tools, 'tower_doctor', { repoRoot: repo })
    assert.equal(doctor.environmentContract.caseInsensitive, null)
    assert.equal(doctor.environmentContract.comparisonMode, 'case-sensitive')
    assert.equal(doctor.checks.find((entry) => entry.id === 'case-mode').status, 'warn')

    // Once a later probe succeeds, an explicit init records it (one revision).
    tower.deps = { ...tower.deps, caseSensitivity: { detect: async () => true } }
    const detected = await tower.init({ towerAgentId: 'tower-scope-case' })
    assert.equal(detected.caseInsensitive, true)
    assert.equal(detected.revision, initialized.revision + 1)
    assert.equal(JSON.parse(fs.readFileSync(tower.paths.state, 'utf8')).caseInsensitive, true)
  } finally {
    cleanup(root)
  }
})

// ---------------------------------------------------------------------------
// End to end: plan, gate and stored scope text
// ---------------------------------------------------------------------------

test('case-insensitive mode: case-only scopes serialise, a case-only file passes the gate, and scope text is untouched', async () => {
  const { root, repo } = seedRepo('dsh-tower-scope-e2e-')
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    // Inject the mode a real Windows/macOS checkout would have detected.
    await patchState(repo, (state) => {
      state.caseInsensitive = true
    })

    const tower = await Tower.open(repo)
    const planned = await tower.plan({
      missions: [
        { title: 'Upper API', scope: ['src/Api/**'] },
        { title: 'Lower API', scope: ['src/api/**'] },
      ],
    })
    // Acceptance: the two missions are overlapping, so they are serialised
    // rather than allowed to run in parallel against the same real files.
    assert.deepEqual(planned.missions[1].deps, ['M1'])

    const state = JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
    // Acceptance: stored scope strings stay exactly as the operator typed them.
    assert.deepEqual(state.missions[0].scope, ['src/Api/**'])
    assert.deepEqual(state.missions[1].scope, ['src/api/**'])

    const provisioned = await tower.provision({ missionId: 'M1' })
    const worktree = provisioned.worktree.path
    fs.mkdirSync(path.join(worktree, 'src', 'api'), { recursive: true })
    fs.writeFileSync(path.join(worktree, 'src', 'api', 'x.js'), 'x\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-m', 'M1 case-only path'])

    // Acceptance: on a case-insensitive checkout the changed file is in scope.
    const accepted = await tower.evaluateGate({ missionId: 'M1', activity: {} })
    assert.equal(
      accepted.blockers.some((blocker) => blocker.code === 'out-of-scope'),
      false,
      JSON.stringify(accepted.blockers),
    )

    // The same fixture on a case-sensitive checkout keeps rejecting it, with an
    // actionable detail naming the scope that differs only by case.
    await patchState(repo, (st) => {
      st.caseInsensitive = false
    })
    const rejected = await tower.evaluateGate({ missionId: 'M1', activity: {} })
    const blocker = rejected.blockers.find((entry) => entry.code === 'out-of-scope')
    assert.ok(blocker, JSON.stringify(rejected.blockers))
    assert.match(blocker.detail, /src\/api\/x\.js/)
    assert.match(blocker.detail, /src\/Api\/\*\*/)
    assert.match(blocker.detail, /case-sensitive/)
  } finally {
    cleanup(root)
  }
})

test('case-insensitive mode: widening a scope onto a case-only twin is rejected as overlapping', async () => {
  const { root, repo } = seedRepo('dsh-tower-scope-widen-')
  try {
    const tower = await Tower.open(repo)
    await tower.init({ towerAgentId: 'tower-scope-case' })
    await patchState(repo, (state) => {
      state.caseInsensitive = true
    })
    await tower.plan({
      missions: [
        { title: 'Upper API', scope: ['src/Api/**'] },
        { title: 'Docs', scope: ['docs/**'] },
      ],
    })
    await tower.mission({ id: 'M2', status: 'active' })
    await assert.rejects(
      () => tower.mission({ id: 'M2', scope: ['src/api/**'] }),
      /widened scope overlaps mission M1/,
    )
    // Case-sensitive checkouts keep the same two trees genuinely distinct.
    await patchState(repo, (state) => {
      state.caseInsensitive = false
    })
    const widened = await tower.mission({ id: 'M2', scope: ['src/api/**'] })
    assert.equal(widened.mission.scope[0], 'src/api/**')
  } finally {
    cleanup(root)
  }
})
