// Workspace lock: the unit-level advisory lock (acquire/touch/release/stale/
// corrupt) and the mode-level integration where only one Tower session may own
// a repository while mode.workspaceLock is on.
// Run with: node --test tests/workspace-lock.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import {
  acquireWorkspaceLock,
  inspectWorkspaceLock,
  releaseWorkspaceLock,
  touchWorkspaceLock,
  workspaceLockPath,
  workspaceLockToken,
} from '../adapters/workspaceLock.js'

// index.js reads its mode store through $DSH_HOME unless mode.storePath is set;
// isolate it before the dynamic import so a test never writes the real store.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-lock-home-'))
process.env.DSH_HOME = home
const { apply } = await import('../index.js')

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function tempCommonDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-lock-unit-'))
  const commonDir = path.join(root, '.git')
  fs.mkdirSync(commonDir)
  return { root, commonDir }
}

function readLock(commonDir) {
  return JSON.parse(fs.readFileSync(workspaceLockPath(commonDir), 'utf8'))
}

test('workspace lock: acquire, self reacquire, inspect and holder reporting', async () => {
  const { root, commonDir } = tempCommonDir()
  try {
    const token = workspaceLockToken()
    const first = await acquireWorkspaceLock(commonDir, { token, sessionId: 'sess-a', agentId: 'agent-a' })
    assert.equal(first.acquired, true)
    assert.equal(first.tookOver, false)
    assert.ok(fs.existsSync(workspaceLockPath(commonDir)))
    const record = readLock(commonDir)
    assert.equal(record.token, token)
    assert.equal(record.sessionId, 'sess-a')
    assert.equal(record.agentId, 'agent-a')
    assert.equal(record.pid, process.pid)
    assert.ok(record.at > 0)

    // The same session+agent reacquires its own lock and keeps the token.
    const again = await acquireWorkspaceLock(commonDir, { token: 'different-token', sessionId: 'sess-a', agentId: 'agent-a' })
    assert.equal(again.acquired, true)
    assert.equal(again.tookOver, false)
    assert.equal(again.record.token, token, 'a reacquire must keep the original token')

    const inspected = await inspectWorkspaceLock(commonDir, { sessionId: 'sess-a' })
    assert.equal(inspected.held, true)
    assert.equal(inspected.self, true)
    assert.equal(inspected.corrupt, false)
    assert.equal(inspected.stale, false)
    assert.equal(inspected.holder.sessionId, 'sess-a')

    const other = await acquireWorkspaceLock(commonDir, { token: 'other', sessionId: 'sess-b', agentId: 'agent-b' })
    assert.equal(other.acquired, false)
    assert.equal(other.holder.sessionId, 'sess-a')
    assert.equal(other.corrupt, undefined)
  } finally {
    removeTemp(root)
  }
})

test('workspace lock: stale takeover and corrupt-lock handling', async () => {
  const { root, commonDir } = tempCommonDir()
  try {
    const now = Date.now()
    const first = await acquireWorkspaceLock(commonDir, {
      token: 'token-a',
      sessionId: 'sess-a',
      agentId: 'agent-a',
      now,
      staleMs: 1000,
    })
    assert.equal(first.acquired, true)

    // Fresh lock, another session: refused.
    const blocked = await acquireWorkspaceLock(commonDir, {
      token: 'token-b',
      sessionId: 'sess-b',
      agentId: 'agent-b',
      now: now + 10,
      staleMs: 1000,
    })
    assert.equal(blocked.acquired, false)

    // A lock older than staleMs is taken over.
    const takeover = await acquireWorkspaceLock(commonDir, {
      token: 'token-b',
      sessionId: 'sess-b',
      agentId: 'agent-b',
      now: now + 10000,
      staleMs: 1000,
    })
    assert.equal(takeover.acquired, true)
    assert.equal(takeover.tookOver, true)
    assert.equal(readLock(commonDir).sessionId, 'sess-b')

    // A corrupt lock is fail-closed while fresh...
    fs.writeFileSync(workspaceLockPath(commonDir), 'not json at all')
    const corrupt = await acquireWorkspaceLock(commonDir, {
      token: 'token-c',
      sessionId: 'sess-c',
      agentId: 'agent-c',
      now: Date.now(),
      staleMs: 60_000,
    })
    assert.equal(corrupt.acquired, false)
    assert.equal(corrupt.corrupt, true)
    const inspected = await inspectWorkspaceLock(commonDir, {})
    assert.equal(inspected.held, false)
    assert.equal(inspected.corrupt, true)

    // ...but a stale corrupt lock is removed like any other stale lock.
    const staleCorrupt = await acquireWorkspaceLock(commonDir, {
      token: 'token-d',
      sessionId: 'sess-d',
      agentId: 'agent-d',
      now: Date.now() + 120_000,
      staleMs: 1000,
    })
    assert.equal(staleCorrupt.acquired, true)
    assert.equal(staleCorrupt.tookOver, true)
    assert.equal(readLock(commonDir).sessionId, 'sess-d')
  } finally {
    removeTemp(root)
  }
})

test('workspace lock: touch and release only act on the owning token', async () => {
  const { root, commonDir } = tempCommonDir()
  try {
    assert.equal(await inspectWorkspaceLock(commonDir).then((info) => info.held), false)
    await acquireWorkspaceLock(commonDir, { token: 'token-a', sessionId: 'sess-a', agentId: 'agent-a', now: 1000 })

    const before = readLock(commonDir).at
    assert.equal(await touchWorkspaceLock(commonDir, { token: 'wrong', now: 5000 }), false)
    assert.equal(readLock(commonDir).at, before, 'a foreign touch must not update the lock')
    assert.equal(await touchWorkspaceLock(commonDir, { token: 'token-a', now: 5000 }), true)
    assert.equal(readLock(commonDir).at, 5000)

    assert.equal(await releaseWorkspaceLock(commonDir, { token: 'wrong' }), false)
    assert.ok(fs.existsSync(workspaceLockPath(commonDir)), 'a foreign release must not delete the lock')
    assert.equal(await releaseWorkspaceLock(commonDir, { token: 'token-a' }), true)
    assert.equal(fs.existsSync(workspaceLockPath(commonDir)), false)
    assert.equal(await releaseWorkspaceLock(commonDir, { token: 'token-a' }), false)
    assert.equal(await touchWorkspaceLock(commonDir, { token: 'token-a' }), false)

    // A lock without a token can be released blindly (used by crash cleanup);
    // inspect still reports the holder truthfully.
    await acquireWorkspaceLock(commonDir, { token: 'token-z', sessionId: 'sess-z', agentId: 'agent-z' })
    assert.equal((await inspectWorkspaceLock(commonDir, { sessionId: 'nope' })).self, false)
    assert.equal(await releaseWorkspaceLock(commonDir, {}), true)
  } finally {
    removeTemp(root)
  }
})

function makeModeCtx() {
  const tools = new Map()
  const commands = new Map()
  const effects = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    get() {
      return undefined
    },
    logger: { error() {}, warn() {}, info() {}, debug() {} },
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
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => {}
      },
    },
  }
  return { ctx, tools, commands, effects, disposeAll: () => effects.forEach((dispose) => dispose()) }
}

function seedRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-lock-mode-'))
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

test('mode.workspaceLock: the second Tower session is refused until the first leaves', async () => {
  const { root, repo } = seedRepo()
  const harness = makeModeCtx()
  const storePath = path.join(home, 'modes')
  try {
    apply(harness.ctx, { mode: { workspaceLock: true, storePath } })
    assert.ok(harness.tools.has('tower_status'), 'the tool surface is registered')
    const agentA = { id: 'session-A' }
    const agentB = { id: 'session-B' }
    const command = harness.commands.get('tower')
    assert.ok(command, 'the /tower command is registered')
    const runCommand = (agent, rawInput) => command.handler({ agent, rawInput, attachments: [] })
    const call = (name, args, agent) => harness.tools.get(name).execute(args, { agent, signal: undefined })
    const commonDir = path.join(repo, '.git')
    const lockFile = workspaceLockPath(commonDir)

    // A enters the mode; tower_init deliberately does not take the workspace lock.
    assert.match((await runCommand(agentA, '')).text, /Tower mode ON/)
    await call('tower_init', { repoRoot: repo }, agentA)
    assert.equal(fs.existsSync(lockFile), false, 'tower_init must not acquire the workspace lock')

    // The first repository-scoped tool call lazily acquires it.
    const statusA = await call('tower_status', { repoRoot: repo }, agentA)
    assert.equal(statusA.revision, 0)
    assert.ok(fs.existsSync(lockFile), 'tower_status must acquire the lazy workspace lock')
    const lockA = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    assert.equal(lockA.sessionId, 'session-A')
    const modeA = await call('tower_mode', {}, agentA)
    assert.equal(modeA.workspaceLock.enabled, true)
    assert.equal(modeA.workspaceLock.held, true)

    // B enters the mode but inherits the busy workspace.
    assert.match((await runCommand(agentB, '')).text, /Tower mode ON/)
    const modeB = await call('tower_mode', {}, agentB)
    assert.equal(modeB.workspaceLock.enabled, true)
    assert.equal(modeB.workspaceLock.held, false)
    await assert.rejects(
      () => call('tower_status', { repoRoot: repo }, agentB),
      (error) => {
        assert.equal(error.code, 'workspace-busy', error.message)
        assert.match(error.message, /locked by session session-A/)
        return true
      },
    )

    // A leaves the mode, which releases the lock; B can now take it.
    assert.match((await runCommand(agentA, 'off')).text, /Tower mode OFF/)
    assert.equal(fs.existsSync(lockFile), false, '/tower off must release the workspace lock')
    await call('tower_status', { repoRoot: repo }, agentB)
    const lockB = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    assert.equal(lockB.sessionId, 'session-B')
    assert.notEqual(lockB.token, lockA.token, 'the new owner gets a fresh token')

    await runCommand(agentB, 'off')
    assert.equal(fs.existsSync(lockFile), false)
  } finally {
    harness.disposeAll()
    removeTemp(root)
    removeTemp(home)
  }
})
