// Platform behaviour is a claim, not an ambient fact (#86).
//
// The production branches on `process.platform` are exercised here by injecting
// the platform (path comparison, the discovery shell) or the syscall (the two
// transient-retry loops), so both outcomes run on every OS. The one case that
// needs a real Windows filesystem is declared with `skip:`, so Linux counts it
// as `# SKIP` in the TAP output instead of dropping it silently.
//
// Run with: node --test tests/platform.test.mjs
// TAP view: node --test --test-reporter=tap tests/platform.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { isInside, win32Lower } from '../lib/legacy.js'
import { shellSpec } from '../lib/tests.js'
import { RENAME_ATTEMPTS, TRANSIENT_RENAME_ERRORS, renameWithRetry } from '../lib/persistence.js'
import { UNLINK_ATTEMPTS, TRANSIENT_UNLINK_ERRORS, unlinkWithRetry } from '../lib/leases.js'
import { compareKey } from '../lib/worktreeOwnership.js'

function tempDir(prefix = 'dsh-tower-platform-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function errno(code) {
  const error = /** @type {Error & {code?: string}} */ (new Error(`synthetic ${code}`))
  error.code = code
  return error
}

// ---------------------------------------------------------------------------
// Path comparison (lib/legacy.js)
// ---------------------------------------------------------------------------

test('isInside: win32 semantics fold case, every other platform does not', () => {
  assert.equal(win32Lower('C:\\Repo\\Sub', 'win32'), 'c:\\repo\\sub')
  assert.equal(win32Lower('C:\\Repo\\Sub', 'linux'), 'C:\\Repo\\Sub')

  // The documented fixture: same directory, different casing.
  assert.equal(isInside('C:\\Repo', 'c:\\repo\\sub', 'win32'), true)
  assert.equal(isInside('C:\\Repo', 'C:\\Repo', 'win32'), true)
  // The fold is a comparison, not a prefix match.
  assert.equal(isInside('C:\\Repo', 'C:\\Repo2', 'win32'), false)
  assert.equal(isInside('C:\\Repo', 'D:\\repo\\sub', 'win32'), false)

  // The POSIX branch must stay case-sensitive; deleting the win32 branch and
  // folding everywhere would make this true.
  assert.equal(isInside('C:\\Repo', 'c:\\repo\\sub', 'linux'), false)
  assert.equal(isInside('/repo', '/repo/sub', 'linux'), true)
  assert.equal(isInside('/repo', '/Repo/sub', 'linux'), false)
  assert.equal(isInside('/repo', '/repo2', 'linux'), false)
  assert.equal(isInside('/repo', '/repo/../escape', 'linux'), false)
})

// ---------------------------------------------------------------------------
// Discovery shell (lib/tests.js)
// ---------------------------------------------------------------------------

test('shellSpec: win32 selects pwsh with a powershell fallback, POSIX selects bash', () => {
  const win = shellSpec('win32')
  assert.equal(win.file, 'pwsh')
  assert.equal(win.fallback?.file, 'powershell')
  assert.deepEqual(win.args('Get-ChildItem'), ['-NoProfile', '-NonInteractive', '-Command', 'Get-ChildItem'])
  assert.deepEqual(win.fallback.args('Get-ChildItem'), win.args('Get-ChildItem'))

  for (const platform of ['linux', 'darwin', 'freebsd']) {
    const posix = shellSpec(platform)
    assert.equal(posix.file, 'bash')
    assert.equal(posix.fallback, null)
    assert.deepEqual(posix.args('ls -la'), ['-lc', 'ls -la'])
  }
})

// ---------------------------------------------------------------------------
// Transient rename retry (lib/persistence.js)
// ---------------------------------------------------------------------------

test('renameWithRetry: every transient code retries and then succeeds', async () => {
  assert.deepEqual([...TRANSIENT_RENAME_ERRORS].sort(), ['EACCES', 'EBUSY', 'EPERM'])
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    let attempts = 0
    const slept = []
    await renameWithRetry('/nonexistent/tmp-file', '/nonexistent/destination', {
      rename: async () => {
        attempts += 1
        if (attempts <= 2) throw errno(code)
      },
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    assert.equal(attempts, 3, `${code} must be retried`)
    assert.deepEqual(slept, [10, 25], `${code} must back off between attempts`)
  }
})

test('renameWithRetry: a non-transient error fails at once and removes the temp file', async () => {
  const dir = tempDir()
  const tmp = path.join(dir, '.state.json.tmp')
  fs.writeFileSync(tmp, 'new')
  try {
    let attempts = 0
    await assert.rejects(
      () =>
        renameWithRetry(tmp, path.join(dir, 'state.json'), {
          rename: async () => {
            attempts += 1
            throw errno('ENOENT')
          },
          sleep: async () => assert.fail('a non-transient error must not sleep'),
        }),
      (error) => error?.code === 'ENOENT',
    )
    assert.equal(attempts, 1)
    assert.equal(fs.existsSync(tmp), false, 'the temp file must not be left behind')
  } finally {
    removeTemp(dir)
  }
})

test('renameWithRetry: a persistent transient error stops at the retry budget', async () => {
  const dir = tempDir()
  const tmp = path.join(dir, '.state.json.tmp')
  fs.writeFileSync(tmp, 'new')
  try {
    let attempts = 0
    const slept = []
    await assert.rejects(
      () =>
        renameWithRetry(tmp, path.join(dir, 'state.json'), {
          rename: async () => {
            attempts += 1
            throw errno('EPERM')
          },
          sleep: async (ms) => {
            slept.push(ms)
          },
        }),
      (error) => error?.code === 'EPERM',
    )
    assert.equal(attempts, RENAME_ATTEMPTS + 1)
    assert.equal(slept.length, RENAME_ATTEMPTS)
    assert.equal(fs.existsSync(tmp), false, 'the temp file must not be left behind')
  } finally {
    removeTemp(dir)
  }
})

test(
  'renameWithRetry: waits for a real Windows handle on the destination, then succeeds',
  {
    skip:
      process.platform === 'win32'
        ? false
        : 'requires a real Windows filesystem (renaming over an open destination is EPERM only there)',
  },
  async () => {
    const dir = tempDir('dsh-tower-rename-open-')
    const destination = path.join(dir, 'state.json')
    const tmp = path.join(dir, '.state.json.tmp')
    fs.writeFileSync(destination, 'old')
    fs.writeFileSync(tmp, 'new')
    const handle = fs.openSync(destination, 'r')
    let released = false
    const timer = setTimeout(() => {
      try {
        fs.closeSync(handle)
      } catch {
        // already closed by the finally block
      }
      released = true
    }, 150)
    try {
      const started = Date.now()
      await renameWithRetry(tmp, destination)
      assert.equal(released, true, 'the rename must have retried until the open handle was released')
      assert.ok(Date.now() - started >= 100, 'the retry loop must have waited, not succeeded first time')
      assert.equal(fs.readFileSync(destination, 'utf8'), 'new')
      assert.equal(fs.existsSync(tmp), false)
    } finally {
      clearTimeout(timer)
      try {
        fs.closeSync(handle)
      } catch {
        // already closed by the timer
      }
      removeTemp(dir)
    }
  },
)

// ---------------------------------------------------------------------------
// Transient unlink retry (lib/leases.js)
// ---------------------------------------------------------------------------

test('unlinkWithRetry: every transient code retries and then succeeds', async () => {
  assert.deepEqual([...TRANSIENT_UNLINK_ERRORS].sort(), ['EACCES', 'EBUSY', 'EPERM'])
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    let attempts = 0
    const slept = []
    const removed = await unlinkWithRetry('/nonexistent/lock', {
      unlink: async () => {
        attempts += 1
        if (attempts <= 2) throw errno(code)
      },
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    assert.equal(removed, true)
    assert.equal(attempts, 3, `${code} must be retried`)
    assert.deepEqual(slept, [10, 25], `${code} must back off between attempts`)
  }
})

test('unlinkWithRetry: ENOENT is reported as already gone, other errors fail at once', async () => {
  const missing = await unlinkWithRetry('/nonexistent/lock', {
    unlink: async () => {
      throw errno('ENOENT')
    },
    sleep: async () => assert.fail('ENOENT must not sleep'),
  })
  assert.equal(missing, false)

  await assert.rejects(
    () =>
      unlinkWithRetry('/nonexistent/lock', {
        unlink: async () => {
          throw errno('EIO')
        },
        sleep: async () => assert.fail('a non-transient error must not sleep'),
      }),
    (error) => error?.code === 'EIO',
  )
})

test('unlinkWithRetry: a persistent transient hold stops at the retry budget', async () => {
  let attempts = 0
  const slept = []
  await assert.rejects(
    () =>
      unlinkWithRetry('/nonexistent/lock', {
        unlink: async () => {
          attempts += 1
          throw errno('EPERM')
        },
        sleep: async (ms) => {
          slept.push(ms)
        },
      }),
    (error) => error?.code === 'EPERM',
  )
  assert.equal(attempts, UNLINK_ATTEMPTS + 1)
  assert.equal(slept.length, UNLINK_ATTEMPTS)
})

test('unlinkWithRetry: removes a real file once and reports a missing file as false', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'leases.json.lock')
  fs.writeFileSync(file, '{}')
  try {
    assert.equal(await unlinkWithRetry(file), true)
    assert.equal(fs.existsSync(file), false)
    assert.equal(await unlinkWithRetry(file), false)
  } finally {
    removeTemp(dir)
  }
})

// ---------------------------------------------------------------------------
// Worktree path identity (lib/worktreeOwnership.js)
// ---------------------------------------------------------------------------

test('compareKey: folds case only under win32 semantics', () => {
  assert.equal(compareKey('C:\\Repo\\Sub', 'win32'), 'c:\\repo\\sub')
  assert.equal(compareKey('C:\\Repo\\Sub', 'win32'), compareKey('c:\\repo\\sub', 'win32'))

  assert.equal(compareKey('/Repo/Sub', 'linux'), '/Repo/Sub')
  assert.notEqual(compareKey('/Repo/Sub', 'linux'), compareKey('/repo/sub', 'linux'))
  assert.equal(compareKey('/repo/sub', 'linux'), '/repo/sub')

  // The native branch: case-insensitive exactly on Windows.
  assert.equal(
    compareKey('/Repo/Sub') === compareKey('/repo/sub'),
    process.platform === 'win32',
    'native comparison must fold case only on win32',
  )
})
