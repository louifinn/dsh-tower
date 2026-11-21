// Reviewer verification adapter (#202): run the fixed read-only whitelist in a
// mission worktree without a shell.
//
// This is the only module that spawns the verification commands. It takes
// already-validated checks (tools/verify.js owns the shape and path rules) and
// always spawns an argument array with `process.execPath`, so a path containing
// a shell metacharacter can never become syntax. Output is capped in memory so
// one noisy run cannot inflate the receipt or the state file.
import { createRequire } from 'node:module'
import path from 'node:path'

import { fs } from './store-fs.js'
import { testProcessEnv } from './tests.js'
import { spawn } from './vcs-git.js'

const OUTPUT_CAP = 64 * 1024
const SHARD_SIZE = 25
const SUMMARY_LIMIT = 240

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
      // best effort: the direct kill above already ended the process
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

function lastLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines.length > 0 ? lines[lines.length - 1].slice(0, SUMMARY_LIMIT) : ''
}

function countOf(text, pattern) {
  const match = pattern.exec(String(text ?? ''))
  return match ? Number(match[1]) : null
}

function summarize({ exitCode, timedOut, spawnError, truncated, timeoutMs, stdout, stderr }) {
  if (timedOut) return `timed out after ${timeoutMs}ms`
  if (spawnError) return `could not start the check: ${String(spawnError.message ?? spawnError).slice(0, SUMMARY_LIMIT)}`
  const passed = countOf(stdout, /# pass (\d+)/) ?? countOf(stdout, /ℹ pass (\d+)/)
  const failed = countOf(stdout, /# fail (\d+)/) ?? countOf(stdout, /ℹ fail (\d+)/)
  if (exitCode === 0 && passed !== null) {
    return `${passed} passed${failed ? `, ${failed} failed` : ''}${truncated ? ' [output truncated]' : ''}`
  }
  if (failed) {
    const detail = lastLine(stderr) || lastLine(stdout)
    return `${failed} failed${detail ? `: ${detail}` : ''}${truncated ? ' [output truncated]' : ''}`
  }
  const detail = lastLine(stderr) || lastLine(stdout)
  const headline = `exit code ${exitCode === null ? 'unknown' : exitCode}`
  return `${headline}${detail ? `: ${detail}` : ''}${truncated ? ' [output truncated]' : ''}`
}

/**
 * Run one command with no shell, capturing a bounded amount of both streams and
 * killing the whole process tree on timeout.
 *
 * @param {{ file: string, args: string[], cwd: string, timeoutMs: number }} options
 */
function runProcess({ file, args, cwd, timeoutMs }) {
  const started = Date.now()
  return new Promise((resolve) => {
    let settled = false
    /** @type {import('node:child_process').ChildProcess | null} */
    let child = null
    let timer = null
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let spawnError = null
    let exitCode = null
    let signal = null

    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ exitCode, signal, timedOut, spawnError, truncated, stdout, stderr, durationMs: Date.now() - started })
    }
    const collect = (kind, chunk) => {
      const used = kind === 'stdout' ? stdout.length : stderr.length
      const remaining = OUTPUT_CAP - used
      if (remaining <= 0) {
        truncated = true
        return
      }
      const text = chunk.toString('utf8')
      const slice = text.length > remaining ? text.slice(0, remaining) : text
      if (text.length > remaining) truncated = true
      if (kind === 'stdout') stdout += slice
      else stderr += slice
    }

    try {
      child = spawn(file, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: testProcessEnv(),
      })
    } catch (error) {
      spawnError = error
      finish()
      return
    }

    timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (chunk) => collect('stdout', chunk))
    child.stderr?.on('data', (chunk) => collect('stderr', chunk))
    child.on('error', (error) => {
      spawnError = error
      finish()
    })
    child.on('close', (code, closeSignal) => {
      exitCode = code
      signal = closeSignal
      finish()
    })
  })
}

/** The TypeScript compiler shipped with the worktree's own dependencies. */
function tscEntry(worktreePath) {
  const modules = path.join(worktreePath, 'node_modules')
  // Never fall back to a global/npx typescript: a reviewer must not report a
  // green type check from a compiler version the mission never installed.
  if (!fs.existsSync(modules)) {
    return {
      error:
        "the mission worktree has no node_modules, so it cannot resolve its own typescript; install the repository dependencies, or run tower_spawn with spawn.nodeModules: 'link' so the worktree can resolve the baseline checkout's node_modules",
    }
  }
  try {
    const require = createRequire(path.join(worktreePath, 'package.json'))
    const entry = require.resolve('typescript', { paths: [modules] })
    const bin = path.join(path.dirname(entry), '..', 'bin', 'tsc')
    if (!fs.existsSync(bin)) return { error: `the resolved typescript package has no bin/tsc at ${bin}` }
    return { bin }
  } catch (error) {
    return {
      error:
        "typescript is not installed in this mission worktree's node_modules; install the repository dependencies, or run tower_spawn with spawn.nodeModules: 'link' so the worktree can resolve the baseline checkout's node_modules",
      detail: String(error?.message ?? error),
    }
  }
}

function baseResult(check, command, extra) {
  return { check, command, exitCode: null, durationMs: 0, summary: '', truncated: false, ...extra }
}

async function runTests(check, { worktreePath, timeoutMs }) {
  const missing = check.files.filter((file) => !fs.existsSync(path.join(worktreePath, file)))
  const command = `node --test ${check.files.join(' ')}`
  if (missing.length > 0) {
    return baseResult(check.label, command, {
      status: 'failed',
      summary: `test file not found in the mission worktree: ${missing.join(', ')}`,
    })
  }
  const run = await runProcess({
    file: process.execPath,
    args: ['--test', ...check.files],
    cwd: worktreePath,
    timeoutMs,
  })
  const status = run.timedOut ? 'timeout' : run.spawnError ? 'error' : run.exitCode === 0 ? 'passed' : 'failed'
  return baseResult(check.label, command, {
    status,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    summary: summarize({ ...run, timeoutMs }),
    truncated: run.truncated,
  })
}

async function runTsc(check, { worktreePath, timeoutMs }) {
  const resolved = tscEntry(worktreePath)
  const command = resolved.bin ? `node ${path.relative(worktreePath, resolved.bin).split(path.sep).join('/')} --noEmit` : 'node <typescript>/bin/tsc --noEmit'
  if (resolved.error || !resolved.bin) {
    return baseResult(check.label, command, {
      status: 'unavailable',
      summary: `${resolved.error}${resolved.detail ? ` (${resolved.detail})` : ''}`,
    })
  }
  const run = await runProcess({
    file: process.execPath,
    args: [resolved.bin, '--noEmit'],
    cwd: worktreePath,
    timeoutMs,
  })
  const status = run.timedOut ? 'timeout' : run.spawnError ? 'error' : run.exitCode === 0 ? 'passed' : 'failed'
  return baseResult(check.label, command, {
    status,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    summary: summarize({ ...run, timeoutMs }),
    truncated: run.truncated,
  })
}

async function runShard(check, { worktreePath, timeoutMs }) {
  const files = fs.globSync('tests/*.test.mjs', { cwd: worktreePath }).map((file) => file.split(path.sep).join('/')).sort()
  const batches = []
  for (let index = 0; index < files.length; index += SHARD_SIZE) batches.push(files.slice(index, index + SHARD_SIZE))
  const batch = check.batch ?? 1
  const label = `shards:${batch}`
  if (batches.length === 0) {
    return baseResult(label, 'node --test', { status: 'failed', summary: 'no tests/*.test.mjs files found in the mission worktree' })
  }
  if (batch > batches.length) {
    return baseResult(label, 'node --test', {
      status: 'failed',
      summary: `shard batch ${batch} does not exist: the plan has ${batches.length} batch(es) of at most ${SHARD_SIZE} files`,
    })
  }
  const batchFiles = batches[batch - 1]
  const command = `node --test ${batchFiles.join(' ')}`
  const run = await runProcess({
    file: process.execPath,
    args: ['--test', ...batchFiles],
    cwd: worktreePath,
    timeoutMs,
  })
  const status = run.timedOut ? 'timeout' : run.spawnError ? 'error' : run.exitCode === 0 ? 'passed' : 'failed'
  return baseResult(label, command, {
    status,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    summary: `shard batch ${batch}/${batches.length} of at most ${SHARD_SIZE} files: ${summarize({ ...run, timeoutMs })}`,
    truncated: run.truncated,
  })
}

/**
 * Run the validated checks sequentially in one mission worktree. A failing check
 * never stops the next one: the reviewer needs the whole picture, and each
 * result is recorded independently.
 *
 * @param {{
 *   worktreePath: string,
 *   timeoutMs?: number,
 *   checks: ({ label: string } & ({ kind: 'tests', files: string[] } | { kind: 'tsc' } | { kind: 'shards', batch?: number }))[],
 * }} options
 */
export async function runVerification(options) {
  const worktreePath = options.worktreePath
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 120000
  const results = []
  for (const check of options.checks ?? []) {
    if (check.kind === 'tests') results.push({ ...(await runTests(check, { worktreePath, timeoutMs })), kind: 'tests', files: check.files })
    else if (check.kind === 'tsc') results.push({ ...(await runTsc(check, { worktreePath, timeoutMs })), kind: 'tsc' })
    else if (check.kind === 'shards') results.push({ ...(await runShard(check, { worktreePath, timeoutMs })), kind: 'shards', batch: check.batch ?? 1 })
    else {
      results.push(baseResult('unknown', '', { status: 'error', summary: 'unsupported check kind' }))
    }
  }
  return results
}

export const VERIFY_SHARD_SIZE = SHARD_SIZE
export const VERIFY_OUTPUT_CAP = OUTPUT_CAP
