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
  WORKSPACE_LOCK_TORN_GRACE_MS,
  acquireWorkspaceLock,
  clearWorkspaceLock,
  inspectWorkspaceLock,
  releaseWorkspaceLock,
  touchWorkspaceLock,
  workspaceLockCapability,
  workspaceLockFacts,
  workspaceLockPath,
  workspaceLockStatus,
  workspaceLockToken,
} from '../adapters/workspaceLock.js'

// index.js reads its mode store through $DSH_HOME unless mode.storePath is set;
// isolate it before the dynamic import so a test never writes the real store.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-lock-home-'))
process.env.DSH_HOME = home
const { apply } = await import('../index.js')
const DEAD_PID = 999999

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

test('workspace lock: age never steals a live owner, a dead PID is reclaimed, corrupt locks fail closed', async () => {
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
    assert.equal(blocked.holder.sessionId, 'sess-a')

    // Age is diagnostic: even far past staleMs the live owner keeps the lock.
    const ancient = await acquireWorkspaceLock(commonDir, {
      token: 'token-b',
      sessionId: 'sess-b',
      agentId: 'agent-b',
      now: now + 10_000_000,
      staleMs: 1000,
    })
    assert.equal(ancient.acquired, false, 'a live PID is never reclaimed on age alone')
    assert.equal(ancient.holder.sessionId, 'sess-a')
    assert.equal(readLock(commonDir).token, 'token-a')

    // A provably dead owner is reclaimed by the kernel.
    fs.writeFileSync(workspaceLockPath(commonDir), JSON.stringify({ ...first.record, pid: DEAD_PID }))
    const takeover = await acquireWorkspaceLock(commonDir, {
      token: 'token-b',
      sessionId: 'sess-b',
      agentId: 'agent-b',
      now: now + 20,
    })
    assert.equal(takeover.acquired, true)
    assert.equal(takeover.tookOver, true)
    assert.equal(readLock(commonDir).sessionId, 'sess-b')

    // A corrupt lock is fail-closed: reported, never removed.
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
    assert.equal(corrupt.holder, null)
    const inspected = await inspectWorkspaceLock(commonDir, {})
    assert.equal(inspected.held, false)
    assert.equal(inspected.corrupt, true)

    // Age does not turn unreadable bytes into an abandoned lock either.
    const staleCorrupt = await acquireWorkspaceLock(commonDir, {
      token: 'token-d',
      sessionId: 'sess-d',
      agentId: 'agent-d',
      now: Date.now() + 120_000,
      staleMs: 1000,
    })
    assert.equal(staleCorrupt.acquired, false)
    assert.equal(staleCorrupt.corrupt, true)
    assert.equal(fs.readFileSync(workspaceLockPath(commonDir), 'utf8'), 'not json at all')
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

    // A lock cannot be released without its token (no blind unlink); inspect
    // still reports the holder truthfully.
    await acquireWorkspaceLock(commonDir, { token: 'token-z', sessionId: 'sess-z', agentId: 'agent-z' })
    assert.equal((await inspectWorkspaceLock(commonDir, { sessionId: 'nope' })).self, false)
    assert.equal(await releaseWorkspaceLock(commonDir, {}), false)
    assert.ok(fs.existsSync(workspaceLockPath(commonDir)), 'a tokenless release must not delete the lock')
    assert.equal(await releaseWorkspaceLock(commonDir, { token: 'token-z' }), true)
    assert.equal(fs.existsSync(workspaceLockPath(commonDir)), false)
  } finally {
    removeTemp(root)
  }
})

function ageLockFile(commonDir, ageMs) {
  const file = workspaceLockPath(commonDir)
  const when = new Date(Date.now() - ageMs)
  fs.utimesSync(file, when, when)
}

test('workspace lock: a torn record is reclaimed only after the grace window', async () => {
  const { root, commonDir } = tempCommonDir()
  try {
    const file = workspaceLockPath(commonDir)
    await acquireWorkspaceLock(commonDir, { token: workspaceLockToken(), sessionId: 'sess-a', agentId: 'agent-a' })
    fs.writeFileSync(file, ' '.repeat(217))
    // F87 red proof: with no grace check this fresh torn record would be stolen
    // from a writer that is still between its exclusive create and its write.
    const fresh = await acquireWorkspaceLock(commonDir, { token: workspaceLockToken(), sessionId: 'sess-b', agentId: 'agent-b' })
    assert.equal(fresh.acquired, false)
    assert.equal(fresh.corrupt, true)
    assert.equal(fresh.reason, 'torn-fresh')
    assert.equal(fresh.workspaceLock.torn, true)
    assert.equal(fresh.workspaceLock.aged, false)
    assert.equal(fresh.workspaceLock.reclaimable, false)
    assert.equal(fs.readFileSync(file, 'utf8'), ' '.repeat(217), 'fresh torn bytes are untouched')

    ageLockFile(commonDir, WORKSPACE_LOCK_TORN_GRACE_MS + 5000)
    const facts = await workspaceLockFacts(commonDir)
    assert.equal(facts.bytes, 217)
    assert.equal(typeof facts.mtime, 'string')
    assert.equal(facts.aged, true)
    assert.equal(facts.reclaimable, true)
    const aged = await acquireWorkspaceLock(commonDir, { token: workspaceLockToken(), sessionId: 'sess-b', agentId: 'agent-b' })
    assert.equal(aged.acquired, true)
    assert.equal(aged.tookOver, true)
    assert.equal(readLock(commonDir).sessionId, 'sess-b')
    assert.ok(aged.backup, 'the torn record is moved to a backup, not deleted')
    assert.equal(fs.readFileSync(aged.backup, 'utf8'), ' '.repeat(217))

    // Zero bytes are the other common torn shape (created, never written).
    fs.writeFileSync(file, '')
    ageLockFile(commonDir, WORKSPACE_LOCK_TORN_GRACE_MS + 5000)
    const zero = await acquireWorkspaceLock(commonDir, { token: workspaceLockToken(), sessionId: 'sess-c', agentId: 'agent-c' })
    assert.equal(zero.acquired, true)
    assert.equal(readLock(commonDir).sessionId, 'sess-c')
    assert.equal(fs.readFileSync(zero.backup, 'utf8'), '')
  } finally {
    removeTemp(root)
  }
})

test('workspace lock: clear refuses fresh torn and live holders, force moves to a backup', async () => {
  const { root, commonDir } = tempCommonDir()
  try {
    const file = workspaceLockPath(commonDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, ' '.repeat(217))
    assert.equal((await workspaceLockStatus(commonDir)).reclaimable, false)
    const refusedFresh = await clearWorkspaceLock(commonDir, {})
    assert.equal(refusedFresh.cleared, false)
    assert.equal(refusedFresh.reason, 'torn-fresh')
    assert.equal(fs.readFileSync(file, 'utf8'), ' '.repeat(217))

    const record = {
      token: workspaceLockToken(),
      pid: process.pid,
      sessionId: 'sess-live',
      agentId: 'agent-live',
      since: Date.now(),
      at: Date.now(),
    }
    fs.writeFileSync(file, JSON.stringify(record))
    const status = await workspaceLockStatus(commonDir, { sessionId: 'sess-live' })
    assert.equal(status.held, true)
    assert.equal(status.self, true)
    assert.equal(status.pid, process.pid)
    assert.equal(status.sessionId, 'sess-live')
    const refusedLive = await clearWorkspaceLock(commonDir, {})
    assert.equal(refusedLive.cleared, false)
    assert.equal(refusedLive.reason, 'holder-alive')
    await assert.rejects(workspaceLockCapability.clear(commonDir, {}), (error) => {
      assert.equal(error.code, 'workspace-busy')
      assert.match(error.message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.match(error.message, new RegExp(String(fs.statSync(file).size)))
      assert.match(error.message, /mtime/)
      return true
    })
    const forced = await workspaceLockCapability.clear(commonDir, { force: true })
    assert.equal(forced.cleared, true)
    assert.equal(forced.forced, true)
    assert.ok(fs.existsSync(forced.backup))
    assert.match(fs.readFileSync(forced.backup, 'utf8'), /"sess-live"/)
    assert.equal(fs.existsSync(file), false)

    // A provably dead PID is the one parsed record the kernel already clears.
    fs.writeFileSync(file, JSON.stringify({ ...record, token: workspaceLockToken(), pid: DEAD_PID, sessionId: 'sess-dead' }))
    const dead = await clearWorkspaceLock(commonDir, {})
    assert.equal(dead.cleared, true)
    assert.ok(dead.backup)
  } finally {
    removeTemp(root)
  }
})

test('workspace lock: an unreadable record is reported and only force clears it', async () => {
  const { root, commonDir } = tempCommonDir()
  try {
    // A directory at the lock path cannot be read as a record: the same
    // unreadable shape as a permission error, without relying on chmod.
    const file = workspaceLockPath(commonDir)
    fs.mkdirSync(file, { recursive: true })
    const facts = await workspaceLockStatus(commonDir)
    assert.equal(facts.held, true)
    assert.equal(facts.unreadable, true)
    assert.equal(facts.error !== null, true)
    const refused = await clearWorkspaceLock(commonDir, {})
    assert.equal(refused.cleared, false)
    assert.equal(refused.reason, 'unreadable')
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

function tornLock(commonDir, bytes = ' '.repeat(217)) {
  const file = workspaceLockPath(commonDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
  return file
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

test('mode.workspaceLock: a torn record is visible and recoverable through tower_recover', async () => {
  const { root, repo } = seedRepo()
  const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-lock-store-'))
  const harness = makeModeCtx()
  try {
    apply(harness.ctx, { mode: { workspaceLock: true, storePath } })
    const agentA = { id: 'session-A' }
    const command = harness.commands.get('tower')
    const runCommand = (rawInput) => command.handler({ agent: agentA, rawInput, attachments: [] })
    const call = (name, args) => harness.tools.get(name).execute(args, { agent: agentA, signal: undefined })
    const commonDir = path.join(repo, '.git')
    await call('tower_init', { repoRoot: repo })
    assert.match((await runCommand('')).text, /Tower mode ON/)

    const lockFile = tornLock(commonDir)
    const tornMtime = new Date(fs.statSync(lockFile).mtimeMs).toISOString()

    // F87: the documented recovery tool must run while the gate is closed.
    const status = await call('tower_recover', { action: 'status', repoRoot: repo })
    assert.equal(status.workspaceLock.path, lockFile)
    assert.equal(status.workspaceLock.bytes, 217)
    assert.equal(status.workspaceLock.mtime, tornMtime)
    assert.equal(status.workspaceLock.held, true)
    assert.equal(status.workspaceLock.torn, true)
    assert.equal(status.workspaceLock.reclaimable, false)

    // Every other tool still refuses, and the refusal names the file facts.
    await assert.rejects(
      () => call('tower_inspect', { view: 'status', repoRoot: repo }),
      (error) => {
        assert.equal(error.code, 'workspace-busy')
        assert.ok(error.message.includes(lockFile), error.message)
        assert.match(error.message, /217 bytes/)
        assert.match(error.message, /mtime/)
        return true
      },
    )

    // The workspace action needs its own confirmation string.
    await assert.rejects(
      () => call('tower_recover', { action: 'clear-workspace-lock', repoRoot: repo, confirm: 'CLEAR_STALE_LOCK' }),
      /confirm:"CLEAR_WORKSPACE_LOCK"/,
    )
    await assert.rejects(
      () => call('tower_recover', { action: 'clear-workspace-lock', repoRoot: repo, confirm: 'CLEAR_WORKSPACE_LOCK' }),
      (error) => {
        assert.equal(error.code, 'workspace-busy')
        assert.equal(error.details.reason, 'torn-fresh')
        return true
      },
    )

    const cleared = await call('tower_recover', {
      action: 'clear-workspace-lock',
      repoRoot: repo,
      confirm: 'CLEAR_WORKSPACE_LOCK',
      force: true,
    })
    assert.equal(cleared.cleared, true)
    assert.equal(cleared.workspaceLock.path, lockFile)
    assert.equal(cleared.workspaceLock.bytes, 217)
    assert.ok(fs.existsSync(cleared.backup), 'the torn record is kept at the backup path')
    assert.equal(fs.readFileSync(cleared.backup, 'utf8'), ' '.repeat(217))

    // The gate is open again: the next tool call acquires a valid record.
    await call('tower_inspect', { view: 'status', repoRoot: repo })
    assert.equal(readLock(commonDir).sessionId, 'session-A')
    await runCommand('off')
  } finally {
    harness.disposeAll()
    removeTemp(root)
    removeTemp(storePath)
  }
})

test('mode.workspaceLock: a live foreign record still closes the gate and only force clears it', async () => {
  const { root, repo } = seedRepo()
  const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-lock-store-'))
  const harness = makeModeCtx()
  try {
    apply(harness.ctx, { mode: { workspaceLock: true, storePath } })
    const agentA = { id: 'session-A' }
    const command = harness.commands.get('tower')
    const runCommand = (rawInput) => command.handler({ agent: agentA, rawInput, attachments: [] })
    const call = (name, args) => harness.tools.get(name).execute(args, { agent: agentA, signal: undefined })
    const commonDir = path.join(repo, '.git')
    await call('tower_init', { repoRoot: repo })
    assert.match((await runCommand('')).text, /Tower mode ON/)

    const lockFile = workspaceLockPath(commonDir)
    fs.mkdirSync(path.dirname(lockFile), { recursive: true })
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        token: workspaceLockToken(),
        pid: process.pid,
        sessionId: 'foreign-session',
        agentId: 'foreign-session',
        since: Date.now(),
        at: Date.now(),
      }),
    )
    await assert.rejects(
      () => call('tower_inspect', { view: 'status', repoRoot: repo }),
      (error) => {
        assert.equal(error.code, 'workspace-busy')
        assert.match(error.message, /locked by session foreign-sess/)
        assert.ok(error.message.includes(lockFile), error.message)
        assert.match(error.message, /mtime/)
        return true
      },
    )
    const status = await call('tower_recover', { action: 'status', repoRoot: repo })
    assert.equal(status.workspaceLock.self, false)
    assert.equal(status.workspaceLock.pid, process.pid)
    assert.equal(status.workspaceLock.sessionId, 'foreign-session')
    await assert.rejects(
      () => call('tower_recover', { action: 'clear-workspace-lock', repoRoot: repo, confirm: 'CLEAR_WORKSPACE_LOCK' }),
      (error) => {
        assert.equal(error.code, 'workspace-busy')
        assert.equal(error.details.reason, 'holder-alive')
        return true
      },
    )
    const cleared = await call('tower_recover', {
      action: 'clear-workspace-lock',
      repoRoot: repo,
      confirm: 'CLEAR_WORKSPACE_LOCK',
      force: true,
    })
    assert.equal(cleared.cleared, true)
    assert.match(fs.readFileSync(cleared.backup, 'utf8'), /foreign-session/)
    await call('tower_inspect', { view: 'status', repoRoot: repo })
    assert.equal(readLock(commonDir).sessionId, 'session-A')
    await runCommand('off')
  } finally {
    harness.disposeAll()
    removeTemp(root)
    removeTemp(storePath)
  }
})

test('mode.workspaceLock: an aged torn record is reclaimed without a recovery call', async () => {
  const { root, repo } = seedRepo()
  const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-lock-store-'))
  const harness = makeModeCtx()
  try {
    apply(harness.ctx, { mode: { workspaceLock: true, storePath } })
    const agentA = { id: 'session-A' }
    const command = harness.commands.get('tower')
    const runCommand = (rawInput) => command.handler({ agent: agentA, rawInput, attachments: [] })
    const call = (name, args) => harness.tools.get(name).execute(args, { agent: agentA, signal: undefined })
    const commonDir = path.join(repo, '.git')
    await call('tower_init', { repoRoot: repo })
    assert.match((await runCommand('')).text, /Tower mode ON/)

    const lockFile = tornLock(commonDir)
    ageLockFile(commonDir, WORKSPACE_LOCK_TORN_GRACE_MS + 5000)
    await call('tower_inspect', { view: 'status', repoRoot: repo })
    assert.equal(readLock(commonDir).sessionId, 'session-A')
    const backups = fs.readdirSync(path.dirname(lockFile)).filter((name) => name.includes('.recovered-'))
    assert.equal(backups.length, 1)
    assert.equal(fs.readFileSync(path.join(path.dirname(lockFile), backups[0]), 'utf8'), ' '.repeat(217))
    await runCommand('off')
  } finally {
    harness.disposeAll()
    removeTemp(root)
    removeTemp(storePath)
  }
})

test('mode.workspaceLock: the second Tower session is refused until the first leaves', async () => {
  const { root, repo } = seedRepo()
  const harness = makeModeCtx()
  const storePath = path.join(home, 'modes')
  try {
    apply(harness.ctx, { mode: { workspaceLock: true, storePath } })
    assert.ok(harness.tools.has('tower_inspect'), 'the tool surface is registered')
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
    const statusA = await call('tower_inspect', { view: 'status', repoRoot: repo }, agentA)
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
      () => call('tower_inspect', { view: 'status', repoRoot: repo }, agentB),
      (error) => {
        assert.equal(error.code, 'workspace-busy', error.message)
        assert.match(error.message, /locked by session session-A/)
        return true
      },
    )

    // A leaves the mode, which releases the lock; B can now take it.
    assert.match((await runCommand(agentA, 'off')).text, /Tower mode OFF/)
    assert.equal(fs.existsSync(lockFile), false, '/tower off must release the workspace lock')
    await call('tower_inspect', { view: 'status', repoRoot: repo }, agentB)
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
