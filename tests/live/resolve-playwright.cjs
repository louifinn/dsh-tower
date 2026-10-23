// Resolve Playwright for the opt-in live suite without assuming a global install.
//
// Search order (#87):
//   1. tests/live/node_modules        — the reproducible install (`npm ci --prefix tests/live`)
//   2. NODE_PATH                      — the documented fallback (a global install)
//
// Every live script goes through `loadOrExit()` instead of a bare
// `require('playwright')`, so a missing install is one readable instruction, not
// a MODULE_NOT_FOUND stack trace. The exit code is 2 and the message names the
// two setup commands verbatim.
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const LIVE_DIR = __dirname
const PACKAGE = 'playwright'

/** The two commands that make the live suite runnable, in order. */
const INSTALL_COMMANDS = [
  'npm ci --prefix tests/live',
  // Run the CLI from the pinned local install, exactly as tests/README.md and
  // CI do. A bare `npx playwright` would fetch whatever latest version npx
  // finds, which defeats the lockfile.
  'npx --prefix tests/live playwright install chromium',
]

const EXIT_MISSING = 2

function installHint() {
  return [
    'live suite: Playwright is not installed.',
    'Run these two commands from the repository root, then re-run `npm run test:live`:',
    ...INSTALL_COMMANDS.map((command, index) => `  ${index + 1}) ${command}`),
    'A global install still works as a fallback: put its node_modules directory on NODE_PATH.',
  ].join(os.EOL)
}

/**
 * Resolve `playwright` from tests/live/node_modules, then NODE_PATH.
 *
 * The check is deliberately a direct lookup of `<dir>/playwright/package.json`
 * rather than `require.resolve`: Node's resolver falls back to its own global
 * folders, which would attribute a machine-global install to `tests/live` and
 * make a missing install look present. Only an explicit NODE_PATH directory is
 * accepted as the fallback.
 *
 * @param {{liveDir?: string, env?: Record<string, string | undefined>}} [options]
 * @returns {{modulePath: string, source: 'tests/live' | 'NODE_PATH', searchDir: string} | null}
 */
function resolvePlaywright(options = {}) {
  const liveDir = options.liveDir ?? LIVE_DIR
  const env = options.env ?? process.env
  const candidates = [
    { dir: path.join(liveDir, 'node_modules'), source: 'tests/live' },
    ...String(env.NODE_PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => ({ dir: path.resolve(dir), source: 'NODE_PATH' })),
  ]

  for (const candidate of candidates) {
    const modulePath = path.join(candidate.dir, PACKAGE)
    const manifest = path.join(modulePath, 'package.json')
    try {
      if (fs.existsSync(manifest) && fs.statSync(manifest).isFile()) {
        return { modulePath, source: candidate.source, searchDir: candidate.dir }
      }
    } catch {
      // Unreadable candidate; try the next one.
    }
  }
  return null
}

/**
 * Load the resolved Playwright package, or explain exactly what to install.
 *
 * @returns {{playwright: unknown, modulePath: string, source: string, searchDir: string}}
 */
function loadOrExit(options) {
  const resolved = resolvePlaywright(options)
  if (resolved) {
    return { playwright: require(resolved.modulePath), ...resolved }
  }
  // No stack trace on purpose: a missing install is an instruction, not a bug.
  console.error(installHint())
  process.exit(EXIT_MISSING)
}

module.exports = {
  EXIT_MISSING,
  INSTALL_COMMANDS,
  PACKAGE,
  installHint,
  loadOrExit,
  resolvePlaywright,
}
