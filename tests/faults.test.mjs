// Failure modes of the durable store: corrupt/unsupported state files, a held
// writer lock, and a mission whose worktree disappeared. Every case goes
// through the real tool surface so the stable [tower:<code>] mapping is part of
// what is verified.
// Run with: node --test tests/faults.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { registerTowerTools } from '../host/tool-registry.js'
import { Tower } from '../host/tower.js'
import { withLock } from '../adapters/store.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo(prefix = 'dsh-tower-faults-') {
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
    },
    systemPrompt: { section() {} },
    inject(_deps, callback) {
      callback(ctx)
    },
  }
  registerTowerTools(ctx)
  return { ctx, tools }
}

const exec = { agent: { id: 'tower-faults' } }

test('corrupt state files are reported as [tower:state-corrupt] and leave the file untouched', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    await tools
      .get('tower_plan')
      .execute({ repoRoot: repo, missions: [{ title: 'Corruption fixture', scope: ['src/**'] }] }, exec)
    const tower = await Tower.open(repo)
    const baseline = fs.readFileSync(tower.paths.state, 'utf8')
    const parsed = JSON.parse(baseline)

    const corruptVariants = [
      ['invalid JSON', 'this is not json at all'],
      ['missing missions array', JSON.stringify({ ...parsed, missions: 'nope' }, null, 2)],
      [
        'unknown mission status',
        JSON.stringify(
          { ...parsed, missions: [{ ...parsed.missions[0], status: 'launched' }] },
          null,
          2,
        ),
      ],
      [
        'duplicate mission ids',
        JSON.stringify({ ...parsed, missions: [parsed.missions[0], { ...parsed.missions[0] }] }, null, 2),
      ],
    ]

    for (const [label, text] of corruptVariants) {
      fs.writeFileSync(tower.paths.state, text)
      await assert.rejects(
        () => tools.get('tower_status').execute({ repoRoot: repo }, exec),
        /\[tower:state-corrupt\]/,
        `${label} must classify as state-corrupt`,
      )
      // The reader never rewrites a corrupt file; operators can inspect it.
      assert.equal(fs.readFileSync(tower.paths.state, 'utf8'), text, `${label} must be left untouched`)
      await assert.rejects(
        () => tools.get('tower_plan').execute({ repoRoot: repo, missions: [{ title: 'Blocked', scope: ['x/**'] }] }, exec),
        /\[tower:state-corrupt\]/,
        `${label} must also block writers`,
      )
      fs.writeFileSync(tower.paths.state, baseline)
    }

    // A newer schema is not corruption: it is refused without a rewrite so an
    // older plugin can never silently downgrade state written by a newer one.
    const newerText = JSON.stringify({ ...parsed, schemaVersion: 99 }, null, 2)
    fs.writeFileSync(tower.paths.state, newerText)
    await assert.rejects(
      () => tools.get('tower_status').execute({ repoRoot: repo }, exec),
      /\[tower:state-version-unsupported\]/,
    )
    assert.equal(fs.readFileSync(tower.paths.state, 'utf8'), newerText, 'a newer state must be left untouched')
    fs.writeFileSync(tower.paths.state, baseline)

    // The untouched baseline still works afterwards.
    const status = await tools.get('tower_status').execute({ repoRoot: repo }, exec)
    assert.equal(status.counts.planned, 1)
  } finally {
    removeTemp(root)
  }
})

test('a heartbeating state writer lock fails closed with [tower:state-locked]', async () => {
  const { root, repo } = seedRepo('dsh-tower-faults-lock-')
  const { tools } = makeCtx()
  try {
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    const tower = await Tower.open(repo)
    // A lock is only "held" while its heartbeat is fresh (#92): hold it through
    // the real withLock so the fixture is a live writer, not a bare PID record.
    let releaseHolder
    const gate = new Promise((resolve) => {
      releaseHolder = resolve
    })
    const holding = withLock(tower.paths, () => gate)
    for (let attempt = 0; attempt < 200 && !fs.existsSync(tower.paths.lock); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(fs.existsSync(tower.paths.lock), 'the holder must acquire the lock')

    const started = Date.now()
    await assert.rejects(
      () => tools.get('tower_plan').execute({ repoRoot: repo, missions: [{ title: 'Locked', scope: ['x/**'] }] }, exec),
      /\[tower:state-locked\]/,
    )
    // The writer must wait for the documented 5s lock timeout, not steal it.
    assert.ok(Date.now() - started >= 4500, 'a held lock must not be stolen')
    assert.ok(fs.existsSync(tower.paths.lock), 'the foreign lock must still exist after giving up')

    releaseHolder()
    await holding
    assert.equal(fs.existsSync(tower.paths.lock), false, 'releasing the holder must clear the lock')
    const planned = await tools
      .get('tower_plan')
      .execute({ repoRoot: repo, missions: [{ title: 'After lock', scope: ['x/**'] }] }, exec)
    assert.equal(planned.missions[0].id, 'M1')
  } finally {
    removeTemp(root)
  }
})

test('a missing worktree blocks preflight with branch-missing instead of throwing', async () => {
  const { root, repo } = seedRepo('dsh-tower-faults-worktree-')
  const { tools } = makeCtx()
  try {
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    await tools
      .get('tower_plan')
      .execute({ repoRoot: repo, missions: [{ title: 'Vanished worktree', scope: ['src/**'] }] }, exec)
    const tower = await Tower.open(repo)
    const provisioned = await tower.provision({ missionId: 'M1' })
    const worktreePath = provisioned.worktree.path
    assert.ok(fs.existsSync(worktreePath))
    removeTemp(worktreePath)

    const preflight = await tools.get('tower_preflight').execute({ repoRoot: repo, missionId: 'M1' }, exec)
    assert.equal(preflight.ok, false)
    assert.ok(
      preflight.blockers.some((blocker) => blocker.code === 'branch-missing'),
      `expected branch-missing, saw ${JSON.stringify(preflight.blockers)}`,
    )

    const status = await tools
      .get('tower_status')
      .execute({ repoRoot: repo, includeGate: true }, exec)
    const pageMission = status.missions.find((mission) => mission.id === 'M1')
    assert.equal(pageMission.gate.ok, false)
    assert.ok(pageMission.gate.blockers.some((blocker) => blocker.code === 'branch-missing'))

    // A merge attempt stays a blocker result, not an exception.
    const merge = await tools.get('tower_merge').execute({ repoRoot: repo, missionId: 'M1' }, exec)
    assert.equal(merge.ok, false)
    assert.ok(merge.blockers.some((blocker) => blocker.code === 'branch-missing'))
  } finally {
    removeTemp(root)
  }
})
