// Nightly live-suite orchestrator (#47).
//
// CI provisions an isolated DSH_HOME under os.tmpdir(), installs the pinned
// @deepseek-ai/dsh host into DSH_HOST_DIR, and runs:
//
//   DSH_LIVE=1 DSH_HOST_DIR=<host> DSH_HOST_VERSION=<pin> node tests/live/run.cjs --script nightly
//
// This script creates a throwaway profile, adds this repository as its bundle,
// writes a `--patch` overlay that pins a writable first-use Workspace directory,
// boots the real Web app on a free loopback port, and hands the tokenized URL to
// boot-smoke.cjs (the browser proof). The server is always stopped afterwards.
// It never touches the operator's real profile: tests/live/_env.cjs refuses to
// load unless DSH_HOME is a disposable directory under os.tmpdir().
'use strict'

const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const env = require('./_env.cjs')

env.announce()

const { installHint, resolvePlaywright } = require('./resolve-playwright.cjs')
const { writeWorkspaceOverride } = require('./_workspace-override.cjs')

const REPO = path.resolve(process.env.DSH_REPO ?? path.join(__dirname, '..', '..'))
const HOST_DIR = process.env.DSH_HOST_DIR
const PROFILE = process.env.DSH_LIVE_PROFILE ?? 'tower-live'
const HOST_BIN = HOST_DIR ? path.join(HOST_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : null
const SERVER_TIMEOUT_MS = Number(process.env.DSH_LIVE_SERVER_TIMEOUT_MS ?? 180000)

if (!HOST_BIN || !fs.existsSync(HOST_BIN)) {
  console.error(`FAIL live nightly: DSH_HOST_DIR must name an installed @deepseek-ai/dsh host (looked for ${HOST_BIN ?? '<unset>'}).`)
  process.exit(1)
}
if (!resolvePlaywright()) {
  console.error(installHint())
  process.exit(2)
}

const childEnv = {
  ...process.env,
  DSH_HOME: env.DSH_HOME,
  DSH_TELEMETRY_DISABLED: '1',
  DSH_LIVE_ANNOUNCED: '1',
}

function runHost(label, args, timeout = 300000) {
  const result = spawnSync(process.execPath, [HOST_BIN, ...args], {
    cwd: REPO,
    env: childEnv,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.error) throw new Error(`${label}: ${result.error.message}\n${output.slice(-2000)}`)
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status}):\n${output.slice(-4000)}`)
  return output
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function waitForUrl(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out after ${timeoutMs}ms waiting for the tokenized URL; output:\n${buffer.slice(-3000)}`))
    }, timeoutMs)
    const onData = (chunk) => {
      buffer += chunk.toString()
      const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
      if (!match) return
      cleanup()
      resolve(match[0])
    }
    const onExit = (code, signal) => {
      cleanup()
      reject(new Error(`the DSH server exited before printing its URL (code=${code}, signal=${signal}); output:\n${buffer.slice(-3000)}`))
    }
    function cleanup() {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      child.off('exit', onExit)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', onExit)
  })
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (server.exitCode !== null || server.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      server.kill('SIGKILL')
      resolve()
    }, 5000)
    server.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    server.kill('SIGTERM')
  })
}

async function main() {
  console.log(`live nightly: host=${HOST_DIR} repo=${REPO} profile=${PROFILE}`)
  runHost('profile create', ['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'])
  // pnpm (installed by the CI job) is the plugin CLI's package manager.
  runHost('plugin add', ['plugin', '--profile', PROFILE, 'add', REPO], 600000)

  // (#47) A CI runner has no xdg Documents directory, so the workspace
  // controller cannot create its first-use default workspace and the Web shell
  // never reaches the composer. Pin the controller's documentsDirectory through
  // a `--patch` overlay under the isolated DSH_HOME. The overlay is a launcher
  // flag, so it must precede the inner app flags (`--port`, `--no-open`).
  const { documentsDirectory, overlayPath } = writeWorkspaceOverride({ dshHome: env.DSH_HOME })
  // Paths only: neither value is sensitive.
  console.log(`live nightly: documents=${documentsDirectory}`)
  console.log(`live nightly: workspace overlay=${overlayPath}`)

  const port = await freePort()
  const server = spawn(
    process.execPath,
    [HOST_BIN, '--profile', PROFILE, '--patch', overlayPath, '--port', String(port), '--no-open'],
    {
      cwd: REPO,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  try {
    const url = await waitForUrl(server, SERVER_TIMEOUT_MS)
    // Never print the token itself; CI logs are durable.
    console.log(`live nightly: server ready at ${url.replace(/token=[^&]+$/, 'token=<redacted>')}`)
    const smoke = spawnSync(process.execPath, [path.join(__dirname, 'boot-smoke.cjs')], {
      cwd: REPO,
      env: { ...childEnv, DSH_TEST_URL: url, DSH_LIVE_REQUIRE: '1' },
      stdio: 'inherit',
    })
    if (smoke.status !== 0) throw new Error(`boot-smoke failed (exit ${smoke.status ?? 'signal'})`)
  } finally {
    await stopServer(server)
  }
  console.log('PASS live nightly (isolated profile booted, browser smoke passed)')
}

main().catch((error) => {
  console.error(`FAIL live nightly: ${error.message}`)
  process.exitCode = 1
})
