// The build shape (#148/#149): a mission that owns a private branch and
// worktree, writes code, and terminates by being merged or abandoned.
//
// This module is the *only* place build-specific policy lives. Generic layers
// resolve a shape through `./index.js` and never compare `mission.kind`.
// @ts-check
import { TowerToolError } from '../errors.js'
import { hasCheckEvidence } from '../evidence.js'
import { blocker } from './blockers.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').Blocker} Blocker */
/** @typedef {import('../../types/index.js').TowerConfig} TowerConfig */

/** @type {readonly string[]} */
export const BUILD_STATUSES = Object.freeze(['planned', 'active', 'completed', 'blocked', 'paused', 'merged', 'abandoned'])

/**
 * The evidence this shape accepts (#149 W4). A build's discovery receipt is
 * evidence only for the tip it ran on; a completion check is the caller's
 * assertion. Both are read through `domain/evidence.js`, never here.
 * @type {import('../evidence.js').EvidenceContract}
 */
export const EVIDENCE = Object.freeze({
  completionChecks: true,
  testReceipts: /** @type {const} */ ('tip-bound'),
})

/**
 * The build shape's path reach (#149 W4): a build owns the scope it declared,
 * so every changed path must match it. This is the only place the permission
 * question is answered; gates and lifecycle rules call domain/scope.js with it.
 * @type {{ ownsPaths: boolean, fence: 'scope' | 'read-only' }}
 */
export const REACH = Object.freeze({
  ownsPaths: true,
  fence: /** @type {const} */ ('scope'),
})

/** @type {Readonly<Record<string, readonly string[]>>} */
export const BUILD_TRANSITIONS = Object.freeze({
  planned: Object.freeze(['active', 'blocked', 'abandoned']),
  active: Object.freeze(['completed', 'blocked', 'paused', 'abandoned']),
  // `blocked` is derived from open blockers (W3): a blocked mission resumes
  // only by clearing them, never by pausing or completing through the state.
  blocked: Object.freeze(['active', 'abandoned']),
  // A blocker always wins over a pause, which is why paused -> blocked exists.
  paused: Object.freeze(['active', 'blocked', 'abandoned']),
  completed: Object.freeze(['active', 'blocked', 'abandoned']),
  merged: Object.freeze([]),
  abandoned: Object.freeze([]),
})

/**
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminal(status) {
  return status === 'merged' || status === 'abandoned'
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  return (BUILD_TRANSITIONS[from] ?? []).includes(to)
}

/**
 * @param {Record<string, any>} context
 * @returns {Record<string, any>}
 */
export function planFields(context) {
  return { scope: context.scope }
}

/**
 * Completion invariants for a build mission: at least one commit on the mission
 * branch since its base and a clean worktree. The app layer has already resolved
 * the worktree and collected the primitives.
 * @param {{ mission: Mission, commits: number, clean: boolean, dirtyPaths: string[] }} context
 * @returns {{ commits: number }}
 */
export function checkCompletion({ mission, commits, clean, dirtyPaths }) {
  const base = mission.worktree?.baseCommit ?? ''
  if (commits < 1) {
    throw new TowerToolError('invalid-argument', `mission branch has no commits since ${String(base).slice(0, 12)}`)
  }
  if (!clean) {
    const shown = dirtyPaths.slice(0, 8).join(', ')
    const more = dirtyPaths.length > 8 ? ', …' : ''
    throw new TowerToolError(
      'worktree-dirty',
      `mission ${mission.id} worktree has uncommitted changes (${shown}${more}); commit, remove, or record them before tower_complete`,
    )
  }
  return { commits }
}

/**
 * Pre-merge completion blockers (the merge gate half of completion).
 * @param {Mission} mission
 * @param {TowerConfig} [config]
 * @returns {Blocker[]}
 */
export function completionBlockers(mission, config = /** @type {TowerConfig} */ ({})) {
  /** @type {Blocker[]} */
  const blockers = []
  if (isTerminal(mission.status)) {
    blockers.push(
      blocker(
        'branch-owned-by-closed-missions',
        `mission ${mission.id} is ${mission.status}; a merge never flips a closed mission — re-plan the work under a new title`,
      ),
    )
  }
  if (mission.status !== 'completed') {
    blockers.push(
      blocker(
        'mission-not-completed',
        mission.status === 'blocked'
          ? `mission ${mission.id} is blocked: ${(mission.blockers ?? []).join('; ')}; clear the blockers to resume it`
          : `mission ${mission.id} is ${mission.status}; completion is required`,
      ),
    )
  }
  const open = (mission.tasks ?? []).filter((task) => task.status === 'open')
  if (open.length > 0) {
    blockers.push(blocker('tasks-open', `${open.length} open task(s): ${open.map((task) => task.text).join('; ')}`))
  }
  if ((mission.blockers ?? []).length > 0) {
    blockers.push(blocker('blockers-present', (mission.blockers ?? []).join('; ')))
  }
  if (config.gates?.requireChecks && !hasCheckEvidence(EVIDENCE, mission)) {
    blockers.push(
      blocker('no-check-evidence', `mission ${mission.id} has no completion checks; gates.requireChecks is enabled`),
    )
  }
  return blockers
}

/**
 * A build mission's dependency is satisfied once it has landed or been dropped.
 * @param {Pick<Mission, 'status'>} dep
 * @returns {boolean}
 */
export function dependencySatisfied(dep) {
  return dep.status === 'merged' || dep.status === 'abandoned'
}

/**
 * Worker spawn constraints: a build worker gets its own branch and worktree.
 * @type {{ provisioning: 'branch-worktree', missionStatuses: readonly string[], worktree: true, countsTowardWorkerBudget: boolean, model: string }}
 */
export const spawn = Object.freeze({
  provisioning: /** @type {const} */ ('branch-worktree'),
  missionStatuses: Object.freeze(['planned', 'active', 'completed', 'blocked', 'paused']),
  worktree: /** @type {const} */ (true),
  countsTowardWorkerBudget: true,
  // Optional model route slot: config.spawn.<model>Model. The shape supplies the
  // fact; the role contract decides whether it is used.
  model: 'worker',
})

/**
 * Mission briefing lines that are specific to the build shape.
 * @param {Mission} mission
 * @param {{ worktree?: { path: string, branch: string, baseCommit?: string } | null, base: string, repoRoot?: string, readCommit?: string, readDirty?: string[] }} context
 * @returns {string[]}
 */
export function briefing(mission, context) {
  const worktree = context.worktree
  if (!worktree) return []
  return [
    `Work ONLY in this git worktree: ${worktree.path}`,
    `Branch: ${worktree.branch} (based on ${context.base} @ ${String(worktree.baseCommit ?? '').slice(0, 12)})`,
  ]
}

/**
 * Projection of the build-specific mission fields for summaries/board rows.
 * @param {Mission} mission
 * @returns {Record<string, any>}
 */
export function summary(mission) {
  return {
    worktree: mission.worktree ? { path: mission.worktree.path, branch: mission.worktree.branch, baseCommit: mission.worktree.baseCommit } : null,
    mergedCommit: mission.mergedCommit ?? null,
    mergedAt: mission.mergedAt ?? null,
  }
}

/**
 * One-line human description of where the mission reads/writes, used by reports.
 * @param {Mission} mission
 * @returns {string | null}
 */
export function describe(mission) {
  return mission.worktree?.branch ? `branch ${mission.worktree.branch}` : null
}

/**
 * v3 -> v4 migration hook (#148). A build mission's document keeps its shape;
 * only the kind discriminant is stamped. Documents written before `kind` existed
 * are builds.
 * @param {Record<string, any>} mission
 * @returns {boolean}
 */
export function isLegacy(mission) {
  return mission.kind === undefined || mission.kind === null || mission.kind === '' || mission.kind === 'build'
}

/**
 * @param {Record<string, any>} mission
 * @param {Record<string, any>} [_options] shared migration context; a build needs none
 * @returns {Record<string, any>}
 */
export function migrateLegacy(mission, _options = {}) {
  return { ...mission, kind: 'build' }
}

export const buildShape = Object.freeze({
  kind: /** @type {const} */ ('build'),
  statuses: BUILD_STATUSES,
  transitions: BUILD_TRANSITIONS,
  isTerminal,
  canTransition,
  isLegacy,
  needsLegacyRead: () => false,
  migrateLegacy,
  canMerge: true,
  canRebase: true,
  provisioning: /** @type {const} */ ('branch-worktree'),
  reach: REACH,
  // Document dimensions this shape owns; the state validator reads these.
  fields: Object.freeze({ worktree: true, readCommit: false, merge: true, sandbox: false }),
  requiredComponent: null,
  acceptsResult: false,
  evidence: EVIDENCE,
  planFields,
  completion: Object.freeze({
    requiresWorktree: true,
    requiresCommits: true,
    requiresClean: true,
    requiresHeadMatch: false,
    requiresTrackedStatus: false,
    check: /** @type {(ctx: any) => { commits: number }} */ (checkCompletion),
  }),
  completionBlockers,
  dependencySatisfied,
  spawn,
  briefing,
  summary,
  describe,
})
