import { TowerToolError } from './errors.js'
// Tower test discovery (2.1): fail-closed admission evidence from the
// repository's own `package.json` `tower.testDiscovery` block.
//
// Trust boundary: every configured command executes repository-controlled code
// inside the mission worktree. Only enable discovery for repositories you
// trust (`tests.allowPackageDiscovery`, documented in the security guide).
// This module never touches the network and never mutates the state store.
//
// Contract (implemented exactly by the 2.1 plan):
//   readDiscoveryConfig(pkgJsonText) -> { configured, config, error }
//   normalizeDiscovery(config)       -> { version, ok, commands, error }
//   parseTap(stdout)                 -> { tests, ok, count, failed, topLevel, plan, error }
//   parseJsonArray(stdout)           -> { tests, ok, count, failed, error }
//   runDiscovery(options)            -> receipt (see below)
//
// Exit paths are intentionally split:
// - a test failure (nonzero exit, malformed output, timeout, oversize,
//   minCount/required shortfall) returns `ok: false` in the receipt;
// - an invalid discovery configuration (or invalid call arguments) throws a
//   plain `Error`, which the tool layer wraps as `tower:invalid-argument`.
import { spawn } from '../adapters/vcs-git.js'
import { createWriteStream } from '../adapters/store-fs.js'
import crypto from 'node:crypto'
import { fsp } from '../adapters/store-fs.js'
import path from 'node:path'

import { tryGit } from './git.js'

export const DISCOVERY_FORMATS = ['node-tap', 'json-array']
export const DEFAULT_TIMEOUT_MS = 60000
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024

const MAX_COMMANDS = 20
const MAX_COMMAND_LENGTH = 4000
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PASS_STATUSES = new Set(['passed', 'pass', 'ok', 'success', 'succeeded', 'done', 'green'])
const FAIL_STATUSES = new Set(['failed', 'fail', 'error', 'errored', 'timeout', 'timed-out', 'blocked'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new TowerToolError('invalid-argument', `${name} must be an integer > 0`)
  return value
}

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'command'
}

function stamp(date) {
  return date.toISOString().replace(/[-:.]/g, '')
}

/**
 * Read `tower.testDiscovery` from package.json text.
 * Returns `{ configured, config, error }`; `configured:false` only means the
 * repository did not opt in (compat), never that discovery succeeded.
 */
export function readDiscoveryConfig(pkgJsonText) {
  if (typeof pkgJsonText !== 'string' || pkgJsonText.trim().length === 0) {
    return { configured: false, config: null, error: 'package.json is empty' }
  }
  let pkg
  try {
    pkg = JSON.parse(pkgJsonText)
  } catch (error) {
    return { configured: false, config: null, error: `package.json is not valid JSON: ${error.message}` }
  }
  if (!isPlainObject(pkg)) {
    return { configured: false, config: null, error: 'package.json must contain a JSON object' }
  }
  const tower = isPlainObject(pkg.tower) ? pkg.tower : null
  const discovery = tower ? tower.testDiscovery : undefined
  if (discovery === undefined || discovery === null) {
    return { configured: false, config: null, error: null }
  }
  return { configured: true, config: discovery, error: null }
}

/**
 * Validate and normalize a `tower.testDiscovery` value (Tower Codex version 1):
 * `{ version: 1, commands: [{ id, command, format, minCount?, required? }] }`.
 * Returns `{ version, ok, commands, error }`; never throws.
 * Defaults: `minCount: 1` (zero discovery is rejected unless explicitly relaxed),
 * `required: []`. The normalized value is accepted again by this function.
 */
export function normalizeDiscovery(config) {
  const fail = (message) => ({ version: 1, ok: false, commands: [], error: message })
  if (!isPlainObject(config)) return fail('tower.testDiscovery must be an object')
  if (config.version !== 1) return fail('tower.testDiscovery.version must be one of: 1')
  if (!Array.isArray(config.commands)) return fail('tower.testDiscovery.commands must be a non-empty array')
  if (config.commands.length === 0) return fail('tower.testDiscovery.commands must be a non-empty array')
  if (config.commands.length > MAX_COMMANDS) {
    return fail(`tower.testDiscovery.commands must have at most ${MAX_COMMANDS} entries`)
  }

  const commands = []
  const ids = new Set()
  for (const [index, raw] of config.commands.entries()) {
    const where = `tower.testDiscovery.commands[${index}]`
    if (!isPlainObject(raw)) return fail(`${where} must be an object`)
    if (!nonEmptyString(raw.id)) return fail(`${where}.id must be a non-empty string`)
    const id = raw.id.trim()
    if (!COMMAND_ID_PATTERN.test(id)) {
      return fail(`${where}.id must match ${COMMAND_ID_PATTERN} (letters, digits, dot, dash, underscore)`)
    }
    if (ids.has(id)) return fail(`${where}.id must not duplicate command id "${id}"`)
    ids.add(id)
    if (!nonEmptyString(raw.command)) return fail(`${where}.command must be a non-empty string`)
    const command = raw.command.trim()
    if (command.length > MAX_COMMAND_LENGTH) {
      return fail(`${where}.command must be at most ${MAX_COMMAND_LENGTH} characters`)
    }
    if (!DISCOVERY_FORMATS.includes(raw.format)) {
      return fail(`${where}.format must be one of: ${DISCOVERY_FORMATS.join(', ')}`)
    }
    let minCount = 1
    if (raw.minCount !== undefined) {
      if (!Number.isInteger(raw.minCount) || raw.minCount < 0) {
        return fail(`${where}.minCount must be an integer >= 0`)
      }
      minCount = raw.minCount
    }
    const required = []
    if (raw.required !== undefined) {
      if (!Array.isArray(raw.required)) return fail(`${where}.required must be an array of test names`)
      for (const [requiredIndex, name] of raw.required.entries()) {
        if (!nonEmptyString(name)) {
          return fail(`${where}.required[${requiredIndex}] must be a non-empty string`)
        }
        const trimmed = name.trim()
        if (required.includes(trimmed)) {
          return fail(`${where}.required must not duplicate test name "${trimmed}"`)
        }
        required.push(trimmed)
      }
    }
    commands.push({ id, command, format: raw.format, minCount, required })
  }
  return { version: 1, ok: true, commands, error: null }
}

/**
 * Parse node-tap output. Counts every test point (nested `node --test` subtests
 * are included) while validating the top-level TAP plan against top-level
 * points only. Failures return `ok:false` plus an `error`; skip/TODO points are
 * tolerated the way TAP defines them.
 */
export function parseTap(stdout) {
  const text = typeof stdout === 'string' ? stdout : ''
  const points = []
  let plan = null
  let sawHeader = false
  let bailout = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '')
    if (/^TAP version \d+\s*$/i.test(line)) {
      sawHeader = true
      continue
    }
    if (/^Bail out!/.test(line)) {
      bailout = true
      continue
    }
    // The `(?=\s|$)` lookahead keeps YAML diagnostics lines such as
    // `    ok: true` from being mistaken for test points.
    const point = /^(\s*)(not ok|ok)\b(?=\s|$)(?:\s+(\d+))?(?:\s*-\s*)?(.*)$/.exec(line)
    if (point) {
      const [, indent, marker, , rest] = point
      let name = rest.trim()
      let directive = null
      const directiveMatch = /\s+#\s*(SKIP|TODO)\b.*$/i.exec(name)
      if (directiveMatch) {
        directive = directiveMatch[1].toUpperCase()
        name = name.slice(0, directiveMatch.index).trim()
      }
      const rawOk = marker === 'ok'
      points.push({ name, ok: rawOk || directive !== null, rawOk, topLevel: indent.length === 0, directive })
      continue
    }
    const planMatch = /^(\s*)1\.\.(\d+)\s*(?:#.*)?$/.exec(line)
    if (planMatch && planMatch[1].length === 0) plan = Number(planMatch[2])
  }

  const tests = points.map((point) => {
    const entry = { name: point.name, ok: point.ok }
    if (point.directive) entry.directive = point.directive
    return entry
  })
  const topLevel = points.filter((point) => point.topLevel).length
  const failed = tests.filter((test) => !test.ok).length
  let error = null
  if (bailout) error = 'TAP bail out'
  else if (plan === null && points.length === 0) error = 'no TAP test points found'
  else if (plan !== null && plan !== topLevel) {
    error = `TAP plan says ${plan} but ${topLevel} top-level test point(s) were found`
  }
  return { tests, ok: error === null && failed === 0, count: tests.length, failed, topLevel, plan, error }
}

/**
 * Parse the `json-array` format: a JSON array of test entries. Entries may be
 * plain name strings or objects carrying `{ name|title|test, ok|pass|success|
 * status|exitCode }`.
 */
export function parseJsonArray(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : ''
  const fail = (error) => ({ tests: [], ok: false, count: 0, failed: 0, error })
  if (text.length === 0) return fail('empty output')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return fail(`output is not valid JSON: ${error.message}`)
  }
  if (!Array.isArray(parsed)) return fail('output must be a JSON array of tests')

  const tests = []
  for (const [index, entry] of parsed.entries()) {
    if (typeof entry === 'string') {
      const name = entry.trim()
      if (name.length === 0) return fail(`entries[${index}] must be a non-empty test name`)
      tests.push({ name, ok: true })
      continue
    }
    if (!isPlainObject(entry)) return fail(`entries[${index}] must be an object or a test name string`)
    const name = [entry.name, entry.title, entry.test].find(nonEmptyString)
    if (!name) return fail(`entries[${index}] has no non-empty name`)
    let ok
    if (typeof entry.ok === 'boolean') ok = entry.ok
    else if (typeof entry.pass === 'boolean') ok = entry.pass
    else if (typeof entry.success === 'boolean') ok = entry.success
    else if (typeof entry.status === 'string') {
      const status = entry.status.trim().toLowerCase()
      if (PASS_STATUSES.has(status)) ok = true
      else if (FAIL_STATUSES.has(status)) ok = false
    } else if (entry.exitCode !== undefined && entry.exitCode !== null) {
      ok = Number(entry.exitCode) === 0
    }
    if (ok === undefined) {
      return fail(`entries[${index}] must have a boolean ok/pass field or a pass/fail status`)
    }
    tests.push({ name: name.trim(), ok })
  }
  const failed = tests.filter((test) => !test.ok).length
  return { tests, ok: failed === 0, count: tests.length, failed, error: null }
}

/** Test discovery is repository-controlled code: do not hand it secrets. */
const TEST_ENV_ALLOW = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'HOME',
  'USERPROFILE',
  'TMP',
  'TEMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SHELL',
  'TERM',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'NODE_PATH',
])

export function testProcessEnv(source = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (!TEST_ENV_ALLOW.has(key)) continue
    env[key] = value
  }
  return env
}

/** Platform shell for discovery commands (PowerShell 7 on Windows, bash on POSIX). */
function shellSpec(platform = process.platform) {
  if (platform === 'win32') {
    const args = (command) => ['-NoProfile', '-NonInteractive', '-Command', command]
    return {
      file: 'pwsh',
      args,
      fallback: { file: 'powershell', args },
    }
  }
  return { file: 'bash', args: (command) => ['-lc', command], fallback: null }
}

function killTree(child) {
  if (!child || !child.pid) return
  if (process.platform === 'win32') {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('error', () => {})
      killer.unref()
    } catch {
      // best effort: the direct kill above already ended the shell
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

function closeStreams(streams) {
  return Promise.all(
    streams.map(
      (stream) =>
        new Promise((resolve) => {
          if (stream.closed || stream.destroyed) {
            resolve()
            return
          }
          stream.once('close', resolve)
          stream.once('error', resolve)
          stream.end()
        }),
    ),
  )
}

/**
 * Default runner: execute one command with the platform shell, streaming both
 * outputs to the given files under a combined `maxBytes` cap. Resolves with
 * `{ exitCode, signal, timedOut, overflow, spawnError, durationMs }`.
 * Tests may inject their own `runner` with the same input/result shape.
 */
function spawnToFiles({ command, cwd, timeoutMs, maxBytes, stdoutPath, stderrPath, shell }) {
  const started = Date.now()
  const stdout = createWriteStream(stdoutPath, { flags: 'w' })
  const stderr = createWriteStream(stderrPath, { flags: 'w' })
  for (const stream of [stdout, stderr]) stream.on('error', () => {})

  return new Promise((resolve) => {
    let settled = false
    let child = null
    let timer = null
    let stdoutBytes = 0
    let stderrBytes = 0
    let overflow = false
    let timedOut = false
    let spawnError = null
    let lastCode = null
    let lastSignal = null

    const result = () => ({ exitCode: lastCode, signal: lastSignal, timedOut, overflow, spawnError, durationMs: Date.now() - started })
    const settle = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      closeStreams([stdout, stderr]).then(() => resolve(result()))
    }
    const stop = (reason) => {
      if (reason === 'timeout') timedOut = true
      else overflow = true
      killTree(child)
    }
    // Each stream is capped independently at maxBytes (the configured
    // "captured stdout/stderr bytes per command" budget).
    const writeChunk = (stream, chunk, kind) => {
      if (overflow || settled) return
      const used = kind === 'stdout' ? stdoutBytes : stderrBytes
      const remaining = maxBytes - used
      if (remaining <= 0) {
        stop('overflow')
        return
      }
      if (chunk.length > remaining) {
        stream.write(chunk.subarray(0, remaining))
        if (kind === 'stdout') stdoutBytes = maxBytes
        else stderrBytes = maxBytes
        stop('overflow')
        return
      }
      stream.write(chunk)
      if (kind === 'stdout') stdoutBytes += chunk.length
      else stderrBytes += chunk.length
    }

    try {
      child = spawn(shell.file, shell.args(command), {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // POSIX: a process group lets a timeout kill grandchildren too.
        detached: process.platform !== 'win32',
        env: testProcessEnv(),
      })
    } catch (error) {
      spawnError = error
      settle()
      return
    }

    child.stdout?.on('data', (chunk) => writeChunk(stdout, chunk, 'stdout'))
    child.stderr?.on('data', (chunk) => writeChunk(stderr, chunk, 'stderr'))
    child.once('error', (error) => {
      spawnError = error
      settle()
    })
    child.once('close', (code, signal) => {
      lastCode = typeof code === 'number' ? code : null
      lastSignal = signal ?? null
      settle()
    })
    timer = setTimeout(() => stop('timeout'), timeoutMs)
  })
}

async function readFileOrEmpty(file) {
  try {
    return await fsp.readFile(file)
  } catch {
    return Buffer.alloc(0)
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

async function readTreeTip(worktreePath) {
  const tip = await tryGit(worktreePath, ['rev-parse', 'HEAD'])
  return tip && tip.trim() ? tip.trim() : null
}

async function resolveCommonDir(worktreePath) {
  const raw = await tryGit(worktreePath, ['rev-parse', '--git-common-dir'])
  if (!raw || !raw.trim()) return null
  return path.isAbsolute(raw.trim()) ? path.resolve(raw.trim()) : path.resolve(worktreePath, raw.trim())
}

async function resolveDiagnosticsDir({ worktreePath, diagnosticsDir, missionId }) {
  if (diagnosticsDir) {
    await fsp.mkdir(diagnosticsDir, { recursive: true })
    return diagnosticsDir
  }
  const now = new Date()
  const suffix = stamp(now)
  const mission = safeSegment(missionId ?? path.basename(worktreePath))
  const commonDir = await resolveCommonDir(worktreePath)
  if (commonDir) {
    const dir = path.join(commonDir, 'dsh-tower', 'test-runs', `${mission}-${suffix}`)
    await fsp.mkdir(dir, { recursive: true })
    return dir
  }
  const dir = path.join(worktreePath, '.tower-discovery-diagnostics', `${mission}-${suffix}`)
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

function normalizeDiscoveryInput(config) {
  if (isPlainObject(config) && Object.prototype.hasOwnProperty.call(config, 'configured')) {
    if (config.error) throw new TowerToolError('invalid-argument', `test discovery configuration is invalid: ${config.error}`)
    if (config.configured === false) return { configured: false, config: null, error: null }
    return { configured: true, config: config.config, error: null }
  }
  if (config === undefined || config === null) return { configured: false, config: null, error: null }
  return { configured: true, config, error: null }
}

/**
 * Run the declared discovery commands inside `worktreePath` and return a
 * fail-closed receipt:
 *
 * {
 *   configured, ok, commands: [{
 *     id, format, command, exitCode,
 *     stdoutPath, stderrPath, stdoutSha256, stderrSha256,
 *     count, requiredMissing, error, ok, durationMs
 *   }],
 *   tests: [{ name, ok }], treeTip, treeTipAfter,
 *   startedAt, finishedAt, diagnosticsPath, receiptPath, error
 * }
 *
 * Options:
 * - `diagnosticsDir` overrides where the receipt/stdout/stderr are written.
 *   When omitted, diagnostics go under
 *   `<git-common-dir>/dsh-tower/test-runs/<worktree>-<stamp>/` (2.1 spec) and
 *   fall back to `<worktree>/.tower-discovery-diagnostics/<stamp>/` when the
 *   worktree is not a Git repository.
 * - `runner` replaces the default shell runner (same input/result shape);
 *   used by tests and by callers that already own process execution.
 * - `missionId` only labels the fallback diagnostics path.
 *
 * Invalid call arguments and invalid discovery configurations throw; test
 * failures never throw and are reported in the receipt.
 */
export async function runDiscovery(options = {}) {
  const {
    worktreePath,
    config,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    runner,
    diagnosticsDir,
    missionId,
  } = options
  const startedAt = new Date().toISOString()

  if (!nonEmptyString(worktreePath)) throw new TowerToolError('invalid-argument', 'worktreePath is required')
  if (!path.isAbsolute(worktreePath)) throw new TowerToolError('invalid-argument', `worktreePath must be an absolute path: ${worktreePath}`)
  const effectiveTimeout = normalizePositiveInteger(timeoutMs, 'timeoutMs')
  const effectiveMaxBytes = normalizePositiveInteger(maxBytes, 'maxBytes')
  if (runner !== undefined && runner !== null && typeof runner !== 'function') {
    throw new TowerToolError('invalid-argument', 'runner must be a function')
  }
  if (diagnosticsDir !== undefined && diagnosticsDir !== null) {
    if (!nonEmptyString(diagnosticsDir) || !path.isAbsolute(diagnosticsDir)) {
      throw new TowerToolError('invalid-argument', `diagnosticsDir must be an absolute path: ${diagnosticsDir}`)
    }
  }

  const discovery = normalizeDiscoveryInput(config)
  const treeTip = await readTreeTip(worktreePath)
  const finishUnconfigured = (error) => ({
    configured: false,
    ok: false,
    commands: [],
    tests: [],
    treeTip,
    treeTipAfter: treeTip,
    startedAt,
    finishedAt: new Date().toISOString(),
    diagnosticsPath: null,
    receiptPath: null,
    error: error ?? 'test discovery is not configured',
  })

  if (!discovery.configured) return finishUnconfigured(discovery.error)
  const normalized = normalizeDiscovery(discovery.config)
  if (!normalized.ok) throw new TowerToolError('invalid-argument', `invalid tower.testDiscovery config: ${normalized.error}`)

  const dir = await resolveDiagnosticsDir({ worktreePath, diagnosticsDir, missionId })
  const commands = []
  const tests = []
  const failures = []
  const shell = shellSpec()

  for (const [index, command] of normalized.commands.entries()) {
    const base = `${String(index + 1).padStart(2, '0')}-${safeSegment(command.id)}`
    const stdoutPath = path.join(dir, `${base}.stdout.log`)
    const stderrPath = path.join(dir, `${base}.stderr.log`)
    const runStarted = Date.now()

    let result
    try {
      const payload = {
        command: command.command,
        cwd: worktreePath,
        timeoutMs: effectiveTimeout,
        maxBytes: effectiveMaxBytes,
        stdoutPath,
        stderrPath,
        shell,
      }
      if (runner) {
        result = await runner(payload)
      } else {
        result = await spawnToFiles(payload)
        if (result.spawnError?.code === 'ENOENT' && shell.fallback) {
          result = await spawnToFiles({ ...payload, shell: shell.fallback })
        }
      }
    } catch (error) {
      result = { exitCode: null, signal: null, timedOut: false, overflow: false, spawnError: error, durationMs: Date.now() - runStarted }
    }

    const stdout = await readFileOrEmpty(stdoutPath)
    const stderr = await readFileOrEmpty(stderrPath)
    let parsed = null
    let error = null
    let requiredMissing = []

    if (result.spawnError) {
      error = `spawn failed: ${result.spawnError.message}`
    } else if (result.timedOut) {
      error = `timed out after ${effectiveTimeout}ms`
    } else if (result.overflow) {
      error = `output exceeded ${effectiveMaxBytes} bytes`
    } else if (result.exitCode !== 0) {
      error = `exit code ${result.exitCode ?? 'unknown'}`
    } else {
      parsed = command.format === 'node-tap' ? parseTap(stdout.toString('utf8')) : parseJsonArray(stdout.toString('utf8'))
      requiredMissing = command.required.filter((name) => !parsed.tests.some((test) => test.name === name))
      if (parsed.error) error = `malformed-output: ${parsed.error}`
      else if (parsed.failed > 0) error = `${parsed.failed} test(s) failed`
      else if (parsed.count < command.minCount) error = `found ${parsed.count} test(s), below minCount ${command.minCount}`
      else if (requiredMissing.length > 0) error = `missing required test(s): ${requiredMissing.join(', ')}`
    }

    if (parsed) tests.push(...parsed.tests)
    commands.push({
      id: command.id,
      format: command.format,
      command: command.command,
      exitCode: result.exitCode ?? null,
      stdoutPath,
      stderrPath,
      stdoutSha256: sha256(stdout),
      stderrSha256: sha256(stderr),
      count: parsed ? parsed.count : 0,
      requiredMissing,
      error,
      ok: error === null,
      durationMs: Date.now() - runStarted,
    })
    if (error) failures.push(`${command.id}: ${error}`)
  }

  const treeTipAfter = await readTreeTip(worktreePath)
  if (treeTip && treeTipAfter && treeTip !== treeTipAfter) {
    failures.push(`worktree HEAD moved during test discovery (${treeTip} -> ${treeTipAfter})`)
  }
  if (tests.length === 0) failures.push('test discovery produced zero tests')

  const receiptPath = path.join(dir, 'receipt.json')
  const receipt = {
    configured: true,
    ok: failures.length === 0,
    commands,
    tests,
    treeTip,
    treeTipAfter,
    startedAt,
    finishedAt: new Date().toISOString(),
    diagnosticsPath: dir,
    receiptPath,
    error: failures.length > 0 ? failures.join('; ') : null,
  }
  await fsp.writeFile(receiptPath, JSON.stringify(receipt, null, 2), 'utf8')
  return receipt
}
