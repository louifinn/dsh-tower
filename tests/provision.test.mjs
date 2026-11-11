// Transactional provisioning (#M65 W2-D): a failed branch/worktree/sandbox step
// rolls back ONLY the artifacts this call created and leaves the repository
// clean, so a retry starts from the same state as a first attempt.
// Run with: node --test tests/provision.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'
import { Tower } from '../host/tower.js'
import { shortHash } from '../adapters/store.js'
import { validateState } from '../domain/state.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seed(prefix = 'dsh-tower-provision-tx-') {
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

function writeRepoConfig(repo, config) {
  const dir = path.join(repo, '.git', 'dsh-tower')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
}

function readState(tower) {
  return JSON.parse(fs.readFileSync(tower.paths.state, 'utf8'))
}

function worktreePathFor(root, tower, missionId) {
  return path.join(root, '.dsh-tower-worktrees', shortHash(tower.commonDir), missionId)
}

function sandboxPathFor(root, tower, missionId) {
  return path.join(root, '.dsh-tower-worktrees', shortHash(tower.commonDir), `${missionId}-sandbox`)
}

/** The repo state a failed provision must leave behind: no checkout, no branch. */
function assertCleanProvision(tower, repo, { wtPath, branch = null }) {
  assert.equal(fs.existsSync(wtPath), false, 'the created checkout must be removed')
  const registered = git(repo, ['worktree', 'list', '--porcelain']).replace(/\\/g, '/')
  assert.equal(registered.includes(wtPath.replace(/\\/g, '/')), false, 'the checkout must not stay registered with git')
  if (branch) assert.equal(git(repo, ['branch', '--list', branch]), '', 'the created branch must be deleted')
  const state = readState(tower)
  validateState(state, tower.paths.state)
  assert.equal(state.missions[0].worktree ?? null, null, 'the failed worktree must not be recorded')
  assert.equal(state.missions[0].sandbox ?? null, null, 'the failed sandbox must not be recorded')
}

test('a post-create failure rolls back the worktree and branch, and a retry succeeds', async () => {
  const { root, repo } = seed('dsh-tower-provision-tx-worktree-')
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Provision tx worktree', scope: ['src/**'] }] })
    const revision = readState(tower).revision
    const wtPath = worktreePathFor(root, tower, 'M1')
    // `worktree add` may create the branch before the failing step.
    const branch = 'tower/m1-provision-tx-worktree'

    tower.ensureExcluded = async () => {
      throw new Error('injected exclude failure')
    }
    await assert.rejects(
      () => tower.provision({ missionId: 'M1' }),
      (error) => /injected exclude failure/.test(String(error.message)),
    )
    assertCleanProvision(tower, repo, { wtPath, branch })
    assert.equal(readState(tower).revision, revision, 'a rolled-back provision does not bump the revision')

    // The same instance retries with the real step: the repository is clean
    // enough for a first attempt.
    tower.ensureExcluded = async () => {}
    const retried = await tower.provision({ missionId: 'M1' })
    assert.equal(retried.created, true)
    assert.equal(retried.worktree.path, wtPath)
    assert.equal(fs.existsSync(wtPath), true)
    assert.equal(readState(tower).missions[0].worktree.path, wtPath)
  } finally {
    removeTemp(root)
  }
})

test('a failure after the canonical-path read also rolls back the created worktree', async () => {
  const { root, repo } = seed('dsh-tower-provision-tx-canonical-')
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Provision tx canonical', scope: ['src/**'] }] })
    const wtPath = worktreePathFor(root, tower, 'M1')
    const realCanonicalPath = tower.deps.ownership.canonicalPath
    tower.deps.ownership.canonicalPath = async () => {
      throw new Error('injected canonical path failure')
    }
    await assert.rejects(
      () => tower.provision({ missionId: 'M1' }),
      (error) => /injected canonical path failure/.test(String(error.message)),
    )
    assertCleanProvision(tower, repo, { wtPath, branch: 'tower/m1-provision-tx-canonical' })

    tower.deps.ownership.canonicalPath = realCanonicalPath
    const retried = await tower.provision({ missionId: 'M1' })
    assert.equal(retried.created, true)
    assert.equal(fs.existsSync(retried.worktree.path), true)
  } finally {
    removeTemp(root)
  }
})

test('a detached sandbox whose post-create step fails is removed, not recorded, and retryable', async () => {
  const { root, repo } = seed('dsh-tower-provision-tx-sandbox-')
  try {
    writeRepoConfig(repo, { survey: { sandbox: 'detached' } })
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Inspect the seed commit', kind: 'survey' }] })
    const sandboxPath = sandboxPathFor(root, tower, 'M1')
    const revision = readState(tower).revision

    tower.ensureExcluded = async () => {
      throw new Error('injected sandbox exclude failure')
    }
    await assert.rejects(
      () => tower.provision({ missionId: 'M1' }),
      (error) => /injected sandbox exclude failure/.test(String(error.message)),
    )
    assert.equal(fs.existsSync(sandboxPath), false, 'the created sandbox must be removed')
    const registered = git(repo, ['worktree', 'list', '--porcelain']).replace(/\\/g, '/')
    assert.equal(registered.includes(sandboxPath.replace(/\\/g, '/')), false, 'the sandbox must not stay registered')
    assert.equal(readState(tower).missions[0].sandbox ?? null, null)
    assert.equal(readState(tower).revision, revision)

    tower.ensureExcluded = async () => {}
    const retried = await tower.provision({ missionId: 'M1' })
    assert.equal(retried.created, true)
    assert.equal(retried.sandbox, sandboxPath)
    assert.equal(fs.existsSync(sandboxPath), true)
  } finally {
    removeTemp(root)
  }
})

test('a state write failure during the commit phase rolls the created checkout back', async () => {
  const { root, repo } = seed('dsh-tower-provision-tx-write-')
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Provision tx write', scope: ['src/**'] }] })
    const wtPath = worktreePathFor(root, tower, 'M1')
    const revision = readState(tower).revision

    const realWriteState = tower.writeState.bind(tower)
    tower.writeState = async () => {
      throw new Error('injected state write failure')
    }
    await assert.rejects(
      () => tower.provision({ missionId: 'M1' }),
      (error) => /injected state write failure/.test(String(error.message)),
    )
    assertCleanProvision(tower, repo, { wtPath, branch: 'tower/m1-provision-tx-write' })
    assert.equal(readState(tower).revision, revision)

    tower.writeState = realWriteState
    const retried = await tower.provision({ missionId: 'M1' })
    assert.equal(retried.created, true)
    assert.equal(readState(tower).missions[0].worktree.path, wtPath)
  } finally {
    removeTemp(root)
  }
})

test('a worktree add that git fails after creating the branch is rolled back and retry succeeds', async () => {
  const { root, repo } = seed('dsh-tower-provision-tx-add-branch-')
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Provision tx add branch', scope: ['src/**'] }] })
    const revision = readState(tower).revision
    const wtPath = worktreePathFor(root, tower, 'M1')
    const branch = 'tower/m1-provision-tx-add-branch'

    // Reproduce the reviewer's failure (#M65 R1 P1): a corrupt blob makes git
    // create the branch, then fail in checkout before the worktree directory or
    // registration exists. Only the branch is left behind to roll back.
    const blob = git(repo, ['rev-parse', 'HEAD:README.md'])
    const objectFile = path.join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2))
    const objectBytes = fs.readFileSync(objectFile)
    fs.chmodSync(objectFile, 0o600)
    fs.rmSync(objectFile)

    await assert.rejects(
      () => tower.provision({ missionId: 'M1' }),
      (error) => /unable to read sha1 file|Could not reset index file/i.test(String(error.message)),
    )
    assertCleanProvision(tower, repo, { wtPath, branch })
    assert.equal(readState(tower).revision, revision, 'a rolled-back provision does not bump the revision')

    // Restore the object the real checkout needs, then retry from the same state
    // a first attempt would have seen: the branch must not wedge it.
    fs.writeFileSync(objectFile, objectBytes)
    const retried = await tower.provision({ missionId: 'M1' })
    assert.equal(retried.created, true)
    assert.equal(retried.worktree.path, wtPath)
    assert.equal(fs.existsSync(wtPath), true)
    assert.equal(readState(tower).missions[0].worktree.path, wtPath)
  } finally {
    removeTemp(root)
  }
})

test('a worktree add that fails after creating the checkout removes the branch and registration', async () => {
  const { root, repo } = seed('dsh-tower-provision-tx-add-partial-')
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Provision tx add partial', scope: ['src/**'] }] })
    const revision = readState(tower).revision
    const wtPath = worktreePathFor(root, tower, 'M1')
    const branch = 'tower/m1-provision-tx-add-partial'

    // The real add creates the branch and the registered checkout; then the
    // command reports a failure, exactly like a failing post-checkout hook. The
    // rollback must remove every artifact the add created.
    const realGit = tower.git.bind(tower)
    let failAfterAdd = true
    tower.git = async (cwd, args, options) => {
      const result = await realGit(cwd, args, options)
      if (failAfterAdd && args[0] === 'worktree' && args[1] === 'add') {
        failAfterAdd = false
        throw new Error('injected worktree add failure after checkout creation')
      }
      return result
    }
    await assert.rejects(
      () => tower.provision({ missionId: 'M1' }),
      (error) => /injected worktree add failure after checkout creation/.test(String(error.message)),
    )
    assert.equal(failAfterAdd, false, 'the injected add failure must have run after a real add')
    assertCleanProvision(tower, repo, { wtPath, branch })
    assert.equal(readState(tower).revision, revision)

    tower.git = realGit
    const retried = await tower.provision({ missionId: 'M1' })
    assert.equal(retried.created, true)
    assert.equal(readState(tower).missions[0].worktree.path, wtPath)
  } finally {
    removeTemp(root)
  }
})

test('rollback keeps a same-named branch that is not at the prepared base commit', async () => {
  const { root, repo } = seed('dsh-tower-provision-tx-branch-guard-')
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Add guard', scope: ['src/**'] }] })
    const wtPath = worktreePathFor(root, tower, 'M1')
    const branch = 'tower/m1-add-guard'
    const head = git(repo, ['rev-parse', 'HEAD'])
    const foreign = git(repo, ['commit-tree', `${head}^{tree}`, '-p', head, '-m', 'foreign branch tip'])

    // Simulate an external race: the branch appears after the act precheck but
    // before the add can create it. Its tip is not the prepared base commit, so
    // the rollback must not delete it.
    const realGit = tower.git.bind(tower)
    let injected = false
    tower.git = async (cwd, args, options) => {
      if (!injected && args[0] === 'worktree' && args[1] === 'add') {
        injected = true
        git(repo, ['update-ref', `refs/heads/${branch}`, foreign])
        throw new Error('injected add failure racing a foreign branch')
      }
      return realGit(cwd, args, options)
    }
    await assert.rejects(
      () => tower.provision({ missionId: 'M1' }),
      (error) => /injected add failure racing a foreign branch/.test(String(error.message)),
    )
    assert.equal(git(repo, ['rev-parse', `refs/heads/${branch}`]), foreign, 'a branch not at the prepared base must survive')
    assert.equal(fs.existsSync(wtPath), false)
    assert.equal(readState(tower).missions[0].worktree ?? null, null)

    tower.git = realGit
    await assert.rejects(
      () => tower.provision({ missionId: 'M1' }),
      (error) => /branch already exists/.test(String(error.message)),
    )
    assert.equal(git(repo, ['rev-parse', `refs/heads/${branch}`]), foreign, 'the retry must not delete it either')
  } finally {
    removeTemp(root)
  }
})

test('a detached sandbox add that fails after creating the checkout is removed and retryable', async () => {
  const { root, repo } = seed('dsh-tower-provision-tx-sandbox-add-')
  try {
    writeRepoConfig(repo, { survey: { sandbox: 'detached' } })
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Inspect the seed commit', kind: 'survey' }] })
    const sandboxPath = sandboxPathFor(root, tower, 'M1')
    const revision = readState(tower).revision

    const realGit = tower.git.bind(tower)
    let failAfterAdd = true
    tower.git = async (cwd, args, options) => {
      const result = await realGit(cwd, args, options)
      if (failAfterAdd && args[0] === 'worktree' && args[1] === 'add') {
        failAfterAdd = false
        throw new Error('injected sandbox add failure after checkout creation')
      }
      return result
    }
    await assert.rejects(
      () => tower.provision({ missionId: 'M1' }),
      (error) => /injected sandbox add failure after checkout creation/.test(String(error.message)),
    )
    assert.equal(failAfterAdd, false, 'the injected add failure must have run after a real add')
    assert.equal(fs.existsSync(sandboxPath), false, 'the partly created sandbox must be removed')
    const registered = git(repo, ['worktree', 'list', '--porcelain']).replace(/\\/g, '/')
    assert.equal(registered.includes(sandboxPath.replace(/\\/g, '/')), false, 'the sandbox must not stay registered')
    assert.equal(readState(tower).missions[0].sandbox ?? null, null)
    assert.equal(readState(tower).revision, revision)

    tower.git = realGit
    const retried = await tower.provision({ missionId: 'M1' })
    assert.equal(retried.created, true)
    assert.equal(retried.sandbox, sandboxPath)
    assert.equal(fs.existsSync(sandboxPath), true)
  } finally {
    removeTemp(root)
  }
})

test('pre-existing artifacts are never touched by a failed provision', async () => {
  const { root, repo } = seed('dsh-tower-provision-tx-existing-')
  try {
    const tower = await Tower.open(repo)
    await tower.init({})
    await tower.plan({ missions: [{ title: 'Provision tx existing', scope: ['src/**'] }] })
    // Both artifacts exist before the call. The prepare phase must refuse
    // without removing anything it did not create.
    const wtPath = worktreePathFor(root, tower, 'M1')
    fs.mkdirSync(path.dirname(wtPath), { recursive: true })
    fs.mkdirSync(wtPath)
    fs.writeFileSync(path.join(wtPath, 'sentinel.txt'), 'keep me\n')

    await assert.rejects(
      () => tower.provision({ missionId: 'M1' }),
      (error) => /worktree path already exists/.test(String(error.message)),
    )
    assert.equal(fs.existsSync(path.join(wtPath, 'sentinel.txt')), true, 'a foreign directory must survive')

    // A pre-existing branch is refused as well, and is never deleted.
    fs.rmSync(wtPath, { recursive: true, force: true })
    git(repo, ['branch', 'tower/m1-provision-tx-existing'])
    await assert.rejects(
      () => tower.provision({ missionId: 'M1' }),
      (error) => /branch already exists/.test(String(error.message)),
    )
    assert.equal(git(repo, ['branch', '--list', 'tower/m1-provision-tx-existing']).includes('tower/m1-provision-tx-existing'), true)
    assert.equal(readState(tower).missions[0].worktree ?? null, null)
  } finally {
    removeTemp(root)
  }
})
