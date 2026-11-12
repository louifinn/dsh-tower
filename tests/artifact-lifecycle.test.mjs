// Artifact shape (#159): a mission that writes deliverables a code review
// cannot judge. It owns a branch/worktree like a build, declares its
// deliverables at plan time, completes only with them committed at the branch
// tip, and merges on a human acceptance of the whole tip instead of a review.
// Everything here drives the real Tower class against a temporary git repo.
// Run with: node --test tests/artifact-lifecycle.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { Tower } from '../host/tower.js'
import { defaultDeps } from '../adapters/default.js'
import { runDoctor } from '../host/doctor.js'
import { requestHumanAcceptance } from '../host/acceptance.js'
import { roleMissionBlockers } from '../domain/roles.js'
import { mergeGateBlockers } from '../domain/gate.js'
import { resolveTowerConfig } from '../domain/config/schema.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-artifact-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo }
}

async function setup(prefix, config) {
  const { root, repo } = seedRepo(prefix)
  if (!config) {
    const tower = await Tower.open(repo)
    await tower.init({})
    return { root, repo, tower }
  }
  const repoInfo = { root: repo, commonDir: path.join(repo, '.git'), branch: 'master' }
  const tower = new Tower(repoInfo, { ...resolveTowerConfig({}), ...config, configPath: null, repoConfigPresent: false }, defaultDeps)
  await tower.init({})
  return { root, repo, tower }
}

/**
 * Drive one artifact mission to `completed` with its deliverables committed.
 * Returns the mission with its worktree and the worker agent id.
 */
async function completedArtifactMission(tower, { artifacts = ['reports/q3/summary.html'], extra = {} } = {}) {
  const planned = await tower.plan({
    missions: [
      {
        title: 'Render the q3 report',
        kind: 'artifact',
        scope: ['reports/**'],
        artifacts,
        tasks: ['render'],
        ...extra,
      },
    ],
  })
  const mission = planned.missions[0]
  const provisioned = await tower.provision({ missionId: mission.id })
  const wt = provisioned.worktree.path
  for (const artifact of artifacts) {
    fs.mkdirSync(path.join(wt, path.dirname(artifact)), { recursive: true })
    fs.writeFileSync(path.join(wt, artifact), `${artifact} content\n`)
  }
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-m', `${mission.id} deliverables`])
  await tower.mission({ id: mission.id, status: 'active' })
  await tower.mission({ id: mission.id, task_done: 'render' })
  await tower.recordSpawn({
    missionId: mission.id,
    name: `worker-${mission.id.toLowerCase()}`,
    role: 'worker',
    agentId: `agent-${mission.id}`,
    parentSessionId: 'session-artifact',
    cwd: wt,
    branch: provisioned.worktree.branch,
  })
  const agentId = `agent-${mission.id}`
  await tower.complete({ missionId: mission.id, agentId, report: 'deliverables rendered and committed' })
  return { missionId: mission.id, worktree: provisioned.worktree, agentId, artifacts }
}

test('planning accepts a declared artifact list and refuses a missing, out-of-scope or glob entry', async () => {
  const { root, repo, tower } = await setup('dsh-tower-artifact-plan-')
  try {
    const planned = await tower.plan({
      missions: [
        {
          title: 'Export the dataset',
          kind: 'artifact',
          scope: ['reports/**', 'data/**'],
          artifacts: ['reports/q3/summary.html', 'data/q3.csv'],
        },
      ],
    })
    const mission = planned.missions[0]
    assert.equal(mission.kind, 'artifact')
    assert.deepEqual(mission.scope, ['reports/**', 'data/**'])
    assert.deepEqual(mission.artifacts, ['reports/q3/summary.html', 'data/q3.csv'])
    const stored = (await tower.load()).missions.find((entry) => entry.id === mission.id)
    assert.deepEqual(stored.artifacts, ['reports/q3/summary.html', 'data/q3.csv'])
    assert.equal('acceptance' in stored, false, 'no acceptance exists before a human accepts')

    await assert.rejects(
      () => tower.plan({ missions: [{ title: 'No deliverables', kind: 'artifact', scope: ['reports/**'] }] }),
      (error) => error.code === 'invalid-argument' && /an artifact mission declares its deliverables/.test(error.message),
    )
    await assert.rejects(
      () =>
        tower.plan({
          missions: [{ title: 'Outside scope', kind: 'artifact', scope: ['reports/**'], artifacts: ['docs/x.md'] }],
        }),
      (error) => error.code === 'invalid-argument' && /artifacts outside the mission scope/.test(error.message),
    )
    await assert.rejects(
      () =>
        tower.plan({
          missions: [{ title: 'Glob deliverable', kind: 'artifact', scope: ['reports/**'], artifacts: ['reports/**'] }],
        }),
      (error) => error.code === 'invalid-argument' && /concrete deliverable paths, not globs/.test(error.message),
    )
    // A build may not declare deliverables; the dimension belongs to the shape.
    await assert.rejects(
      () => tower.plan({ missions: [{ title: 'Build with artifacts', scope: ['src/**'], artifacts: ['src/a.js'] }] }),
      (error) => error.code === 'invalid-argument' && /may not declare artifacts/.test(error.message),
    )
  } finally {
    removeTemp(root)
  }
})

test('planning an artifact mission is refused with an actionable code while the tower-artifact row is off', async () => {
  const { root, repo } = await setup('dsh-tower-artifact-off-')
  try {
    const probed = []
    const offTower = await Tower.open(repo, {
      ...defaultDeps,
      components: {
        available: async (id) => {
          probed.push(id)
          return id !== 'tower-artifact'
        },
      },
    })
    await assert.rejects(
      () =>
        offTower.plan({
          missions: [{ title: 'Off-row artifact', kind: 'artifact', scope: ['reports/**'], artifacts: ['reports/r.html'] }],
        }),
      (error) =>
        error.code === 'invalid-argument' &&
        /the tower-artifact component is off: artifact missions cannot be planned; the other kinds are unaffected/.test(
          error.message,
        ) &&
        /enable the tower-artifact component/.test(String(error.nextAction)),
    )
    assert.deepEqual(probed, ['tower-artifact'], 'the shape row is what the probe gates')
    // Build and survey missions are unaffected by the off row.
    const build = await offTower.plan({ missions: [{ title: 'Build unaffected', scope: ['src/**'] }] })
    assert.equal(build.missions[0].kind, 'build')
    const survey = await offTower.plan({ missions: [{ title: 'Survey unaffected', kind: 'survey' }] })
    assert.equal(survey.missions[0].kind, 'survey')
  } finally {
    removeTemp(root)
  }
})

test('completion refuses an artifact that is uncommitted or missing from the branch tip', async () => {
  const { root, tower } = await setup('dsh-tower-artifact-uncommitted-')
  try {
    const planned = await tower.plan({
      missions: [{ title: 'Half-done report', kind: 'artifact', scope: ['reports/**'], artifacts: ['reports/r.html'], tasks: ['render'] }],
    })
    const missionId = planned.missions[0].id
    const provisioned = await tower.provision({ missionId })
    const wt = provisioned.worktree.path
    // Write the deliverable but commit only the notes: the worktree is dirty
    // with the uncommitted artifact, which completion must refuse.
    fs.mkdirSync(path.join(wt, 'reports'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'reports', 'notes.txt'), 'notes\n')
    fs.writeFileSync(path.join(wt, 'reports', 'r.html'), '<html>draft</html>\n')
    git(wt, ['add', 'reports/notes.txt'])
    git(wt, ['commit', '-m', 'notes only'])
    await tower.mission({ id: missionId, status: 'active' })
    await tower.mission({ id: missionId, task_done: 'render' })
    await tower.recordSpawn({
      missionId,
      name: 'worker-m1',
      role: 'worker',
      agentId: 'agent-m1',
      parentSessionId: 'session-artifact',
      cwd: wt,
      branch: provisioned.worktree.branch,
    })
    await assert.rejects(
      () => tower.complete({ missionId, agentId: 'agent-m1', report: 'done (dirty)' }),
      (error) => error.code === 'worktree-dirty' && /uncommitted changes/.test(error.message),
    )
    // Remove the draft and commit: the worktree is clean but the tip never
    // contained the deliverable, which completion must also refuse.
    fs.rmSync(path.join(wt, 'reports', 'r.html'))
    git(wt, ['add', '-A'])
    git(wt, ['commit', '--allow-empty', '-m', 'no deliverable yet'])
    await assert.rejects(
      () => tower.complete({ missionId, agentId: 'agent-m1', report: 'done (missing)' }),
      (error) =>
        error.code === 'invalid-argument' &&
        /artifacts missing from the branch tip/.test(error.message) &&
        /reports\/r\.html/.test(error.message),
    )
    // The pure check refuses an out-of-scope deliverable the same way, for a
    // scope that narrowed after the plan (scope can only widen in the tool
    // layer, so this path is exercised directly against the shape).
    const shape = (await import('../domain/shapes/index.js')).shapeFor('artifact')
    assert.throws(
      () =>
        shape.completion.check({
          mission: { id: 'M9', kind: 'artifact', scope: ['reports/**'], artifacts: ['docs/x.md'], worktree: { baseCommit: 'b' } },
          commits: 1,
          clean: true,
          dirtyPaths: [],
          artifactTip: 'tip1234567890',
          artifactsMissingAtTip: [],
          caseInsensitive: false,
        }),
      (error) => error.code === 'invalid-argument' && /artifacts outside its scope/.test(error.message),
    )
    // Committing the deliverable admits completion.
    fs.writeFileSync(path.join(wt, 'reports', 'r.html'), '<html>q3</html>\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'deliverable'])
    const done = await tower.complete({ missionId, agentId: 'agent-m1', report: 'rendered' })
    assert.equal(done.mission.status, 'completed')
  } finally {
    removeTemp(root)
  }
})

test('acceptance is a human record bound to a tip; workers and other shapes are refused', async () => {
  const { root, tower } = await setup('dsh-tower-artifact-accept-')
  try {
    const planned = await tower.plan({
      missions: [{ title: 'Dataset export', kind: 'artifact', scope: ['data/**'], artifacts: ['data/q3.csv'] }],
    })
    const missionId = planned.missions[0].id
    // Before provisioning there is no branch, so there is no tip to accept.
    await assert.rejects(
      () => tower.mission({ id: missionId, accept: { tip: 'abc' } }),
      (error) => error.code === 'invalid-transition' && /no branch yet/.test(error.message),
    )
    const provisioned = await tower.provision({ missionId })
    const tip = git(tower.root, ['rev-parse', `refs/heads/${provisioned.worktree.branch}`])
    const accepted = await tower.mission({ id: missionId, accept: { tip, note: ' human approved ' } })
    assert.equal(accepted.mission.acceptance.by, 'human')
    assert.equal(accepted.mission.acceptance.tip, tip)
    assert.equal(accepted.mission.acceptance.note, 'human approved')
    assert.deepEqual(accepted.mission.acceptance.artifacts, ['data/q3.csv'])
    assert.ok(Number.isFinite(accepted.mission.acceptance.at))

    // A worker cannot accept: the acceptance channel is the human decision.
    await assert.rejects(
      () =>
        tower.mission({
          id: missionId,
          accept: { tip },
          actor: { name: 'worker-m1', role: 'worker' },
        }),
      (error) => error.code === 'acceptance-human-only' && /a worker cannot accept/.test(error.message),
    )
    // A build mission never carries an acceptance record.
    const build = await tower.plan({ missions: [{ title: 'Plain build', scope: ['src/**'] }] })
    await assert.rejects(
      () => tower.mission({ id: build.missions[0].id, accept: { tip } }),
      (error) =>
        error.code === 'invalid-argument' && /a human acceptance replaces the review only for an artifact mission/.test(error.message),
    )
  } finally {
    removeTemp(root)
  }
})

test('a state document cannot smuggle an acceptance onto a build or a malformed record onto an artifact', async () => {
  const { root, tower } = await setup('dsh-tower-artifact-state-')
  try {
    const build = await tower.plan({ missions: [{ title: 'Build', scope: ['src/**'] }] })
    const artifact = await tower.plan({
      missions: [{ title: 'Report', kind: 'artifact', scope: ['reports/**'], artifacts: ['reports/r.html'] }],
    })
    const { validateState } = await import('../domain/state.js')
    const state = await tower.load()
    const buildRow = state.missions.find((entry) => entry.id === build.missions[0].id)
    const artifactRow = state.missions.find((entry) => entry.id === artifact.missions[0].id)
    assert.throws(
      () => validateState({ ...state, missions: [{ ...buildRow, acceptance: { at: 1, by: 'human', tip: 't', artifacts: [] } }] }, ''),
      (error) => error.code === 'state-corrupt' && /may not carry an acceptance record/.test(error.message),
    )
    assert.throws(
      () => validateState({ ...state, missions: [{ ...buildRow, artifacts: ['x'] }] }, ''),
      (error) => error.code === 'state-corrupt' && /may not declare artifacts/.test(error.message),
    )
    assert.throws(
      () =>
        validateState(
          { ...state, missions: [{ ...artifactRow, acceptance: { at: 1, by: 'agent', tip: 't', artifacts: ['reports/r.html'] } }] },
          '',
        ),
      (error) => error.code === 'state-corrupt' && /invalid acceptance record/.test(error.message),
    )
    assert.throws(
      () => validateState({ ...state, missions: [{ ...artifactRow, artifacts: [] }] }, ''),
      (error) => error.code === 'state-corrupt' && /needs a non-empty artifacts array/.test(error.message),
    )
  } finally {
    removeTemp(root)
  }
})

test('the merge gate refuses without an acceptance, refuses a stale one naming both shas, and merges on a current one', async () => {
  // review.mode is required for this whole flow: an artifact mission must be
  // structurally exempt from the review blockers and still merge (#159 D4).
  const { root, tower } = await setup('dsh-tower-artifact-gate-', { review: { mode: 'required' } })
  try {
    const { missionId, worktree, agentId, artifacts } = await completedArtifactMission(tower)
    const branchTip = () => git(tower.root, ['rev-parse', `refs/heads/${worktree.branch}`])

    // No review exists and none is demanded: the blocker is the acceptance.
    const missing = await tower.evaluateGate({ missionId, activity: {}, action: 'preflight' })
    assert.equal(missing.ok, false)
    const missingCodes = missing.blockers.map((blocker) => blocker.code)
    assert.ok(missingCodes.includes('acceptance-missing'), JSON.stringify(missingCodes))
    assert.equal(missingCodes.includes('no-review'), false, 'review blockers do not apply to an artifact mission')

    // Accept, then add one commit: the acceptance is stale and names both shas.
    await tower.mission({ id: missionId, accept: { tip: branchTip() } })
    const wt = worktree.path
    fs.writeFileSync(path.join(wt, 'reports', 'summary.html'), '<html>q3 v2</html>\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'deliverable v2'])
    const stale = await tower.evaluateGate({ missionId, activity: {}, action: 'preflight' })
    assert.equal(stale.ok, false)
    const staleBlocker = stale.blockers.find((blocker) => blocker.code === 'acceptance-stale')
    assert.ok(staleBlocker, JSON.stringify(stale.blockers.map((blocker) => blocker.code)))
    assert.match(staleBlocker.detail, /accepted [0-9a-f]{7} but tip is [0-9a-f]{7}/)

    // A fresh acceptance of the new tip merges for real.
    await tower.mission({ id: missionId, accept: { tip: branchTip() } })
    const ready = await tower.evaluateGate({ missionId, activity: {}, action: 'preflight' })
    assert.equal(ready.ok, true, JSON.stringify(ready.blockers))
    const merged = await tower.merge({ missionId, activity: {} })
    assert.equal(merged.ok, true, JSON.stringify(merged))
    const state = await tower.load()
    const stored = state.missions.find((entry) => entry.id === missionId)
    assert.equal(stored.status, 'merged')
    assert.ok(stored.mergedCommit)
    // The deliverable really landed in the main checkout.
    for (const artifact of artifacts) assert.equal(fs.existsSync(path.join(tower.root, artifact)), true)
    // The acceptance stays tip-bound: it names the tip that merged.
    assert.equal(stored.acceptance.tip, branchTip())
  } finally {
    removeTemp(root)
  }
})

test('an artifact mission has no reviewer: spawn prerequisites and review submission are refused', async () => {
  const { root, tower } = await setup('dsh-tower-artifact-noreview-')
  try {
    const planned = await tower.plan({
      missions: [{ title: 'Chart pack', kind: 'artifact', scope: ['reports/**'], artifacts: ['reports/c.png'] }],
    })
    const missionId = planned.missions[0].id
    const provisioned = await tower.provision({ missionId })
    const mission = (await tower.load()).missions.find((entry) => entry.id === missionId)
    const blockers = roleMissionBlockers('reviewer', { shape: (await import('../domain/shapes/index.js')).shapeFor('artifact'), mission })
    assert.ok(
      blockers.some((blocker) => /human acceptance of the committed tip, not a review/.test(blocker.message)),
      JSON.stringify(blockers),
    )
    // A break-glass tower review is refused too: the verdict channel does not
    // exist for this shape.
    await assert.rejects(
      () =>
        tower.submitReview({
          missionId,
          agentId: 'reviewer-x',
          status: 'clean',
          merge: 'merge',
          findings: 'none',
          decision: 'should be refused',
          actor: { name: 'tower', role: 'tower' },
          breakGlassReason: 'fixture',
        }),
      (error) => error.code === 'invalid-transition' && /human acceptance of the committed tip, not a review/.test(error.message),
    )
    void provisioned
  } finally {
    removeTemp(root)
  }
})

test('the human acceptance channel asks, records only on approval, and never auto-accepts', async () => {
  const { root, tower } = await setup('dsh-tower-artifact-channel-')
  try {
    const { missionId, worktree } = await completedArtifactMission(tower)
    const mission = (await tower.load()).missions.find((entry) => entry.id === missionId)
    const tip = git(tower.root, ['rev-parse', `refs/heads/${worktree.branch}`])

    const asked = []
    /** @param {string[] | null} selected @param {boolean} cancelled */
    const ctxWith = (selected, cancelled = false) => ({
      get: (id) =>
        id === 'userQuestions'
          ? {
              ask: async (question) => {
                asked.push(question.questions[0].question)
                if (cancelled) {
                  const error = new Error('cancelled')
                  error.cause = { code: 'ASK_CANCELLED' }
                  throw error
                }
                return { answers: [{ id: 'tower-acceptance', selected }] }
              },
            }
          : undefined,
    })
    const exec = { agent: { id: 'tower-agent' }, signal: undefined, concludeTurn: () => {} }

    // Approving through the human option records the acceptance at the tip.
    const approved = await requestHumanAcceptance(ctxWith(['Accept the committed tip']), exec, {
      tower,
      missionId,
      note: 'ship it',
    })
    assert.equal(approved.approved, true)
    assert.equal(approved.tip, tip)
    await tower.mission({ id: missionId, accept: { tip: approved.tip, note: 'ship it' } })
    assert.equal((await tower.load()).missions.find((entry) => entry.id === missionId).acceptance.tip, tip)

    // Declining or cancelling records nothing.
    for (const [label, ctx, expected] of [
      ['declined', ctxWith(['Keep unaccepted']), { approved: false, cancelled: false }],
      ['cancelled', ctxWith(null, true), { approved: false, cancelled: true }],
    ]) {
      const decision = await requestHumanAcceptance(ctx, exec, { tower, missionId })
      assert.equal(decision.approved, expected.approved, label)
      assert.equal(decision.cancelled ?? false, expected.cancelled, label)
    }
    assert.equal(asked.length, 3, 'each path asked the human exactly once')
    assert.match(asked[0], new RegExp(`Accept mission ${missionId}`))

    // Without the userQuestions service the acceptance is refused — a
    // non-interactive session never auto-accepts.
    await assert.rejects(
      () => requestHumanAcceptance({ get: () => undefined }, exec, { tower, missionId }),
      (error) => error.code === 'approval-unavailable' && /never auto-recorded/.test(error.message),
    )
    void mission
  } finally {
    removeTemp(root)
  }
})

test('doctor reports a missing artifact acceptance as a warning, not a review failure', async () => {
  const { root, tower } = await setup('dsh-tower-artifact-doctor-')
  try {
    const { missionId, worktree } = await completedArtifactMission(tower)
    const ctx = { get: () => undefined }
    const before = await runDoctor({ tower, ctx, agent: null })
    const pending = before.checks.find((entry) => entry.id === 'artifact-acceptance')
    assert.equal(pending.status, 'warn')
    assert.match(pending.detail, /1 artifact mission\(s\) wait on a human acceptance/)

    const tip = git(tower.root, ['rev-parse', `refs/heads/${worktree.branch}`])
    await tower.mission({ id: missionId, accept: { tip } })
    const after = await runDoctor({ tower, ctx, agent: null })
    const accepted = after.checks.find((entry) => entry.id === 'artifact-acceptance')
    assert.equal(accepted.status, 'pass')
    assert.match(accepted.detail, /with a recorded human acceptance/)
  } finally {
    removeTemp(root)
  }
})

test('the pure merge gate: an artifact never merges on a stale or missing acceptance under any review mode', () => {
  const mission = {
    id: 'M5',
    kind: 'artifact',
    status: 'completed',
    scope: ['reports/**'],
    artifacts: ['reports/r.html'],
    deps: [],
    tasks: [],
    blockers: [],
    notes: [],
    reviewPolicy: 'required-clean',
    testRuns: [],
    worktree: { path: '/wt', branch: 'tower/m5', baseCommit: 'b' },
  }
  for (const mode of ['off', 'optional', 'required']) {
    const evidence = {
      mission,
      roster: [],
      branch: 'tower/m5',
      branchTip: 'f'.repeat(40),
      review: null,
      config: { review: { mode }, gates: { requireChecks: false, requireTests: false } },
      activity: {},
      parentStatus: null,
      inactiveStates: [],
    }
    const missing = mergeGateBlockers({ ...evidence })
    assert.deepEqual(
      missing.map((blocker) => blocker.code),
      ['acceptance-missing'],
      `mode ${mode}: no review blocker is produced for an artifact mission`,
    )
    const stale = mergeGateBlockers({
      ...evidence,
      mission: { ...mission, acceptance: { at: 1, by: 'human', tip: 'e'.repeat(40), artifacts: ['reports/r.html'] } },
    })
    assert.deepEqual(
      stale.map((blocker) => blocker.code),
      ['acceptance-stale'],
      `mode ${mode}: a moved tip makes the acceptance stale`,
    )
    assert.match(stale[0].detail, /accepted eeeeeee but tip is fffffff/)
    const current = mergeGateBlockers({
      ...evidence,
      mission: { ...mission, acceptance: { at: 1, by: 'human', tip: 'f'.repeat(40), artifacts: ['reports/r.html'] } },
    })
    assert.deepEqual(current, [], `mode ${mode}: a tip-bound acceptance clears the gate`)
  }
})
