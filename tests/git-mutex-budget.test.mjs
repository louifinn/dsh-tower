// #93: the git mutex waiter owns a budget derived from the merge timeout, the
// timeout names the holder, and the holder is visible in tower_status/doctor.
//
// The fast fixtures use the injected clock/deps seam: a merge that would hold
// the mutex for 90 s is simulated by advancing virtual time and refreshing the
// holder's heartbeat, so the whole file adds seconds, not minutes, to CI.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import {
  GIT_LOCK_MARGIN_MS,
  gitLockTimeoutMs,
  pathsFor,
  withGitLock,
} from '../lib/store.js'
import { touchLock } from '../lib/persistence.js'
import { Tower } from '../lib/tower.js'
import { registerTowerTools } from '../lib/tool-registry.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(10)
  }
  return false
}

/** An injected clock shared by the merge holder and the waiting init. */
function createClock() {
  let value = Date.now()
  return {
    now: () => value,
    advance(ms) {
      value += ms
    },
    deps: { now: () => value },
  }
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
  return { tools }
}

const exec = { agent: { id: 'tower-git-mutex-budget' } }

/** A repository with one completed mission ready to merge. */
async function mergeReadyMission(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])

  const tower = await Tower.open(repo)
  await tower.init({})
  await tower.plan({
    missions: [{ title: 'Git mutex budget', scope: ['src/**'], tasks: ['write file', 'commit'] }],
  })
  const provisioned = await tower.provision({ missionId: 'M1' })
  const wt = provisioned.worktree.path
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
  fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'a\n')
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-m', 'M1 a'])

  await tower.mission({ id: 'M1', status: 'active' })
  await tower.mission({ id: 'M1', task_done: 'write file' })
  await tower.mission({ id: 'M1', task_done: 'commit' })
  const agentId = 'agent-git-mutex-budget'
  await tower.recordSpawn({
    missionId: 'M1',
    name: 'worker-git-mutex-budget',
    role: 'worker',
    agentId,
    parentSessionId: 'session-git-mutex-budget',
    cwd: wt,
    branch: provisioned.worktree.branch,
  })
  await tower.complete({ missionId: 'M1', agentId, report: 'done' })
  return { root, repo, tower }
}

function readGitLockRecord(tower) {
  try {
    return JSON.parse(fs.readFileSync(tower.paths.gitLock, 'utf8'))
  } catch {
    return null
  }
}

function gitHolds(tower) {
  try {
    return fs
      .readFileSync(path.join(tower.paths.dir, 'lock-holds.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((hold) => hold.kind === 'git')
  } catch {
    return []
  }
}

test('the git-mutex budget follows the merge timeout, not the old 60 s default (#93)', () => {
  assert.equal(GIT_LOCK_MARGIN_MS, 60000)
  assert.equal(gitLockTimeoutMs({ merge: { timeoutMs: 900000 } }), 960000)
  assert.equal(gitLockTimeoutMs({ merge: { timeoutMs: 600000 } }, 120000), 180000)
  assert.equal(gitLockTimeoutMs(), 960000)
  assert.ok(gitLockTimeoutMs({ merge: { timeoutMs: 15000 } }) > 60000)
  assert.ok(gitLockTimeoutMs({}, 900000) - 900000 === GIT_LOCK_MARGIN_MS)
})

test('a smaller-budget git-mutex waiter fails with holder facts, not prose (#93)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-git-mutex-facts-'))
  const paths = pathsFor(path.join(root, '.git'))
  fs.mkdirSync(paths.dir, { recursive: true })
  let releaseHolder
  const holderGate = new Promise((resolve) => {
    releaseHolder = resolve
  })
  const holding = withGitLock(paths, () => holderGate, { phase: 'merge', timeoutMs: 5000 })
  try {
    assert.ok(await waitFor(() => fs.existsSync(paths.gitLock)), 'the holder must acquire the git mutex')
    let applied = false
    await assert.rejects(
      () =>
        withGitLock(
          paths,
          async () => {
            applied = true
          },
          { phase: 'init', timeoutMs: 120, pollMs: 10 },
        ),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.details.holderPid, process.pid)
        assert.equal(error.details.holderPhase, 'merge')
        assert.equal(typeof error.details.heldMs, 'number')
        assert.ok(error.details.heldMs >= 100, `heldMs ${error.details.heldMs} must reflect the holder age`)
        assert.equal(typeof error.details.waitedMs, 'number')
        assert.ok(error.details.waitedMs >= 100, `waitedMs ${error.details.waitedMs} must reflect the wait`)
        assert.match(error.message, new RegExp(`held by pid ${process.pid} \\(merge\\)`))
        return true
      },
    )
    assert.equal(applied, false, 'the waiter must not run while the holder is alive')
  } finally {
    releaseHolder()
    await holding
    removeTemp(root)
  }
})

test('a tower_init waits out a simulated 90 s merge, and status/doctor expose the holder (#93)', async () => {
  const ctx = await mergeReadyMission('dsh-tower-git-mutex-budget-')
  try {
    const clock = createClock()
    const mergeTower = ctx.tower
    mergeTower.deps = { ...mergeTower.deps, clock: clock.deps }

    let releaseMerge
    const mergeGate = new Promise((resolve) => {
      releaseMerge = resolve
    })
    let reachedMerge
    const mergeReached = new Promise((resolve) => {
      reachedMerge = resolve
    })
    const realGit = mergeTower.git.bind(mergeTower)
    mergeTower.git = async (cwd, args, options) => {
      if (args[0] === 'merge' && args[1] === '--no-ff') {
        reachedMerge()
        await mergeGate
      }
      return realGit(cwd, args, options)
    }

    const mergePromise = mergeTower.merge({ missionId: 'M1', activity: {} })
    try {
      await mergeReached
      const holder = readGitLockRecord(mergeTower)
      assert.ok(holder, 'the merge must hold the git mutex')
      assert.equal(holder.pid, process.pid)
      assert.equal(holder.phase, 'merge')

      // (c) The git mutex is visible while the merge runs.
      const { tools } = makeCtx()
      const heldStatus = await tools.get('tower_status').execute({ repoRoot: ctx.repo }, exec)
      assert.equal(heldStatus.gitLock.held, true)
      assert.equal(heldStatus.gitLock.pid, process.pid)
      assert.equal(heldStatus.gitLock.phase, 'merge')
      assert.equal(typeof heldStatus.gitLock.heldMs, 'number')
      const heldDoctor = await tools.get('tower_doctor').execute({ repoRoot: ctx.repo }, exec)
      assert.equal(heldDoctor.gitLock.held, true)
      assert.equal(heldDoctor.gitLock.pid, process.pid)
      assert.equal(heldDoctor.gitLock.phase, 'merge')
      assert.equal(heldDoctor.checks.find((entry) => entry.id === 'git-lock').status, 'warn')

      // (a) A concurrent tower_init (create path, same repo/git mutex) is
      // started before virtual time advances, so its 60 s deadline is already
      // fixed when the merge is made to look 90 s old.
      let initClockCalls = 0
      const initClock = {
        now() {
          initClockCalls += 1
          return clock.now()
        },
      }
      const initTower = await Tower.open(ctx.repo)
      initTower.deps = { ...initTower.deps, clock: initClock }
      // Only the state path is diverted: the init exercises its real create
      // path (and therefore the real git mutex) against the same repository.
      initTower.paths = { ...initTower.paths, state: path.join(ctx.root, 'init-only-state.json') }
      let initSettled = false
      const initPromise = initTower.init({}).finally(() => {
        initSettled = true
      })
      assert.ok(
        await waitFor(() => initClockCalls >= 3, 5000),
        'the init must enter the git-mutex wait loop before virtual time advances',
      )
      assert.equal(initSettled, false)

      // Simulate 90 s of merge time. Write the holder's heartbeat one jump
      // ahead first and only then move the shared clock: a record dated in the
      // future is never stale (the age clamps at zero), so the accelerated jump
      // cannot be mistaken for a silent/crashed holder and reclaimed.
      assert.equal(
        await touchLock(mergeTower.paths.gitLock, holder.token, { now: clock.now() + 90000 }),
        true,
        'the holder must still own the lock before virtual time advances',
      )
      clock.advance(90000)
      await sleep(150)
      assert.equal(initSettled, false, 'the waiter must outlive the old 60 s budget')

      releaseMerge()
      const [merged, inited] = await Promise.all([mergePromise, initPromise])
      assert.equal(merged.ok, true, JSON.stringify(merged))
      assert.equal(inited.created, true)

      // The app-level waiter used the merge-derived budget, not 60 s, and it
      // really waited (the hold log is the durable evidence).
      const initHold = gitHolds(mergeTower).filter((hold) => hold.phase === 'init').at(-1)
      assert.ok(initHold, 'the waiting init must be recorded in lock-holds.jsonl')
      assert.equal(initHold.budgetMs, gitLockTimeoutMs(initTower.config))
      assert.ok(initHold.budgetMs > 60000, `budget ${initHold.budgetMs} must exceed the old 60 s default`)
      assert.ok(initHold.waitedMs >= 60000, `waitedMs ${initHold.waitedMs} must show the 90 s wait`)

      // (c) The lock is reported free after the merge finishes.
      const freeDoctor = await tools.get('tower_doctor').execute({ repoRoot: ctx.repo }, exec)
      assert.equal(freeDoctor.gitLock.held, false)
      assert.equal(freeDoctor.checks.find((entry) => entry.id === 'git-lock').status, 'pass')
    } finally {
      releaseMerge()
      await mergePromise.catch(() => {})
    }
  } finally {
    removeTemp(ctx.root)
  }
})
