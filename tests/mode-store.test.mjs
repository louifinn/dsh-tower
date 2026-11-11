// #167: the mode store distinguishes a first run (missing) from unreadable
// bytes (corrupt), reports why a save failed, and never turns a failed save into
// a successful `/tower off`.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { loadModes, loadModesDetailed, saveModes, saveModesDetailed, storePath } from '../host/modeStore.js'

// index.js resolves the default store through $DSH_HOME; isolate it before the
// dynamic import so the command test can never write the real mode store.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-mode-home-'))
process.env.DSH_HOME = home
const { apply } = await import('../index.js')

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeStore(baseDir, payload) {
  fs.mkdirSync(path.dirname(storePath(baseDir)), { recursive: true })
  fs.writeFileSync(storePath(baseDir), typeof payload === 'string' ? payload : JSON.stringify(payload))
}

test('mode store: a missing store is missing, not corrupt', () => {
  const root = tempDir('dsh-tower-mode-missing-')
  try {
    const baseDir = path.join(root, 'store')
    const detailed = loadModesDetailed(baseDir)
    assert.equal(detailed.status, 'missing')
    assert.equal(detailed.modes.size, 0)
    assert.equal(detailed.file, storePath(baseDir))
    assert.equal(detailed.error, undefined)
    assert.equal(loadModes(baseDir).size, 0)
  } finally {
    removeTemp(root)
  }
})

test('mode store: an unparsable or shapeless document is corrupt and not loaded', () => {
  const root = tempDir('dsh-tower-mode-corrupt-')
  try {
    const first = path.join(root, 'bad-json')
    writeStore(first, 'not json at all')
    const badJson = loadModesDetailed(first)
    assert.equal(badJson.status, 'corrupt')
    assert.equal(badJson.modes.size, 0)
    assert.match(badJson.error, /corrupt tower state|JSON|not json/i)
    assert.equal(loadModes(first).size, 0)

    const shapeless = path.join(root, 'shapeless')
    writeStore(shapeless, { version: 1 })
    const badShape = loadModesDetailed(shapeless)
    assert.equal(badShape.status, 'corrupt')
    assert.equal(badShape.modes.size, 0)
    assert.match(badShape.error, /expected/)
  } finally {
    removeTemp(root)
  }
})

test('mode store: a valid document loads only active entries and preserves lock tokens', () => {
  const root = tempDir('dsh-tower-mode-ok-')
  try {
    const baseDir = path.join(root, 'store')
    writeStore(baseDir, {
      version: 1,
      modes: {
        a: { on: true, at: 10, pausedGoal: { id: 'G1' }, lastDisclosure: 'full' },
        b: { on: false, at: 20 },
        c: {
          on: true,
          at: 30,
          lock: { token: 'tok-c', commonDir: '/repo/.git' },
          baseBranch: 'main',
          lastChange: { by: 'user', action: 'on', at: 30 },
        },
      },
    })
    const detailed = loadModesDetailed(baseDir)
    assert.equal(detailed.status, 'ok')
    assert.deepEqual([...detailed.modes.keys()].sort(), ['a', 'c'])
    assert.equal(detailed.modes.get('a').pausedGoal.id, 'G1')
    assert.equal(detailed.modes.get('c').lock.token, 'tok-c')
    assert.equal(detailed.modes.get('c').baseBranch, 'main')
    assert.equal(detailed.modes.get('c').lastChange.by, 'user')
    assert.equal(loadModes(baseDir).size, 2)
  } finally {
    removeTemp(root)
  }
})

test('mode store: save reports success, merges by timestamp, and returns a boolean via saveModes', () => {
  const root = tempDir('dsh-tower-mode-save-')
  try {
    const baseDir = path.join(root, 'store')
    writeStore(baseDir, { version: 1, modes: { old: { on: true, at: 200 } } })
    const modes = new Map([
      ['old', { on: true, at: 100 }],
      ['fresh', { on: true, at: 300 }],
    ])
    const result = saveModesDetailed(modes, baseDir)
    assert.equal(result.ok, true)
    const disk = JSON.parse(fs.readFileSync(storePath(baseDir), 'utf8'))
    assert.equal(disk.version, 1)
    assert.equal(disk.modes.old.at, 200, 'a newer on-disk entry must win')
    assert.equal(disk.modes.fresh.at, 300)
    assert.equal(saveModes(modes, baseDir), true)
  } finally {
    removeTemp(root)
  }
})

test('mode store: save failures are explicit and a corrupt store is not overwritten', () => {
  const root = tempDir('dsh-tower-mode-fail-')
  try {
    const blocker = path.join(root, 'blocker')
    fs.writeFileSync(blocker, 'not a directory')
    const unusable = saveModesDetailed(new Map(), path.join(blocker, 'store'))
    assert.equal(unusable.ok, false)
    assert.match(unusable.error, /cannot create|mode store/)
    assert.equal(saveModes(new Map(), path.join(blocker, 'store')), false)

    const corruptDir = path.join(root, 'corrupt')
    writeStore(corruptDir, 'not json at all')
    const refused = saveModesDetailed(new Map([['a', { on: true, at: 1 }]]), corruptDir)
    assert.equal(refused.ok, false)
    assert.match(refused.error, /cannot read the mode store|corrupt/i)
    assert.equal(fs.readFileSync(storePath(corruptDir), 'utf8'), 'not json at all', 'the corrupt bytes are preserved')
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
  return { ctx, tools, commands, disposeAll: () => effects.forEach((dispose) => dispose()) }
}

test('/tower off reports an error when the mode store cannot be saved', async () => {
  const root = tempDir('dsh-tower-mode-off-')
  const harness = makeModeCtx()
  try {
    const storeDir = path.join(root, 'store')
    fs.mkdirSync(storeDir, { recursive: true })
    // A live lock in the mode store makes every save time out quickly; the
    // command must report that, not "Tower mode OFF" success.
    fs.writeFileSync(
      path.join(storeDir, 'modes.lock'),
      JSON.stringify({ token: 'held-by-test', pid: process.pid, at: Date.now(), since: Date.now() }),
    )
    apply(harness.ctx, { mode: { storePath: storeDir, lockTimeoutMs: 50 } })
    const command = harness.commands.get('tower')
    const agent = { id: 'session-mode-off' }
    const run = (rawInput) => command.handler({ agent, rawInput, attachments: [] })

    const on = await run('')
    assert.equal(on.kind, 'error', 'the entry change could not be persisted')
    assert.match(on.text, /could not be persisted|timed out/i)

    const off = await run('off')
    assert.equal(off.kind, 'error', '/tower off must not report success')
    // F33: the failed save rolls the tombstone back, so the session is still
    // on and the text must not claim "Tower mode OFF".
    assert.doesNotMatch(off.text, /Tower mode OFF/)
    assert.match(off.text, /Tower mode remains ON/)
    assert.match(off.text, /\[tower:mode-persist-failed\]/)
    assert.match(off.text, /could not be saved|timed out/i)
    assert.equal(fs.existsSync(path.join(storeDir, 'modes.json')), false, 'no mode document was written')
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(storeDir, 'modes.lock'), 'utf8')).token,
      'held-by-test',
      'the foreign lock must not be removed',
    )
  } finally {
    harness.disposeAll()
    removeTemp(root)
  }
})
