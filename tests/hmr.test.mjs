// Tests for the Tower → DSH HMR bridge and the `enable-dev-hmr` CLI.
//
// The bridge only needs `ctx.get('hmr')`, so every case runs against a fake
// service: no DSH runtime, no profile and no live session is touched. The CLI
// cases run in a temporary $DSH_HOME and assert the marked block is written,
// replaced (idempotent) and removed without disturbing other lines.
//
// Run: node --test tests/hmr.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_DELAY_MS,
  DEFAULT_REQUIRED_IDS,
  createHmrBridge,
} from '../lib/hmr.js'
import { TowerToolError } from '../domain/errors.js'
import {
  MARKER,
  findBlock,
  removeBlock,
  renderBlock,
  upsertBlock,
} from '../scripts/enable-dev-hmr.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'enable-dev-hmr.mjs')

function fakeCtx(hmr) {
  return {
    get(name) {
      return name === 'hmr' ? hmr : undefined
    },
  }
}

function fakeHmr(overrides = {}) {
  const calls = { exclusive: 0, reconcile: [] }
  const hmr = {
    runExclusive(operation) {
      calls.exclusive += 1
      return Promise.resolve().then(operation)
    },
    async reconcileProfile(ids) {
      calls.reconcile.push([...ids])
      return { warnings: [], pending: [] }
    },
    ...overrides,
  }
  return { hmr, calls }
}

function runScript(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
}

function makeTempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-hmr-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeProfile(home, profile, patch) {
  const profileDir = path.join(home, 'profiles', profile)
  fs.mkdirSync(profileDir, { recursive: true })
  const file = path.join(profileDir, 'cordis.patch.yml')
  if (patch !== undefined) fs.writeFileSync(file, patch)
  return file
}

test('available and status track the live hmr service', () => {
  let service
  const bridge = createHmrBridge({
    get(name) {
      return name === 'hmr' ? service : undefined
    },
  })

  assert.equal(bridge.available, false, 'no service yet')
  assert.deepEqual(bridge.requiredIds, [...DEFAULT_REQUIRED_IDS])
  assert.equal(bridge.delayMs, DEFAULT_DELAY_MS)
  assert.deepEqual(bridge.status(), {
    available: false,
    requiredIds: [...DEFAULT_REQUIRED_IDS],
    delayMs: DEFAULT_DELAY_MS,
    scheduled: false,
    lastRunAt: null,
    lastError: null,
  })

  service = fakeHmr().hmr
  assert.equal(bridge.available, true, 'availability is read on every access')
  assert.equal(bridge.status().available, true)

  // A half-installed or disposed service is not usable.
  const exclusiveOnly = createHmrBridge(fakeCtx({ runExclusive() {} }))
  assert.equal(exclusiveOnly.available, false)
  const reconcileOnly = createHmrBridge(fakeCtx({ reconcileProfile() {} }))
  assert.equal(reconcileOnly.available, false)
  assert.equal(createHmrBridge({}).available, false)
})

test('runNow passes the required ids and runs inside runExclusive', async () => {
  let insideTransaction = false
  let seenIds = null
  const hmr = {
    runExclusive(operation) {
      assert.equal(insideTransaction, false, 'runExclusive must open the transaction first')
      insideTransaction = true
      return Promise.resolve().then(operation).finally(() => {
        insideTransaction = false
      })
    },
    async reconcileProfile(ids) {
      assert.equal(insideTransaction, true, 'reconcileProfile must run inside runExclusive')
      seenIds = [...ids]
      return { warnings: [], pending: [{ url: 'file:///lib/x.js', reason: 'unmanaged-plugin' }] }
    },
  }
  const bridge = createHmrBridge(fakeCtx(hmr))
  const result = await bridge.runNow()

  assert.deepEqual(seenIds, [...DEFAULT_REQUIRED_IDS])
  assert.deepEqual(result, { warnings: [], pending: [{ url: 'file:///lib/x.js', reason: 'unmanaged-plugin' }] })
  const status = bridge.status()
  assert.equal(typeof status.lastRunAt, 'number')
  assert.equal(status.lastError, null)
})

test('requiredIds and delayMs options are normalised', async () => {
  const { hmr, calls } = fakeHmr()
  const bridge = createHmrBridge(fakeCtx(hmr), {
    requiredIds: [' tower ', 'tower', '', 42, 'tower-skills'],
    delayMs: 25,
  })
  assert.deepEqual(bridge.requiredIds, ['tower', 'tower-skills'])
  assert.equal(bridge.delayMs, 25)

  await bridge.runNow()
  assert.deepEqual(calls.reconcile, [['tower', 'tower-skills']])

  // An explicit empty list is honoured; malformed values fall back.
  const empty = createHmrBridge(fakeCtx(hmr), { requiredIds: [] })
  assert.deepEqual(empty.requiredIds, [])
  const invalid = createHmrBridge(fakeCtx(hmr), { requiredIds: 'tower', delayMs: -5 })
  assert.deepEqual(invalid.requiredIds, [...DEFAULT_REQUIRED_IDS])
  assert.equal(invalid.delayMs, DEFAULT_DELAY_MS)
})

test('a missing service rejects runNow with reload-unavailable', async () => {
  const bridge = createHmrBridge(fakeCtx(undefined))
  await assert.rejects(bridge.runNow(), (error) => {
    assert.ok(error instanceof TowerToolError)
    assert.equal(error.code, 'reload-unavailable')
    assert.match(error.message, /^\[tower:reload-unavailable\]/)
    assert.match(error.message, /restart DSH/i)
    return true
  })
  assert.match(String(bridge.status().lastError), /unavailable/i)
})

test('a failing reconciliation rejects runNow with reload-failed and keeps the cause', async () => {
  const hmr = {
    runExclusive: (operation) => Promise.resolve().then(operation),
    async reconcileProfile() {
      throw new Error('entry preset-tower-worker is inactive')
    },
  }
  const bridge = createHmrBridge(fakeCtx(hmr))
  await assert.rejects(bridge.runNow(), (error) => {
    assert.ok(error instanceof TowerToolError)
    assert.equal(error.code, 'reload-failed')
    assert.match(error.message, /^\[tower:reload-failed\]/)
    assert.match(error.message, /entry preset-tower-worker is inactive/)
    assert.match(error.message, /restart DSH/i)
    assert.match(String(error.cause?.message), /entry preset-tower-worker is inactive/)
    return true
  })
  const status = bridge.status()
  assert.equal(status.lastRunAt, null, 'a failed run does not count as a successful run')
  assert.match(String(status.lastError), /inactive/)
})

test('schedule returns immediately and reconciles after delayMs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { hmr, calls } = fakeHmr()
  const bridge = createHmrBridge(fakeCtx(hmr), {
    requiredIds: ['tower', 'tower-skills'],
    delayMs: 25,
  })

  const outcome = bridge.schedule()
  assert.deepEqual(outcome, { scheduled: true, delayMs: 25, requiredIds: ['tower', 'tower-skills'] })
  assert.equal(bridge.status().scheduled, true)
  assert.equal(calls.reconcile.length, 0, 'nothing runs before the delay')

  t.mock.timers.tick(25)
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(calls.reconcile, [['tower', 'tower-skills']])
  const status = bridge.status()
  assert.equal(status.scheduled, false, 'the timer is cleared after firing')
  assert.equal(typeof status.lastRunAt, 'number')
  assert.equal(status.lastError, null)
})

test('a second schedule replaces the pending timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { hmr, calls } = fakeHmr()
  const bridge = createHmrBridge(fakeCtx(hmr), { delayMs: 10 })

  bridge.schedule()
  t.mock.timers.tick(5)
  bridge.schedule()
  t.mock.timers.tick(10)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(calls.reconcile.length, 1, 'a burst of changes coalesces into one reconciliation')
  assert.equal(bridge.status().scheduled, false)
})

test('a failing scheduled reload is recorded, not an unhandled rejection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))

  const logged = []
  const hmr = {
    runExclusive: (operation) => Promise.resolve().then(operation),
    async reconcileProfile() {
      throw new Error('reload blew up')
    },
  }
  const bridge = createHmrBridge(fakeCtx(hmr), {
    delayMs: 10,
    logger: {
      warn(message) {
        logged.push(String(message))
      },
    },
  })
  bridge.schedule()
  t.mock.timers.tick(10)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const status = bridge.status()
  assert.equal(status.scheduled, false)
  assert.equal(status.lastRunAt, null)
  assert.match(String(status.lastError), /reload blew up/)
  assert.deepEqual(unhandled, [], 'schedule() must swallow its rejection')
  assert.equal(logged.length, 1)
  assert.match(logged[0], /reload blew up/)
  assert.match(logged[0], /scheduled HMR reload failed/)
})

// --- enable-dev-hmr CLI -----------------------------------------------------

test('the managed block is rendered exactly', () => {
  assert.equal(
    renderBlock('D:/work/dsh-tower'),
    [
      '# dsh-tower:dev-hmr',
      '- id: hmr',
      '  config:',
      '    root:',
      "      - 'D:/work/dsh-tower'",
    ].join('\n'),
  )
  assert.equal(MARKER, '# dsh-tower:dev-hmr')
  // YAML single-quote escaping for an unusual checkout path.
  assert.match(renderBlock("D:/work/o'brien"), /- 'D:\/work\/o''brien'/)
})

test('upsertBlock appends, replaces in place and removeBlock restores the file', () => {
  const root = 'D:/work/dsh-tower'
  const original = '# keep this layer\n- id: locale\n  config:\n    preference: en\n'
  const once = upsertBlock(original, root)

  assert.ok(once.startsWith(original), 'the existing lines are preserved verbatim')
  assert.ok(once.includes(renderBlock(root)))
  assert.equal(once.endsWith('\n'), true)

  assert.equal(upsertBlock(once, root), once, 're-running the same root is a no-op')

  const moved = upsertBlock(once, 'D:/work/other')
  assert.equal(moved.match(/# dsh-tower:dev-hmr/g).length, 1, 'exactly one managed block')
  assert.ok(moved.includes("      - 'D:/work/other'"))
  assert.equal(moved.includes("      - 'D:/work/dsh-tower'"), false, 'the old root is replaced')

  assert.equal(removeBlock(moved), original, 'remove undoes the append')

  const found = findBlock(once.split('\n'))
  assert.ok(found, 'the block is found in the written file')
  assert.equal(once.split('\n')[found.start], MARKER)
  assert.equal(findBlock(['- id: locale']), null)

  // A hand-edited duplicate block collapses back to one on the next write.
  const duplicated = `${once}\n${renderBlock('D:/work/duplicate')}`
  const deduped = upsertBlock(duplicated, root)
  assert.equal(deduped.match(/# dsh-tower:dev-hmr/g).length, 1)
  assert.equal(deduped.includes('duplicate'), false)
})

test('editing keeps CRLF endings, comments and unrelated blank lines intact', () => {
  const root = 'D:/work/dsh-tower'

  const crlf = '# a\r\n\r\n\r\n# b\r\n- id: locale\r\n'
  const written = upsertBlock(crlf, root)
  assert.ok(written.includes("      - 'D:/work/dsh-tower'\r\n"), 'appended lines use the file EOL')
  assert.equal(removeBlock(written), crlf, 'remove restores a CRLF file byte for byte')

  const spaced = '# top\n\n\n- id: locale\n'
  const appended = upsertBlock(spaced, root)
  assert.equal(removeBlock(appended), spaced, 'blank lines outside the block are preserved')

  // A hand-written comment right after the block belongs to the user, not the block.
  const commented = `- id: locale\n${renderBlock(root)}\n# keep this comment\n- id: other\n  config:\n    x: 1\n`
  const removed = removeBlock(commented)
  assert.doesNotMatch(removed, /dsh-tower:dev-hmr/)
  assert.match(removed, /# keep this comment/)
  assert.match(removed, /- id: other/)
  // ...and re-writing the block keeps the comment and adds exactly one block.
  const rewritten = upsertBlock(removed, root)
  assert.match(rewritten, /# keep this comment/)
  assert.equal(rewritten.match(/# dsh-tower:dev-hmr/g).length, 1)
})

test('CLI writes, is idempotent and removes the block in an isolated profile', (t) => {
  const home = makeTempHome(t)
  const root = makeTempHome(t)
  const original = '# user layer\n- id: locale\n  config:\n    preference: en\n'
  const patch = makeProfile(home, 'devhmr', original)
  const args = ['--profile', 'devhmr', '--root', root]

  const first = runScript(args, { DSH_HOME: home })
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /Wrote the dsh-tower dev-hmr block/)
  assert.match(first.stdout, /Restart DSH once/)
  assert.match(first.stdout, /absolute paths/)

  const written = fs.readFileSync(patch, 'utf8')
  const expectedRoot = fs.realpathSync(root).replaceAll('\\', '/')
  assert.ok(written.startsWith(original), 'unrelated lines are preserved')
  assert.ok(written.includes(`      - '${expectedRoot}'`), 'the absolute root is written with forward slashes')

  const second = runScript(args, { DSH_HOME: home })
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /already up to date/)
  assert.equal(fs.readFileSync(patch, 'utf8'), written, 'a second run changes nothing')

  const removed = runScript([...args, '--remove'], { DSH_HOME: home })
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(fs.readFileSync(patch, 'utf8'), original, 'remove restores the original patch file')
})

test('CLI --dry-run prints a diff and writes nothing', (t) => {
  const home = makeTempHome(t)
  const root = makeTempHome(t)
  const original = '- id: locale\n  config:\n    preference: en\n'
  const patch = makeProfile(home, 'dry', original)

  const dry = runScript(['--profile', 'dry', '--root', root, '--dry-run'], { DSH_HOME: home })
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /^--- /m)
  assert.match(dry.stdout, /^\+# dsh-tower:dev-hmr$/m)
  assert.match(dry.stdout, /Dry run: no file written/)
  assert.equal(fs.readFileSync(patch, 'utf8'), original, 'dry-run must not write')

  // Removing a block that does not exist is a no-op, not an error.
  const noop = runScript(['--profile', 'dry', '--remove'], { DSH_HOME: home })
  assert.equal(noop.status, 0)
  assert.match(noop.stdout, /nothing to remove/)
  assert.equal(fs.readFileSync(patch, 'utf8'), original)
})

test('CLI refuses to create a missing profile and rejects bad arguments', (t) => {
  const home = makeTempHome(t)

  const missing = runScript(['--profile', 'nope'], { DSH_HOME: home })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /does not exist/)
  assert.match(missing.stderr, /never creates a profile/)
  assert.equal(fs.existsSync(path.join(home, 'profiles', 'nope')), false)

  makeProfile(home, 'devhmr')
  const badRoot = runScript(['--profile', 'devhmr', '--root', path.join(home, 'missing-root')], { DSH_HOME: home })
  assert.equal(badRoot.status, 1)
  assert.match(badRoot.stderr, /existing directory/)

  const unknown = runScript(['--profile', 'devhmr', '--bogus'], { DSH_HOME: home })
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unknown argument/)

  const badProfile = runScript(['--profile', '../escape'], { DSH_HOME: home })
  assert.equal(badProfile.status, 1)
  assert.match(badProfile.stderr, /invalid profile name/)
})
