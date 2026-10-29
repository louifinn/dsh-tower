#!/usr/bin/env node
// Entry point for the reproducible live suite (#87, #47).
//
//   npm run test:live                  # env guard, resolver, then a live script
//   npm run test:live -- --check       # env + resolution only, no browser, <10 s
//   npm run test:live -- --script hmr  # run one tests/live/*.cjs script
//   npm run test:live -- --list        # print the available live scripts
//   npm run test:live -- --help
//
// The guard runs before anything else: DSH_LIVE=1 and a DSH_HOME under
// os.tmpdir() (never the operator's real home or one of its profiles). The first
// stdout line names the resolved DSH_HOME and host version (#47). A missing
// Playwright install prints the two setup commands and exits 2 with no stack.
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { EXIT_MISSING, INSTALL_COMMANDS, installHint, resolvePlaywright } = require('./resolve-playwright.cjs')

const DEFAULT_SCRIPT = 'boot-smoke'

function usage() {
  return [
    'Usage: npm run test:live [-- [--check] [--script <name>] [--list] [--help]]',
    '',
    '  --check         validate the environment and Playwright resolution; no browser, no server',
    `  --script <n>    run tests/live/<n>.cjs (default: ${DEFAULT_SCRIPT})`,
    '  --list          list the live scripts that can be selected',
    '',
    'Environment: DSH_LIVE=1 and DSH_HOME=<fresh directory under os.tmpdir()>.',
    'Setup:       npm ci --prefix tests/live && npx --prefix tests/live playwright install chromium',
  ].join(os.EOL)
}

function parseArgs(argv) {
  const options = { check: false, list: false, help: false, script: DEFAULT_SCRIPT, rest: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--check') options.check = true
    else if (argument === '--list') options.list = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else if (argument === '--script') {
      const value = argv[index + 1]
      if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`--script needs a live script name, got ${JSON.stringify(value ?? null)}`)
      options.script = value
      index += 1
    } else if (argument === '--') {
      options.rest = argv.slice(index + 1)
      break
    } else {
      throw new Error(`unknown argument ${JSON.stringify(argument)}`)
    }
  }
  return options
}

function availableScripts() {
  return fs
    .readdirSync(__dirname)
    .filter((name) => name.endsWith('.cjs'))
    .map((name) => name.slice(0, -'.cjs'.length))
    .filter((name) => !['_env', '_guard', '_diagnostic-env', '_boot-diagnostics', 'resolve-playwright', 'run'].includes(name))
    .sort()
}

function printInstallHint() {
  console.error(installHint())
}

function printResolution(resolved) {
  if (resolved) {
    console.log(`live: playwright ${resolved.modulePath} (${resolved.source})`)
    return
  }
  console.log('live: playwright not installed (the live run needs it; --check does not)')
  console.log('live: setup commands:')
  for (const [index, command] of INSTALL_COMMANDS.entries()) console.log(`  ${index + 1}) ${command}`)
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`live suite: ${error.message}`)
  console.error(usage())
  process.exit(1)
}

if (options.help) {
  console.log(usage())
  process.exit(0)
}

// The environment guard is the first thing that runs (#47). Requiring the
// shared helper validates DSH_LIVE and the isolated DSH_HOME and computes the
// real home path used in the first output line.
let env
try {
  env = require('./_env.cjs')
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

env.announce()

if (options.list) {
  for (const name of availableScripts()) console.log(name)
  process.exit(0)
}

const resolved = resolvePlaywright()

if (options.check) {
  // Resolution + environment only: no browser, no server, and a clean clone
  // (no tests/live/node_modules) still passes. The point is to catch a rotted
  // harness on every push, not to require a Playwright install there.
  printResolution(resolved)
  console.log('live check: ok (environment valid, no browser launched)')
  process.exit(0)
}

if (!resolved) {
  printInstallHint()
  process.exit(EXIT_MISSING)
}

const scriptPath = path.join(__dirname, `${options.script}.cjs`)
if (!fs.existsSync(scriptPath)) {
  console.error(`live suite: no such live script: ${options.script}`)
  console.error(`live suite: available scripts: ${availableScripts().join(', ')}`)
  process.exit(1)
}

// The banner was already printed by this process; keep the child from printing
// it again while still carrying the same isolated environment through.
const childEnv = { ...process.env, DSH_LIVE_ANNOUNCED: '1' }
const result = spawnSync(process.execPath, [scriptPath, ...options.rest], {
  cwd: process.cwd(),
  env: childEnv,
  stdio: 'inherit',
})
if (result.error) {
  console.error(`live suite: could not start ${options.script}: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
