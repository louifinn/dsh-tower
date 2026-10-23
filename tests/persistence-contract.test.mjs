// One persistence contract for state.json and modes.json (#56 P2b).
//
// Each case is exercised through both public surfaces (adapters/store.js and
// host/modeStore.js) so the shared adapters/persistence.js primitives cannot drift
// back into two implementations. Temp dirs only; no live profile is touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'

import { readLock, readLockSync, releaseLock, releaseLockSync } from '../adapters/persistence.js'
import { pathsFor, readStateLock, withLock, writeJsonAtomic } from '../adapters/store.js'
import { loadModes, saveModes, storePath } from '../host/modeStore.js'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Existing lock tests use the same sentinel; init cannot reuse a live PID.
const DEAD_PID = 999999

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** A repo-shaped state store with its lock directory already created. */
function statePaths(root) {
  const paths = pathsFor(path.join(root, '.git'))
  fs.mkdirSync(paths.dir, { recursive: true })
  return paths
}

function writeLock(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(record))
}

function readText(file) {
  return fs.readFileSync(file, 'utf8')
}

function tempRemnants(dir, basename) {
  return fs.readdirSync(dir).filter((name) => name.startsWith(`.${basename}.tmp-`))
}

function quarantineRemnants(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes('.stale-'))
}

test('state.json and modes.json both reclaim a lock whose PID is dead', async () => {
  const root = tempDir('dsh-tower-p2b-dead-')
  const modesDir = path.join(root, 'modes')
  try {
    const paths = statePaths(root)
    writeLock(paths.lock, { token: 'dead-state', pid: DEAD_PID, at: 1 })
    assert.equal((await readStateLock(paths)).alive, false)
    assert.equal((await readLock(paths.lock)).alive, false)
    assert.equal(await withLock(paths, async () => 'state-ok'), 'state-ok')
    assert.equal(fs.existsSync(paths.lock), false)
    assert.deepEqual(quarantineRemnants(paths.dir), [])

    writeLock(path.join(modesDir, 'modes.lock'), { token: 'dead-modes', pid: DEAD_PID, at: 1 })
    assert.equal(readLockSync(path.join(modesDir, 'modes.lock')).alive, false)
    assert.equal(saveModes(new Map([['session-a', { on: true, at: 1 }]]), modesDir), true)
    assert.equal(fs.existsSync(path.join(modesDir, 'modes.lock')), false)
    assert.deepEqual(quarantineRemnants(modesDir), [])
    assert.equal(loadModes(modesDir).has('session-a'), true)
  } finally {
    removeTemp(root)
  }
})

test('a foreign live lock is reported, never deleted, for state.json and modes.json', async () => {
  const root = tempDir('dsh-tower-p2b-foreign-')
  const modesDir = path.join(root, 'modes')
  try {
    const paths = statePaths(root)
    const foreignState = JSON.stringify({ token: 'foreign-state', pid: process.pid, at: Date.now() })
    fs.writeFileSync(paths.lock, foreignState)
    await assert.rejects(
      () => withLock(paths, async () => 'never', { timeoutMs: 40, pollMs: 10 }),
      (error) => error?.code === 'state-locked',
    )
    assert.equal(readText(paths.lock), foreignState)
    // Token-checked release must also refuse to remove a lock it does not own.
    assert.equal(await releaseLock(paths.lock, 'not-the-owner'), false)
    assert.equal(releaseLockSync(paths.lock, 'not-the-owner'), false)
    assert.equal(readText(paths.lock), foreignState)

    const modesLock = path.join(modesDir, 'modes.lock')
    const foreignModes = JSON.stringify({ token: 'foreign-modes', pid: process.pid, at: Date.now() })
    writeLock(modesLock, JSON.parse(foreignModes))
    assert.equal(saveModes(new Map([['session-a', { on: true, at: 1 }]]), modesDir, 200, { timeoutMs: 40 }), false)
    assert.equal(readText(modesLock), foreignModes)
    assert.equal(releaseLockSync(modesLock, 'not-the-owner'), false)
    assert.equal(readText(modesLock), foreignModes)
  } finally {
    removeTemp(root)
  }
})

test('both stores wait for a bounded time before reporting a live holder', async () => {
  const root = tempDir('dsh-tower-p2b-timeout-')
  const modesDir = path.join(root, 'modes')
  try {
    const paths = statePaths(root)
    fs.writeFileSync(paths.lock, JSON.stringify({ token: 'live-state', pid: process.pid, at: Date.now() }))
    const stateStarted = Date.now()
    await assert.rejects(
      () => withLock(paths, async () => 'never', { timeoutMs: 60, pollMs: 10 }),
      /locked by another writer/,
    )
    const stateWaited = Date.now() - stateStarted
    assert.ok(stateWaited >= 50, `state lock wait must be bounded, not instant (waited ${stateWaited}ms)`)
    assert.ok(stateWaited < 2000, `state lock wait must not exceed its bound (waited ${stateWaited}ms)`)
    assert.equal(JSON.parse(readText(paths.lock)).token, 'live-state')

    const modesLock = path.join(modesDir, 'modes.lock')
    writeLock(modesLock, { token: 'live-modes', pid: process.pid, at: Date.now() })
    const modesStarted = Date.now()
    assert.equal(saveModes(new Map([['session-a', { on: true, at: 1 }]]), modesDir, 200, { timeoutMs: 60 }), false)
    const modesWaited = Date.now() - modesStarted
    assert.ok(modesWaited >= 50, `mode lock wait must be bounded, not instant (waited ${modesWaited}ms)`)
    assert.ok(modesWaited < 2000, `mode lock wait must not exceed its bound (waited ${modesWaited}ms)`)
    assert.equal(JSON.parse(readText(modesLock)).token, 'live-modes')
  } finally {
    removeTemp(root)
  }
})

test('state.json and modes.json both replace their document atomically', async () => {
  const root = tempDir('dsh-tower-p2b-atomic-')
  const modesDir = path.join(root, 'modes')
  try {
    const paths = statePaths(root)

    // Whole-document replacement: the second write is complete, not a patch.
    await writeJsonAtomic(paths.state, { version: 1, value: 'first' })
    assert.deepEqual(JSON.parse(readText(paths.state)), { version: 1, value: 'first' })
    await writeJsonAtomic(paths.state, { version: 1, value: 'second' })
    assert.deepEqual(JSON.parse(readText(paths.state)), { version: 1, value: 'second' })
    assert.deepEqual(tempRemnants(paths.dir, 'state.json'), [])

    assert.equal(saveModes(new Map([['session-a', { on: true, at: 1 }]]), modesDir), true)
    const modesFirst = readText(storePath(modesDir))
    assert.equal(saveModes(new Map([['session-b', { on: true, at: 2 }]]), modesDir), true)
    const modesSecond = readText(storePath(modesDir))
    assert.notEqual(modesSecond, modesFirst)
    assert.deepEqual(Object.keys(JSON.parse(modesSecond).modes).sort(), ['session-a', 'session-b'])
    assert.deepEqual(tempRemnants(modesDir, 'modes.json'), [])

    // A value that cannot be serialised must never touch the live document.
    const circular = {}
    circular.self = circular
    const stateBefore = readText(paths.state)
    await assert.rejects(() => writeJsonAtomic(paths.state, circular))
    assert.equal(readText(paths.state), stateBefore)

    const modesBefore = readText(storePath(modesDir))
    assert.equal(saveModes(new Map([['broken', circular]]), modesDir), false)
    assert.equal(readText(storePath(modesDir)), modesBefore)
  } finally {
    removeTemp(root)
  }
})

test('concurrent mode saves merge by timestamp without losing updates', async () => {
  const root = tempDir('dsh-tower-p2b-merge-')
  const modesDir = path.join(root, 'modes')
  try {
    assert.equal(saveModes(new Map([['baseline', { on: true, at: 1000 }]]), modesDir), true)

    // Separate processes contend for modes.lock; each writes one new key. The
    // merge-under-lock must retain every child's key plus the baseline.
    const storeUrl = pathToFileURL(path.join(ROOT, 'host', 'modeStore.js')).href
    const children = Array.from({ length: 4 }, (_, index) => {
      const key = `worker-${index}`
      const script = [
        `import { saveModes } from ${JSON.stringify(storeUrl)}`,
        `const ok = saveModes(new Map([[${JSON.stringify(key)}, { on: true, at: ${2000 + index} }]]), ${JSON.stringify(modesDir)})`,
        'process.exit(ok ? 0 : 2)',
      ].join('\n')
      return execFileAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT })
    })
    await Promise.all(children)

    const modes = loadModes(modesDir)
    for (const key of ['baseline', 'worker-0', 'worker-1', 'worker-2', 'worker-3']) {
      assert.ok(modes.has(key), `concurrent merge lost ${key}: ${[...modes.keys()].join(', ')}`)
    }

    // Per-key timestamp ordering still wins over a stale in-memory record.
    // Read the raw document: loadModes() intentionally returns only active
    // (on:true) entries, so an older on:true record is what must survive.
    assert.equal(saveModes(new Map([['baseline', { on: false, at: 500 }]]), modesDir), true)
    assert.equal(JSON.parse(readText(storePath(modesDir))).modes.baseline.on, true)
    assert.equal(saveModes(new Map([['baseline', { on: false, at: 5000 }]]), modesDir), true)
    assert.equal(JSON.parse(readText(storePath(modesDir))).modes.baseline.on, false)
  } finally {
    removeTemp(root)
  }
})
