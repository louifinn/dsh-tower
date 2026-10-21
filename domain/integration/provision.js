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
 * @param {string} branch
 * @param {string} wtPath
 * @returns {string}
 */
export function provisionActivityText(branch, wtPath) {
  return `${branch} at ${wtPath}`
}
