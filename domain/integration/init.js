// Pure init decisions: explicit/fallback base selection, ownership and reanchor
// policy, snapshot decisions, and the initial/existing result projections. All
// fs/git work and state persistence stay in app/init.js.
// @ts-check
import { SCHEMA_VERSION, TERMINAL_STATUSES } from '../mission.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').TowerState} TowerState */

export const SNAPSHOT_REF_PREFIX = 'refs/tower/snapshot/'

/**
 * @param {string} commit
 * @returns {string}
 */
export function snapshotRefFor(commit) {
  return `${SNAPSHOT_REF_PREFIX}${commit}`
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function explicitBase(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * An explicit base must be a local branch name, never a raw ref or remote ref.
 * @param {string} base
 * @returns {string | null} the failure message, or null when valid
 */
export function invalidBaseMessage(base) {
  return /^refs\//.test(base) || base.startsWith('origin/') ? `base must be a local branch name, not ${base}` : null
}

/**
 * Without an explicit base, use the checked-out branch and fall back to `main`
 * only for an unborn repository.
 * @param {object} input
 * @param {string | null} [input.branch]
 * @param {boolean} input.committed
 * @returns {{ base: string } | { error: string }}
 */
export function fallbackBase({ branch, committed }) {
  let base = branch
  if (!base && !committed) base = 'main'
  if (!base) return { error: 'repository is in detached HEAD; pass an explicit local base branch' }
  return { base }
}

/**
 * @param {string | null} owner
 * @param {string | null} caller
 * @returns {boolean}
 */
export function ownedByOther(owner, caller) {
  return Boolean(owner && caller && owner !== caller)
}

/**
 * @param {string | null} owner
 * @param {string | null} caller
 * @returns {string | null} the caller that claims an unowned state
 */
export function claimCaller(owner, caller) {
  return !owner && caller ? caller : null
}

/**
 * @param {Mission[]} missions
 * @returns {string | null} refusal message, or null when reanchor may proceed
 */
export function reanchorBlockedMessage(missions) {
  const active = missions.filter((mission) => !TERMINAL_STATUSES.has(mission.status))
  return active.length > 0 ? `cannot reanchor base while ${active.length} mission(s) are not merged or abandoned` : null
}

/**
 * @param {object} input
 * @param {boolean} input.reanchor
 * @param {string | null} input.reanchorBase
 * @param {string} input.currentBase
 * @returns {boolean}
 */
export function shouldReanchor({ reanchor, reanchorBase, currentBase }) {
  return reanchor === true && reanchorBase !== currentBase
}

/**
 * @param {object} input
 * @param {boolean} input.snapshotDirty
 * @param {boolean} input.dirty
 * @returns {boolean}
 */
export function shouldSnapshot({ snapshotDirty, dirty }) {
  return snapshotDirty === true && dirty
}

/**
 * @param {object} input
 * @param {TowerState} input.state
 * @param {string} input.statePath
 * @param {boolean} input.dirty
 * @returns {object}
 */
export function existingInitResult({ state, statePath, dirty }) {
  return {
    created: false,
    repoRoot: state.repoRoot,
    commonDir: state.commonDir,
    statePath,
    base: state.base,
    revision: state.revision,
    missions: state.missions.length,
    reanchored: false,
    dirty,
    snapshotCommit: state.snapshotCommit ?? null,
    caseInsensitive: state.caseInsensitive ?? null,
  }
}

/**
 * @param {object} input
 * @param {string} input.repoRoot
 * @param {string} input.commonDir
 * @param {string} input.base
 * @param {boolean} input.dirty
 * @param {string | null} [input.towerAgentId]
 * @param {string | null} [input.snapshotCommit]
 * @param {string | null} [input.snapshotRef]
 * @param {boolean | null} [input.caseInsensitive]
 * @param {number} input.now
 * @returns {TowerState}
 */
export function initialState({
  repoRoot,
  commonDir,
  base,
  dirty,
  towerAgentId = null,
  snapshotCommit = null,
  snapshotRef = null,
  caseInsensitive = null,
  now,
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    repoRoot,
    commonDir,
    base,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    dirtyBase: dirty,
    caseInsensitive,
    ...(towerAgentId ? { towerAgentId: String(towerAgentId) } : {}),
    ...(snapshotCommit ? { snapshotCommit, snapshotRef } : {}),
    missions: [],
  }
}

/**
 * @param {object} input
 * @param {string} input.repoRoot
 * @param {string} input.commonDir
 * @param {string} input.statePath
 * @param {string} input.base
 * @param {boolean} input.dirty
 * @param {string | null} input.snapshotCommit
 * @param {string | null} input.snapshotRef
 * @param {boolean | null} [input.caseInsensitive]
 * @returns {object}
 */
export function createdInitResult({
  repoRoot,
  commonDir,
  statePath,
  base,
  dirty,
  snapshotCommit,
  snapshotRef,
  caseInsensitive = null,
}) {
  return {
    created: true,
    repoRoot,
    commonDir,
    statePath,
    base,
    revision: 0,
    missions: 0,
    reanchored: false,
    dirty,
    snapshotCommit,
    snapshotRef,
    caseInsensitive,
  }
}

/**
 * @param {object} input
 * @param {TowerState} input.state
 * @param {string} input.statePath
 * @param {boolean} input.dirty
 * @param {boolean} input.reanchored
 * @returns {object}
 */
export function existingInitWriteResult({ state, statePath, dirty, reanchored }) {
  return {
    created: false,
    repoRoot: state.repoRoot,
    commonDir: state.commonDir,
    statePath,
    base: state.base,
    revision: state.revision,
    missions: state.missions.length,
    reanchored,
    dirty,
    snapshotCommit: state.snapshotCommit ?? null,
    caseInsensitive: state.caseInsensitive ?? null,
  }
}

/**
 * @param {object} input
 * @param {string} input.base
 * @param {string | null} [input.snapshotCommit]
 * @param {boolean} input.dirty
 * @param {boolean | null} [input.caseInsensitive]
 * @returns {string}
 */
export function initActivityText({ base, snapshotCommit = null, dirty, caseInsensitive = null }) {
  const mode = caseInsensitive === null ? '' : ` (${caseInsensitive ? 'case-insensitive' : 'case-sensitive'} filesystem)`
  return `base ${base}${snapshotCommit ? ` snapshot ${snapshotCommit.slice(0, 12)}` : ''}${dirty ? ' (dirty base)' : ''}${mode}`
}

/**
 * Activity line for a probe recorded on an existing state.
 * @param {boolean} caseInsensitive
 * @returns {string}
 */
export function caseProbeActivityText(caseInsensitive) {
  return `case sensitivity detected: ${caseInsensitive ? 'case-insensitive' : 'case-sensitive'}`
}

/**
 * @param {string} caller
 * @returns {string}
 */
export function ownerClaimActivityText(caller) {
  return `tower owner claimed by ${caller}`
}

/**
 * @param {string} base
 * @returns {string}
 */
export function reanchorActivityText(base) {
  return `base reanchored to ${base}`
}
