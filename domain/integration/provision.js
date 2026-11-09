// Pure provision decisions: branch slug, base-commit choice, worktree root and
// path resolution, and result/activity projections. Git worktree creation and
// state persistence stay in app/provision.js.
// @ts-check
import path from 'node:path'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').MissionWorktree} MissionWorktree */

/**
 * @param {unknown} title
 * @returns {string}
 */
export function slugify(title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return slug || 'mission'
}

/**
 * @param {Mission} mission
 * @returns {string}
 */
export function worktreeBranch(mission) {
  return `tower/${mission.id.toLowerCase()}-${slugify(mission.title)}`
}

/**
 * Pick the base commit from the explicit argument, the requested base ref, or
 * the recorded dirty snapshot. `source: 'base'` means the caller must rev-parse
 * the configured base (the only I/O in the choice).
 * @param {object} input
 * @param {unknown} [input.baseCommit]
 * @param {unknown} [input.includeDirtyBase]
 * @param {string | null} [input.snapshotCommit]
 * @param {boolean} [input.snapshotCommitValid]
 * @returns {{ source: 'explicit' | 'snapshot', commit: string } | { source: 'base' }}
 */
export function baseCommitChoice({ baseCommit, includeDirtyBase, snapshotCommit = null, snapshotCommitValid = false }) {
  if (baseCommit) return { source: 'explicit', commit: String(baseCommit) }
  if (includeDirtyBase === false) return { source: 'base' }
  if (snapshotCommit && snapshotCommitValid) return { source: 'snapshot', commit: snapshotCommit }
  return { source: 'base' }
}

/**
 * @param {object} input
 * @param {string | null} [input.worktreeRoot]
 * @param {string | null} [input.configuredRoot]
 * @param {string} input.repoRoot
 * @param {string} input.commonDirHash
 * @returns {string}
 */
export function worktreeRoot({ worktreeRoot = null, configuredRoot = null, repoRoot, commonDirHash }) {
  if (worktreeRoot) return path.resolve(worktreeRoot)
  if (configuredRoot) return path.resolve(configuredRoot)
  return path.join(path.dirname(repoRoot), '.dsh-tower-worktrees', commonDirHash)
}

/**
 * @param {string} root
 * @param {string} missionId
 * @returns {string}
 */
export function worktreePath(root, missionId) {
  return path.join(root, missionId)
}

/**
 * The disposable detached checkout a `survey.sandbox: 'detached'` survey reads
 * in (#148 W2). The `-sandbox` suffix keeps it distinct from a build worktree
 * with the same mission id and from the mission branch naming scheme.
 * @param {string} root
 * @param {string} missionId
 * @returns {string}
 */
export function sandboxPath(root, missionId) {
  return path.join(root, `${missionId}-sandbox`)
}

/**
 * @param {unknown} missionId
 * @returns {boolean}
 */
export function hasMissionId(missionId) {
  return typeof missionId === 'string' && missionId.trim().length > 0
}

/**
 * @param {object} input
 * @param {string} input.path
 * @param {string} input.branch
 * @param {string} input.baseCommit
 * @param {number} input.createdAt
 * @param {string | null} [input.realPath]
 * @returns {MissionWorktree}
 */
export function worktreeRecord({ path: wtPath, branch, baseCommit, createdAt, realPath = null }) {
  return /** @type {MissionWorktree} */ ({
    path: wtPath,
    branch,
    baseCommit,
    createdAt,
    ...(realPath === null ? {} : { realPath }),
  })
}

/**
 * @param {Mission} mission
 * @param {MissionWorktree} worktree
 * @returns {{ mission: Mission, worktree: MissionWorktree, created: false }}
 */
export function existingWorktreeResult(mission, worktree) {
  return { mission, worktree, created: false }
}

/**
 * @param {Mission} mission
 * @param {MissionWorktree} worktree
 * @returns {{ mission: Mission, worktree: MissionWorktree, created: true }}
 */
export function createdWorktreeResult(mission, worktree) {
  return { mission, worktree, created: true }
}

/**
 * A shared-checkout shape (survey) provisions no branch and no worktree: the
 * agent reads the recorded commit in the main checkout.
 * @param {Mission} mission
 * @param {string} cwd
 * @returns {{ mission: Mission, worktree: null, cwd: string, created: false, provisioning: 'shared' }}
 */
export function sharedProvisionResult(mission, cwd) {
  return { mission, worktree: null, cwd, created: false, provisioning: /** @type {const} */ ('shared') }
}

/**
 * A detached survey result (#148 W2). The mission has no worktree projection:
 * the sandbox path is recorded as `mission.sandbox` and is the agent's cwd.
 * @param {Mission} mission
 * @param {string} sandbox
 * @param {boolean} created
 * @returns {{ mission: Mission, worktree: null, sandbox: string, cwd: string, created: boolean, provisioning: 'detached' }}
 */
export function detachedSandboxResult(mission, sandbox, created) {
  return {
    mission,
    worktree: null,
    sandbox,
    cwd: sandbox,
    created,
    provisioning: /** @type {const} */ ('detached'),
  }
}

/**
 * @param {string} sandbox
 * @param {string} readCommit
 * @returns {string}
 */
export function sandboxActivityText(sandbox, readCommit) {
  return `detached sandbox at ${sandbox} (read ${String(readCommit).slice(0, 12)})`
}

/**
 * @param {string} branch
 * @param {string} wtPath
 * @returns {string}
 */
export function provisionActivityText(branch, wtPath) {
  return `${branch} at ${wtPath}`
}
