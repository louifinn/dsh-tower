// #93: the git mutex waiter owns a budget derived from the merge timeout, the
// timeout names the holder, and the holder is visible in tower_status/doctor.
//
// F58: on Windows the machine's system `core.autocrlf=true` reaches Tower (it
// strips `GIT_CONFIG_NOSYSTEM`) while a collaborating git — a DSH agent whose
// environment carries `GIT_CONFIG_NOSYSTEM=1`, which this test's fixture
// imitates — does not convert. Tower used to materialize the converted CRLF
// copy in its worktree, the fixture's `git add -A` then committed that copy of
// an untouched file, the gate reported it out of scope and the merge never
// reached `git merge --no-ff`, so `mergeReached` below waited forever.
// `mergeReadyMission` therefore sets a repository-scope `core.autocrlf=true`
// (the deterministic equivalent of a machine-level setting, since Tower reads
// repository config) while every fixture git call pins
// `-c core.autocrlf=false`, and the wait on `mergeReached` is bounded. The
// adapter fix is the write-side `-c core.autocrlf=false` in adapters/git.js;
// see the two merge tests at the end of this file for the bidirectional case.
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
} from '../adapters/store.js'
import { touchLock } from '../adapters/persistence.js'
import { Tower } from '../host/tower.js'
import { registerTowerTools } from '../host/tool-registry.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The fixture plays the role of a git in the DSH process environment: pinned
// to no conversion so its index never normalizes. That keeps the fixture
// deterministic on every machine while the repository's own
// `core.autocrlf` (below) stays the only setting Tower can inherit.
function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
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

/**
 * A repository with one completed mission ready to merge.
 * @param {string} prefix
 * @param {{ autocrlf?: boolean }} [options] when true, the repository carries
 *   `core.autocrlf=true`, the deterministic equivalent of the machine-level
 *   setting Tower inherits on Windows (F58).
 */
async function mergeReadyMission(prefix, { autocrlf = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  if (autocrlf) git(repo, ['config', 'core.autocrlf', 'true'])
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
  // F58: whatever the repository/machine `core.autocrlf` says, Tower must
  // materialize the committed bytes verbatim. Otherwise the fixture's
  // no-conversion `git add -A` below stages the CRLF copy of README.md and the
  // mission diff falsely contains an out-of-scope file.
  assert.equal(fs.readFileSync(path.join(wt, 'README.md'), 'utf8'), 'seed\n')
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
  // The pathological F58 configuration: the repository carries
  // `core.autocrlf=true` (the machine-level default Tower inherits) while the
  // fixture git is pinned to no conversion. Before the adapter fix the gate
  // rejected the mission for an out-of-scope README.md and this test waited on
  // `mergeReached` forever; the bounded wait below turns that into an
  // immediate, self-describing failure.
  const ctx = await mergeReadyMission('dsh-tower-git-mutex-budget-', { autocrlf: true })
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

    /** @type {any} */
    let mergeSettled = null
    const mergePromise = mergeTower.merge({ missionId: 'M1', activity: {} }).then(
      (result) => {
        mergeSettled = result
        return result
      },
      (error) => {
        mergeSettled = { error: String(error?.message ?? error) }
        throw error
      },
    )
    try {
      const reached = await Promise.race([mergeReached.then(() => true), sleep(5000).then(() => false)])
      assert.equal(
        reached,
        true,
        `the merge must reach "git merge --no-ff"; a gate blocker would otherwise hang this test: ${JSON.stringify(mergeSettled)}`,
      )
      const holder = readGitLockRecord(mergeTower)
      assert.ok(holder, 'the merge must hold the git mutex')
      assert.equal(holder.pid, process.pid)
      assert.equal(holder.phase, 'merge')

      // (c) The git mutex is visible while the merge runs.
      const { tools } = makeCtx()
      const heldStatus = await tools.get('tower_inspect').execute({ view: 'status', repoRoot: ctx.repo }, exec)
      assert.equal(heldStatus.gitLock.held, true)
      assert.equal(heldStatus.gitLock.pid, process.pid)
      assert.equal(heldStatus.gitLock.phase, 'merge')
      assert.equal(typeof heldStatus.gitLock.heldMs, 'number')
      const heldDoctor = await tools.get('tower_inspect').execute({ view: 'doctor', repoRoot: ctx.repo }, exec)
      assert.equal(heldDoctor.gitLock.held, true)
      assert.equal(heldDoctor.gitLock.pid, process.pid)
      assert.equal(heldDoctor.gitLock.phase, 'merge')
      assert.equal(heldDoctor.checks.find((entry) => entry.id === 'git-lock').status, 'warn')

      // (a) A concurrent tower_init (create path, same repo/git mutex) is
      // started before virtual time advances, so its 60 s deadline is already
      // fixed when the merge is made to look 90 s old.
      const advancedAt = clock.now() + 90000
      let advancedSeenResolve
      const advancedSeen = new Promise((resolve) => {
        advancedSeenResolve = resolve
      })
      let initClockCalls = 0
      const initClock = {
        now() {
          initClockCalls += 1
          const value = clock.now()
          if (value >= advancedAt) advancedSeenResolve()
          return value
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
      // Wait for the init's wait loop to observe the advanced clock instead of
      // betting on a fixed 150 ms sleep. The race keeps a genuinely stuck waiter
      // from hanging the whole file; the assertion below is unchanged.
      const advanced = await Promise.race([
        advancedSeen.then(() => true),
        sleep(5000).then(() => false),
      ])
      assert.equal(advanced, true, 'the init must re-check its budget after virtual time advances')
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
      const freeDoctor = await tools.get('tower_inspect').execute({ view: 'doctor', repoRoot: ctx.repo }, exec)
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

// F58, normal configuration: with no `core.autocrlf` override anywhere the
// mission branch must still contain exactly the file the worker wrote, and the
// merge must run. This is the other half of the bidirectional contract: the
// pathological case above and the ordinary case here both go through the same
// adapter checkout path.
test('a normal repository configuration keeps the mission diff to the files the worker wrote (F58)', async () => {
  const ctx = await mergeReadyMission('dsh-tower-git-autocrlf-normal-')
  try {
    const gate = await ctx.tower.evaluateGate({ missionId: 'M1', activity: {}, action: 'preflight' })
    assert.deepEqual(gate.changedFiles, ['src/a.txt'], JSON.stringify(gate.changedFiles))
    assert.equal(
      gate.blockers.some((blocker) => blocker.code === 'out-of-scope'),
      false,
      JSON.stringify(gate.blockers),
    )
    const merged = await ctx.tower.merge({ missionId: 'M1', activity: {} })
    assert.equal(merged.ok, true, JSON.stringify(merged))
  } finally {
    removeTemp(ctx.root)
  }
})
