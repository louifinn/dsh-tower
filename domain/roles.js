// Role vocabulary (#149). Roles are decided from one place so generic layers do
// not compare against role strings: the shape audit refuses `role === 'worker'`
// outside this module. `domain/vocabulary.js` re-exports these constants for the
// public vocabulary surface; `domain/roster.js` imports them directly so the
// roster/vocabulary cycle does not exist.
//
// #149 W4: a role is not a shape kind. This module owns the role contract; a
// shape supplies facts (can it merge? does it own a worktree? which model slot?)
// and this contract decides what a role requires, where it runs, which preset
// row and model route it resolves, and whether it consumes a worker slot. Spawn,
// presets, roster and gates resolve role orthogonally to shape through these
// functions instead of combining `isReviewerRole` with `shape.*` at each site.
export const ROLE = Object.freeze({
  tower: 'tower',
  worker: 'worker',
  reviewer: 'reviewer',
  unknown: 'unknown',
})

/** Roles a spawned child may have. */
export const ROLES = Object.freeze([ROLE.worker, ROLE.reviewer])

/** Every actor role a tool may see. */
export const ACTOR_ROLES = Object.freeze([ROLE.tower, ROLE.worker, ROLE.reviewer, ROLE.unknown])

export const DEFAULT_ROLE = ROLE.worker

/** @param {unknown} role */
export function isTowerRole(role) {
  return role === ROLE.tower
}

/** @param {unknown} role */
export function isWorkerRole(role) {
  return role === ROLE.worker
}

/** @param {unknown} role */
export function isReviewerRole(role) {
  return role === ROLE.reviewer
}

/** @param {unknown} role */
export function isUnknownRole(role) {
  return role === ROLE.unknown
}

/**
 * The one role contract. Every field is a role fact, never a shape fact:
 *
 *   preset: 'shape' uses the shape's resolved default preset, otherwise the
 *           reviewer preset row; `model` names the config.spawn.<slot>Model
 *           route (a shape supplies its own slot through shape.spawn.model);
 *   placement: 'mission' provisions the mission placement (branch worktree,
 *              shared checkout or detached sandbox), 'review-checkout' creates
 *              the disposable detached review checkout;
 * `tracksMission`/`countsTowardBudget` answer ownership and resource questions;
 * `requires` lists what the mission must satisfy (`statuses: 'shape'` defers the
 * status set to the shape's spawn contract).
 * @type {Readonly<Record<string, {
 *   preset: 'shape' | 'reviewer',
 *   model: 'shape' | 'reviewer',
 *   placement: 'mission' | 'review-checkout',
 *   briefing: 'worker' | 'reviewer',
 *   tracksMission: boolean,
 *   countsTowardBudget: 'shape' | boolean,
 *   spawnDiscovery: 'worktree' | 'never',
 *   requires: { review: boolean, canMerge: boolean, worktree: boolean, statuses: 'shape' | readonly string[] },
 * }>>}
 */
export const ROLE_CONTRACT = Object.freeze({
  [ROLE.worker]: Object.freeze({
    preset: 'shape',
    model: 'shape',
    placement: 'mission',
    briefing: 'worker',
    tracksMission: true,
    countsTowardBudget: 'shape',
    spawnDiscovery: 'worktree',
    requires: Object.freeze({ review: false, canMerge: false, worktree: false, statuses: 'shape' }),
  }),
  [ROLE.reviewer]: Object.freeze({
    preset: 'reviewer',
    model: 'reviewer',
    placement: 'review-checkout',
    briefing: 'reviewer',
    tracksMission: false,
    countsTowardBudget: false,
    spawnDiscovery: 'never',
    requires: Object.freeze({ review: true, canMerge: true, worktree: true, statuses: Object.freeze(['completed']) }),
  }),
})

/** @param {unknown} role */
export function roleContract(role) {
  return typeof role === 'string' && Object.prototype.hasOwnProperty.call(ROLE_CONTRACT, role)
    ? ROLE_CONTRACT[role]
    : null
}

/** @param {unknown} role */
export function roleTracksMission(role) {
  return roleContract(role)?.tracksMission === true
}

/** @param {unknown} role */
export function roleBriefingKind(role) {
  return roleContract(role)?.briefing ?? null
}

/** @param {unknown} role */
export function rolePlacement(role) {
  return roleContract(role)?.placement ?? null
}

/** @param {unknown} role */
export function rolePresetSlot(role) {
  return roleContract(role)?.preset ?? null
}

/**
 * Which config key supplies a role's preset, and the schema fallback. A role
 * whose `preset` is `shape` takes the shape-resolved preset when one exists and
 * falls back to `spawn.workerPreset`; the reviewer uses its own row.
 * @param {unknown} role
 * @returns {{ slot: 'workerPreset' | 'reviewerPreset', fallback: string } | null}
 */
export function rolePresetConfig(role) {
  const spec = roleContract(role)
  if (!spec) return null
  return spec.preset === 'shape'
    ? { slot: 'workerPreset', fallback: 'tower-worker' }
    : { slot: 'reviewerPreset', fallback: 'tower-reviewer' }
}

/**
 * Does this role consume a worker slot for a mission of this shape?
 * @param {unknown} role
 * @param {{ spawn?: { countsTowardWorkerBudget?: boolean } } | null | undefined} shape
 */
export function roleCountsTowardBudget(role, shape) {
  const spec = roleContract(role)
  if (!spec) return false
  if (spec.countsTowardBudget === 'shape') return shape?.spawn?.countsTowardWorkerBudget !== false
  return spec.countsTowardBudget === true
}

/**
 * Should this spawn run test discovery before activation? A worker on a shape
 * with a worktree can; a reviewer never runs repository code.
 * @param {unknown} role
 * @param {{ fields?: { worktree?: boolean } } | null | undefined} shape
 */
export function roleSpawnDiscovery(role, shape) {
  const spec = roleContract(role)
  if (!spec) return false
  return spec.spawnDiscovery === 'worktree' && shape?.fields?.worktree === true
}

/**
 * Resolve the role-controlled spawn facts: preset, model route, placement and
 * briefing. The shape supplies `canMerge`/`worktree`/`spawn.model`; the role
 * decides how they are used.
 * @param {string} role
 * @param {{ config: any, shape: any, shapePreset?: string | null }} input
 */
export function resolveRoleSpawn(role, { config, shape, shapePreset = null }) {
  const spec = roleContract(role)
  const spawnConfig = config?.spawn ?? {}
  if (!spec) return null
  const preset = spec.preset === 'shape' ? (shapePreset ?? spawnConfig.workerPreset) : spawnConfig.reviewerPreset
  const modelSlot = spec.model === 'shape' ? (shape?.spawn?.model ?? 'worker') : 'reviewer'
  const model = spawnConfig[`${modelSlot}Model`]
  return { preset, model, placement: spec.placement, briefing: spec.briefing }
}

/**
 * Role prerequisites for one mission. The caller checks service-level facts
 * (`reviewAvailable`); shape facts arrive on `shape`/`mission`. Returns
 * blockers in the order a human would fix them; the caller throws the first.
 * @param {string} role
 * @param {{ shape: any, mission: any, reviewAvailable?: boolean }} input
 * @returns {Array<{ code: string, message: string }>}
 */
export function roleMissionBlockers(role, { shape, mission, reviewAvailable = true }) {
  const spec = roleContract(role)
  if (!spec) return [{ code: 'invalid-argument', message: `role must be one of ${ROLES.join('|')}` }]
  const blockers = []
  if (spec.requires.review && !reviewAvailable) {
    blockers.push({
      code: 'review-disabled',
      message: 'review.mode is off, so review is unavailable and a reviewer cannot be spawned',
    })
  }
  if (spec.requires.canMerge && !shape?.canMerge) {
    blockers.push({
      code: 'invalid-transition',
      message: `mission ${mission?.id} is a ${shape?.kind}: it has no branch to review and is never reviewed`,
    })
  }
  if (spec.requires.worktree && !mission?.worktree) {
    blockers.push({
      code: 'reviewer-prerequisite',
      message: 'reviewer needs an existing mission worktree; spawn a worker first',
    })
  }
  const statuses = spec.requires.statuses === 'shape' ? (shape?.spawn?.missionStatuses ?? []) : spec.requires.statuses
  if (!statuses.includes(mission?.status)) {
    blockers.push(
      spec.requires.statuses === 'shape'
        ? {
            code: 'invalid-transition',
            message: `mission ${mission?.id} is ${mission?.status}; a ${role} can only be spawned for a planned or active mission`,
          }
        : {
            code: 'reviewer-prerequisite',
            message: `reviewer requires a completed mission; ${mission?.id} is ${mission?.status}`,
          },
    )
  }
  return blockers
}
