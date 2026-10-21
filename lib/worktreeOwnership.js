// Worktree ownership verification.
//
// A stored worktree path is an identity claim, not a sandbox: before Tower
// trusts it (preflight/merge/review/diff), the path must still resolve to the
// same real directory, must not have been replaced by a symlink or junction,
// and must still be the Git worktree of the recorded branch in the recorded
// repository. Every mismatch is rejected with an actionable message; nothing
// is repaired or recreated here.
import { fsp } from './adapters/store-fs.js'
import path from 'node:path'

import { git } from './git.js'

function fail(code, message) {
  /** @type {Error & {code?: string}} */
  const error = new Error(message)
  error.code = code
  throw error
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function compareKey(target) {
  const resolved = path.resolve(target)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath(a, b) {
  return compareKey(a) === compareKey(b)
}

async function realpathOrResolve(target) {
  try {
    return await fsp.realpath(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return path.resolve(target)
    throw error
  }
}

/**
 * Resolve a path to its canonical realpath. Requires an absolute path and an
 * existing target; a dangling target is reported as a missing path.
 */
export async function canonicalPath(target) {
  if (!isNonEmptyString(target)) fail('invalid-argument', 'path is required')
  if (!path.isAbsolute(target)) fail('invalid-argument', `path must be an absolute path: ${target}`)
  try {
    return await fsp.realpath(target)
  } catch (error) {
    if (error?.code === 'ENOENT') fail('invalid-transition', `path does not exist: ${path.resolve(target)}`)
    throw error
  }
}

async function gitTop(resolved, label) {
  try {
    return await git(resolved, ['rev-parse', '--show-toplevel'])
  } catch (error) {
    fail('invalid-transition', `${label} ${resolved} is not a Git worktree: ${error.message}`)
  }
}

/**
 * Verify that a stored worktree still belongs to this repository, branch, and
 * mission.
 *
 * @param {object} input
 * @param {string} input.storedPath absolute worktree path recorded in state
 * @param {string} [input.storedRealPath] realpath recorded when the worktree was created
 * @param {string} input.branch expected branch
 * @param {string} input.commonDir expected Git common dir (shared by worktrees)
 * @param {string} [input.missionId] mission id, used in error messages
 * @returns {Promise<{path:string, realPath:string}>}
 */
export async function assertOwnership(input = /** @type {any} */ ({})) {
  const storedPath = input?.storedPath
  const storedRealPath = input?.storedRealPath
  const branch = input?.branch
  const commonDir = input?.commonDir
  const missionId = input?.missionId

  if (!isNonEmptyString(storedPath)) fail('invalid-argument', 'storedPath is required')
  if (!path.isAbsolute(storedPath)) fail('invalid-argument', `storedPath must be an absolute path: ${storedPath}`)
  if (!isNonEmptyString(branch)) fail('invalid-argument', 'branch is required')
  if (!isNonEmptyString(commonDir)) fail('invalid-argument', 'commonDir is required')
  if (!path.isAbsolute(commonDir)) fail('invalid-argument', `commonDir must be an absolute path: ${commonDir}`)
  if (missionId !== undefined && !isNonEmptyString(missionId)) {
    fail('invalid-argument', `missionId must be a non-empty string: ${JSON.stringify(missionId)}`)
  }
  if (storedRealPath !== undefined && storedRealPath !== null && storedRealPath !== '') {
    if (!isNonEmptyString(storedRealPath) || !path.isAbsolute(storedRealPath)) {
      fail('invalid-argument', `storedRealPath must be an absolute path: ${storedRealPath}`)
    }
  }

  const label = missionId ? `mission ${missionId} worktree` : 'worktree'
  const resolved = path.resolve(storedPath)

  let linkStat
  try {
    linkStat = await fsp.lstat(resolved)
  } catch (error) {
    if (error?.code === 'ENOENT') fail('invalid-transition', `${label} is missing: ${resolved}`)
    throw error
  }
  if (linkStat.isSymbolicLink()) {
    fail(
      'invalid-transition',
      `${label} ${resolved} is a symlink or junction; refusing to treat a redirected path as the owned worktree`,
    )
  }

  const realPath = await canonicalPath(resolved)
  const stat = await fsp.stat(realPath)
  if (!stat.isDirectory()) fail('invalid-transition', `${label} is not a directory: ${resolved}`)

  if (storedRealPath !== undefined && storedRealPath !== null && storedRealPath !== '' && !samePath(storedRealPath, realPath)) {
    fail(
      'invalid-transition',
      `${label} real path changed: expected ${path.resolve(storedRealPath)}, found ${realPath}; refusing to use a replaced worktree`,
    )
  }

  const topRaw = await gitTop(resolved, label)
  const top = await canonicalPath(topRaw)
  if (!samePath(top, realPath)) {
    fail(
      'invalid-transition',
      `${label} path ${resolved} is not the Git worktree root (top-level is ${top}); refusing to trust a nested or redirected path`,
    )
  }

  let head
  try {
    head = await git(resolved, ['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch (error) {
    fail('invalid-transition', `${label} ${resolved} has no readable HEAD: ${error.message}`)
  }
  const actualBranch = head === 'HEAD' ? null : String(head).trim()
  if (actualBranch !== branch) {
    fail(
      'invalid-transition',
      `${label} ${resolved} is on ${actualBranch ?? 'detached HEAD'}, expected ${branch}`,
    )
  }

  let commonRaw = ''
  try {
    commonRaw = await git(resolved, ['rev-parse', '--git-common-dir'])
  } catch (error) {
    fail('invalid-transition', `${label} ${resolved} has no readable Git common dir: ${error.message}`)
  }
  const actualCommon = path.isAbsolute(commonRaw) ? path.resolve(commonRaw) : path.resolve(resolved, commonRaw)
  const expectedCommon = await realpathOrResolve(path.resolve(commonDir))
  const actualCommonReal = await realpathOrResolve(actualCommon)
  if (!samePath(actualCommonReal, expectedCommon)) {
    fail(
      'invalid-transition',
      `${label} ${resolved} belongs to a different repository (common dir ${actualCommonReal}, expected ${expectedCommon})`,
    )
  }

  return { path: resolved, realPath }
}
