// Pure guard for the opt-in live suite (#47).
//
// The live suite may only run against a disposable DSH home under the OS temp
// directory. It must never touch the operator's real `$DSH_HOME` (where their
// settings, sessions and credentials live), and it must never be pointed at one
// of their profiles. Keeping the check pure makes it unit-testable without
// spawning a browser or creating a home in the operator's real directory.
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HINT = 'Run the live suite with `npm run test:live`, which documents the isolated DSH_HOME setup in tests/README.md.'
const PACKAGE_JSON = path.join('node_modules', '@deepseek-ai', 'dsh', 'package.json')

const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)

/** True when `child` is `parent` or a descendant of it. */
function isInside(parent, child) {
  const relative = path.relative(normalize(parent), normalize(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function realpathOrNull(value) {
  try {
    return fs.realpathSync(value)
  } catch {
    return null
  }
}

/**
 * Assert that `dshHome` is a disposable directory under `tmpDir`.
 *
 * Rejects, in order: a missing `DSH_HOME`, a non-directory, a path under the
 * operator's real DSH home (named as a profile under `profiles/` when that is
 * what it is), and any path that is not a strict child of the OS temp
 * directory. Errors always name `npm run test:live`.
 *
 * @param {{env?: Record<string, string | undefined>, dshHome?: string, tmpDir?: string,
 *   operatorHome?: string, exists?: (path: string) => boolean, realpath?: (path: string) => string,
 *   stat?: (path: string) => { isDirectory(): boolean }}} [options]
 * @returns {string} the resolved real path of the isolated home
 */
function assertIsolatedHome(options = {}) {
  const env = options.env ?? process.env
  const tmpDir = options.tmpDir ?? os.tmpdir()
  const operatorHome = options.operatorHome ?? path.join(os.homedir(), '.dsh')
  const exists = options.exists ?? ((target) => fs.existsSync(target))
  const realpath = options.realpath ?? ((target) => fs.realpathSync(target))
  const stat = options.stat ?? ((target) => fs.statSync(target))
  const configured = options.dshHome ?? env.DSH_HOME

  if (typeof configured !== 'string' || configured.trim() === '') {
    throw new Error(`Refusing live run: DSH_HOME must be set explicitly to a disposable directory under os.tmpdir(). ${HINT}`)
  }
  const resolved = path.resolve(configured)
  if (!exists(resolved)) {
    throw new Error(`Refusing live run: DSH_HOME does not exist: ${resolved}. Create a fresh temporary directory first. ${HINT}`)
  }
  let isDir = false
  try {
    isDir = stat(resolved).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) {
    throw new Error(`Refusing live run: DSH_HOME is not a directory: ${resolved}. ${HINT}`)
  }

  const real = realpath(resolved)
  const operatorReal = realpathOrNull(operatorHome) ?? path.resolve(operatorHome)
  const operatorProfiles = path.join(operatorReal, 'profiles')

  // Name the profile case first: `DSH_HOME=~/.dsh/profiles/desktop` is the most
  // likely mistake, and "inside the operator's real home" would be true but less
  // useful than "this is one of your real profiles".
  if (isInside(operatorProfiles, real)) {
    throw new Error(
      `Refusing live run: DSH_HOME names an operator profile under ${operatorProfiles}: ${resolved}. ` +
        `A profile is not a disposable home. ${HINT}`,
    )
  }
  if (isInside(operatorReal, real)) {
    throw new Error(
      `Refusing live run: DSH_HOME resolves inside the operator's real DSH_HOME ${operatorReal}: ${resolved}. ` +
        `Point DSH_HOME at a fresh directory under os.tmpdir() instead. ${HINT}`,
    )
  }

  const realTmp = realpathOrNull(tmpDir) ?? path.resolve(tmpDir)
  if (real === realTmp || !isInside(realTmp, real)) {
    throw new Error(
      `Refusing live run: DSH_HOME must be a disposable directory under os.tmpdir() (${realTmp}); got ${real}. ${HINT}`,
    )
  }
  return real
}

/** The DSH host build under test, for the first line of live output (#47). */
function hostVersion(env = process.env) {
  if (env.DSH_HOST_VERSION) return env.DSH_HOST_VERSION
  if (env.DSH_HOST_DIR) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(env.DSH_HOST_DIR, PACKAGE_JSON), 'utf8'))
      if (manifest.version) return manifest.version
    } catch {
      // Fall through to the explicit unknown marker.
    }
  }
  return 'unknown'
}

/** The line every live entry prints before doing anything observable. */
function announceLine(dshHome, env = process.env) {
  return `live: DSH_HOME=${dshHome} host=${hostVersion(env)}`
}

module.exports = { HINT, announceLine, assertIsolatedHome, hostVersion, isInside }
