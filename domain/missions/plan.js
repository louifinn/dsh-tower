// Pure mission planning input normalization and projections.
//
// The use case in app/plan.js owns the state lock, load, persistence, and the
// activity entry; everything here is deterministic and repository-free.
// @ts-check
import { TowerToolError } from '../errors.js'
import { normalizeScope, validateTitle } from '../scope.js'

/** @typedef {import('../../types/index.js').Mission} Mission */

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new TowerToolError('invalid-argument', message)
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate and normalize one `tower_plan` mission entry.
 * @param {any} input
 * @param {number} index
 * @returns {any}
 */
export function normalizeMissionInput(input, index) {
  if (!isPlainObject(input)) fail(`missions[${index}] must be an object`)
  const title = validateTitle(input.title)
  const kind = input.kind === 'survey' ? 'survey' : 'build'
  const scope = normalizeScope(input.scope ?? [], { allowEmpty: kind === 'survey' })
  /** @type {Array<{ text: string, status: string }>} */
  const tasks = []
  if (input.tasks !== undefined) {
    if (!Array.isArray(input.tasks)) fail(`missions[${index}].tasks must be an array of strings`)
    for (const task of input.tasks) {
      if (typeof task !== 'string' || task.trim().length === 0) {
        fail(`missions[${index}].tasks entries must be non-empty strings`)
      }
      tasks.push({ text: task.trim(), status: 'open' })
    }
  }
  /** @type {string[]} */
  const deps = []
  if (input.deps !== undefined) {
    if (!Array.isArray(input.deps)) fail(`missions[${index}].deps must be an array of mission ids`)
    for (const dep of input.deps) {
      if (typeof dep !== 'string' || dep.trim().length === 0) {
        fail(`missions[${index}].deps entries must be non-empty mission ids`)
      }
      if (!deps.includes(dep.trim())) deps.push(dep.trim())
    }
  }
  const context = typeof input.context === 'string' ? input.context.slice(0, 4096) : ''
  /** @type {string[]} */
  const references = []
  if (input.references !== undefined) {
    if (!Array.isArray(input.references)) fail(`missions[${index}].references must be an array of pointers`)
    if (input.references.length > 20) fail(`missions[${index}].references supports at most 20 pointers`)
    for (const reference of input.references) {
      if (typeof reference !== 'string' || reference.trim().length === 0) {
        fail(`missions[${index}].references entries must be non-empty strings`)
      }
      if (!references.includes(reference.trim())) references.push(reference.trim())
    }
  }
  const reviewPolicy = input.reviewPolicy === undefined ? 'required-clean' : input.reviewPolicy
  if (!['required-clean', 'none'].includes(reviewPolicy)) {
    fail(`missions[${index}].reviewPolicy must be "required-clean" or "none"`)
  }
  const reviewExemptionReason = typeof input.reviewExemptionReason === 'string' ? input.reviewExemptionReason.trim() : ''
  if (reviewPolicy === 'none' && reviewExemptionReason.length === 0) {
    fail(`missions[${index}].reviewPolicy "none" requires a non-empty reviewExemptionReason`)
  }
  return { title, kind, scope, tasks, deps, context, references, reviewPolicy, reviewExemptionReason }
}

/**
 * Validate the plan envelope and normalize every mission entry.
 * @param {any} input
 * @returns {any[]}
 */
export function normalizePlanMissions(input) {
  if (!Array.isArray(input.missions) || input.missions.length === 0) {
    fail('tower_plan needs at least one mission')
  }
  return input.missions.map((mission, index) => normalizeMissionInput(mission, index))
}

/**
 * Assign the next contiguous mission ids without mutating the input.
 * @param {any[]} prepared
 * @param {number} start
 * @returns {any[]}
 */
export function assignMissionIds(prepared, start) {
  return prepared.map((mission, index) => ({ ...mission, id: `M${start + index}` }))
}

/**
 * Every explicit dependency must name an existing or newly assigned mission.
 * @param {any[]} assigned
 * @param {Mission[]} existingMissions
 * @returns {void}
 */
export function assertKnownDependencies(assigned, existingMissions) {
  const known = new Set([...existingMissions.map((mission) => mission.id), ...assigned.map((mission) => mission.id)])
  for (const mission of assigned) {
    for (const dep of mission.deps) {
      if (!known.has(dep)) fail(`mission ${mission.id} depends on unknown mission "${dep}"`)
    }
  }
}

/**
 * Project a normalized, id-assigned input into a fresh mission record.
 * @param {string} id
 * @param {any} input
 * @param {number} now
 * @returns {Mission}
 */
export function newMission(id, input, now) {
  return /** @type {Mission} */ (/** @type {any} */ ({
    id,
    title: input.title,
    kind: input.kind,
    scope: input.scope,
    tasks: input.tasks,
    deps: input.deps,
    context: input.context,
    references: input.references ?? [],
    reviewPolicy: input.reviewPolicy ?? 'required-clean',
    reviewExemptionReason: input.reviewExemptionReason ?? '',
    status: 'planned',
    owner: null,
    blockers: [],
    notes: [],
    reviews: [],
    scopeGeneration: 1,
    createdAt: now,
    updatedAt: now,
  }))
}
