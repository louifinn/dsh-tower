// Shared environment for the opt-in live suite (#47, #87).
//
// Requiring this module is the entry guard: it asserts, before a single browser
// or server is touched, that DSH_LIVE=1 and that DSH_HOME is a disposable
// directory under os.tmpdir() (never the operator's real DSH_HOME or one of its
// profiles). Scripts that need a raw Playwright import use
// `./resolve-playwright.cjs`, never `require('playwright')`.
//
// Read-only session diagnostics intentionally target the operator's real
// $DSH_HOME and use `./_diagnostic-env.cjs` instead.
'use strict'

const os = require('node:os')
const path = require('node:path')

const { assertIsolatedHome, announceLine, hostVersion } = require('./_guard.cjs')

if (process.env.DSH_LIVE !== '1') {
  throw new Error('Live suite is opt-in: set DSH_LIVE=1 and an isolated DSH_HOME before running tests/live scripts. Run the live suite with `npm run test:live`.')
}

const DSH_HOME = assertIsolatedHome()

function sessionRoot() {
  if (process.env.DSH_SESSION_ROOT) return process.env.DSH_SESSION_ROOT
  const slug = `--${process.cwd().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}--`
  return path.join(DSH_HOME, 'sessions', slug)
}

// Playwright launches its own bundled browser by default; set DSH_TEST_CHROME
// to force a specific executable.
function chromePath() {
  return process.env.DSH_TEST_CHROME
}

/**
 * Print the one-line provenance banner (#47). It is the first stdout line of a
 * live run; a script spawned by tests/live/run.cjs passes
 * DSH_LIVE_ANNOUNCED=1 so the banner is not duplicated.
 */
function announce() {
  if (process.env.DSH_LIVE_ANNOUNCED === '1') return null
  process.env.DSH_LIVE_ANNOUNCED = '1'
  const line = announceLine(DSH_HOME)
  console.log(line)
  return line
}

module.exports = { DSH_HOME, announce, chromePath, hostVersion, sessionRoot }
