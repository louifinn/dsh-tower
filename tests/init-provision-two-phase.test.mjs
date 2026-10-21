// #51 two-phase coverage for tower_init and tower_provision: every git spawn
// runs outside the state lock, the mutating ones run under the repo-scoped git
// mutex, and a state revision that moves while the operation is prepared/acted
// is rejected (provision rolls its worktree back).
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Tower } from '../lib/tower.js'
import { shortHash } from '../lib/store.js'
import { validateState } from '../lib/domain/state.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

function seed(prefix = 'dsh-tower-init-provision-') {
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

function readState(tower) {
  return JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
}

function tryReadState(tower) {
  try {
    return JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
  } catch {
    return null
  }
}

/** Record whether the state/git locks are held (and whether state exists) for
 * every git call the operation makes. Both instance adapters are wrapped so
 * prepare reads and act mutations are both observable. */
function watchGit(tower) {
  const calls = []
  const record = (command) => {
    const state = tryReadState(tower)
    calls.push({
      command,
      stateLock: fs.existsSync(tower.paths.lock),
      gitLock: fs.existsSync(tower.paths.gitLock),
      stateExists: state !== null,
      worktree: state?.missions?.find((mission) => mission.id === 'M1')?.worktree ?? null,
    })
  }
  const realGit = tower.git.bind(tower)
  tower.git = async (cwd, args, options) => {
    record(args.join(' '))
    return realGit(cwd, args, options)
  }
  const realTryGit = tower.tryGit.bind(tower)
  tower.tryGit = async (cwd, args, options) => {
    record(args.join(' '))
    return realTryGit(cwd, args, options)
  }
  return {
    calls,
    restore() {
      tower.git = realGit
      tower.tryGit = realTryGit
    },
  }
}

function assertNoStateLock(calls, label) {
  for (const call of calls) {
    assert.equal(call.stateLock, false, `${label}: state.lock must not be held during git ${call.command}`)
  }
}

test('init: the dirty snapshot and state file are created outside the state lock', async () => {
  const { root, repo } = seed('dsh-tower-init-two-phase-create-')
  try {
    fs.writeFileSync(path.join(repo, 'README.md'), 'dirty snapshot\n')
    const tower = await Tower.open(repo)
    const spy = watchGit(tower)
    const result = await tower.init({ snapshotDirty: true })

    assert.equal(result.created, true)
    assert.match(result.snapshotCommit, /^[0-9a-f]{40}$/)
    assert.equal(result.revision, 0)

    assertNoStateLock(spy.calls, 'init create')
    // Every git call ran before the state file existed: the state write is the
    // commit phase, after all git work.
    for (const call of spy.calls) {
      assert.equal(call.stateExists, false, `git ${call.command} must run before the state write`)
    }

    const stash = spy.calls.find((call) => call.command === 'stash create')
    assert.ok(stash, 'stash create must run for a dirty snapshot')
    assert.equal(stash.gitLock, true, 'stash create must run under withGitLock')

    const updateRef = spy.calls.find((call) => call.command.startsWith('update-ref refs/tower/snapshot/'))
    assert.ok(updateRef, 'the snapshot ref must be written')
    assert.equal(updateRef.gitLock, true, 'update-ref must run under withGitLock')

    const state = readState(tower)
    validateState(state, tower.paths.state)
    assert.equal(state.snapshotCommit, result.snapshotCommit)
    assert.equal(state.snapshotRef, result.snapshotRef)
    assert.equal(git(repo, ['rev-parse', result.snapshotRef]), result.snapshotCommit)
  } finally {
    cleanup(root)
  }
})

test('init: reanchor deletes snapshot refs under the git lock and commits the base change', async () => {
  const { root, repo } = seed('dsh-tower-init-two-phase-reanchor-')
  try {
    fs.writeFileSync(path.join(repo, 'README.md'), 'dirty baseline\n')
    const tower = await Tower.open(repo)
    const first = await tower.init({ snapshotDirty: true })
    assert.ok(first.snapshotRef)
    await tower.plan({ missions: [{ title: 'Reanchor fixture', scope: ['src/**'] }] })
    await tower.mission({ id: 'M1', status: 'abandoned', note: 'fixture is descoped' })
    git(repo, ['branch', 'release'])
    const before = readState(tower)

    const spy = watchGit(tower)
    const result = await tower.init({ reanchor: true, base: 'release' })

    assert.equal(result.created, false)
    assert.equal(result.reanchored, true)
    assert.equal(result.base, 'release')
    assert.equal(result.revision, before.revision + 1)
    assert.equal(result.snapshotCommit, null)

    assertNoStateLock(spy.calls, 'init reanchor')
    const refsRead = spy.calls.find((call) => call.command.startsWith('for-each-ref'))
    assert.ok(refsRead, 'snapshot refs must be read before deletion')
    assert.equal(refsRead.gitLock, true, 'the reanchor git work runs under withGitLock')
    const deletion = spy.calls.find((call) => call.command.startsWith('update-ref -d'))
    assert.ok(deletion, 'snapshot refs must be deleted')
    assert.equal(deletion.gitLock, true, 'update-ref -d must run under withGitLock')

    const state = readState(tower)
    validateState(state, tower.paths.state)
    assert.equal(state.base, 'release')
    assert.equal(state.snapshotCommit ?? null, null)
    assert.equal(state.snapshotRef ?? null, null)
    assert.equal(git(repo, ['show-ref']).includes(first.snapshotRef), false, 'the old snapshot ref must be gone')
  } finally {
    cleanup(root)
  }
})

test('init: a state revision change during the reanchor act is rejected and keeps the snapshot ref', async () => {
  const { root, repo } = seed('dsh-tower-init-two-phase-stale-')
  try {
    fs.writeFileSync(path.join(repo, 'README.md'), 'dirty baseline\n')
    const tower = await Tower.open(repo)
    const first = await tower.init({ snapshotDirty: true })
    assert.ok(first.snapshotCommit)
    await tower.plan({ missions: [{ title: 'Reanchor stale fixture', scope: ['src/**'] }] })
    await tower.mission({ id: 'M1', status: 'abandoned', note: 'fixture is descoped' })
    git(repo, ['branch', 'release'])

    const other = await Tower.open(repo)
    const realLoad = tower.load.bind(tower)
    let loads = 0
    tower.load = async () => {
      loads += 1
      // Load #1 is the prepare snapshot; load #2 is the act revalidation.
      if (loads === 2) await other.mission({ id: 'M1', note: 'concurrent write during init act' })
      return realLoad()
    }

    await assert.rejects(
      () => tower.init({ reanchor: true, base: 'release' }),
      (error) => {
        assert.equal(error.code, 'stale-base')
        return true
      },
    )

    const state = readState(tower)
    validateState(state, tower.paths.state)
    assert.notEqual(state.base, 'release', 'the base must not be reanchored on a stale act')
    assert.ok(state.missions[0].notes.includes('concurrent write during init act'), 'the concurrent write must survive')
    assert.equal(state.snapshotRef, first.snapshotRef, 'state still references the snapshot ref')
    assert.equal(git(repo, ['rev-parse', first.snapshotRef]), first.snapshotCommit, 'the snapshot ref must not be deleted')
  } finally {
    cleanup(root)
  }
})

test('provision: worktree add runs under the git lock and the state write happens afterwards', async () => {
  const { root, repo } = seed('dsh-tower-provision-two-phase-create-')
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Provision two phase', scope: ['src/**'] }] })
    const before = readState(tower)

    const spy = watchGit(tower)
    const result = await tower.provision({ missionId: 'M1' })

    assert.equal(result.created, true)
    assert.equal(result.mission.worktree.path, result.worktree.path)
    assert.ok(fs.existsSync(result.worktree.path), 'the worktree must exist on disk')

    assertNoStateLock(spy.calls, 'provision create')
    const add = spy.calls.find((call) => call.command.startsWith('worktree add'))
    assert.ok(add, 'worktree add must run')
    assert.equal(add.gitLock, true, 'worktree add must run under withGitLock')
    assert.equal(add.worktree, null, 'the worktree must not be recorded in state while git runs')

    // The prepare read runs before the git mutex; the act re-runs the branch
    // check under it immediately before the mutation.
    const branchReads = spy.calls.filter((call) => call.command.startsWith('show-ref'))
    assert.ok(branchReads.some((call) => call.gitLock === false), 'the prepare branch read runs outside the git mutex')
    assert.ok(
      branchReads.some((call) => call.gitLock === true),
      'the act revalidates the branch existence under the git mutex',
    )
    for (const call of spy.calls) {
      if (call.command.startsWith('worktree add') || call.command.startsWith('show-ref')) continue
      assert.equal(call.gitLock, false, `prepare read ${call.command} must run before the git mutex`)
    }

    const after = readState(tower)
    validateState(after, tower.paths.state)
    assert.equal(after.revision, before.revision + 1, 'one provision bumps the revision exactly once')
    assert.equal(after.missions[0].worktree.path, result.worktree.path)
    assert.equal(after.missions[0].baseCommit, result.worktree.baseCommit)

    // A second call is idempotent and creates nothing.
    const again = await tower.provision({ missionId: 'M1' })
    assert.equal(again.created, false)
    assert.equal(again.worktree.path, result.worktree.path)
    assert.equal(readState(tower).revision, after.revision)
  } finally {
    cleanup(root)
  }
})

test('provision: a state revision change during the act rolls the worktree back', async () => {
  const { root, repo } = seed('dsh-tower-provision-two-phase-stale-')
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Provision rollback', scope: ['src/**'] }] })
    const other = await Tower.open(repo)
    const before = readState(tower)
    const branch = 'tower/m1-provision-rollback'
    const wtPath = path.join(root, '.dsh-tower-worktrees', shortHash(tower.commonDir), 'M1')

    const realGit = tower.git.bind(tower)
    let injected = false
    tower.git = async (cwd, args, options) => {
      const result = await realGit(cwd, args, options)
      if (!injected && args[0] === 'worktree' && args[1] === 'add') {
        injected = true
        // Land a competing state write after the worktree was created but
        // before the short commit lock.
        await other.mission({ id: 'M1', note: 'concurrent write during provision act' })
      }
      return result
    }

    await assert.rejects(
      () => tower.provision({ missionId: 'M1' }),
      (error) => {
        assert.equal(error.code, 'stale-base')
        return true
      },
    )
    assert.equal(injected, true)

    const after = readState(tower)
    validateState(after, tower.paths.state)
    assert.ok(after.missions[0].notes.includes('concurrent write during provision act'))
    assert.equal(after.missions[0].worktree ?? null, null, 'the rolled-back worktree must not be recorded')
    assert.equal(after.revision, before.revision + 1, 'only the concurrent write bumps the revision')
    assert.equal(fs.existsSync(wtPath), false, 'the created worktree must be removed')
    assert.equal(git(repo, ['branch', '--list', branch]), '', 'the created branch must be deleted')
    assert.equal(
      git(repo, ['worktree', 'list', '--porcelain']).includes(wtPath.replace(/\\/g, '/')),
      false,
      'the worktree must not stay registered with git',
    )

    // The mission stays retryable once the concurrent writer settles.
    const retried = await tower.provision({ missionId: 'M1' })
    assert.equal(retried.created, true)
    assert.equal(fs.existsSync(retried.worktree.path), true)
  } finally {
    cleanup(root)
  }
})
