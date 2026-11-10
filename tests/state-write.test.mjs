// #167: state.json is written only by the process that holds the state lock.
// A direct call, a stale token, or a token from a different paths object is
// refused, so a reader or a late writer cannot overwrite a concurrent writer's
// document. The migration path must use the same token.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import {
  isStateLockHeld,
  pathsFor,
  stateLockToken,
  withLock,
  writeStateLocked,
} from '../adapters/store.js'
import { loadStateFile } from '../adapters/stateFile.js'

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-state-write-'))
  const paths = pathsFor(path.join(root, '.git'))
  fs.mkdirSync(paths.dir, { recursive: true })
  return { root, paths }
}

function v1Fixture() {
  return {
    schemaVersion: 1,
    repoRoot: '/repo',
    commonDir: '/repo/.git',
    base: 'main',
    missions: [{ id: 'M1', title: 'Legacy mission', status: 'planned', scope: ['src/**'] }],
  }
}

test('state writes outside the held lock are refused', async () => {
  const { root, paths } = tempPaths()
  try {
    assert.equal(isStateLockHeld(paths), false)
    assert.equal(stateLockToken(paths), null)
    await assert.rejects(
      () => writeStateLocked(paths, { ok: true }, 'any-token'),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.retryable, false)
        assert.match(error.nextAction, /withLock/)
        assert.match(error.message, /outside the held state lock/)
        return true
      },
    )
    assert.equal(fs.existsSync(paths.state), false, 'the refused write must not create state.json')
  } finally {
    removeTemp(root)
  }
})

test('only the token issued by withLock may write state.json', async () => {
  const { root, paths } = tempPaths()
  try {
    await assert.rejects(
      () =>
        withLock(paths, async (_paths, held) => {
          assert.equal(isStateLockHeld(paths), true)
          assert.equal(stateLockToken(paths), held.token)
          await writeStateLocked(paths, { ok: false }, 'wrong-token')
        }),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.retryable, false)
        return true
      },
    )
    assert.equal(fs.existsSync(paths.state), false, 'the wrong token must not write state.json')
    assert.equal(fs.existsSync(paths.lock), false, 'withLock must release the lock after the throw')

    let token = null
    await withLock(paths, async (_paths, held) => {
      token = held.token
      await writeStateLocked(paths, { ok: true, revision: 1 }, held.token)
    })
    const written = JSON.parse(fs.readFileSync(paths.state, 'utf8'))
    assert.equal(written.ok, true)
    assert.equal(written.revision, 1)
    assert.equal(typeof token, 'string')
    // The token is valid only for the lifetime of the lock section.
    await assert.rejects(
      () => writeStateLocked(paths, { late: true }, token),
      (error) => error.code === 'state-locked',
    )
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.state, 'utf8')), { ok: true, revision: 1 })
  } finally {
    removeTemp(root)
  }
})

test('a state-load migration persists through writeStateLocked with the held token', async () => {
  const { root, paths } = tempPaths()
  try {
    const legacy = v1Fixture()
    const calls = []
    const backupWrites = []
    let migratedState = null
    const store = {
      async readJson(file) {
        assert.equal(file, paths.state)
        return legacy
      },
      async writeJsonAtomic(file, value) {
        if (file === paths.state) throw new Error('unguarded state write must not be used')
        backupWrites.push({ file, value })
      },
      async writeStateLocked(gotPaths, state, token) {
        assert.equal(gotPaths, paths)
        calls.push(token)
        migratedState = state
      },
      async appendJsonl() {},
    }

    await withLock(paths, async (_paths, held) => {
      const result = await loadStateFile({ store, paths, now: 4321 })
      assert.equal(result.migration.persisted, true)
      assert.equal(result.migration.from, 1)
      assert.equal(result.migration.to, 5)
      assert.equal(calls.length, 1)
      assert.equal(calls[0], held.token, 'the loader must pass the lock token')
      assert.equal(backupWrites.length, 1, 'the pre-migration backup is still written')
      assert.equal(migratedState.schemaVersion, 5)
      assert.equal(migratedState.revision, 1)
      assert.equal(migratedState.updatedAt, 4321)
    })
    assert.equal(fs.existsSync(paths.state), false, 'the fake store records the write, it does not create the file')
  } finally {
    removeTemp(root)
  }
})
