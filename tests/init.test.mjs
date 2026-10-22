// tower_init policy: autoGitInit in a plain directory, snapshotDirty baselines
// for a dirty working tree, reanchor preconditions and dirty reporting.
//
// Real temporary git repositories through the real tool surface; no DSH
// runtime and no model calls.
// Run with: node --test tests/init.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { registerTowerTools } from '../lib/tool-registry.js'
import { Tower, SCHEMA_VERSION } from '../app/tower.js'
import { configureRuntime } from '../lib/config.js'
import { validateJsonSchema } from './schema-validator.mjs'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
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

function seedRepo(prefix = 'dsh-tower-init-') {
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

async function call(tools, name, args, exec = { agent: { id: 'tower-init' } }) {
  const tool = tools.get(name)
  assert.ok(tool, `${name} is registered`)
  const value = await tool.execute(args, exec)
  const violations = validateJsonSchema(tool.output.schema, value)
  assert.deepEqual(violations, [], `${name}: ${violations.join('; ')}`)
  return value
}

test('autoGitInit: a plain directory becomes a repository with an empty initial commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-init-auto-'))
  const plain = path.join(root, 'plain')
  fs.mkdirSync(plain)
  const { tools } = makeCtx()
  try {
    // Without the flag the directory is rejected with the stable repo code.
    await assert.rejects(
      () => tools.get('tower_init').execute({ repoRoot: plain }, { agent: { id: 'tower-init' } }),
      /\[tower:repo-invalid\]/,
    )

    const initialized = await call(tools, 'tower_init', { repoRoot: plain, autoGitInit: true })
    assert.equal(initialized.created, true)
    assert.ok(fs.existsSync(path.join(plain, '.git')), 'git init must create .git')
    assert.equal(initialized.missions, 0)
    assert.equal(initialized.revision, 0)
    assert.equal(initialized.dirty, false)

    // The default base is the checked-out branch of the fresh repository, and
    // the empty commit exists so missions always have a baseline.
    const branch = git(plain, ['symbolic-ref', '--short', 'HEAD'])
    assert.equal(initialized.base, branch)
    assert.equal(git(plain, ['rev-list', '--count', 'HEAD']), '1')
    assert.equal(git(plain, ['log', '-1', '--format=%s']), 'tower: initial empty commit')

    const state = JSON.parse(fs.readFileSync(initialized.statePath, 'utf8'))
    assert.equal(state.schemaVersion, SCHEMA_VERSION)
    assert.equal(state.base, branch)
    assert.equal(state.repoRoot, initialized.repoRoot)

    // Re-running is idempotent and does not re-create the commit.
    const again = await call(tools, 'tower_init', { repoRoot: plain })
    assert.equal(again.created, false)
    assert.equal(again.revision, 0)
    assert.equal(git(plain, ['rev-list', '--count', 'HEAD']), '1')
  } finally {
    cleanup(root)
  }
})

test('snapshotDirty: the dirty working tree becomes the mission baseline', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    fs.writeFileSync(path.join(repo, 'README.md'), 'dirty snapshot\n')
    const initialized = await call(tools, 'tower_init', { repoRoot: repo, snapshotDirty: true })
    assert.equal(initialized.created, true)
    assert.equal(initialized.dirty, true)
    assert.match(initialized.snapshotCommit, /^[0-9a-f]{40}$/)

    const tower = await Tower.open(repo)
    const state = await tower.load()
    assert.equal(state.snapshotCommit, initialized.snapshotCommit)
    assert.equal(state.dirtyBase, true)

    // provision() uses the snapshot commit as the mission baseline by default.
    await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Snapshot baseline', scope: ['src/**'] }],
    })
    const provisioned = await (await Tower.open(repo)).provision({ missionId: 'M1' })
    assert.equal(provisioned.worktree.baseCommit, initialized.snapshotCommit)
    assert.equal(
      fs.readFileSync(path.join(provisioned.worktree.path, 'README.md'), 'utf8').trim(),
      'dirty snapshot',
      'the worktree must be based on the dirty snapshot, not the committed tree',
    )
    // The snapshot is a dangling commit, not a rewrite of the base branch.
    assert.notEqual(initialized.snapshotCommit, git(repo, ['rev-parse', 'HEAD']))
  } finally {
    cleanup(root)
  }
})

test('snapshotDirty: a clean tree records no snapshot, and a missing one is rejected', async () => {
  const { root, repo } = seedRepo('dsh-tower-init-clean-')
  const { tools } = makeCtx()
  try {
    const clean = await call(tools, 'tower_init', { repoRoot: repo, snapshotDirty: true })
    assert.equal(clean.dirty, false)
    assert.equal(clean.snapshotCommit, null)

    // A dirty tree made only of untracked files has no stash snapshot, so the
    // explicit request fails instead of silently using the committed baseline.
    const fresh = seedRepo('dsh-tower-init-untracked-')
    try {
      fs.writeFileSync(path.join(fresh.repo, 'new-file.txt'), 'untracked\n')
      await assert.rejects(
        () => tools.get('tower_init').execute({ repoRoot: fresh.repo, snapshotDirty: true }, { agent: { id: 'tower-init' } }),
        /snapshotDirty was requested but no snapshot commit could be created/i,
      )
    } finally {
      cleanup(fresh.root)
    }
  } finally {
    cleanup(root)
  }
})

test('reanchor: refused while missions are open, allowed after they are closed', async () => {
  const { root, repo } = seedRepo('dsh-tower-init-reanchor-')
  const { tools } = makeCtx()
  try {
    const originalBase = git(repo, ['symbolic-ref', '--short', 'HEAD'])
    git(repo, ['branch', 'release', `refs/heads/${originalBase}`])
    await call(tools, 'tower_init', { repoRoot: repo })
    await call(tools, 'tower_plan', { repoRoot: repo, missions: [{ title: 'Open mission', scope: ['src/**'] }] })

    await assert.rejects(
      () => tools.get('tower_init').execute({ repoRoot: repo, reanchor: true, base: 'release' }, { agent: { id: 'tower-init' } }),
      /cannot reanchor base while 1 mission\(s\) are not merged or abandoned/,
    )

    // Closing the only mission makes the base movable.
    await call(tools, 'tower_mission', {
      repoRoot: repo,
      id: 'M1',
      status: 'abandoned',
      note: 'fixture mission is descoped',
    })
    const before = JSON.parse(fs.readFileSync((await Tower.open(repo)).paths.state, 'utf8'))
    const reanchored = await call(tools, 'tower_init', { repoRoot: repo, reanchor: true, base: 'release' })
    assert.equal(reanchored.created, false)
    assert.equal(reanchored.reanchored, true)
    assert.equal(reanchored.base, 'release')
    assert.equal(reanchored.revision, before.revision + 1)
    const after = await (await Tower.open(repo)).load()
    assert.equal(after.base, 'release')
    assert.ok(after.baseChangedAt > 0)

    // A no-op reanchor reports reanchored:false and does not bump the revision.
    const same = await call(tools, 'tower_init', { repoRoot: repo, reanchor: true, base: 'release' })
    assert.equal(same.reanchored, false)
    assert.equal(same.revision, after.revision)

    // Reanchoring to a branch that does not exist locally is refused.
    await assert.rejects(
      () => tools.get('tower_init').execute({ repoRoot: repo, reanchor: true, base: 'nope' }, { agent: { id: 'tower-init' } }),
      /base branch "nope" does not exist locally/,
    )
  } finally {
    cleanup(root)
  }
})

test('init config policy: profile init.autoGitInit / init.snapshotDirty supply the defaults', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-init-policy-'))
  const { tools } = makeCtx()
  try {
    // init.autoGitInit lets tower_init initialize a plain directory with no
    // per-call argument.
    const plain = path.join(base, 'plain')
    fs.mkdirSync(plain)
    configureRuntime({ init: { autoGitInit: true } })
    try {
      const initialized = await call(tools, 'tower_init', { repoRoot: plain })
      assert.equal(initialized.created, true)
      assert.ok(fs.existsSync(path.join(plain, '.git')))
    } finally {
      configureRuntime({})
    }

    // init.snapshotDirty snapshots a dirty tree without the argument.
    const seeded = seedRepo('dsh-tower-init-policy-repo-')
    try {
      fs.writeFileSync(path.join(seeded.repo, 'README.md'), 'policy snapshot\n')
      configureRuntime({ init: { snapshotDirty: true } })
      try {
        const initialized = await call(tools, 'tower_init', { repoRoot: seeded.repo })
        assert.equal(initialized.dirty, true)
        assert.match(initialized.snapshotCommit, /^[0-9a-f]{40}$/)
      } finally {
        configureRuntime({})
      }
    } finally {
      cleanup(seeded.root)
    }
  } finally {
    configureRuntime({})
    cleanup(base)
  }
})

test('init reports a dirty working tree without failing', async () => {
  const { root, repo } = seedRepo('dsh-tower-init-dirty-')
  const { tools } = makeCtx()
  try {
    const first = await call(tools, 'tower_init', { repoRoot: repo })
    assert.equal(first.dirty, false)
    fs.appendFileSync(path.join(repo, 'README.md'), 'uncommitted\n')
    const second = await call(tools, 'tower_init', { repoRoot: repo })
    assert.equal(second.created, false)
    assert.equal(second.dirty, true)
    assert.equal(second.snapshotCommit, null)
  } finally {
    cleanup(root)
  }
})
