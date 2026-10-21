// Pure finding normalization, filtering, and transition policy.
//
// app/findings.js owns loading state, the writer lock, sequence assignment,
// persistence, and the activity entry.
// @ts-check
import { TowerToolError } from '../errors.js'
import { FINDING_SEVERITIES, FINDING_STATUSES, FINDING_TRANSITIONS, FINDING_TYPES } from '../mission.js'
import { countFindings, findingSummary } from '../summary.js'

/** @typedef {import('../../types/index.js').Finding} Finding */
/** @typedef {import('../../types/index.js').Mission} Mission */

/**
 * @param {string} message
 * @param {string} [code]
 * @returns {never}
 */
function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmpty(value) {
  return value !== undefined && value !== null && value !== ''
}

/**
 * Validate and project the user-supplied fields of a new finding.
 * @param {any} input
 * @param {Mission[]} missions
 * @returns {any}
 */
export function normalizeFindingInput(input, missions) {
  if (!FINDING_TYPES.includes(input.type)) {
    fail(`finding type must be one of ${FINDING_TYPES.join('|')}`)
  }
  const title = String(input.title ?? '').trim()
  if (!title) fail('finding title is required')
  const summary = String(input.summary ?? '').trim()
  if (!summary) fail('finding summary is required')
  const details = String(input.details ?? '').trim()
  if (!details) fail('finding details are required')
  const suggestedFix = String(input.suggested_fix ?? '').trim()
  if (!suggestedFix) fail('finding suggested_fix is required')
  const severity = input.severity ?? null
  if (severity !== null && !FINDING_SEVERITIES.includes(severity)) {
    fail(`finding severity must be one of ${FINDING_SEVERITIES.join('|')}`)
  }
  let mission = null
  if (isNonEmpty(input.missionId)) {
    mission = missions.find((entry) => entry.id === input.missionId) ?? null
    if (!mission) fail(`unknown mission "${input.missionId}"`, 'mission-not-found')
  }
  return {
    type: input.type,
    title,
    severity,
    summary,
    location: typeof input.location === 'string' && input.location.trim() ? input.location.trim() : null,
    details,
    suggested_fix: suggestedFix,
    missionId: mission ? mission.id : null,
    branch: mission && mission.worktree ? mission.worktree.branch : null,
  }
}

/**
 * Project the complete finding record that gets persisted.
 * @param {any} fields
 * @param {{ seq: number, now: number, reportedBy: unknown }} params
 * @returns {Finding}
 */
export function newFinding(fields, { seq, now, reportedBy }) {
  return {
    id: `F${seq}`,
    seq,
    ...fields,
    reportedBy,
    at: now,
    status: 'open',
  }
}

/**
 * @param {any} actor
 * @returns {{ name: string, role: string }}
 */
export function normalizeFindingActor(actor) {
  const resolved = actor ?? { name: 'tower', role: 'tower' }
  if (typeof resolved.role !== 'string') fail('finding actor role must be a string')
  return resolved
}

/**
 * @param {any} input
 * @returns {boolean}
 */
export function wantsFindingUpdate(input) {
  const hasId = isNonEmpty(input.id)
  return hasId && (input.status !== undefined || input.note !== undefined)
}

/**
 * Pure read/list projection. Throws on an unknown id or an invalid filter.
 * @param {Finding[]} findings
 * @param {any} input
 * @returns {any}
 */
export function readFindingsView(findings, input) {
  const counts = countFindings(findings)
  if (isNonEmpty(input.id)) {
    const finding = findings.find((entry) => entry.id === input.id)
    if (!finding) fail(`unknown finding "${input.id}"`, 'finding-not-found')
    return { finding: { ...finding }, counts, total: findings.length, filtered: 1, action: 'read' }
  }
  if (input.status !== undefined && input.status !== 'all') {
    if (!FINDING_STATUSES.includes(input.status)) {
      fail(`finding status must be one of ${FINDING_STATUSES.join('|')}`)
    }
  }
  let visible = findings
  if (input.status !== undefined && input.status !== 'all') {
    visible = visible.filter((finding) => (finding.status ?? 'open') === input.status)
  }
  if (input.type !== undefined) {
    if (!FINDING_TYPES.includes(input.type)) fail(`finding type must be one of ${FINDING_TYPES.join('|')}`)
    visible = visible.filter((finding) => finding.type === input.type)
  }
  if (input.severity !== undefined) {
    if (!FINDING_SEVERITIES.includes(input.severity)) {
      fail(`finding severity must be one of ${FINDING_SEVERITIES.join('|')}`)
    }
    visible = visible.filter((finding) => finding.severity === input.severity)
  }
  if (isNonEmpty(input.missionId)) {
    visible = visible.filter((finding) => finding.missionId === input.missionId)
  }
  if (input.open === true) {
    visible = visible.filter((finding) => !['fixed', 'wontfix'].includes(finding.status ?? 'open'))
  }
  const limit = Math.max(1, Math.min(200, Number.isInteger(input.limit) ? input.limit : 50))
  const page = visible.slice(-limit).reverse()
  return {
    findings: page.map((finding) => findingSummary(finding)),
    counts,
    total: findings.length,
    filtered: visible.length,
    action: 'list',
  }
}

/**
 * Apply one finding lifecycle transition to the draft finding.
 * @param {{ finding: Finding, input: any, actor: { name: string, role: string }, now: number }} params
 * @returns {{ noteAdded: boolean }}
 */
export function applyFindingUpdate({ finding, input, actor, now }) {
  if (actor.role === 'reviewer') {
    fail('reviewers may list and read findings, but only the tower or a worker may change finding status', 'not-authorized')
  }
  let noteAdded = false
  if (input.status !== undefined) {
    if (input.status === 'all') {
      fail('finding status "all" is only a list filter; pass a concrete status when updating')
    }
    if (!FINDING_STATUSES.includes(input.status)) {
      fail(`finding status must be one of ${FINDING_STATUSES.join('|')}`)
    }
    const current = finding.status ?? 'open'
    const allowed = FINDING_TRANSITIONS[current] ?? []
    if (!allowed.includes(input.status)) {
      fail(`finding ${finding.id} cannot move from ${current} to ${input.status}`, 'invalid-transition')
    }
    finding.status = input.status
    if (input.status === 'fixed' || input.status === 'wontfix') finding.closedAt = now
    else delete finding.closedAt
  }
  if (input.note !== undefined) {
    if (typeof input.note !== 'string' || input.note.trim().length === 0) {
      fail('finding note must be a non-empty string')
    }
    const record = /** @type {any} */ (finding)
    if (!Array.isArray(record.notes)) record.notes = []
    record.notes.push({ by: actor.name, at: now, text: input.note.trim() })
    noteAdded = true
  }
  finding.updatedAt = now
  return { noteAdded }
}

/**
 * @param {Finding} finding
 * @param {Finding[]} all
 * @returns {any}
 */
export function findingUpdateView(finding, all) {
  return { finding: { ...finding }, counts: countFindings(all), total: all.length, filtered: 1, action: 'updated' }
}
