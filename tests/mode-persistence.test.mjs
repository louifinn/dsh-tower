// F33 regression: a failed mode-store save must never be reported as a
// successful `/tower off` and must never release the workspace lock. The mode
// change is rolled back in memory so the session keeps the mode the disk still
// records, and the failure is a stable actionable `mode-persist-failed` error.
// Run with: node --test tests/mode-persistence.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { removeTemp } from './helpers/cleanup.mjs'

// index.js resolves its mode store through $DSH_HOME unless mode.storePath is
// set; isolate it before the dynamic import so a test never writes the real
// store.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-mode-persist-home-'))
process.env.DSH_HOME = home
const { apply } = await import('../index.js')
const { workspaceLockPath } = await import('../adapters/workspaceLock.js')

test.after(() => removeTemp(home))

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

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

/**
 * A real repository with Tower initialized and the advisory workspace lock
 * acquired through the lazy `tower_status` path, so exitMode has a lock to
 * keep or release.
 */
async function setup(id) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-mode-persist-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])

  const harness = makeModeCtx()
  const storeDir = path.join(root, 'mode-store')
  apply(harness.ctx, { mode: { workspaceLock: true, storePath: storeDir } })
  const agent = { id }
  const command = harness.commands.get('tower')
  assert.ok(command, 'the /tower command must be registered')
  const call = (name, args) => harness.tools.get(name).execute(args, { agent, signal: undefined })
  const run = (rawInput) => command.handler({ agent, rawInput, attachments: [] })

  assert.match((await run('')).text, /Tower mode ON/)
  await call('tower_init', { repoRoot: repo })
  await call('tower_inspect', { view: 'status', repoRoot: repo })

  const lockFile = workspaceLockPath(path.join(repo, '.git'))
  const storeFile = path.join(storeDir, 'modes.json')
  assert.ok(fs.existsSync(lockFile), 'tower_status must acquire the workspace lock')
  assert.ok(fs.existsSync(storeFile), 'the lock must be persisted with the mode')

  return { root, repo, harness, agent, call, run, lockFile, storeFile, dispose: harness.disposeAll }
}

/** The persisted document still says on and carries the workspace lock token. */
function assertPersistedOn(t, lockBefore) {
  const store = JSON.parse(fs.readFileSync(t.storeFile, 'utf8'))
  assert.equal(store.modes[t.agent.id].on, true)
  assert.equal(store.modes[t.agent.id].lock.token, lockBefore.token)
}

test('/tower off: a failed mode-store save keeps the mode and the workspace lock (F33)', async () => {
  const t = await setup('session-off-failure')
  try {
    const lockBefore = JSON.parse(fs.readFileSync(t.lockFile, 'utf8'))
    const storeBefore = fs.readFileSync(t.storeFile, 'utf8')
    assertPersistedOn(t, lockBefore)

    // A corrupt store is never overwritten (host/modeStore.js contract), so
    // the next save fails at its read step deterministically.
    fs.writeFileSync(t.storeFile, 'not json at all')
    const off = await t.run('off')

    assert.equal(off.kind, 'error', '/tower off must report the failure, not success')
    assert.match(off.text, /\[tower:mode-persist-failed\]/)
    assert.match(off.text, /Tower mode remains ON/)
    assert.doesNotMatch(off.text, /Tower mode OFF/)
    assert.match(off.text, /— next: /, 'the failure carries the recovery action')

    assert.equal((await t.call('tower_mode')).mode, 'on', 'the in-memory mode is restored, not left off')
    assert.equal(fs.readFileSync(t.storeFile, 'utf8'), 'not json at all', 'the corrupt bytes are untouched')

    const lockAfter = JSON.parse(fs.readFileSync(t.lockFile, 'utf8'))
    assert.equal(lockAfter.token, lockBefore.token, 'a failed /tower off must not release the workspace lock')
    assert.equal((await t.call('tower_mode')).workspaceLock.held, true)

    // Restoring the last good store makes the retry persist the off tombstone
    // and release the lock with the token that was kept in memory.
    fs.writeFileSync(t.storeFile, storeBefore)
    const retry = await t.run('off')
    assert.equal(retry.kind, 'success')
    assert.match(retry.text, /Tower mode OFF/)
    assert.equal((await t.call('tower_mode')).mode, 'off')
    assert.equal(fs.existsSync(t.lockFile), false, 'the successful retry releases the lock')
    const after = JSON.parse(fs.readFileSync(t.storeFile, 'utf8'))
    assert.equal(after.modes[t.agent.id].on, false, 'the retry persists the off tombstone')
  } finally {
    t.dispose()
    removeTemp(t.root)
  }
})

test('/tower off: a successful save releases the lock and writes the off tombstone', async () => {
  const t = await setup('session-off-success')
  try {
    const lockBefore = JSON.parse(fs.readFileSync(t.lockFile, 'utf8'))
    const off = await t.run('off')
    assert.equal(off.kind, 'success')
    assert.match(off.text, /Tower mode OFF/)
    assert.equal((await t.call('tower_mode')).mode, 'off')
    assert.equal(fs.existsSync(t.lockFile), false, 'a persisted off releases the workspace lock')

    const store = JSON.parse(fs.readFileSync(t.storeFile, 'utf8'))
    assert.equal(store.modes[t.agent.id].on, false)
    assert.equal(store.modes[t.agent.id].lock, undefined, 'the off tombstone does not retain the released lock')
    assert.notEqual(store.modes[t.agent.id].at, lockBefore.at)
  } finally {
    t.dispose()
    removeTemp(t.root)
  }
})

test('tower_mode exit: a failed save returns persisted:false with mode-persist-failed and keeps the lock', async () => {
  const t = await setup('session-control-failure')
  try {
    const lockBefore = JSON.parse(fs.readFileSync(t.lockFile, 'utf8'))
    const storeBefore = fs.readFileSync(t.storeFile, 'utf8')
    fs.writeFileSync(t.storeFile, 'not json at all')

    const failed = await t.call('tower_mode', { active: false, reason: 'task is done' })
    assert.equal(failed.ok, false)
    assert.equal(failed.persisted, false)
    assert.equal(failed.changed, false, 'a rolled-back off is not a change')
    assert.equal(failed.mode, 'on', 'the tool reports the mode actually in force')
    assert.equal(failed.errorCode, 'mode-persist-failed')
    assert.match(failed.error, /\[tower:mode-persist-failed\]/)
    assert.match(failed.error, /— next: /)
    assert.equal((await t.call('tower_mode')).mode, 'on')
    assert.equal(JSON.parse(fs.readFileSync(t.lockFile, 'utf8')).token, lockBefore.token)

    // Repair the store and retry through the model path.
    fs.writeFileSync(t.storeFile, storeBefore)
    const retry = await t.call('tower_mode', { active: false, reason: 'task is done, retry' })
    assert.equal(retry.ok, true)
    assert.equal(retry.persisted, true)
    assert.equal(retry.mode, 'off')
    assert.equal(fs.existsSync(t.lockFile), false)
    assert.equal(JSON.parse(fs.readFileSync(t.storeFile, 'utf8')).modes[t.agent.id].on, false)
  } finally {
    t.dispose()
    removeTemp(t.root)
  }
})
