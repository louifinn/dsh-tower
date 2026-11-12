// #163 Phase 1: one repository resolution for every tool call
// (session binding -> working directory -> explicit field), and the tool
// profile registry that the worker/reviewer presets and the surface gate share.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { ACTOR_ACCESS, AUTHORIZATION_MATRIX } from '../host/authorization.js'
import { modeState } from '../host/mode-state.js'
import { registerTowerTools } from '../host/tool-registry.js'
import {
  REPOSITORY_OPTIONAL_TOOLS,
  REVIEWER_ALLOW,
  TOWER_ONLY_TOOLS,
  WORKER_ALLOW,
  isRepositoryOptionalTool,
  isTowerOnlyTool,
} from '../host/tool-profiles.js'
import { resolveToolRepoRoot } from '../host/tool-repo.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo(prefix = 'dsh-tower-repo-resolve-') {
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
  return { ctx, tools }
}

test('tool profiles: the registry and the authorization matrix agree', () => {
  assert.ok(Object.isFrozen(WORKER_ALLOW) && Object.isFrozen(REVIEWER_ALLOW))
  for (const name of TOWER_ONLY_TOOLS) {
    assert.equal(isTowerOnlyTool(name), true)
    const row = AUTHORIZATION_MATRIX[name]
    assert.ok(row, `${name} has an authorization row`)
    assert.deepEqual(row.allow, [ACTOR_ACCESS.tower], `${name} is a tower-only row`)
  }
  assert.equal(isTowerOnlyTool('tower_status'), false)
  // Repository-optional is a subset of the tower-only contract (#163 Phase 1):
  // a tool cannot run without a repository unless its profile is tower-only.
  for (const name of REPOSITORY_OPTIONAL_TOOLS) {
    assert.equal(isRepositoryOptionalTool(name), true)
    assert.ok(TOWER_ONLY_TOOLS.includes(name), `${name} is also registered as tower-only`)
  }
  assert.equal(REPOSITORY_OPTIONAL_TOOLS.includes('tower_reload'), true)
  // The worker/reviewer lists are the presets' mount lists; the repository
  // escape hatch and the optional capability tools are not part of them.
  for (const name of ['tower_reload', 'tower_batch', 'tower_resource', 'tower_test', 'tower_import_legacy', 'tower_legacy_map']) {
    assert.equal(WORKER_ALLOW.includes(name), false, `worker does not mount ${name}`)
    assert.equal(REVIEWER_ALLOW.includes(name), false, `reviewer does not mount ${name}`)
  }
})

test('tool repo resolution: session binding wins over the working directory and the explicit field', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-bound-'))
  const bound = path.join(root, 'bound')
  fs.mkdirSync(bound)
  modeState.set('agent-bound', { on: true, lock: { token: 't', commonDir: path.join(bound, '.git') } })
  try {
    const exec = { agent: { id: 'agent-bound', session: { header: { cwd: root } } } }
    assert.equal(await resolveToolRepoRoot('tower_status', { repoRoot: root }, exec), bound)
  } finally {
    modeState.delete('agent-bound')
    removeTemp(root)
  }
})

test('tool repo resolution: the working directory resolves through git and maps a linked worktree to the main checkout', async () => {
  const { root, repo } = makeRepo()
  try {
    const exec = { agent: { id: 'agent-cwd', session: { header: { cwd: path.join(repo, 'subdir') } } } }
    fs.mkdirSync(path.join(repo, 'subdir'), { recursive: true })
    assert.equal(await resolveToolRepoRoot('tower_status', {}, exec), repo)

    const worktree = path.join(root, 'wt')
    git(repo, ['worktree', 'add', '-b', 'agent/repo-resolve', worktree])
    const worker = { agent: { id: 'agent-wt', session: { header: { cwd: worktree } } } }
    assert.equal(await resolveToolRepoRoot('tower_mission', {}, worker), repo)
  } finally {
    removeTemp(root)
  }
})

test('tool repo resolution: the explicit field is accepted when no session is available', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-explicit-'))
  try {
    assert.equal(await resolveToolRepoRoot('tower_status', { repoRoot: root }, { agent: { id: 'agent-x' } }), root)
    await assert.rejects(
      () => resolveToolRepoRoot('tower_status', {}, { agent: { id: 'agent-x' } }),
      (error) => error.code === 'repo-invalid',
    )
  } finally {
    removeTemp(root)
  }
})

test('tool repo resolution: a call without repoRoot uses the session working directory end to end', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  const exec = { agent: { id: 'agent-e2e', session: { header: { cwd: repo } } } }
  try {
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    await tools.get('tower_plan').execute({ missions: [{ title: 'cwd mission', scope: ['src/**'] }] }, exec)
    const status = await tools.get('tower_status').execute({}, exec)
    assert.equal(fs.realpathSync(status.repoRoot), fs.realpathSync(repo))
    assert.equal(status.missions.length, 1)
  } finally {
    removeTemp(root)
  }
})
