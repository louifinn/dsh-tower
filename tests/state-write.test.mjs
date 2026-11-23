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

import { lockRecord, lockTiming } from '../adapters/lock.js'
import {
  isStateLockHeld,
  pathsFor,
  readStateCommitLock,
  readStateLock,
  stateCommitLockPath,
  stateLockToken,
  withGitLock,
  withLock,
  writeStateLocked,
} from '../adapters/store.js'
import { clearStateCommitLock, createStorePort, fsp } from '../adapters/store-fs.js'
import { loadStateFile } from '../adapters/stateFile.js'
import { registerRecoverTool } from '../tools/recover.js'

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-state-write-'))
  const paths = pathsFor(path.join(root, '.git'))
  fs.mkdirSync(paths.dir, { recursive: true })
  return { root, paths }
}

// Minimal tower_recover harness: the host injects the read-only lock inspector
// and the timing helper, while openTower/actorFor only supply the store the
// recovery needs. That keeps the tool's actual control flow under test without
// standing up a full Tower session.
function recoverToolFor(paths) {
  let definition = null
  const tower = { paths, deps: { store: createStorePort() } }
  registerRecoverTool(
    {},
    {
      define: (_ctx, tool) => {
        definition = tool
      },
      openTower: async () => tower,
      actorFor: async () => ({ role: 'tower' }),
      requireTowerActor: () => {},
      readStateLock,
      lockTiming,
    },
  )
  return { call: (args) => definition.execute(args, {}) }
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

// #167 R63 P2-1: the in-process token map only proves the mutation *started*
// inside withLock. The on-disk record is checked again before commit, so a
// record moved/replaced during the mutation cannot let a stale writer land
// state.json under a lock another process now owns.
test('a lock record replaced between withLock and the state write is refused', async () => {
  const { root, paths } = tempPaths()
  try {
    await assert.rejects(
      () =>
        withLock(paths, async (_paths, held) => {
          fs.writeFileSync(paths.lock, JSON.stringify(lockRecord('intruder', { marker: 'clobbered' })))
          await writeStateLocked(paths, { ok: true }, held.token)
        }),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.retryable, false)
        assert.match(error.message, /no longer carries this mutation token/)
        assert.equal(error.details.reason, 'state-lock-holder-mismatch')
        assert.equal(error.details.actualToken, 'intruder')
        return true
      },
    )
    assert.equal(fs.existsSync(paths.state), false, 'the refused write must not create state.json')
    assert.equal(JSON.parse(fs.readFileSync(paths.lock, 'utf8')).token, 'intruder', 'the foreign lock is not removed')
  } finally {
    removeTemp(root)
  }
})

test('a state write with the lock record gone is refused', async () => {
  const { root, paths } = tempPaths()
  try {
    await assert.rejects(
      () =>
        withLock(paths, async (_paths, held) => {
          fs.unlinkSync(paths.lock)
          await writeStateLocked(paths, { ok: true }, held.token)
        }),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.retryable, false)
        assert.match(error.message, /is missing/)
        assert.equal(error.details.reason, 'state-lock-missing')
        return true
      },
    )
    assert.equal(fs.existsSync(paths.state), false)
  } finally {
    removeTemp(root)
  }
})

test('a lock mutated during state serialisation cannot slip a stale write through', async () => {
  const { root, paths } = tempPaths()
  try {
    await assert.rejects(
      () =>
        withLock(paths, async (_paths, held) => {
          const state = {
            toJSON() {
              // Mutate the lock record while the document is being serialised,
              // after the pre-write check but before the atomic rename.
              fs.writeFileSync(paths.lock, JSON.stringify(lockRecord('intruder', { marker: 'serialisation' })))
              return { ok: true }
            },
          }
          await writeStateLocked(paths, state, held.token)
        }),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.retryable, false)
        assert.equal(error.details.reason, 'state-lock-holder-mismatch')
        return true
      },
    )
    assert.equal(fs.existsSync(paths.state), false, 'state.json must not be replaced')
    assert.deepEqual(
      fs.readdirSync(paths.dir).filter((name) => name.includes('.state.json.tmp-')),
      [],
      'the aborted write must remove its temp file',
    )
  } finally {
    removeTemp(root)
  }
})

// #F71: the commit mutex is a short-lived fence around one rename. It has no
// heartbeat, so a leftover record from a dead PID is reclaimed by the next
// acquisition, and a live-but-silent record is a visible wedge with an audited
// recovery path instead of a file an operator has to delete by hand.

test('a commit mutex left by a dead PID does not wedge the next state write (F71)', async () => {
  const { root, paths } = tempPaths()
  try {
    const at = Date.now() - 5000
    fs.writeFileSync(
      stateCommitLockPath(paths),
      JSON.stringify({ token: 'dead-commit', pid: 999999, kind: 'state-commit', since: at, at }),
    )
    const inspected = await readStateCommitLock(paths)
    assert.equal(inspected.record.token, 'dead-commit')
    assert.equal(inspected.alive, false)

    await withLock(paths, async (_paths, held) => {
      await writeStateLocked(paths, { ok: true, revision: 1 }, held.token, { commitLockTimeoutMs: 250 })
    })
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.state, 'utf8')), { ok: true, revision: 1 })
    assert.equal(fs.existsSync(stateCommitLockPath(paths)), false, 'the dead record must be reclaimed by acquisition')
  } finally {
    removeTemp(root)
  }
})

test('a live-but-silent commit mutex blocks writes until an explicit force clears it (F71)', async () => {
  const { root, paths } = tempPaths()
  try {
    const at = Date.now() - 10000
    const raw = JSON.stringify({ token: 'silent-commit', pid: process.pid, kind: 'state-commit', since: at, at })
    fs.writeFileSync(stateCommitLockPath(paths), raw)

    await assert.rejects(
      () =>
        withLock(paths, async (_paths, held) => {
          await writeStateLocked(paths, { ok: true }, held.token, { commitLockTimeoutMs: 120, commitLockPollMs: 10 })
        }),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.details.reason, 'state-commit-busy')
        assert.match(error.message, /commit mutex/)
        assert.match(error.nextAction, /tower_recover clear-stale-lock/)
        return true
      },
    )
    assert.equal(fs.existsSync(paths.state), false, 'the blocked write must not create state.json')

    // A live PID is never moved without force, however old the record is.
    await assert.rejects(() => clearStateCommitLock(paths), /still held by pid/)
    assert.equal(fs.readFileSync(stateCommitLockPath(paths), 'utf8'), raw)

    const cleared = await clearStateCommitLock(paths, { force: true })
    assert.equal(cleared.cleared, true)
    assert.equal(cleared.forced, true)
    assert.equal(cleared.pid, process.pid)
    assert.match(cleared.backup, /state\.commit\.lock\.recovered-\d+$/)
    assert.equal(fs.existsSync(stateCommitLockPath(paths)), false)
    assert.equal(fs.readFileSync(cleared.backup, 'utf8'), raw, 'the moved record stays auditable')

    await withLock(paths, async (_paths, held) => {
      await writeStateLocked(paths, { ok: true, revision: 1 }, held.token, { commitLockTimeoutMs: 250 })
    })
    assert.equal(JSON.parse(fs.readFileSync(paths.state, 'utf8')).revision, 1)
  } finally {
    removeTemp(root)
  }
})

test('commit-mutex recovery refuses a record that changed after inspection (F71)', async () => {
  const { root, paths } = tempPaths()
  try {
    const at = Date.now() - 5000
    fs.writeFileSync(
      stateCommitLockPath(paths),
      JSON.stringify({ token: 'inspected', pid: 999999, kind: 'state-commit', since: at, at }),
    )
    const inspected = await readStateCommitLock(paths)
    const newer = JSON.stringify({ token: 'newer', pid: 999999, kind: 'state-commit', since: at, at: at + 1 })
    fs.writeFileSync(stateCommitLockPath(paths), newer)
    await assert.rejects(
      () => clearStateCommitLock(paths, { force: true, expectedRaw: inspected.raw }),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.details.reason, 'state-commit-lock-changed')
        return true
      },
    )
    assert.equal(fs.readFileSync(stateCommitLockPath(paths), 'utf8'), newer, 'a changed record must not be moved')
  } finally {
    removeTemp(root)
  }
})

// #F71 R1: a torn write (the record is created with `wx`, not atomically) leaves
// bytes that are not a lock record. `readLock` reports an error and no record, so
// before this the recovery path treated the mutex as absent: status said "no
// lock", clear-stale-lock answered cleared:false, and every write kept failing.
// The unreadable bytes are a record to move, never a file to delete.

test('an unreadable commit mutex is refused without force and moved to a backup with force (F71)', async () => {
  const { root, paths } = tempPaths()
  try {
    const raw = '{"token":"torn",'
    fs.writeFileSync(stateCommitLockPath(paths), raw)
    const inspected = await readStateCommitLock(paths)
    assert.equal(inspected.record, null)
    assert.equal(typeof inspected.error, 'string')
    assert.equal(inspected.alive, null)

    // Without force the adapter refuses with an actionable message and keeps
    // the bytes exactly where they are.
    await assert.rejects(
      () => clearStateCommitLock(paths),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.details.reason, 'state-commit-lock-unreadable')
        assert.match(error.message, /could not be read/)
        assert.match(error.nextAction, /force:true/)
        assert.match(error.nextAction, /backup/)
        return true
      },
    )
    assert.equal(fs.readFileSync(stateCommitLockPath(paths), 'utf8'), raw)

    // The wedge is real: acquisition retries the unparseable record and then
    // gives up with the same state-commit-busy an operator sees in production.
    await assert.rejects(
      () =>
        withLock(paths, async (_paths, held) => {
          await writeStateLocked(paths, { ok: true }, held.token, { commitLockTimeoutMs: 120, commitLockPollMs: 10 })
        }),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.details.reason, 'state-commit-busy')
        return true
      },
    )

    const cleared = await clearStateCommitLock(paths, { force: true })
    assert.equal(cleared.cleared, true)
    assert.equal(cleared.unreadable, true)
    assert.match(cleared.backup, /state\.commit\.lock\.recovered-\d+$/)
    assert.equal(fs.existsSync(stateCommitLockPath(paths)), false)
    assert.equal(fs.readFileSync(cleared.backup, 'utf8'), raw, 'the unreadable bytes stay auditable')

    await withLock(paths, async (_paths, held) => {
      await writeStateLocked(paths, { ok: true, revision: 1 }, held.token, { commitLockTimeoutMs: 250 })
    })
    assert.equal(JSON.parse(fs.readFileSync(paths.state, 'utf8')).revision, 1)
  } finally {
    removeTemp(root)
  }
})

test('two recoveries in the same millisecond keep distinct numeric backups (F71)', async () => {
  const { root, paths } = tempPaths()
  const realNow = Date.now
  try {
    // Pin the wall clock so both recoveries would compute the same timestamp;
    // the appended monotonic tick is what keeps the names apart.
    Date.now = () => 1_750_000_000_000
    fs.writeFileSync(stateCommitLockPath(paths), '{"token":"torn",')
    const first = await clearStateCommitLock(paths, { force: true })
    fs.writeFileSync(stateCommitLockPath(paths), '{"token":"torn",')
    const second = await clearStateCommitLock(paths, { force: true })
    assert.match(first.backup, /state\.commit\.lock\.recovered-\d+$/)
    assert.match(second.backup, /state\.commit\.lock\.recovered-\d+$/)
    assert.notEqual(first.backup, second.backup, 'a same-millisecond recovery must not overwrite the earlier backup')
    assert.equal(fs.existsSync(first.backup), true)
    assert.equal(fs.existsSync(second.backup), true)
  } finally {
    Date.now = realNow
    removeTemp(root)
  }
})

test('tower_recover status surfaces an unreadable commit mutex and force repairs it (F71)', async () => {
  const { root, paths } = tempPaths()
  try {
    const raw = '{"token":"torn",'
    fs.writeFileSync(stateCommitLockPath(paths), raw)
    const recover = recoverToolFor(paths)

    const status = await recover.call({ action: 'status' })
    assert.equal(status.stateLock, null)
    assert.equal(status.commitLock.unreadable, true)
    assert.equal(status.commitLock.path, stateCommitLockPath(paths))
    assert.equal(typeof status.commitLock.error, 'string')

    await assert.rejects(
      () => recover.call({ action: 'clear-stale-lock', confirm: 'CLEAR_STALE_LOCK' }),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.details.reason, 'state-commit-lock-unreadable')
        assert.match(error.nextAction, /force:true/)
        return true
      },
    )
    assert.equal(fs.readFileSync(stateCommitLockPath(paths), 'utf8'), raw)

    const cleared = await recover.call({ action: 'clear-stale-lock', confirm: 'CLEAR_STALE_LOCK', force: true })
    assert.equal(cleared.cleared, true)
    assert.equal(cleared.forced, true)
    assert.match(cleared.commitBackup, /state\.commit\.lock\.recovered-\d+$/)
    assert.equal(fs.existsSync(stateCommitLockPath(paths)), false)
    assert.equal(fs.readFileSync(cleared.commitBackup, 'utf8'), raw)

    await withLock(paths, async (_paths, held) => {
      await writeStateLocked(paths, { ok: true, revision: 1 }, held.token, { commitLockTimeoutMs: 250 })
    })
    assert.equal(JSON.parse(fs.readFileSync(paths.state, 'utf8')).revision, 1)
  } finally {
    removeTemp(root)
  }
})

test('tower_recover moves an unreadable state lock aside only with force (F71)', async () => {
  const { root, paths } = tempPaths()
  try {
    const raw = '{"token":"torn",'
    fs.writeFileSync(paths.lock, raw)
    const recover = recoverToolFor(paths)

    const status = await recover.call({ action: 'status' })
    assert.equal(status.stateLock.unreadable, true)
    assert.equal(status.stateLock.path, paths.lock)
    assert.equal(typeof status.stateLock.error, 'string')
    assert.equal(status.commitLock, null)

    await assert.rejects(
      () => recover.call({ action: 'clear-stale-lock', confirm: 'CLEAR_STALE_LOCK' }),
      (error) => {
        assert.equal(error.code, 'state-locked')
        assert.equal(error.details.reason, 'state-lock-unreadable')
        assert.match(error.nextAction, /force:true/)
        return true
      },
    )
    assert.equal(fs.readFileSync(paths.lock, 'utf8'), raw)

    const cleared = await recover.call({ action: 'clear-stale-lock', confirm: 'CLEAR_STALE_LOCK', force: true })
    assert.equal(cleared.cleared, true)
    assert.match(cleared.backup, /state\.lock\.recovered-\d+$/)
    assert.equal(fs.existsSync(paths.lock), false)
    assert.equal(fs.readFileSync(cleared.backup, 'utf8'), raw)

    await withLock(paths, async (_paths, held) => {
      await writeStateLocked(paths, { ok: true, revision: 1 }, held.token)
    })
    assert.equal(JSON.parse(fs.readFileSync(paths.state, 'utf8')).revision, 1)
  } finally {
    removeTemp(root)
  }
})

// #228: a refused durable write used to escape as a bare Node error and reach the
// model as `[tower:tool-internal] ENOSPC: no space left on device, write` with no
// path, no phase and no remedy. The state write is the seam tower_merge fails in,
// so the errno is translated there — and the document already on disk keeps its
// exact bytes, because the temp file is unlinked before the error leaves.
for (const code of ['ENOSPC', 'EMFILE', 'ENFILE', 'EIO']) {
  test(`a refused state write reports a catalogued ${code} and leaves state.json byte-identical (#228)`, async () => {
    const { root, paths } = tempPaths()
    const { fsp } = await import('../adapters/store-fs.js')
    const originalOpen = fsp.open
    try {
      await withLock(paths, async (_paths, held) => {
        await writeStateLocked(paths, { ok: true, revision: 1, missions: [] }, held.token)
      })
      const before = fs.readFileSync(paths.state)
      const beforeNames = fs.readdirSync(paths.dir).sort()

      fsp.open = async () => {
        throw Object.assign(new Error(`${code}: no space left on device, write`), { code })
      }
      try {
        await assert.rejects(
          () =>
            withLock(paths, async (_paths, held) => {
              await writeStateLocked(paths, { ok: true, revision: 2, missions: [] }, held.token)
            }),
          (error) => {
            assert.equal(error.code, 'state-io-failed')
            assert.equal(error.retryable, false)
            assert.equal(error.details.code, code)
            assert.equal(error.details.path, paths.state)
            assert.equal(error.details.phase, 'state-write')
            assert.match(error.message, /\[tower:state-io-failed\]/)
            assert.match(error.message, /during state-write/)
            assert.match(error.message, /— next: .*free space/)
            assert.match(error.message, /the previous document is unchanged/)
            return true
          },
        )
      } finally {
        fsp.open = originalOpen
      }

      assert.deepEqual(fs.readFileSync(paths.state), before, 'state.json keeps its exact bytes')
      assert.equal(JSON.parse(fs.readFileSync(paths.state, 'utf8')).revision, 1)
      assert.deepEqual(
        fs.readdirSync(paths.dir).filter((name) => name.includes('.tmp-')),
        [],
        'no temp document is left behind',
      )
      assert.ok(beforeNames.length > 0)
    } finally {
      fsp.open = originalOpen
      removeTemp(root)
    }
  })
}

test('a refused activity append names the activity log and the append phase (#228)', async () => {
  const { root, paths } = tempPaths()
  const { fsp } = await import('../adapters/store-fs.js')
  const { appendJsonl } = await import('../adapters/persistence.js')
  const originalAppendFile = fsp.appendFile
  try {
    fs.writeFileSync(paths.activity, '{"at":1}\n')
    const before = fs.readFileSync(paths.activity)
    fsp.appendFile = async () => {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    }
    try {
      await assert.rejects(
        () => appendJsonl(paths.activity, { at: 2, type: 'mission.planned' }, { phase: 'activity-append' }),
        (error) => {
          assert.equal(error.code, 'state-io-failed')
          assert.equal(error.retryable, false)
          assert.equal(error.details.code, 'ENOSPC')
          assert.equal(error.details.path, paths.activity)
          assert.equal(error.details.phase, 'activity-append')
          assert.match(error.message, /append to .*activity\.jsonl/)
          assert.match(error.message, /volume /)
          return true
        },
      )
    } finally {
      fsp.appendFile = originalAppendFile
    }
    assert.deepEqual(fs.readFileSync(paths.activity), before, 'the activity log keeps its exact bytes')
  } finally {
    fsp.appendFile = originalAppendFile
    removeTemp(root)
  }
})

test('a refused lock create reports the lock path instead of a bare errno (#228)', async () => {
  const { root, paths } = tempPaths()
  try {
    // The kernel keeps its contract (it rethrows the create failure unchanged, see
    // lock-kernel.test.mjs); the translation lives in withLock, above it.
    await assert.rejects(
      () =>
        withLock(paths, async () => {
          throw new Error('unreachable')
        }, { create: () => {
          throw Object.assign(new Error('ENOSPC: no space left on device, open'), { code: 'ENOSPC' })
        } }),
      (error) => {
        assert.equal(error.code, 'state-io-failed')
        assert.equal(error.retryable, false)
        assert.equal(error.details.code, 'ENOSPC')
        assert.equal(error.details.path, paths.lock)
        assert.equal(error.details.phase, 'lock-create')
        return true
      },
    )
    assert.equal(fs.existsSync(paths.state), false)
  } finally {
    removeTemp(root)
  }
})

test('a refused mode-store write reports the config-write phase (#228)', async () => {
  const { root } = tempPaths()
  const { writeJsonAtomicSync } = await import('../adapters/persistence.js')
  const file = path.join(root, 'modes.json')
  const originalWriteFileSync = fs.writeFileSync
  try {
    fs.writeFileSync(file, '{"keep":true}\n')
    fs.writeFileSync = () => {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    }
    assert.throws(
      () => writeJsonAtomicSync(file, { mode: 'on' }),
      (error) => {
        assert.equal(error.code, 'state-io-failed')
        assert.equal(error.retryable, false)
        assert.equal(error.details.path, file)
        assert.equal(error.details.phase, 'config-write')
        assert.match(error.message, /during config-write/)
        return true
      },
    )
  } finally {
    fs.writeFileSync = originalWriteFileSync
    assert.equal(fs.readFileSync(file, 'utf8'), '{"keep":true}\n', 'the previous mode store is unchanged')
    removeTemp(root)
  }
})

// #228 P3-c: the git-mutex create is translated too, but by its own phase name so
// a failed merge names the record it could not create instead of looking like a
// state write.
test('a refused git-mutex create reports the merge-lock phase (#228)', async () => {
  const { root, paths } = tempPaths()
  try {
    await assert.rejects(
      () =>
        withGitLock(
          paths,
          async () => {
            throw new Error('unreachable')
          },
          {
            phase: 'merge',
            create: () => {
              throw Object.assign(new Error('ENOSPC: no space left on device, open'), { code: 'ENOSPC' })
            },
          },
        ),
      (error) => {
        assert.equal(error.code, 'state-io-failed')
        assert.equal(error.retryable, false)
        assert.equal(error.details.code, 'ENOSPC')
        assert.equal(error.details.path, paths.gitLock)
        assert.equal(error.details.phase, 'merge-lock')
        assert.match(error.message, /during merge-lock/)
        return true
      },
    )
    assert.equal(fs.existsSync(paths.gitLock), false)
    assert.equal(fs.existsSync(paths.state), false)
  } finally {
    removeTemp(root)
  }
})

// #228 P1-1: the state commit mutex is created *inside* writeStateLocked, after
// the mutation already decided to publish. A refused create there used to escape
// untranslated and reach the model as `[tower:tool-internal] ENOSPC: ...`.
test('a refused commit-mutex create reports the state-commit-lock phase (#228)', async () => {
  const { root, paths } = tempPaths()
  try {
    await assert.rejects(
      () =>
        withLock(paths, async (_paths, held) => {
          await writeStateLocked(paths, { revision: 1, missions: [] }, held.token, {
            commitLockCreate: () => {
              throw Object.assign(new Error('ENOSPC: no space left on device, open'), { code: 'ENOSPC' })
            },
          })
        }),
      (error) => {
        assert.equal(error.code, 'state-io-failed')
        assert.equal(error.retryable, false)
        assert.equal(error.details.code, 'ENOSPC')
        assert.equal(error.details.path, stateCommitLockPath(paths))
        assert.equal(error.details.phase, 'state-commit-lock')
        assert.match(error.message, /during state-commit-lock/)
        assert.match(error.message, /commit mutex/)
        assert.match(error.message, /— next: .*free space/)
        assert.doesNotMatch(error.message, /tool-internal/)
        return true
      },
    )
    assert.equal(fs.existsSync(paths.state), false, 'the refused commit mutex wrote no state')
  } finally {
    removeTemp(root)
  }
})

// #228 P1-2: `writeFile(..., {flag:'wx'})` creates the record and then writes the
// payload, so a full volume can leave an empty/torn record behind. Left in place
// it would make every later writer report `state-commit-busy` forever.
test('a failed commit-mutex create removes the partial record it left behind (#228)', async () => {
  const { root, paths } = tempPaths()
  const lockPath = stateCommitLockPath(paths)
  try {
    await assert.rejects(
      () =>
        withLock(paths, async (_paths, held) => {
          await writeStateLocked(paths, { revision: 1, missions: [] }, held.token, {
            commitLockCreate: async (file) => {
              // The name is created, then the payload write fails: exactly the
              // torn record a full disk leaves.
              await fsp.writeFile(file, '{"token":"partial', 'utf8')
              throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
            },
          })
        }),
      (error) => {
        assert.equal(error.code, 'state-io-failed')
        assert.equal(error.details.phase, 'state-commit-lock')
        return true
      },
    )
    assert.equal(fs.existsSync(lockPath), false, 'the partial commit record is removed')

    // The next writer is not wedged: a normal commit still succeeds.
    await withLock(paths, async (_paths, held) => {
      await writeStateLocked(paths, { revision: 1, missions: [] }, held.token)
    })
    assert.equal(JSON.parse(fs.readFileSync(paths.state, 'utf8')).revision, 1)
  } finally {
    removeTemp(root)
  }
})

test('a failed commit-mutex create never removes a foreign holder record (#228)', async () => {
  const { root, paths } = tempPaths()
  const lockPath = stateCommitLockPath(paths)
  try {
    // A real holder's record (its token is not this attempt's) must survive: the
    // removal is a cleanup of our own failed create, not a reclaim.
    const foreign = '{"token":"another-writer","pid":424242}\n'
    fs.writeFileSync(lockPath, foreign)
    await assert.rejects(
      () =>
        withLock(paths, async (_paths, held) => {
          await writeStateLocked(paths, { revision: 1, missions: [] }, held.token, {
            commitLockCreate: () => {
              throw Object.assign(new Error('ENOSPC: no space left on device, open'), { code: 'ENOSPC' })
            },
          })
        }),
      (error) => {
        assert.equal(error.code, 'state-io-failed')
        assert.equal(error.details.phase, 'state-commit-lock')
        return true
      },
    )
    assert.equal(fs.readFileSync(lockPath, 'utf8'), foreign, 'a foreign holder record is untouched')
  } finally {
    removeTemp(root)
  }
})

// #228 P1-3: the release runs *after* the state document may already be on disk,
// so its failure must say the write landed and name the path the next writer will
// trip over — never borrow the "previous document is unchanged" note.
test('a refused commit-mutex release says the state write landed and names the stuck lock (#228)', async () => {
  const { root, paths } = tempPaths()
  const originalRename = fsp.rename
  try {
    await withLock(paths, async (_paths, held) => {
      await writeStateLocked(paths, { revision: 1, missions: [] }, held.token)
    })
    fsp.rename = async (from, to) => {
      if (String(from).includes('state.commit.lock')) {
        throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' })
      }
      return originalRename(from, to)
    }
    try {
      await assert.rejects(
        () =>
          withLock(paths, async (_paths, held) => {
            await writeStateLocked(paths, { revision: 2, missions: [] }, held.token)
          }),
        (error) => {
          assert.equal(error.code, 'state-io-failed')
          assert.equal(error.retryable, false)
          assert.equal(error.details.phase, 'state-commit-lock')
          assert.equal(error.details.path, stateCommitLockPath(paths))
          assert.equal(error.details.released, false)
          assert.match(error.message, /the state document was written/)
          assert.match(error.message, /state-commit-busy/)
          assert.doesNotMatch(error.message, /previous document is unchanged/)
          assert.doesNotMatch(error.message, /tool-internal/)
          return true
        },
      )
    } finally {
      fsp.rename = originalRename
    }
    // The state write did land: the message must not imply otherwise.
    assert.equal(JSON.parse(fs.readFileSync(paths.state, 'utf8')).revision, 2)
    assert.equal(fs.existsSync(stateCommitLockPath(paths)), true, 'the stuck mutex is still there')
  } finally {
    fsp.rename = originalRename
    removeTemp(root)
  }
})

// #228 P1-4: withLock's own release is a durable write too. When the mutation
// succeeded, a refused release must surface translated; when it failed, the
// release failure must not replace the error that is already on its way out.
test('a refused state-lock release after a successful mutation reports the lock-release phase (#228)', async () => {
  const { root, paths } = tempPaths()
  const originalRename = fsp.rename
  try {
    fsp.rename = async (from, to) => {
      if (from === paths.lock) {
        throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' })
      }
      return originalRename(from, to)
    }
    try {
      await assert.rejects(
        () => withLock(paths, async () => 'ok'),
        (error) => {
          assert.equal(error.code, 'state-io-failed')
          assert.equal(error.retryable, false)
          assert.equal(error.details.code, 'ENOSPC')
          assert.equal(error.details.path, paths.lock)
          assert.equal(error.details.phase, 'lock-release')
          assert.match(error.message, /during lock-release/)
          assert.match(error.message, /state-locked until it is removed/)
          assert.doesNotMatch(error.message, /tool-internal/)
          return true
        },
      )
    } finally {
      fsp.rename = originalRename
    }
  } finally {
    fsp.rename = originalRename
    removeTemp(root)
  }
})

test('a refused state-lock release never replaces the mutation error already in flight (#228)', async () => {
  const { root, paths } = tempPaths()
  const originalRename = fsp.rename
  try {
    fsp.rename = async (from, to) => {
      if (from === paths.lock) {
        throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' })
      }
      return originalRename(from, to)
    }
    try {
      await assert.rejects(
        () =>
          withLock(paths, async () => {
            throw new Error('the mutation itself failed')
          }),
        (error) => {
          assert.equal(error.message, 'the mutation itself failed')
          assert.equal(error.code, undefined)
          return true
        },
      )
    } finally {
      fsp.rename = originalRename
    }
  } finally {
    fsp.rename = originalRename
    removeTemp(root)
  }
})
