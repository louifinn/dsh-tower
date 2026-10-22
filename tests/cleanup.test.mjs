// The shared teardown helper is itself a contract (#91).
//
// Windows can keep a handle on a file inside a temp tree after the test that
// created it has finished, so a bare recursive delete turns a green suite red
// at random. The helper retries transient failures with bounded backoff, moves
// the tree out of the way after the first one, and refuses to delete anything
// outside `os.tmpdir()`.
//
// The retry path is exercised two ways: with injected syscalls on every OS, and
// with a real Windows handle (a file opened with `FileShare.None`). The real
// case is skipped, visibly, off Windows.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  CLEANUP_ATTEMPTS,
  TRANSIENT_CLEANUP_ERRORS,
  assertTempPath,
  removeOnce,
  removeTemp,
} from './helpers/cleanup.mjs'

function tempDir(prefix = 'dsh-tower-cleanup-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function errno(code) {
  const error = /** @type {Error & {code?: string}} */ (new Error(`synthetic ${code}`))
  error.code = code
  return error
}

test('assertTempPath: accepts a child of os.tmpdir and refuses everything else', () => {
  const inside = path.join(os.tmpdir(), 'dsh-tower-cleanup-target')
  assert.equal(assertTempPath(inside), path.resolve(inside))

  // The temp root itself is not a test-owned tree.
  assert.throws(() => assertTempPath(os.tmpdir()), /not inside the temp directory/)
  // A path that normalises outside is refused, not merely rejected by prefix.
  assert.throws(() => assertTempPath(path.join(os.tmpdir(), '..', 'escape')), /not inside the temp directory/)
  // A volume root is never a test-owned tree.
  assert.throws(() => assertTempPath(path.parse(os.tmpdir()).root), /not inside the temp directory/)
  assert.throws(() => assertTempPath(''), TypeError)
})

test('removeTemp: removes a tree once and treats an already-missing target as a no-op', () => {
  const root = tempDir()
  fs.mkdirSync(path.join(root, 'repo', '.git'), { recursive: true })
  fs.writeFileSync(path.join(root, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main\n')

  removeTemp(root)
  assert.equal(fs.existsSync(root), false)
  removeTemp(root)
})

test('removeTemp: every transient Windows code retries and then succeeds', () => {
  assert.deepEqual([...TRANSIENT_CLEANUP_ERRORS].sort(), ['EACCES', 'EBUSY', 'EPERM'])
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const root = tempDir()
    fs.writeFileSync(path.join(root, 'held.txt'), 'held\n')
    let attempts = 0
    const slept = []
    removeTemp(root, {
      renameOutOfTheWay: false,
      remove(file) {
        attempts += 1
        if (attempts <= 2) throw errno(code)
        removeOnce(file)
      },
      sleep(ms) {
        slept.push(ms)
      },
    })
    assert.equal(attempts, 3, `${code} must be retried`)
    assert.deepEqual(slept, [25, 50], `${code} must back off between attempts`)
    assert.equal(fs.existsSync(root), false)
  }
})

test('removeTemp: moves the tree out of the way, then removes the quarantine', () => {
  const root = tempDir()
  fs.writeFileSync(path.join(root, 'held.txt'), 'held\n')
  const renamed = []
  const slept = []
  removeTemp(root, {
    rename(from, to) {
      renamed.push({ from, to })
      fs.renameSync(from, to)
    },
    remove(file) {
      if (renamed.length === 0) throw errno('EPERM')
      removeOnce(file)
    },
    sleep(ms) {
      slept.push(ms)
    },
  })

  assert.equal(renamed.length, 1, 'the first transient failure must move the tree aside')
  assert.equal(renamed[0].from, root)
  assert.ok(renamed[0].to.startsWith(`${root}.cleanup-`), 'the quarantine must be a sibling with a fresh name')
  assert.equal(assertTempPath(renamed[0].to), path.resolve(renamed[0].to))
  assert.deepEqual(slept, [25])
  assert.equal(fs.existsSync(root), false)
  assert.equal(fs.existsSync(renamed[0].to), false, 'the quarantine must not be left behind')
})

test('removeTemp: a non-transient error fails at once without sleeping', () => {
  const root = tempDir()
  try {
    let attempts = 0
    assert.throws(
      () =>
        removeTemp(root, {
          remove() {
            attempts += 1
            throw errno('EIO')
          },
          rename: () => assert.fail('a non-transient error must not move the tree'),
          sleep: () => assert.fail('a non-transient error must not sleep'),
        }),
      (error) => error?.cause?.code === 'EIO' && /EIO/.test(error.message),
    )
    assert.equal(attempts, 1)
  } finally {
    removeTemp(root)
  }
})

test('removeTemp: a persistent transient hold stops at the retry budget', () => {
  const root = tempDir()
  try {
    let attempts = 0
    const slept = []
    assert.throws(
      () =>
        removeTemp(root, {
          attempts: 3,
          renameOutOfTheWay: false,
          remove() {
            attempts += 1
            throw errno('EPERM')
          },
          sleep(ms) {
            slept.push(ms)
          },
        }),
      (error) => error?.cause?.code === 'EPERM' && error.message.includes(root),
    )
    assert.equal(attempts, 3)
    assert.deepEqual(slept, [25, 50], 'the last attempt must not sleep')
    assert.ok(CLEANUP_ATTEMPTS > 3, 'the production budget must be larger than the seeded one')
  } finally {
    removeTemp(root)
  }
})

test(
  'removeTemp: waits for a real Windows handle, then succeeds',
  {
    skip:
      process.platform === 'win32'
        ? false
        : 'requires a real Windows filesystem (a file opened with FileShare.None blocks deletion only there)',
  },
  async () => {
    const root = tempDir('dsh-tower-cleanup-handle-')
    const file = path.join(root, 'held.txt')
    fs.writeFileSync(file, 'held\n')
    // Windows PowerShell opens the file with FileShare.None, so every delete
    // attempt is EPERM until the child closes it. The child exits by itself
    // while the helper is retrying, so the retry loop is what makes the
    // removal succeed. `ready` is what makes the fixture deterministic: the
    // handle exists before the first attempt.
    const script = [
      "$h = [System.IO.File]::Open($env:DSH_TOWER_HOLD_FILE, 'Open', 'Read', 'None')",
      "[Console]::Out.WriteLine('ready')",
      '[Console]::Out.Flush()',
      'Start-Sleep -Milliseconds 400',
      '$h.Close()',
    ].join('; ')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, DSH_TOWER_HOLD_FILE: file },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const ready = new Promise((resolve, reject) => {
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (output.includes('ready')) resolve(undefined)
      })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (!output.includes('ready')) reject(new Error(`handle fixture exited before ready (code ${code})`))
      })
    })
    try {
      await ready
      const started = Date.now()
      removeTemp(root)
      const elapsed = Date.now() - started
      assert.equal(fs.existsSync(root), false)
      assert.ok(elapsed >= 100, `the removal must have waited for the handle (waited ${elapsed}ms)`)
    } finally {
      if (child.exitCode === null) child.kill()
      removeTemp(root)
    }
  },
)
