// Environment for the read-only session diagnostics under tests/live/.
//
// These scripts exist to inspect or repair a session in the operator's real
// $DSH_HOME, so they are deliberately separate from `_env.cjs` (#47): the live
// suite guard must never be relaxed, and the diagnostics must never be forced
// to run against a throwaway home. They are opt-in (`DSH_LIVE=1`) because
// repair-session.cjs writes to the session log it is given.
'use strict'

const path = require('node:path')

if (process.env.DSH_LIVE !== '1') {
  throw new Error('Diagnostics are opt-in: set DSH_LIVE=1 and DSH_HOME to the DSH home whose sessions you inspect. Run the live suite with `npm run test:live`.')
}
if (!process.env.DSH_HOME) {
  throw new Error('Refusing diagnostic run: DSH_HOME must be set explicitly to the DSH home whose sessions you inspect. Run the live suite with `npm run test:live`.')
}

const DSH_HOME = process.env.DSH_HOME

function sessionRoot() {
  if (process.env.DSH_SESSION_ROOT) return process.env.DSH_SESSION_ROOT
  const slug = `--${process.cwd().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}--`
  return path.join(DSH_HOME, 'sessions', slug)
}

module.exports = { DSH_HOME, sessionRoot }
