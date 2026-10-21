// Concurrency and resource policies: spawn.maxLiveWorkers, tower_send rate
// limiting, stale roster views and parallel writers sharing the state lock.
// Run with: node --test tests/concurrency.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { registerTowerTools } from '../tools/index.js'
import { Tower, validateState } from '../app/tower.js'

const exec = { agent: { id: 'tower-concurrency' } }

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

function seedRepo(prefix = 'dsh-tower-concurrency-') {
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

function fakeSubagents() {
  let seq = 0
  const activations = []
  return {
    activations,
    list: () => ['spawn'],
    async startActivation(input) {
      seq += 1
      activations.push(input)
      return {
        childId: `child-${seq}`,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }], diagnostic: null }),
      }
    },
    async sendMessage() {},
    async listDescendants() {
      return []
    },
  }
}

function makeCtx() {
  const tools = new Map()
  const subagents = fakeSubagents()
  const agentPresets = { list: async () => [{ id: 'tower-worker' }, { id: 'tower-reviewer' }] }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'subagents') return subagents
      if (name === 'agentPresets') return agentPresets
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
  return { ctx, tools, subagents }
}

function writeRepoConfig(repo, value) {
  const file = path.join(repo, '.git', 'dsh-tower', 'config.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
  return file
}

test('spawn.maxLiveWorkers caps live roster workers and allows the limit', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    writeRepoConfig(repo, { spawn: { maxLiveWorkers: 1 } })
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    const planned = await tools.get('tower_plan').execute(
      {
        repoRoot: repo,
        missions: [
          { title: 'Live one', scope: ['one/**'] },
          { title: 'Live two', scope: ['two/**'] },
        ],
      },
      exec,
    )
    assert.equal(planned.missions.length, 2)

    // A directly recorded live worker consumes the only slot.
    const tower = await Tower.open(repo)
    await tower.recordSpawn({
      missionId: 'M1',
      name: 'worker-m1',
      role: 'worker',
      agentId: 'agent-live-1',
      parentSessionId: 'session-concurrency',
      cwd: null,
      branch: null,
    })

    await assert.rejects(
      () => tools.get('tower_spawn').execute({ repoRoot: repo, missionId: 'M2', role: 'worker' }, exec),
      (error) => {
        assert.equal(error.code, 'worker-limit', error.message)
        assert.match(error.message, /live worker limit reached \(1\)/)
        return true
      },
    )

    // The failed spawn must not add a second live worker to the roster.
    const roster = await tools.get('tower_roster').execute({ repoRoot: repo }, exec)
    assert.equal(roster.roster.filter((entry) => entry.role === 'worker').length, 1)

    // Raising the limit to 2 lets exactly one more worker start.
    writeRepoConfig(repo, { spawn: { maxLiveWorkers: 2 } })
    const spawned = await tools.get('tower_spawn').execute({ repoRoot: repo, missionId: 'M2', role: 'worker' }, exec)
    assert.equal(spawned.role, 'worker')
    const after = await tools.get('tower_roster').execute({ repoRoot: repo }, exec)
    assert.equal(
      after.roster.filter((entry) => entry.role === 'worker').length,
      2,
      'raising spawn.maxLiveWorkers to 2 must allow a second worker entry',
    )
  } finally {
    cleanup(root)
  }
})

test('tower_send rate limit: send.maxPerMinute rejects further sends in the window', async () => {
  const { root, repo } = seedRepo('dsh-tower-concurrency-send-')
  const { tools } = makeCtx()
  try {
    writeRepoConfig(repo, { send: { maxPerMinute: 1 } })
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    const first = await tools
      .get('tower_send')
      .execute({ repoRoot: repo, to: 'all', subject: 'first', body: 'one' }, exec)
    assert.equal(first.message.id, 'msg-1')

    await assert.rejects(
      () => tools.get('tower_send').execute({ repoRoot: repo, to: 'all', subject: 'second', body: 'two' }, exec),
      (error) => {
        assert.equal(error.code, 'rate-limited', error.message)
        assert.match(error.message, /rate limit reached \(1\/min/)
        return true
      },
    )
    // The rejected send was not persisted.
    const status = await tools.get('tower_status').execute({ repoRoot: repo }, exec)
    assert.equal(status.messages, 1)

    // maxPerMinute:0 disables the limiter entirely.
    writeRepoConfig(repo, { send: { maxPerMinute: 0 } })
    await tools.get('tower_send').execute({ repoRoot: repo, to: 'all', subject: 'third', body: 'three' }, exec)
    await tools.get('tower_send').execute({ repoRoot: repo, to: 'all', subject: 'fourth', body: 'four' }, exec)
    const reloaded = await tools.get('tower_status').execute({ repoRoot: repo }, exec)
    assert.equal(reloaded.messages, 3)
  } finally {
    cleanup(root)
  }
})

test('spawn.staleMs marks roster entries without catalog activity as stale', async () => {
  const { root, repo } = seedRepo('dsh-tower-concurrency-stale-')
  const { tools } = makeCtx()
  try {
    writeRepoConfig(repo, { spawn: { staleMs: 50 } })
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    await tools
      .get('tower_plan')
      .execute({ repoRoot: repo, missions: [{ title: 'Stale case', scope: ['src/**'] }] }, exec)
    const spawned = await tools.get('tower_spawn').execute({ repoRoot: repo, missionId: 'M1', role: 'worker' }, exec)
    await new Promise((resolve) => setTimeout(resolve, 120))

    const stale = await tools.get('tower_roster').execute({ repoRoot: repo }, exec)
    const entry = stale.roster.find((candidate) => candidate.agentId === spawned.agentId)
    assert.ok(entry, 'spawned entry must be listed')
    assert.equal(entry.observed, false)
    assert.equal(entry.activity, 'missing')
    assert.equal(entry.stale, true, 'a quiet roster entry older than staleMs must be flagged')
    assert.equal(stale.parentStatus['tower-concurrency'], 'ok')

    // staleMs:0 disables staleness detection.
    writeRepoConfig(repo, { spawn: { staleMs: 0 } })
    const fresh = await tools.get('tower_roster').execute({ repoRoot: repo }, exec)
    const entryAgain = fresh.roster.find((candidate) => candidate.agentId === spawned.agentId)
    assert.equal(entryAgain.stale, false)
  } finally {
    cleanup(root)
  }
})

test('parallel writers serialize on the state lock and keep revisions monotonic', async () => {
  const { root, repo } = seedRepo('dsh-tower-concurrency-parallel-')
  const { tools } = makeCtx()
  try {
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    const missions = Array.from({ length: 8 }, (_, index) => ({
      title: `Parallel ${index}`,
      scope: [`parallel-${index}/**`],
    }))
    await tools.get('tower_plan').execute({ repoRoot: repo, missions }, exec)
    const tower = await Tower.open(repo)
    const before = await tower.load()

    // Mix writers (notes on distinct missions) with readers (status calls).
    const writes = Array.from({ length: 8 }, (_, index) =>
      tools.get('tower_mission').execute(
        { repoRoot: repo, id: `M${index + 1}`, note: `parallel note ${index}` },
        exec,
      ),
    )
    const reads = Array.from({ length: 8 }, () => tools.get('tower_status').execute({ repoRoot: repo }, exec))
    const results = await Promise.allSettled([...writes, ...reads])
    const rejected = results.filter((result) => result.status === 'rejected')
    assert.deepEqual(rejected, [], `no parallel operation may fail: ${rejected.map((result) => result.reason?.message).join('; ')}`)

    const after = await tower.load()
    validateState(after, tower.paths.state)
    assert.equal(after.revision, before.revision + 8, 'each successful mutation must bump the revision exactly once')
    for (let index = 0; index < 8; index += 1) {
      const mission = after.missions.find((entry) => entry.id === `M${index + 1}`)
      assert.ok(mission.notes.includes(`parallel note ${index}`), `M${index + 1} lost its concurrent note`)
    }
    assert.ok(after.revision > before.revision)
  } finally {
    cleanup(root)
  }
})

test('reconcileObservedInactive releases a slot as soon as the catalog reports inactive', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    writeRepoConfig(repo, { spawn: { maxLiveWorkers: 1 } })
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    await tools.get('tower_plan').execute(
      { repoRoot: repo, missions: [{ title: 'One', scope: ['one/**'] }, { title: 'Two', scope: ['two/**'] }] },
      exec,
    )
    const tower = await Tower.open(repo)
    await tower.recordSpawn({
      missionId: 'M1', name: 'worker-m1', role: 'worker', agentId: 'agent-inactive-1',
      parentSessionId: 'session-inactive', cwd: null, branch: null,
    })
    const result = await tower.reconcileObservedInactive({ 'agent-inactive-1': 'inactive' })
    assert.deepEqual(result.released, ['worker-m1'])
    const state = await tower.load()
    assert.equal(state.roster.find((entry) => entry.name === 'worker-m1').state, 'inactive')
    const spawned = await tools.get('tower_spawn').execute({ repoRoot: repo, missionId: 'M2', role: 'worker' }, exec)
    assert.equal(spawned.name, 'worker-m2')
  } finally {
    cleanup(root)
  }
})

test('Tower instances keep independent git timeouts without mutating the process default', async () => {
  const { root, repo } = seedRepo()
  const { configuredGitTimeout } = await import('../lib/git.js')
  try {
    git(repo, ['init'])
    const first = new Tower({ root: repo, commonDir: path.join(repo, '.git'), branch: 'main' }, { git: { timeoutMs: 1000 } })
    const second = new Tower({ root: repo, commonDir: path.join(repo, '.git'), branch: 'main' }, { git: { timeoutMs: 3000 } })
    assert.equal(first.config.git.timeoutMs, 1000)
    assert.equal(second.config.git.timeoutMs, 3000)
    assert.equal(configuredGitTimeout(), 15000)
  } finally {
    cleanup(root)
  }
})

test('withGitLock serializes git work without the state lock', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { withGitLock, pathsFor } = await import('../lib/store.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-gitlock-'))
  const commonDir = path.join(root, '.git')
  try {
    const paths = pathsFor(commonDir)
    paths.dir = path.join(commonDir, 'dsh-tower')
    paths.gitLock = path.join(paths.dir, 'git.lock')
    fs.mkdirSync(paths.dir, { recursive: true })
    const value = await withGitLock(paths, async () => 42)
    assert.equal(value, 42)
    assert.equal(fs.existsSync(paths.gitLock), false)
    fs.writeFileSync(paths.gitLock, JSON.stringify({ pid: 999999, token: 'dead', at: 1 }))
    assert.equal(await withGitLock(paths, async () => 'ok'), 'ok')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('withGitLock serializes concurrent git mutations', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { withGitLock, pathsFor } = await import('../lib/store.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-gitlock-serialize-'))
  const commonDir = path.join(root, '.git')
  try {
    const paths = pathsFor(commonDir)
    paths.dir = path.join(commonDir, 'dsh-tower')
    paths.gitLock = path.join(paths.dir, 'git.lock')
    fs.mkdirSync(paths.dir, { recursive: true })
    let active = 0
    let max = 0
    const work = async () => {
      active += 1
      max = Math.max(max, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active -= 1
    }
    await Promise.all([withGitLock(paths, work), withGitLock(paths, work)])
    assert.equal(max, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Tower accepts injected adapters instead of importing the defaults', async () => {
  const { Tower } = await import('../app/tower.js')
  const { defaultDeps } = await import('../adapters/default.js')
  let gitCalls = 0
  let readCalls = 0
  const deps = {
    ...defaultDeps,
    vcs: {
      ...defaultDeps.vcs,
      git: async () => {
        gitCalls += 1
        return 'injected\n'
      },
    },
    store: {
      ...defaultDeps.store,
      readJson: async () => {
        readCalls += 1
        throw new Error('injected store used')
      },
    },
  }
  const nodeFs = await import('node:fs')
  const nodePath = await import('node:path')
  const nodeOs = await import('node:os')
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dsh-tower-di-'))
  const commonDir = nodePath.join(root, '.git')
  nodeFs.mkdirSync(nodePath.join(commonDir, 'dsh-tower'), { recursive: true })
  nodeFs.writeFileSync(nodePath.join(commonDir, 'dsh-tower', 'state.json'), '{}')
  try {
    const tower = new Tower({ root, commonDir }, {}, deps)
    assert.equal(await tower.git(root, ['status']), 'injected\n')
    await assert.rejects(() => tower.load(), /injected store used/)
    assert.equal(gitCalls, 1)
    assert.equal(readCalls, 1)
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true })
  }
})
