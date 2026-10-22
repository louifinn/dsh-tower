// #92: a recycled PID must not make a crashed state lock permanently
// unrecoverable. Liveness is decided by the heartbeat the holder rewrites, not
// by the PID alone: `processAlive` is a fast path (ESRCH) plus a fall-through to
// the heartbeat test, so a live-looking PID with a silent heartbeat is
// reclaimable while a live writer that keeps heartbeating is never stolen.
//
// Every case runs in a temp repo and injects the heartbeat interval / stale
// window, so no fixture sleeps for the shipped 3 s grace period.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { fsp } from '../adapters/store-fs.js'
import {
  DEFAULT_LOCK_HEARTBEAT_MS,
  LOCK_HEARTBEAT_STALE_FACTOR,
  lockHeartbeatMs,
  lockLiveness,
  lockRecord,
  lockStaleAfterMs,
  reclaimDeadLock,
  touchLock,
} from '../lib/persistence.js'
import { pathsFor, withLock } from '../lib/store.js'
import { registerTowerTools } from '../lib/tool-registry.js'
import { Tower } from '../app/tower.js'

const DEAD_PID = 999999
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** A repo-shaped state directory; the primitives only need the paths. */
function lockPaths(root) {
  const paths = pathsFor(path.join(root, '.git'))
  fs.mkdirSync(paths.dir, { recursive: true })
  return paths
}

function writeLock(file, record) {
  fs.writeFileSync(file, JSON.stringify(record))
  return JSON.stringify(record)
}

function readLockFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function reclaimedBackups(dir) {
  return fs.readdirSync(dir).filter((name) => name.startsWith('state.lock.reclaimed-'))
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(5)
  }
  return false
}

// ---------------------------------------------------------------------------
// Primitive classification
// ---------------------------------------------------------------------------

test('lock liveness: ESRCH is immediate, a live PID falls through to the heartbeat (#92)', () => {
  assert.equal(DEFAULT_LOCK_HEARTBEAT_MS * LOCK_HEARTBEAT_STALE_FACTOR, lockStaleAfterMs())
  assert.equal(lockHeartbeatMs({ heartbeatMs: 40 }), 40)
  assert.equal(lockStaleAfterMs({ heartbeatMs: 40 }), 120)
  assert.equal(lockStaleAfterMs({ heartbeatMs: 40, heartbeatStaleMs: 900 }), 900)

  const now = Date.now()
  const gone = lockLiveness({ pid: DEAD_PID, at: now }, { now })
  assert.equal(gone.dead, true)
  assert.equal(gone.reason, 'esrch')

  const fresh = lockLiveness({ pid: process.pid, at: now }, { now })
  assert.equal(fresh.dead, false)
  assert.equal(fresh.reason, 'held')

  // A live-looking PID whose holder stopped heartbeating is reclaimable: this
  // is the recycled-PID case the issue is about.
  const stale = lockLiveness({ pid: process.pid, at: now - 10000 }, { now })
  assert.equal(stale.dead, true)
  assert.equal(stale.reason, 'heartbeat-stale')
  assert.ok(stale.timing.heartbeatAgeMs >= 10000)

  const invalid = lockLiveness({ pid: 0, at: now }, { now })
  assert.equal(invalid.dead, false, 'a malformed PID is reported, not reclaimed')
  assert.equal(lockLiveness({ pid: 0, at: now }, { now, invalidPidIsDead: true }).dead, true)

  const record = lockRecord('token-a', { startedAt: 1 }, { now: 1234 })
  assert.equal(record.since, 1234)
  assert.equal(record.at, 1234)
  assert.equal(record.startedAt, 1)
})

test('touchLock only refreshes a record this token still owns', async () => {
  const root = tempDir('dsh-tower-lock-touch-')
  try {
    const paths = lockPaths(root)
    const record = lockRecord('owner', {}, { now: 1000 })
    fs.writeFileSync(paths.lock, JSON.stringify(record))

    assert.equal(await touchLock(paths.lock, 'someone-else', { now: 2000 }), false)
    assert.equal(readLockFile(paths.lock).at, 1000)

    assert.equal(await touchLock(paths.lock, 'owner', { now: 2000 }), true)
    const refreshed = readLockFile(paths.lock)
    assert.equal(refreshed.at, 2000)
    assert.equal(refreshed.token, 'owner')
    assert.equal(refreshed.since, 1000, 'the heartbeat must not rewrite the record age')

    fs.unlinkSync(paths.lock)
    assert.equal(await touchLock(paths.lock, 'owner', { now: 3000 }), false, 'a released lock must not be recreated')
    assert.equal(fs.existsSync(paths.lock), false)
  } finally {
    removeTemp(root)
  }
})

// ---------------------------------------------------------------------------
// Acceptance fixtures
// ---------------------------------------------------------------------------

test('a live-PID lock with a stale heartbeat is reclaimed and kept as an audit backup (#92)', async () => {
  const root = tempDir('dsh-tower-lock-stale-')
  try {
    const paths = lockPaths(root)
    const at = Date.now() - 10000
    const original = writeLock(paths.lock, {
      token: 'recycled-pid',
      pid: process.pid,
      startedAt: Date.now() - 60000,
      since: Date.now() - 60000,
      at,
    })

    const started = Date.now()
    const value = await withLock(paths, async () => 'reclaimed', { heartbeatMs: 1000 })
    assert.equal(value, 'reclaimed')
    assert.ok(Date.now() - started < 3000, 'the stale heartbeat, not the PID, must decide the reclaim')

    assert.equal(fs.existsSync(paths.lock), false)
    const backups = reclaimedBackups(paths.dir)
    assert.equal(backups.length, 1, 'the reclaimed bytes must stay auditable')
    assert.equal(fs.readFileSync(path.join(paths.dir, backups[0]), 'utf8'), original)
  } finally {
    removeTemp(root)
  }
})

test('a lock that keeps heartbeating is never stolen even when the waiter times out (#92)', async () => {
  const root = tempDir('dsh-tower-lock-heartbeat-')
  try {
    const paths = lockPaths(root)
    let releaseHolder
    const holderGate = new Promise((resolve) => {
      releaseHolder = resolve
    })
    const heartbeatMs = 10
    // A wide stale window keeps the fixture independent of a slow CI host: the
    // waiter times out long before the (very frequent) heartbeat could age out.
    const heartbeatStaleMs = 5000
    const holding = withLock(paths, () => holderGate, { heartbeatMs, heartbeatStaleMs })
    assert.ok(await waitFor(() => fs.existsSync(paths.lock)), 'the holder must acquire the lock')
    const holderToken = readLockFile(paths.lock).token

    const before = readLockFile(paths.lock).at
    await sleep(60)
    const during = readLockFile(paths.lock)
    assert.ok(during.at > before, 'a held lock must keep rewriting its heartbeat')
    assert.equal(during.token, holderToken)

    let applied = false
    await assert.rejects(
      () =>
        withLock(
          paths,
          async () => {
            applied = true
          },
          { timeoutMs: 150, pollMs: 10, heartbeatMs, heartbeatStaleMs },
        ),
      (error) => error?.code === 'state-locked',
    )
    assert.equal(applied, false, 'the waiter must not write while the holder heartbeats')
    assert.equal(readLockFile(paths.lock).token, holderToken, 'the lock must still belong to the holder')
    assert.equal(fs.existsSync(paths.lock), true)

    releaseHolder()
    await holding
    assert.equal(fs.existsSync(paths.lock), false)
    await sleep(40)
    assert.equal(fs.existsSync(paths.lock), false, 'the release must clear the heartbeat timer')
  } finally {
    removeTemp(root)
  }
})

test('ESRCH still reclaims immediately, without waiting for the heartbeat grace period (#92)', async () => {
  const root = tempDir('dsh-tower-lock-esrch-')
  try {
    const paths = lockPaths(root)
    writeLock(paths.lock, { token: 'gone', pid: DEAD_PID, startedAt: Date.now(), since: Date.now(), at: Date.now() })

    const started = Date.now()
    // A 60 s heartbeat means a 180 s grace period; only the PID fast path can
    // explain an immediate reclaim.
    assert.equal(await withLock(paths, async () => 'fast', { heartbeatMs: 60000 }), 'fast')
    assert.ok(Date.now() - started < 2000, 'ESRCH must not wait for the heartbeat grace period')
    assert.equal(fs.existsSync(paths.lock), false)
    assert.deepEqual(reclaimedBackups(paths.dir), [], 'a provably dead PID leaves no reclaim backup')
  } finally {
    removeTemp(root)
  }
})

test('a record swapped mid-reclaim is restored and the reclaim loses the race safely (#92)', async () => {
  const root = tempDir('dsh-tower-lock-race-')
  try {
    const paths = lockPaths(root)
    writeLock(paths.lock, { token: 'original', pid: DEAD_PID, at: 1 })
    const replacement = JSON.stringify({ token: 'successor', pid: process.pid, since: Date.now(), at: Date.now() })
    let swapped = false
    // Simulate the writer replacing the record between the reclaim's read and
    // its rename: the quarantine then holds bytes the reclaimer never inspected.
    const rename = async (from, to) => {
      if (!swapped) {
        swapped = true
        fs.writeFileSync(from, replacement)
      }
      return fsp.rename(from, to)
    }

    assert.equal(await reclaimDeadLock(paths.lock, { rename }), false)
    assert.equal(swapped, true, 'the fixture must actually exercise the swap')
    assert.equal(fs.readFileSync(paths.lock, 'utf8'), replacement, 'the newer record must be restored, not deleted')
    assert.deepEqual(
      fs.readdirSync(paths.dir).filter((name) => name.includes('.stale-') || name.includes('.reclaimed-')),
      [],
    )
  } finally {
    removeTemp(root)
  }
})

// ---------------------------------------------------------------------------
// Tool surface: tower_recover force + tower_doctor heartbeat
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo() {
  const root = tempDir('dsh-tower-lock-recover-')
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
  const subagents = {
    list: () => ['spawn'],
    startActivation: async () => ({ childId: 'child-1', result: Promise.resolve({ stopReason: 'completed' }) }),
    sendMessage: async () => {},
    listDescendants: async () => [],
    interrupt: () => {},
  }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get: (name) => (name === 'subagents' ? subagents : undefined),
    emit: () => {},
    on: () => () => {},
    inject(_deps, callback) {
      callback(ctx)
    },
    tools: { register: (definition) => (tools.set(definition.name, definition), () => {}), guard: () => () => {}, restrict() {} },
    systemPrompt: { section() {} },
  }
  registerTowerTools(ctx)
  return { tools }
}

const exec = { agent: { id: 'tower-lock-heartbeat' } }
const call = (tools, name, args) => tools.get(name).execute(args, exec)

test('tower_recover force:true clears a live-but-silent PID and leaves a .recovered-<ts> backup (#92)', async () => {
  const { root, repo } = makeRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    fs.writeFileSync(
      tower.paths.lock,
      JSON.stringify({
        token: 'live-but-silent',
        pid: process.pid,
        startedAt: Date.now() - 60000,
        since: Date.now() - 60000,
        at: Date.now() - 10000,
      }),
    )

    const status = await call(tools, 'tower_recover', { repoRoot: repo, action: 'status' })
    assert.equal(status.stateLock.pid, process.pid)
    assert.equal(status.stateLock.alive, true, 'the PID is alive; only the heartbeat is silent')
    assert.ok(status.stateLock.heartbeatAgeMs >= 9000)
    assert.ok(status.stateLock.ageMs >= 50000)
    assert.equal(status.stateLock.stale, true)

    // Without force the repair still refuses an alive PID.
    await assert.rejects(
      () =>
        call(tools, 'tower_recover', {
          repoRoot: repo,
          action: 'clear-stale-lock',
          confirm: 'CLEAR_STALE_LOCK',
        }),
      /still alive/i,
    )
    assert.equal(fs.existsSync(tower.paths.lock), true)

    // force is itself gated by the confirmation string.
    await assert.rejects(
      () => call(tools, 'tower_recover', { repoRoot: repo, action: 'clear-stale-lock', force: true }),
      /confirm/i,
    )

    const cleared = await call(tools, 'tower_recover', {
      repoRoot: repo,
      action: 'clear-stale-lock',
      confirm: 'CLEAR_STALE_LOCK',
      force: true,
    })
    assert.equal(cleared.cleared, true)
    assert.equal(cleared.forced, true)
    assert.equal(cleared.stateLock.pid, process.pid)
    assert.ok(cleared.stateLock.heartbeatAgeMs >= 9000)
    assert.match(cleared.backup, /state\.lock\.recovered-\d+$/)
    assert.equal(fs.existsSync(tower.paths.lock), false)
    assert.equal(fs.existsSync(cleared.backup), true, 'the recovered record must remain auditable')
  } finally {
    removeTemp(root)
  }
})

test('tower_doctor reports state-lock age and heartbeat freshness (#92)', async () => {
  const { root, repo } = makeRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    fs.writeFileSync(
      tower.paths.lock,
      JSON.stringify({
        token: 'silent-holder',
        pid: process.pid,
        startedAt: Date.now() - 60000,
        since: Date.now() - 60000,
        at: Date.now() - 10000,
      }),
    )

    const doctor = await call(tools, 'tower_doctor', { repoRoot: repo })
    const check = doctor.checks.find((entry) => entry.id === 'state-lock')
    assert.equal(check.status, 'warn')
    assert.match(check.detail, /heartbeat/i)

    assert.equal(doctor.stateLock.held, true)
    assert.equal(doctor.stateLock.pid, process.pid)
    assert.equal(doctor.stateLock.alive, true)
    assert.equal(doctor.stateLock.stale, true)
    assert.ok(doctor.stateLock.heartbeatAgeMs >= 9000)
    assert.ok(doctor.stateLock.ageMs >= 50000)
    assert.ok(doctor.stateLock.staleAfterMs > 0)

    // A fresh heartbeat is reported as held, not stale.
    fs.writeFileSync(
      tower.paths.lock,
      JSON.stringify({ token: 'fresh', pid: process.pid, since: Date.now(), at: Date.now() }),
    )
    const fresh = await call(tools, 'tower_doctor', { repoRoot: repo })
    assert.equal(fresh.stateLock.stale, false)
    assert.match(fresh.checks.find((entry) => entry.id === 'state-lock').detail, /held by pid/i)
  } finally {
    removeTemp(root)
  }
})
