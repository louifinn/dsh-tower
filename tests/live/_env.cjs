// Shared environment for the live test/ops scripts.
//
// Resolve the DSH home and the per-workspace session directory from the
// environment instead of hard-coding one machine's paths. Run these scripts
// from the DSH workspace directory whose sessions you inspect, or set
// DSH_SESSION_ROOT explicitly.
const os = require('node:os')
const path = require('node:path')

if (process.env.DSH_LIVE !== '1') {
  throw new Error('Live suite is opt-in: set DSH_LIVE=1 and an isolated DSH_HOME before running tests/live scripts.')
}
if (!process.env.DSH_HOME) {
  throw new Error('Refusing non-isolated live run: DSH_HOME must be set explicitly to a disposable profile/home.')
}

const DSH_HOME = process.env.DSH_HOME

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

module.exports = { DSH_HOME, sessionRoot, chromePath }
