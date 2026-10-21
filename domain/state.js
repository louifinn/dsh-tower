// Pure state-file validation.
// @ts-check
import { TowerToolError } from '../lib/errors.js'
import { MISSION_STATUSES, FINDING_STATUSES, SCHEMA_VERSION, MERGE_VERDICTS, REVIEW_STATUS_RE } from './mission.js'

/** @typedef {import('../types/index.js').TowerState} TowerState */

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
 * @param {unknown} state
 * @param {string} [statePath]
 * @returns {TowerState}
 */
export function validateState(state, statePath) {
  const where = statePath ? ` at ${statePath}` : ''
  if (!isPlainObject(state)) fail(`tower state is not an object${where}`)
  const record = /** @type {Record<string, any>} */ (state)
  if (record.schemaVersion !== SCHEMA_VERSION) {
    fail(`unsupported tower state schemaVersion ${record.schemaVersion}${where}`)
  }
  if (!Array.isArray(record.missions)) fail(`tower state has no missions array${where}`)
  const ids = new Set()
  for (const mission of record.missions) {
    if (!isPlainObject(mission) || typeof mission.id !== 'string') fail(`mission entry without id${where}`)
    if (ids.has(mission.id)) fail(`duplicate mission id ${mission.id}${where}`)
    ids.add(mission.id)
    if (!MISSION_STATUSES.includes(mission.status)) {
      fail(`mission ${mission.id} has unknown status ${mission.status}${where}`)
    }
    if (!Array.isArray(mission.tasks)) fail(`mission ${mission.id} has no tasks array${where}`)
    if (!Array.isArray(mission.deps)) fail(`mission ${mission.id} has no deps array${where}`)
    if (mission.references !== undefined && !Array.isArray(mission.references)) {
      fail(`mission ${mission.id} has no references array${where}`)
    }
    if (mission.reviewPolicy !== undefined && !['required-clean', 'none'].includes(mission.reviewPolicy)) {
      fail(`mission ${mission.id} has unknown reviewPolicy ${mission.reviewPolicy}${where}`)
    }
    if (mission.reviewPolicy === 'none' && !String(mission.reviewExemptionReason ?? '').trim()) {
      fail(`mission ${mission.id} has reviewPolicy none without a reason${where}`)
    }
    if (mission.testRuns !== undefined && !Array.isArray(mission.testRuns)) {
      fail(`mission ${mission.id} has no testRuns array${where}`)
    }
  }
  for (const key of ['batches', 'legacySnapshots', 'legacyMaps', 'deliveries']) {
    if (record[key] !== undefined && !Array.isArray(record[key])) fail(`tower state ${key} is not an array${where}`)
  }
  if (record.mergeIntent !== undefined && record.mergeIntent !== null && !isPlainObject(record.mergeIntent)) {
    fail(`tower state mergeIntent is not an object${where}`)
  }
  if (record.roster !== undefined) {
    if (!Array.isArray(record.roster)) fail(`tower state roster is not an array${where}`)
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
    if (!Array.isArray(record.messages)) fail(`tower state messages is not an array${where}`)
    const ids = new Set()
    for (const message of record.messages) {
      if (!message || typeof message.id !== 'string' || typeof message.to !== 'string') {
        fail(`invalid message entry${where}`)
      }
      if (ids.has(message.id)) fail(`duplicate message id ${message.id}${where}`)
      ids.add(message.id)
      if (!Array.isArray(message.readBy)) fail(`message ${message.id} has no readBy array${where}`)
    }
  }
  if (record.findings !== undefined) {
    if (!Array.isArray(record.findings)) fail(`tower state findings is not an array${where}`)
    const ids = new Set()
    for (const finding of record.findings) {
      if (!finding || typeof finding.id !== 'string') fail(`invalid finding entry${where}`)
      if (ids.has(finding.id)) fail(`duplicate finding id ${finding.id}${where}`)
      ids.add(finding.id)
      if (finding.status !== undefined && !FINDING_STATUSES.includes(finding.status)) {
        fail(`finding ${finding.id} has unknown status ${finding.status}${where}`)
      }
    }
  }
  if (record.reviews !== undefined) {
    if (!Array.isArray(record.reviews)) fail(`tower state reviews is not an array${where}`)
    const ids = new Set()
    for (const review of record.reviews) {
      if (!review || typeof review.id !== 'string') fail(`invalid review entry${where}`)
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
