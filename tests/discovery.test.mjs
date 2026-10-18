// Offline tests for the 2.1 test-discovery admission module (lib/tests.js).
// Every command is a local shell snippet (PowerShell/bash) or a fake runner;
// no network, no DSH runtime, no real $DSH_HOME.
// Run with: node --test tests/discovery.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  readDiscoveryConfig,
  normalizeDiscovery,
  parseTap,
  parseJsonArray,
  runDiscovery,
} from '../lib/tests.js'

const isWindows = process.platform === 'win32'

/** Build one shell command that prints the given lines (no child process). */
function printLines(lines) {
  if (isWindows) {
    return lines.map((line) => `Write-Output '${String(line).replace(/'/g, "''")}'`).join('; ')
  }
  return `printf '%s\\n' ${lines.map((line) => `'${String(line).replace(/'/g, "'\\''")}'`).join(' ')}`
}

function exitCommand(code) {
  return `exit ${code}`
}

function sleepCommand(seconds) {
  return isWindows ? `Start-Sleep -Seconds ${seconds}` : `sleep ${seconds}`
}

function oversizeCommand(bytes) {
  return isWindows ? `Write-Output ('x' * ${bytes})` : `printf 'x%.0s' {1..${bytes}}`
}

function makeWorktree(prefix = 'dsh-tower-discovery-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function tapConfig(command, extra = {}) {
  return { version: 1, commands: [{ id: 'tap', command, format: 'node-tap', ...extra }] }
}

function jsonConfig(command, extra = {}) {
  return { version: 1, commands: [{ id: 'json', command, format: 'json-array', ...extra }] }
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeGitRepo() {
  const root = makeWorktree('dsh-tower-discovery-git-')
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'seed'])
  return { root, repo }
}

// ---------------------------------------------------------------------------
// readDiscoveryConfig / normalizeDiscovery
// ---------------------------------------------------------------------------

test('readDiscoveryConfig: reads tower.testDiscovery and treats absence as unconfigured', () => {
  const raw = { version: 1, commands: [{ id: 'unit', command: 'node --test', format: 'node-tap' }] }
  const configured = readDiscoveryConfig(JSON.stringify({ name: 'demo', tower: { testDiscovery: raw } }))
  assert.equal(configured.configured, true)
  assert.equal(configured.error, null)
  assert.deepEqual(configured.config, raw)

  const absent = readDiscoveryConfig(JSON.stringify({ name: 'demo' }))
  assert.deepEqual(absent, { configured: false, config: null, error: null })

  const towerNotObject = readDiscoveryConfig(JSON.stringify({ tower: 'legacy text' }))
  assert.equal(towerNotObject.configured, false)

  const empty = readDiscoveryConfig('')
  assert.equal(empty.configured, false)
  assert.match(empty.error, /empty/)

  const broken = readDiscoveryConfig('{ not json')
  assert.equal(broken.configured, false)
  assert.match(broken.error, /not valid JSON/)
})

test('normalizeDiscovery: applies defaults and is idempotent', () => {
  const normalized = normalizeDiscovery({
    version: 1,
    commands: [
      { id: 'unit', command: 'node --test', format: 'node-tap' },
      { id: 'e2e', command: 'node e2e.mjs', format: 'json-array', minCount: 2, required: ['boot', 'shutdown'] },
    ],
  })
  assert.equal(normalized.ok, true)
  assert.equal(normalized.error, null)
  assert.deepEqual(normalized.commands[0], {
    id: 'unit',
    command: 'node --test',
    format: 'node-tap',
    minCount: 1,
    required: [],
  })
  assert.equal(normalized.commands[1].minCount, 2)
  assert.deepEqual(normalized.commands[1].required, ['boot', 'shutdown'])

  const again = normalizeDiscovery(normalized)
  assert.equal(again.ok, true)
  assert.deepEqual(again.commands, normalized.commands)
})

test('normalizeDiscovery: invalid Tower Codex configs return a stable error', () => {
  const good = { version: 1, commands: [{ id: 'unit', command: 'node --test', format: 'node-tap' }] }
  const tooMany = {
    version: 1,
    commands: Array.from({ length: 21 }, (_, index) => ({ id: `c${index}`, command: 'true', format: 'node-tap' })),
  }
  const cases = [
    [null, /must be an object/],
    [{ commands: [] }, /version must be one of: 1/],
    [{ version: 2, commands: [] }, /version must be one of: 1/],
    [{ version: 1 }, /commands must be a non-empty array/],
    [{ version: 1, commands: [] }, /commands must be a non-empty array/],
    [tooMany, /at most 20 entries/],
    [{ version: 1, commands: [null] }, /commands\[0\] must be an object/],
    [{ version: 1, commands: [{ id: '', command: 'x', format: 'node-tap' }] }, /id must be a non-empty string/],
    [{ version: 1, commands: [{ id: 'bad id!', command: 'x', format: 'node-tap' }] }, /must match/],
    [
      {
        version: 1,
        commands: [
          { id: 'dup', command: 'true', format: 'node-tap' },
          { id: 'dup', command: 'true', format: 'node-tap' },
        ],
      },
      /must not duplicate command id/,
    ],
    [{ version: 1, commands: [{ id: 'a', command: '', format: 'node-tap' }] }, /command must be a non-empty string/],
    [
      { version: 1, commands: [{ id: 'a', command: 'x'.repeat(4001), format: 'node-tap' }] },
      /at most 4000 characters/,
    ],
    [{ version: 1, commands: [{ id: 'a', command: 'x', format: 'tap' }] }, /format must be one of/],
    [{ version: 1, commands: [{ id: 'a', command: 'x', format: 'node-tap', minCount: -1 }] }, /minCount must be an integer >= 0/],
    [{ version: 1, commands: [{ id: 'a', command: 'x', format: 'node-tap', minCount: 1.5 }] }, /minCount must be an integer >= 0/],
    [{ version: 1, commands: [{ id: 'a', command: 'x', format: 'node-tap', required: 'a' }] }, /required must be an array/],
    [{ version: 1, commands: [{ id: 'a', command: 'x', format: 'node-tap', required: [''] }] }, /must be a non-empty string/],
    [
      { version: 1, commands: [{ id: 'a', command: 'x', format: 'node-tap', required: ['a', 'a'] }] },
      /must not duplicate test name/,
    ],
  ]
  for (const [config, pattern] of cases) {
    const normalized = normalizeDiscovery(config)
    assert.equal(normalized.ok, false, `expected rejection for ${JSON.stringify(config)}`)
    assert.match(normalized.error, pattern)
    assert.deepEqual(normalized.commands, [])
  }
  assert.equal(normalizeDiscovery(good).ok, true)
})

// ---------------------------------------------------------------------------
// parseTap / parseJsonArray
// ---------------------------------------------------------------------------

test('parseTap: passing plan, test names, and failure detection', () => {
  const passing = parseTap('TAP version 13\nok 1 - alpha\nok 2 - beta\n1..2\n')
  assert.equal(passing.ok, true)
  assert.equal(passing.count, 2)
  assert.equal(passing.failed, 0)
  assert.equal(passing.error, null)
  assert.deepEqual(passing.tests, [
    { name: 'alpha', ok: true },
    { name: 'beta', ok: true },
  ])

  const failing = parseTap('TAP version 13\nok 1 - alpha\nnot ok 2 - beta\n1..2\n')
  assert.equal(failing.ok, false)
  assert.equal(failing.count, 2)
  assert.equal(failing.failed, 1)
  assert.equal(failing.error, null)
  assert.deepEqual(failing.tests[1], { name: 'beta', ok: false })
})

test('parseTap: SKIP/TODO directives and node --test nested subtests', () => {
  const skipped = parseTap('TAP version 13\nok 1 - alpha # SKIP not ready\nnot ok 2 - beta # TODO known\n1..2\n')
  assert.equal(skipped.ok, true)
  assert.equal(skipped.tests[0].name, 'alpha')
  assert.equal(skipped.tests[0].directive, 'SKIP')
  assert.equal(skipped.tests[1].ok, true)
  assert.equal(skipped.tests[1].directive, 'TODO')

  const nested = parseTap(
    [
      'TAP version 13',
      '# Subtest: math',
      '    ok 1 - adds',
      '    ok 2 - subtracts',
      '    1..2',
      'ok 1 - math',
      '1..1',
      '',
    ].join('\n'),
  )
  assert.equal(nested.ok, true)
  assert.equal(nested.plan, 1)
  assert.equal(nested.topLevel, 1)
  assert.equal(nested.count, 3)
  assert.deepEqual(
    nested.tests.map((entry) => entry.name),
    ['adds', 'subtracts', 'math'],
  )

  const emptyPlan = parseTap('TAP version 13\n1..0\n')
  assert.equal(emptyPlan.ok, true)
  assert.equal(emptyPlan.count, 0)
})

test('parseTap: malformed output is rejected', () => {
  const notTap = parseTap('hello, this is not TAP\n')
  assert.equal(notTap.ok, false)
  assert.equal(notTap.count, 0)
  assert.match(notTap.error, /no TAP test points/)

  const headerOnly = parseTap('TAP version 13\n')
  assert.equal(headerOnly.ok, false)
  assert.match(headerOnly.error, /no TAP test points/)

  const planMismatch = parseTap('TAP version 13\nok 1 - alpha\n1..2\n')
  assert.equal(planMismatch.ok, false)
  assert.match(planMismatch.error, /plan says 2/)

  const bailout = parseTap('TAP version 13\nBail out! disk on fire\n')
  assert.equal(bailout.ok, false)
  assert.match(bailout.error, /bail out/i)

  const crlf = parseTap('TAP version 13\r\nok 1 - alpha\r\n1..1\r\n')
  assert.equal(crlf.ok, true)

  const empty = parseTap('')
  assert.equal(empty.ok, false)
  assert.match(empty.error, /no TAP test points/)

  // YAML diagnostic blocks are not test points.
  const yamlBlock = parseTap(
    ['TAP version 13', 'ok 1 - alpha', '  ---', '  ok: true', '  ...', '1..1', ''].join('\n'),
  )
  assert.equal(yamlBlock.ok, true)
  assert.equal(yamlBlock.count, 1)
})

test('parseJsonArray: object/string entries and failure detection', () => {
  const parsed = parseJsonArray(
    JSON.stringify([
      { name: 'alpha', ok: true },
      { name: 'beta', pass: true },
      { name: 'gamma', status: 'passed' },
      { name: 'delta', exitCode: 0 },
      'epsilon',
    ]),
  )
  assert.equal(parsed.ok, true)
  assert.equal(parsed.count, 5)
  assert.deepEqual(parsed.tests.map((entry) => entry.name), ['alpha', 'beta', 'gamma', 'delta', 'epsilon'])

  const failing = parseJsonArray(JSON.stringify([{ name: 'alpha', ok: true }, { name: 'beta', status: 'failed' }]))
  assert.equal(failing.ok, false)
  assert.equal(failing.failed, 1)
  assert.equal(failing.error, null)
  assert.equal(failing.tests[1].ok, false)
})

test('parseJsonArray: malformed payloads are rejected', () => {
  const cases = [
    ['', /empty output/],
    ['not json', /not valid JSON/],
    ['{"tests":[]}', /must be a JSON array/],
    ['[42]', /must be an object or a test name string/],
    ['[""]', /non-empty test name/],
    ['[{"name":""}]', /has no non-empty name/],
    ['[{"name":"alpha"}]', /boolean ok\/pass field or a pass\/fail status/],
  ]
  for (const [stdout, pattern] of cases) {
    const parsed = parseJsonArray(stdout)
    assert.equal(parsed.ok, false, JSON.stringify(stdout))
    assert.match(parsed.error, pattern)
    assert.deepEqual(parsed.tests, [])
  }
})

// ---------------------------------------------------------------------------
// runDiscovery: invalid arguments and invalid configuration throw
// ---------------------------------------------------------------------------

test('runDiscovery: invalid arguments and invalid config throw a plain Error', async () => {
  const worktree = makeWorktree()
  try {
    await assert.rejects(() => runDiscovery({ worktreePath: 'relative/path', config: null }), /absolute path/)
    await assert.rejects(
      () => runDiscovery({ worktreePath: worktree, config: null, timeoutMs: 0 }),
      /timeoutMs must be an integer/,
    )
    await assert.rejects(
      () => runDiscovery({ worktreePath: worktree, config: null, maxBytes: -1 }),
      /maxBytes must be an integer/,
    )
    await assert.rejects(
      () => runDiscovery({ worktreePath: worktree, config: null, runner: 'not-a-function' }),
      /runner must be a function/,
    )
    await assert.rejects(
      () => runDiscovery({ worktreePath: worktree, config: null, diagnosticsDir: 'relative' }),
      /diagnosticsDir must be an absolute path/,
    )
    await assert.rejects(
      () =>
        runDiscovery({
          worktreePath: worktree,
          config: { version: 2, commands: [] },
          diagnosticsDir: path.join(worktree, 'diag'),
        }),
      /invalid tower\.testDiscovery config/,
    )
    await assert.rejects(
      () =>
        runDiscovery({
          worktreePath: worktree,
          config: { configured: false, config: null, error: 'package.json is not valid JSON: boom' },
        }),
      /test discovery configuration is invalid/,
    )
    assert.equal(fs.existsSync(path.join(worktree, 'diag')), false, 'no diagnostics dir for invalid config')
  } finally {
    removeDir(worktree)
  }
})

test('runDiscovery: unconfigured discovery is a failed receipt, not an exception', async () => {
  const worktree = makeWorktree()
  try {
    for (const config of [null, undefined, { configured: false, config: null, error: null }]) {
      const receipt = await runDiscovery({ worktreePath: worktree, config })
      assert.equal(receipt.configured, false)
      assert.equal(receipt.ok, false)
      assert.equal(receipt.commands.length, 0)
      assert.match(receipt.error, /not configured/)
      assert.equal(receipt.diagnosticsPath, null)
      assert.equal(receipt.treeTip, null)
    }
  } finally {
    removeDir(worktree)
  }
})

// ---------------------------------------------------------------------------
// runDiscovery: real shell commands
// ---------------------------------------------------------------------------

test('runDiscovery: TAP and json-array success write hashed diagnostics and a receipt', async () => {
  const worktree = makeWorktree()
  const diagnosticsDir = path.join(worktree, 'diagnostics')
  try {
    const receipt = await runDiscovery({
      worktreePath: worktree,
      diagnosticsDir,
      config: {
        version: 1,
        commands: [
          { id: 'unit', command: printLines(['TAP version 13', 'ok 1 - alpha', 'ok 2 - beta', '1..2']), format: 'node-tap', required: ['beta'] },
          { id: 'api', command: printLines([JSON.stringify([{ name: 'boot', ok: true }, { name: 'shutdown', ok: true }])]), format: 'json-array', minCount: 2 },
        ],
      },
    })
    assert.equal(receipt.configured, true)
    assert.equal(receipt.ok, true, receipt.error)
    assert.equal(receipt.error, null)
    assert.equal(receipt.treeTip, null)
    assert.equal(receipt.commands.length, 2)
    assert.equal(receipt.diagnosticsPath, diagnosticsDir)
    assert.equal(receipt.receiptPath, path.join(diagnosticsDir, 'receipt.json'))

    const [tap, json] = receipt.commands
    assert.equal(tap.id, 'unit')
    assert.equal(tap.format, 'node-tap')
    assert.equal(tap.exitCode, 0)
    assert.equal(tap.count, 2)
    assert.equal(tap.ok, true)
    assert.deepEqual(tap.requiredMissing, [])
    assert.equal(json.id, 'api')
    assert.equal(json.count, 2)
    assert.equal(json.ok, true)
    assert.deepEqual(tap.requiredMissing, [])

    assert.deepEqual(receipt.tests, [
      { name: 'alpha', ok: true },
      { name: 'beta', ok: true },
      { name: 'boot', ok: true },
      { name: 'shutdown', ok: true },
    ])

    for (const command of receipt.commands) {
      const stdout = fs.readFileSync(command.stdoutPath)
      const stderr = fs.readFileSync(command.stderrPath)
      assert.equal(command.stdoutSha256, crypto.createHash('sha256').update(stdout).digest('hex'))
      assert.equal(command.stderrSha256, crypto.createHash('sha256').update(stderr).digest('hex'))
    }
    const saved = JSON.parse(fs.readFileSync(receipt.receiptPath, 'utf8'))
    assert.equal(saved.ok, true)
    assert.equal(saved.commands[0].stdoutSha256, tap.stdoutSha256)
    assert.equal(saved.receiptPath, receipt.receiptPath)
  } finally {
    removeDir(worktree)
  }
})

test('runDiscovery: failures fail closed without throwing (nonzero/malformed/timeout/oversize/minCount/required/failed tests)', async () => {
  const worktree = makeWorktree()
  const diagnosticsDir = path.join(worktree, 'diagnostics')
  try {
    const receipt = await runDiscovery({
      worktreePath: worktree,
      diagnosticsDir,
      timeoutMs: 8000,
      maxBytes: 2048,
      config: {
        version: 1,
        commands: [
          { id: 'nonzero', command: printLines(['TAP version 13', 'ok 1 - alpha', '1..1']) + `; ${exitCommand(4)}`, format: 'node-tap' },
          { id: 'malformed', command: printLines(['definitely not tap']), format: 'node-tap' },
          { id: 'oversize', command: oversizeCommand(4096), format: 'json-array' },
          { id: 'short', command: printLines(['TAP version 13', 'ok 1 - only', '1..1']), format: 'node-tap', minCount: 2 },
          {
            id: 'required',
            command: printLines(['TAP version 13', 'ok 1 - alpha', '1..1']),
            format: 'node-tap',
            required: ['alpha', 'gamma'],
          },
          { id: 'failing-json', command: printLines([JSON.stringify([{ name: 'alpha', ok: false }])]), format: 'json-array' },
          { id: 'zero', command: printLines(['TAP version 13', '1..0']), format: 'node-tap', minCount: 0 },
          { id: 'bad-json', command: printLines(['{not-json']), format: 'json-array' },
        ],
      },
    })
    assert.equal(receipt.configured, true)
    assert.equal(receipt.ok, false)
    assert.match(receipt.error, /nonzero: exit code 4/)
    assert.match(receipt.error, /malformed: malformed-output/)
    assert.match(receipt.error, /oversize: output exceeded 2048 bytes/)
    assert.match(receipt.error, /short: found 1 test\(s\), below minCount 2/)
    assert.match(receipt.error, /required: missing required test\(s\): gamma/)
    assert.match(receipt.error, /failing-json: 1 test\(s\) failed/)
    assert.match(receipt.error, /bad-json: malformed-output/)

    const byId = new Map(receipt.commands.map((command) => [command.id, command]))
    assert.equal(byId.get('nonzero').exitCode, 4)
    assert.equal(byId.get('malformed').ok, false)
    assert.equal(byId.get('oversize').ok, false)
    assert.equal(byId.get('short').count, 1)
    assert.deepEqual(byId.get('required').requiredMissing, ['gamma'])
    assert.equal(byId.get('failing-json').ok, false)
    assert.equal(byId.get('zero').ok, true, 'explicit minCount 0 tolerates an empty command')
    assert.equal(byId.get('bad-json').ok, false)
    assert.equal(fs.existsSync(receipt.receiptPath), true, 'diagnostics receipt is written for failures too')
    assert.equal(fs.existsSync(byId.get('oversize').stdoutPath), true)
  } finally {
    removeDir(worktree)
  }
})

test('runDiscovery: only explicit minCount 0 can tolerate an empty command, never zero total discovery', async () => {
  const worktree = makeWorktree()
  try {
    const empty = await runDiscovery({
      worktreePath: worktree,
      diagnosticsDir: path.join(worktree, 'diag'),
      config: tapConfig(printLines(['TAP version 13', '1..0']), { minCount: 0 }),
    })
    assert.equal(empty.commands[0].ok, true)
    assert.equal(empty.commands[0].count, 0)
    assert.equal(empty.ok, false)
    assert.match(empty.error, /test discovery produced zero tests/)
  } finally {
    removeDir(worktree)
  }
})

test('runDiscovery: timeout kills the command and reports a failed receipt', async () => {
  const worktree = makeWorktree()
  const diagnosticsDir = path.join(worktree, 'diagnostics')
  try {
    const started = Date.now()
    const receipt = await runDiscovery({
      worktreePath: worktree,
      diagnosticsDir,
      timeoutMs: 400,
      config: tapConfig(sleepCommand(30)),
    })
    assert.equal(receipt.ok, false)
    assert.equal(receipt.commands[0].ok, false)
    assert.match(receipt.commands[0].error, /timed out after 400ms/)
    assert.ok(Date.now() - started < 10000, 'timeout must not wait for the sleeping command')
  } finally {
    removeDir(worktree)
  }
})

test('runDiscovery: accepts the readDiscoveryConfig wrapper and an injected runner', async () => {
  const worktree = makeWorktree()
  const diagnosticsDir = path.join(worktree, 'diagnostics')
  try {
    const wrapper = readDiscoveryConfig(
      JSON.stringify({
        tower: {
          testDiscovery: {
            version: 1,
            commands: [{ id: 'fake', command: 'ignored', format: 'node-tap', required: ['beta'] }],
          },
        },
      }),
    )
    let seen = null
    const runner = async (payload) => {
      seen = payload
      fs.writeFileSync(payload.stdoutPath, 'TAP version 13\nok 1 - alpha\nok 2 - beta\n1..2\n')
      fs.writeFileSync(payload.stderrPath, '')
      return { exitCode: 0, signal: null, timedOut: false, overflow: false, spawnError: null, durationMs: 1 }
    }
    const receipt = await runDiscovery({
      worktreePath: worktree,
      config: wrapper,
      diagnosticsDir,
      runner,
      timeoutMs: 1234,
      maxBytes: 4096,
    })
    assert.equal(receipt.ok, true, receipt.error)
    assert.equal(receipt.commands[0].id, 'fake')
    assert.equal(receipt.commands[0].count, 2)
    assert.ok(seen)
    assert.equal(seen.command, 'ignored')
    assert.equal(seen.cwd, worktree)
    assert.equal(seen.timeoutMs, 1234)
    assert.equal(seen.maxBytes, 4096)
    assert.equal(seen.shell.file, isWindows ? 'pwsh' : 'bash')

    const failingRunner = async (payload) => {
      fs.writeFileSync(payload.stdoutPath, '')
      fs.writeFileSync(payload.stderrPath, 'boom')
      return { exitCode: 7, signal: null, timedOut: false, overflow: false, spawnError: null, durationMs: 1 }
    }
    const failed = await runDiscovery({
      worktreePath: worktree,
      config: wrapper,
      diagnosticsDir,
      runner: failingRunner,
    })
    assert.equal(failed.ok, false)
    assert.match(failed.commands[0].error, /exit code 7/)
  } finally {
    removeDir(worktree)
  }
})

test(
  'runDiscovery: records treeTip and defaults diagnostics under the git common dir',
  { skip: !gitAvailable() },
  async () => {
    const { root, repo } = makeGitRepo()
    try {
      const head = git(repo, ['rev-parse', 'HEAD'])
      const receipt = await runDiscovery({
        worktreePath: repo,
        config: tapConfig(printLines(['TAP version 13', 'ok 1 - alpha', '1..1'])),
      })
      assert.equal(receipt.treeTip, head)
      assert.equal(receipt.treeTipAfter, head)
      assert.equal(receipt.ok, true, receipt.error)
      assert.ok(receipt.diagnosticsPath.startsWith(path.join(repo, '.git', 'dsh-tower', 'test-runs')), receipt.diagnosticsPath)
      assert.equal(fs.existsSync(path.join(receipt.diagnosticsPath, 'receipt.json')), true)
    } finally {
      removeDir(root)
    }
  },
)
