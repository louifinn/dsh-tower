// Semantic state-file checks (#56 P4).
//
// `stateShapeError` proves the structural contract; this module owns the policy
// the shape cannot express: unique ids, status/verdict vocabularies, the review
// exemption, roster/agent uniqueness, worktree records and the revision
// counter. Messages keep the historical `[tower:state-corrupt]` wording.
// @ts-check
import { TowerToolError } from '../errors.js'
import { FINDING_STATUSES, MERGE_VERDICTS, MISSION_STATUSES, REVIEW_STATUS_RE } from '../mission.js'

/** @typedef {import('../../types/index.js').TowerState} TowerState */

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new TowerToolError('state-corrupt', message)
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A worktree record may omit legacy fields, but every field it carries must
 * keep its documented type.
 * @param {Record<string, any>} mission
 * @param {string} where
 * @returns {void}
 */
function assertWorktreeRecord(mission, where) {
  const worktree = mission.worktree
  if (worktree === undefined || worktree === null) return
  const invalid = !isPlainObject(worktree) || ['path', 'branch', 'baseCommit', 'realPath'].some(
    (key) => worktree[key] !== undefined && typeof worktree[key] !== 'string',
  ) || (worktree.createdAt !== undefined && typeof worktree.createdAt !== 'number')
  if (invalid) fail(`mission ${mission.id} has an invalid worktree record${where}`)
}

/**
 * @param {unknown} state
 * @param {string} where
 * @returns {TowerState}
 */
export function assertStateSemantics(state, where) {
  const record = /** @type {Record<string, any>} */ (state)
  if (record.revision !== undefined && (!Number.isInteger(record.revision) || record.revision < 0)) {
    fail(`tower state revision is not a non-negative integer${where}`)
  }
  const missionIds = new Set()
  for (const mission of record.missions) {
    if (missionIds.has(mission.id)) fail(`duplicate mission id ${mission.id}${where}`)
    missionIds.add(mission.id)
    if (!MISSION_STATUSES.includes(mission.status)) {
      fail(`mission ${mission.id} has unknown status ${mission.status}${where}`)
    }
    if (mission.reviewPolicy !== undefined && !['required-clean', 'none'].includes(mission.reviewPolicy)) {
      fail(`mission ${mission.id} has unknown reviewPolicy ${mission.reviewPolicy}${where}`)
    }
    if (mission.reviewPolicy === 'none' && !String(mission.reviewExemptionReason ?? '').trim()) {
      fail(`mission ${mission.id} has reviewPolicy none without a reason${where}`)
    }
    assertWorktreeRecord(mission, where)
  }
  if (record.roster !== undefined) {
    const names = new Set()
    const agents = new Set()
    for (const entry of record.roster) {
      const reserved = entry?.state === 'reserved'
      if (!entry || typeof entry.name !== 'string' || (!reserved && typeof entry.agentId !== 'string')) {
        fail(`invalid roster entry${where}`)
      }
      if (names.has(entry.name)) fail(`duplicate roster name ${entry.name}${where}`)
      if (typeof entry.agentId === 'string') {
        if (agents.has(entry.agentId)) fail(`duplicate roster agent ${entry.agentId}${where}`)
        agents.add(entry.agentId)
      }
      names.add(entry.name)
    }
  }
  if (record.messages !== undefined) {
    const ids = new Set()
    for (const message of record.messages) {
      if (ids.has(message.id)) fail(`duplicate message id ${message.id}${where}`)
      ids.add(message.id)
    }
  }
  if (record.findings !== undefined) {
    const ids = new Set()
    for (const finding of record.findings) {
      if (ids.has(finding.id)) fail(`duplicate finding id ${finding.id}${where}`)
      ids.add(finding.id)
      if (finding.status !== undefined && !FINDING_STATUSES.includes(finding.status)) {
        fail(`finding ${finding.id} has unknown status ${finding.status}${where}`)
      }
    }
  }
  if (record.reviews !== undefined) {
    const ids = new Set()
    for (const review of record.reviews) {
      if (ids.has(review.id)) fail(`duplicate review id ${review.id}${where}`)
      ids.add(review.id)
      if (!REVIEW_STATUS_RE.test(String(review.status))) {
        fail(`review ${review.id} has unknown status ${review.status}${where}`)
      }
      if (!MERGE_VERDICTS.includes(review.mergeVerdict)) {
        fail(`review ${review.id} has unknown merge verdict ${review.mergeVerdict}${where}`)
      }
    }
  }
  return /** @type {TowerState} */ (record)
}
