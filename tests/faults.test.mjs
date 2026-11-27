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
import { configureRuntime } from '../host/config.js'
import { Tower } from '../host/tower.js'
import { withLock } from '../adapters/store.js'
import { validateJsonSchema } from './schema-validator.mjs'

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

/** Pre-migration backups a load would create (`state.json.v<N>.bak`). */
function backupsFor(tower) {
  return fs
    .readdirSync(tower.paths.dir)
    .filter((name) => /^state\.json\.v\d+\.bak$/.test(name))
    .sort()
}

/**
 * F41: a degraded report must name the resolution failure exactly once, replace
 * the normal config row instead of duplicating it, and still run the rest of the
 * read-only diagnostics. The value must stay valid against the declared output
 * schema.
 */
function assertConfigFailure(doctor, doctorTool, { code, detail }) {
  validateJsonSchema(doctorTool.output.schema, doctor)
  assert.equal(doctor.ok, false, 'a config-resolution failure must degrade the report, not reject')
  assert.equal(typeof doctor.configError, 'string')
  assert.match(doctor.configError, new RegExp(`\\[tower:${code}\\]`))
  assert.match(doctor.configError, detail)
  const configRows = doctor.checks.filter((entry) => entry?.id === 'config')
  assert.equal(configRows.length, 1, 'the normal config row is replaced, not duplicated')
  assert.equal(configRows[0].status, 'fail')
  assert.match(configRows[0].detail, new RegExp(`\\[tower:${code}\\]`))
  assert.match(configRows[0].action, /repair the config/)
  assert.equal(doctor.checks.find((entry) => entry?.id === 'state')?.status, 'pass')
  assert.equal(doctor.stateSchema.status, 'current')
}

test('unreadable state degrades tower_status to a read-only diagnostic and leaves the file untouched', async () => {
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

    // `stateSchema` can only report what the version header says: invalid JSON
    // is genuinely `invalid`, while the semantic variants below still parse as
    // the current version and fail validity, so their status legitimately stays
    // `current` and `stateError` carries the fault (F40).
    const corruptVariants = [
      { label: 'invalid JSON', text: 'this is not json at all', schemaStatus: 'invalid' },
      { label: 'missing missions array', text: JSON.stringify({ ...parsed, missions: 'nope' }, null, 2) },
      {
        label: 'unknown mission status',
        text: JSON.stringify({ ...parsed, missions: [{ ...parsed.missions[0], status: 'launched' }] }, null, 2),
      },
      {
        label: 'duplicate mission ids',
        text: JSON.stringify({ ...parsed, missions: [parsed.missions[0], { ...parsed.missions[0] }] }, null, 2),
      },
    ]

    for (const { label, text, schemaStatus } of corruptVariants) {
      fs.writeFileSync(tower.paths.state, text)
      // F40: status is a public read-only diagnostic row. It reports the
      // unreadable state from disk instead of throwing inside the handler, and
      // it never migrates, backs up, or rewrites the file.
      const status = await tools.get('tower_inspect').execute({ view: 'status', repoRoot: repo }, exec)
      assert.equal(status.ok, false, `${label} must degrade status, not reject`)
      assert.match(status.stateError, /\[tower:state-corrupt\]/, `${label} must classify as state-corrupt`)
      assert.deepEqual(status.counts, {}, `${label} must not invent counts`)
      assert.deepEqual(status.missions, [], `${label} must not invent missions`)
      assert.deepEqual(status.activity, [], `${label} must not invent activity`)
      assert.deepEqual(status.stateSchema.migrations, [])
      if (schemaStatus === 'invalid') {
        // Nothing was parsed, so the on-disk schema report is genuinely invalid.
        assert.equal(status.stateSchema.status, 'invalid', `${label} must report an invalid schema`)
        assert.equal(status.stateSchema.currentVersion, null)
        assert.match(status.stateSchema.message, /could not be inspected/)
      } else {
        // Semantic corruption still parses as the current schemaVersion: the
        // version is readable even though the contents are not.
        assert.equal(status.stateSchema.currentVersion, parsed.schemaVersion)
      }
      // The reader never rewrites a corrupt file; operators can inspect it.
      assert.equal(fs.readFileSync(tower.paths.state, 'utf8'), text, `${label} must be left untouched`)
      assert.deepEqual(backupsFor(tower), [], `${label} must not be backed up or migrated`)
      await assert.rejects(
        () => tools.get('tower_plan').execute({ repoRoot: repo, missions: [{ title: 'Blocked', scope: ['x/**'] }] }, exec),
        /\[tower:state-corrupt\]/,
        `${label} must also block writers`,
      )
      fs.writeFileSync(tower.paths.state, baseline)
    }

    // A newer schema is not corruption: status degrades the same way, and the
    // document is refused without a rewrite so an older plugin can never
    // silently downgrade state written by a newer one.
    const newerText = JSON.stringify({ ...parsed, schemaVersion: 99 }, null, 2)
    fs.writeFileSync(tower.paths.state, newerText)
    const newer = await tools.get('tower_inspect').execute({ view: 'status', repoRoot: repo }, exec)
    assert.equal(newer.ok, false)
    assert.match(newer.stateError, /\[tower:state-version-unsupported\]/)
    assert.equal(newer.stateSchema.status, 'newer')
    assert.equal(newer.stateSchema.currentVersion, 99)
    assert.equal(newer.stateSchema.supportedVersion, parsed.schemaVersion)
    assert.deepEqual(newer.stateSchema.migrations, [])
    assert.deepEqual(newer.counts, {})
    assert.deepEqual(newer.missions, [])
    assert.deepEqual(newer.activity, [])
    assert.equal(fs.readFileSync(tower.paths.state, 'utf8'), newerText, 'a newer state must be left untouched')
    assert.deepEqual(backupsFor(tower), [], 'a newer state must never be backed up or downgraded')
    await assert.rejects(
      () => tools.get('tower_plan').execute({ repoRoot: repo, missions: [{ title: 'Blocked', scope: ['x/**'] }] }, exec),
      /\[tower:state-version-unsupported\]/,
      'a newer state must still block writers',
    )
    fs.writeFileSync(tower.paths.state, baseline)

    // The untouched baseline still works afterwards.
    const status = await tools.get('tower_inspect').execute({ view: 'status', repoRoot: repo }, exec)
    assert.equal(status.counts.planned, 1)
  } finally {
    removeTemp(root)
  }
})

test('F41: an invalid repository config still reaches tower_doctor as a degraded read-only report', async () => {
  const { root, repo } = seedRepo('dsh-tower-faults-config-')
  const { tools } = makeCtx()
  const doctorTool = tools.get('tower_inspect')
  try {
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    await tools
      .get('tower_plan')
      .execute({ repoRoot: repo, missions: [{ title: 'Config fault fixture', scope: ['src/**'] }] }, exec)
    const tower = await Tower.open(repo)
    const configFile = path.join(tower.commonDir, 'dsh-tower', 'config.json')
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    const stateBefore = fs.readFileSync(tower.paths.state, 'utf8')
    const variants = [
      { label: 'invalid JSON', text: '{ "spawn": ', code: 'config-invalid', detail: /not valid JSON/ },
      {
        label: 'unknown key',
        text: JSON.stringify({ allowAgentToggle: true }),
        code: 'config-unknown-key',
        detail: /unknown key/,
      },
      {
        label: 'invalid value',
        text: JSON.stringify({ merge: { timeoutMs: 5 } }),
        code: 'config-invalid',
        detail: /is invalid/,
      },
    ]
    for (const variant of variants) {
      fs.writeFileSync(configFile, variant.text)
      const doctor = await doctorTool.execute({ view: 'doctor', repoRoot: repo }, exec)
      assertConfigFailure(doctor, doctorTool, variant)
      assert.equal(doctor.environmentContract.repoRoot, repo)
      // Read-only means byte-identical: no state rewrite, no migration backup,
      // and no normalisation of the broken config file.
      assert.equal(fs.readFileSync(tower.paths.state, 'utf8'), stateBefore, `${variant.label}: state must be untouched`)
      assert.equal(fs.readFileSync(configFile, 'utf8'), variant.text, `${variant.label}: config must be untouched`)
      assert.deepEqual(backupsFor(tower), [], `${variant.label}: no migration may run`)
      // Only the config-diagnostic row degrades; every other tool fails closed.
      const codePattern = new RegExp(`\\[tower:${variant.code}\\]`)
      await assert.rejects(
        () => tools.get('tower_inspect').execute({ view: 'status', repoRoot: repo }, exec),
        codePattern,
        `${variant.label}: status must report the config error`,
      )
      await assert.rejects(
        () =>
          tools
            .get('tower_plan')
            .execute({ repoRoot: repo, missions: [{ title: 'Blocked', scope: ['x/**'] }] }, exec),
        codePattern,
        `${variant.label}: plan must report the config error`,
      )
    }
  } finally {
    removeTemp(root)
  }
})

test('F41: an invalid profile config degrades tower_doctor while writers stay closed', async () => {
  const { root, repo } = seedRepo('dsh-tower-faults-profile-')
  const { tools } = makeCtx()
  const doctorTool = tools.get('tower_inspect')
  try {
    // configureRuntime() assigns the raw profile before it validates it, so a
    // rejected plugin config (or a live `.volatile()` settings write) leaves an
    // unresolvable profile behind — the second F41 seam.
    configureRuntime({})
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    await tools
      .get('tower_plan')
      .execute({ repoRoot: repo, missions: [{ title: 'Profile fault fixture', scope: ['src/**'] }] }, exec)
    const tower = await Tower.open(repo)
    const stateBefore = fs.readFileSync(tower.paths.state, 'utf8')
    const configFile = path.join(tower.commonDir, 'dsh-tower', 'config.json')
    const variants = [
      { label: 'unknown key', raw: { allowAgentToggle: true }, code: 'config-unknown-key', detail: /unknown key/ },
      { label: 'invalid value', raw: { merge: { timeoutMs: 5 } }, code: 'config-invalid', detail: /is invalid/ },
    ]
    for (const variant of variants) {
      let rejected = null
      try {
        configureRuntime(variant.raw)
      } catch (error) {
        rejected = error
      }
      assert.equal(rejected?.code, variant.code, `${variant.label}: configureRuntime must reject the profile`)
      try {
        const doctor = await doctorTool.execute({ view: 'doctor', repoRoot: repo }, exec)
        assertConfigFailure(doctor, doctorTool, variant)
        assert.equal(fs.readFileSync(tower.paths.state, 'utf8'), stateBefore, `${variant.label}: state must be untouched`)
        assert.equal(fs.existsSync(configFile), false, `${variant.label}: the doctor must not create a repo config`)
        const codePattern = new RegExp(`\\[tower:${variant.code}\\]`)
        await assert.rejects(() => tools.get('tower_inspect').execute({ view: 'status', repoRoot: repo }, exec), codePattern)
        await assert.rejects(
          () =>
            tools
              .get('tower_plan')
              .execute({ repoRoot: repo, missions: [{ title: 'Blocked', scope: ['y/**'] }] }, exec),
          codePattern,
        )
      } finally {
        configureRuntime({})
      }
    }
    // A resolvable profile restores the healthy report.
    // A resolvable profile restores the ordinary report: the degraded marker is
    // gone and the config row is no longer a hard failure. (The report as a
    // whole can still be `ok:false` for unrelated environment checks in this
    // mock host, so assert on the config row rather than `ok`.)
    const healthy = await doctorTool.execute({ view: 'doctor', repoRoot: repo }, exec)
    validateJsonSchema(doctorTool.output.schema, healthy)
    assert.equal(healthy.configError, undefined)
    assert.notEqual(healthy.checks.find((entry) => entry.id === 'config')?.status, 'fail')
  } finally {
    configureRuntime({})
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

    const preflight = await tools.get('tower_inspect').execute({ view: 'preflight', repoRoot: repo, missionId: 'M1' }, exec)
    assert.equal(preflight.ok, false)
    assert.ok(
      preflight.blockers.some((blocker) => blocker.code === 'branch-missing'),
      `expected branch-missing, saw ${JSON.stringify(preflight.blockers)}`,
    )

    const status = await tools
      .get('tower_inspect')
      .execute({ view: 'status', repoRoot: repo, includeGate: true }, exec)
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

/**
 * #228: the merge-commit record is the one durable write that happens *after*
 * git has already created the merge commit. A refused write there must name the
 * path and phase, stay non-retryable, and say plainly that the merge did not
 * land — never escape as `[tower:tool-internal] ENOSPC: ...`.
 */
async function mergeableMission(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])

  const tower = await Tower.open(repo)
  // Claim ownership so the tool-level merge below resolves the caller as the
  // tower; a worker actor is refused before any write.
  await tower.init({ towerAgentId: 'tower-faults' })
  await tower.plan({ missions: [{ title: 'Disk full merge', scope: ['src/**'], tasks: ['write file'] }] })
  const provisioned = await tower.provision({ missionId: 'M1' })
  const wt = provisioned.worktree.path
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
  fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'a\n')
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-m', 'M1 a'])
  await tower.mission({ id: 'M1', status: 'active' })
  await tower.mission({ id: 'M1', task_done: 'write file' })
  await tower.recordSpawn({
    missionId: 'M1',
    name: 'worker-disk-full',
    role: 'worker',
    agentId: 'agent-disk-full',
    parentSessionId: 'session-disk-full',
    cwd: wt,
    branch: provisioned.worktree.branch,
  })
  await tower.complete({ missionId: 'M1', agentId: 'agent-disk-full', report: 'done' })
  await tower.submitReview({
    missionId: 'M1',
    agentId: 'reviewer-not-in-roster',
    status: 'clean',
    merge: 'merge',
    findings: 'none',
    decision: 'single in-scope file',
    actor: { name: 'tower', role: 'tower' },
    breakGlassReason: 'disk-full fault test has no independent reviewer',
  })
  return { root, repo, tower }
}

test('a refused merge-commit write reports the path, phase and that the merge did not land (#228)', async () => {
  const { root, repo, tower } = await mergeableMission('dsh-tower-faults-merge-disk-')
  const { fsp } = await import('../adapters/store-fs.js')
  const realOpen = fsp.open
  try {
    const statePath = tower.paths.state
    // Snapshot the instant the refusal happens: the intent write before it is a
    // separate, successful mutation; the *commit* write is the one refused.
    let atRefusal = null
    // Fail only the commit-phase record: the intent write runs while no
    // mergeIntent is on disk yet, the commit write runs with one pending.
    fsp.open = async function refuseStateWrite(target, ...rest) {
      const pending = (() => {
        try {
          return JSON.parse(fs.readFileSync(statePath, 'utf8')).mergeIntent ?? null
        } catch {
          return null
        }
      })()
      if (pending && String(target).includes('.state.json.tmp-')) {
        atRefusal = fs.readFileSync(statePath)
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      }
      return realOpen.call(this, target, ...rest)
    }

    // Drive the merge use case directly: the tool layer only propagates this
    // error, and the fake ctx has no subagent catalog for the gate.
    await assert.rejects(
      () => tower.merge({ missionId: 'M1', activity: {} }),
      (error) => {
        assert.equal(error.code, 'state-io-failed')
        assert.equal(error.retryable, false, 'a full disk is not fixed by retrying the same call')
        assert.equal(error.details.phase, 'state-write')
        assert.equal(error.details.path, statePath)
        assert.equal(error.details.code, 'ENOSPC')
        assert.match(error.message, /^\[tower:state-io-failed\] /)
        assert.equal(error.message.split('[tower:state-io-failed]').length - 1, 1, 'exactly one prefix')
        assert.equal(error.message.split('— next:').length - 1, 1, 'exactly one next-action suffix')
        assert.match(error.message, /during state-write/)
        assert.match(error.message, /the previous document is unchanged/)
        assert.match(error.message, /did not land in the mission state and must be re-run/)
        assert.doesNotMatch(error.message, /tool-internal/)
        return true
      },
    )

    // The document on disk is byte-identical to the moment of the refusal: the
    // failed write added no partial state, and only the git commit exists.
    assert.ok(atRefusal, 'the commit-phase write must be the one refused')
    assert.deepEqual(fs.readFileSync(statePath), atRefusal)
    const after = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    assert.equal(after.mergeIntent?.missionId, 'M1', 'the intent is retained so a re-run can finish')
    // Git did land the merge commit; only the record of it was refused.
    assert.equal(git(repo, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length, 3)
  } finally {
    fsp.open = realOpen
    removeTemp(root)
  }
})

// #228 P3-a: the mirror case. The merge landed and the state record was
// committed; only the activity line is refused. "The previous activity document
// is unchanged" alone would read like the merge failed, so the message has to
// say what actually landed.
test('a refused activity append after a landed merge says the merge landed (#228)', async () => {
  const { root, tower } = await mergeableMission('dsh-tower-faults-merge-activity-')
  const { fsp } = await import('../adapters/store-fs.js')
  const realAppendFile = fsp.appendFile
  const statePath = tower.paths.state
  try {
    // Fail only the post-merge activity line: the state on disk already records
    // the mission as merged when the append runs.
    fsp.appendFile = async function refuseActivity(target, ...rest) {
      const mergedOnDisk = (() => {
        try {
          return (JSON.parse(fs.readFileSync(statePath, 'utf8')).missions ?? []).some((entry) => entry.status === 'merged')
        } catch {
          return false
        }
      })()
      if (mergedOnDisk && String(target).includes('activity.jsonl')) {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      }
      return realAppendFile.call(this, target, ...rest)
    }

    await assert.rejects(
      () => tower.merge({ missionId: 'M1', activity: {} }),
      (error) => {
        assert.equal(error.code, 'state-io-failed')
        assert.equal(error.retryable, false)
        assert.equal(error.details.code, 'ENOSPC')
        assert.equal(error.details.path, tower.paths.activity)
        assert.equal(error.details.phase, 'activity-append')
        assert.equal(error.message.split('[tower:state-io-failed]').length - 1, 1, 'exactly one prefix')
        assert.equal(error.message.split('— next:').length - 1, 1, 'exactly one next-action suffix')
        assert.match(error.message, /landed and the mission record is committed/)
        assert.match(error.message, /only this merge's activity line could not be appended/)
        assert.doesNotMatch(error.message, /did not land in the mission state/)
        assert.doesNotMatch(error.message, /tool-internal/)
        return true
      },
    )

    // The merge really did land, in Git and in the mission state.
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    assert.equal(state.missions.find((entry) => entry.id === 'M1')?.status, 'merged')
    assert.equal(state.mergeIntent, undefined, 'the intent is consumed by a landed merge')
    assert.equal(git(tower.root, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length, 3)
  } finally {
    fsp.appendFile = realAppendFile
    removeTemp(root)
  }
})

// #228 P3-a: a post-merge hook turns the commit into a shape mismatch (HEAD is
// a hook commit whose only parent is the merge). Git already created commits, so
// the refused record of that problem must say the merge commit exists.
test('a refused merge-shape record says the merge commit exists in Git (#228)', async () => {
  const { root, repo, tower } = await mergeableMission('dsh-tower-faults-merge-shape-')
  const { fsp } = await import('../adapters/store-fs.js')
  const realOpen = fsp.open
  const statePath = tower.paths.state
  try {
    // A hook commit on top of the merge makes HEAD no longer a two-parent merge.
    const hooksDir = path.join(repo, '.git', 'hooks')
    fs.mkdirSync(hooksDir, { recursive: true })
    fs.writeFileSync(path.join(hooksDir, 'post-merge'), '#!/bin/sh\ngit commit --allow-empty -q -m hook-commit\n', {
      mode: 0o755,
    })

    fsp.open = async function refuseShapeWrite(target, ...rest) {
      const pending = (() => {
        try {
          return JSON.parse(fs.readFileSync(statePath, 'utf8')).mergeIntent ?? null
        } catch {
          return null
        }
      })()
      if (pending && String(target).includes('.state.json.tmp-')) {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      }
      return realOpen.call(this, target, ...rest)
    }

    await assert.rejects(
      () => tower.merge({ missionId: 'M1', activity: {} }),
      (error) => {
        assert.equal(error.code, 'state-io-failed')
        assert.equal(error.details.phase, 'state-write')
        assert.equal(error.message.split('[tower:state-io-failed]').length - 1, 1, 'exactly one prefix')
        assert.equal(error.message.split('— next:').length - 1, 1, 'exactly one next-action suffix')
        assert.match(error.message, /exists in Git, but Tower could not record the merge-shape problem/)
        assert.match(error.message, /did not land in the mission state/)
        assert.doesNotMatch(error.message, /tool-internal/)
        return true
      },
    )
  } finally {
    fsp.open = realOpen
    removeTemp(root)
  }
})

test('the doctor disk row fails below the free-space floor and names the volume (#228)', async () => {
  const { diskSpaceCheck } = await import('../host/doctor-acceptance.js')
  const floorBytes = 64 * 1024 * 1024

  const failing = diskSpaceCheck({ volume: 'D:\\', floorBytes, freeBytes: 1024 * 1024 })
  assert.equal(failing.id, 'disk-space')
  assert.equal(failing.status, 'fail')
  assert.match(failing.detail, /volume D:\\ has 1 MB free, below the 64 MB/)
  assert.match(failing.action, /free space on the named volume/)
  assert.doesNotMatch(failing.action, /\btower_[a-z_]+/)

  const passing = diskSpaceCheck({ volume: 'D:\\', floorBytes, freeBytes: floorBytes * 4 })
  assert.equal(passing.status, 'pass')
  assert.match(passing.detail, /above the 64 MB free-space floor/)

  const unreadable = diskSpaceCheck({ volume: 'D:\\', floorBytes, freeBytes: null, error: 'statfs failed' })
  assert.equal(unreadable.status, 'warn')
  assert.match(unreadable.detail, /unreadable \(statfs failed\)/)

  // The live row is part of the report and is deterministic in shape — but not
  // in verdict: this runs against the host's real volume, and a CI machine below
  // the 64 MB floor legitimately fails (a full disk is exactly what #228 is
  // about). Assert the row exists with a real verdict and a detail naming the
  // volume; the injected cases above pin the fail/pass/warn wording.
  const { root, repo } = seedRepo('dsh-tower-faults-disk-')
  const { tools } = makeCtx()
  try {
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    const doctorTool = tools.get('tower_inspect')
    const doctor = await doctorTool.execute({ view: 'doctor', repoRoot: repo }, exec)
    const rows = doctor.checks.filter((entry) => entry.id === 'disk-space')
    assert.equal(rows.length, 1, `expected one disk-space row, saw ${JSON.stringify(doctor.checks.map((e) => e.id))}`)
    assert.ok(
      ['pass', 'warn', 'fail'].includes(rows[0].status),
      `unexpected disk-space status ${rows[0].status}: ${rows[0].detail}`,
    )
    assert.match(rows[0].detail, /volume /)
    validateJsonSchema(doctorTool.output.schema, doctor)
  } finally {
    removeTemp(root)
  }
})
