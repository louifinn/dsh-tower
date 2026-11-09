// The survey shape (#148/#149): a read of one commit, not a write of a branch.
//
// A survey has no worktree, no branch and no commit of its own. It runs in the
// shared checkout with a read-only preset allow-list, records the commit it read
// plus the tracked-status fingerprint captured at plan time, and completes with
// zero commits while HEAD and the fingerprint are unchanged.
// @ts-check
import { TowerToolError } from '../errors.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').Blocker} Blocker */
/** @typedef {import('../../types/index.js').TowerConfig} TowerConfig */

/** @type {readonly string[]} */
export const SURVEY_STATUSES = Object.freeze(['planned', 'active', 'completed', 'blocked', 'paused', 'abandoned'])

/**
 * A survey has no `merged` row or column: it is never merged, only completed.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const SURVEY_TRANSITIONS = Object.freeze({
  planned: Object.freeze(['active', 'abandoned']),
  active: Object.freeze(['completed', 'blocked', 'paused', 'abandoned']),
  blocked: Object.freeze(['active', 'paused', 'completed', 'abandoned']),
  paused: Object.freeze(['active', 'abandoned']),
  completed: Object.freeze([]),
  abandoned: Object.freeze([]),
})

/**
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminal(status) {
  return status === 'completed' || status === 'abandoned'
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  return (SURVEY_TRANSITIONS[from] ?? []).includes(to)
}

/**
 * Survey planning records what is being read, not what will be written: the
 * commit and the tracked-status fingerprint at plan time. Scope is empty.
 * @param {{ readCommit?: unknown, readDirty?: unknown }} context
 * @returns {{ scope: string[], readCommit: string, readDirty: string[] }}
 */
export function planFields(context) {
  const readCommit = context.readCommit
  if (typeof readCommit !== 'string' || readCommit.length === 0) {
    throw new TowerToolError('invalid-argument', 'a survey needs the commit it reads (state.base did not resolve)', {
      nextAction: 'run tower_init so the base branch resolves to a commit, then plan the survey again',
    })
  }
  const readDirty = Array.isArray(context.readDirty)
    ? context.readDirty.filter((entry) => typeof entry === 'string')
    : []
  return { scope: [], readCommit, readDirty }
}

/**
 * Completion invariants for a survey: zero commits, same HEAD, same tracked
 * files. The app layer supplies the observed primitives.
 * @param {{ mission: Mission, head: string, readCommit: string, trackedChanged: string[] }} context
 * @returns {{ commits: number }}
 */
export function checkCompletion({ mission, head, readCommit, trackedChanged }) {
  if (head !== readCommit) {
    throw new TowerToolError(
      'invalid-argument',
      `survey ${mission.id} moved HEAD from ${String(readCommit).slice(0, 12)} to ${String(head).slice(0, 12)}; a survey reads one commit and makes no commits`,
      { nextAction: 'reset the shared checkout to the recorded readCommit; do not commit survey work' },
    )
  }
  if (trackedChanged.length > 0) {
    throw new TowerToolError(
      'invalid-argument',
      `survey ${mission.id} changed tracked files: ${trackedChanged.join(', ')}; a survey is read-only`,
      { nextAction: 'restore the shared checkout tracked files to the status captured at plan time' },
    )
  }
  return { commits: 0 }
}

/**
 * Completion blockers for a survey. A survey is never merged, so the build-only
 * "closed mission owns a branch" blocker does not exist for it.
 * @param {Mission} mission
 * @param {TowerConfig} [config]
 * @returns {Blocker[]}
 */
export function completionBlockers(mission, config = /** @type {TowerConfig} */ ({})) {
  /** @type {Blocker[]} */
  const blockers = []
  if (mission.status !== 'completed') {
    blockers.push({ code: 'mission-not-completed', detail: `mission ${mission.id} is ${mission.status}; completion is required` })
  }
  const open = (mission.tasks ?? []).filter((task) => task.status === 'open')
  if (open.length > 0) {
    blockers.push({ code: 'tasks-open', detail: `${open.length} open task(s): ${open.map((task) => task.text).join('; ')}` })
  }
  if ((mission.blockers ?? []).length > 0) {
    blockers.push({ code: 'blockers-present', detail: (mission.blockers ?? []).join('; ') })
  }
  if (config.gates?.requireChecks && !(mission.completionReport?.checks ?? []).length) {
    blockers.push({
      code: 'no-check-evidence',
      detail: `mission ${mission.id} has no completion checks; gates.requireChecks is enabled`,
    })
  }
  return blockers
}

/**
 * A completed survey satisfies its dependents; its read commit is part of the
 * evidence, but the shape contract only needs the terminal status.
 * @param {Pick<Mission, 'status'>} dep
 * @returns {boolean}
 */
export function dependencySatisfied(dep) {
  return dep.status === 'completed' || dep.status === 'abandoned'
}

/**
 * Worker spawn constraints: a survey worker runs in the shared checkout with the
 * Tower-owned read-only preset, so no branch or worktree is provisioned.
 * @type {{ provisioning: 'shared', missionStatuses: readonly string[], worktree: false, defaultPreset: string, countsTowardWorkerBudget: boolean }}
 */
export const spawn = Object.freeze({
  provisioning: /** @type {const} */ ('shared'),
  missionStatuses: Object.freeze(['planned', 'active', 'blocked', 'paused']),
  worktree: /** @type {const} */ (false),
  defaultPreset: 'tower-survey',
  countsTowardWorkerBudget: false,
})

/**
 * Mission briefing lines that are specific to the survey shape.
 * @param {Mission} mission
 * @param {{ repoRoot: string, worktree?: unknown }} context
 * @returns {string[]}
 */
export function briefing(mission, context) {
  const short = String(mission.readCommit ?? '').slice(0, 12)
  const fingerprint = (mission.readDirty ?? []).length
  return [
    `Read only: commit ${short} in the shared checkout ${context.repoRoot} (no branch, no worktree, no commits)`,
    `Completion invariants: HEAD must still be ${short} and the tracked-status set captured at plan time (${fingerprint} path(s)) must be unchanged. Complete with zero commits.`,
  ]
}

/**
 * Projection of the survey-specific mission fields for summaries/board rows.
 * @param {Mission} mission
 * @returns {Record<string, any>}
 */
export function summary(mission) {
  return {
    worktree: null,
    readCommit: mission.readCommit ?? null,
    readDirty: [...(mission.readDirty ?? [])],
    mergedCommit: null,
    mergedAt: null,
  }
}

/**
 * One-line human description of where the mission reads, used by reports.
 * @param {Mission} mission
 * @returns {string | null}
 */
export function describe(mission) {
  return mission.readCommit ? `read at ${String(mission.readCommit).slice(0, 12)}` : null
}

/**
 * v3 -> v4 migration hook (#148). A legacy survey reads the commit its
 * branch-shaped worktree was based on, keeps its completion report, and loses
 * the worktree/branch/merge projection. A legacy survey that was merged becomes
 * completed: a survey is never merged in v4.
 * @param {Record<string, any>} mission
 * @returns {boolean}
 */
export function isLegacy(mission) {
  return mission.kind === 'survey'
}

/**
 * @param {Record<string, any>} mission
 * @returns {Record<string, any>}
 */
export function migrateLegacy(mission) {
  const readCommit = mission.readCommit ?? mission.worktree?.baseCommit ?? mission.baseCommit
  if (typeof readCommit !== 'string' || readCommit.length === 0) {
    throw new Error(`survey ${String(mission.id)} has no recorded base commit to read`)
  }
  const next = /** @type {Record<string, any>} */ ({
    ...mission,
    kind: 'survey',
    scope: [],
    readCommit,
    readDirty: Array.isArray(mission.readDirty) ? [...mission.readDirty] : [],
  })
  if (next.status === 'merged') next.status = 'completed'
  delete next.worktree
  delete next.worktreeRemovedAt
  delete next.branch
  delete next.baseCommit
  delete next.mergedCommit
  delete next.mergedAt
  return next
}

export const surveyShape = Object.freeze({
  kind: /** @type {const} */ ('survey'),
  statuses: SURVEY_STATUSES,
  transitions: SURVEY_TRANSITIONS,
  isTerminal,
  canTransition,
  isLegacy,
  migrateLegacy,
  canMerge: false,
  canRebase: false,
  provisioning: /** @type {const} */ ('shared'),
  ownsScope: false,
  // Document dimensions this shape owns; the state validator reads these.
  fields: Object.freeze({ worktree: false, readCommit: true, merge: false }),
  // A survey needs its optional component row; a build does not.
  requiredComponent: 'tower-survey',
  // Only a survey records `result` evidence on completion.
  acceptsResult: true,
  planFields,
  completion: Object.freeze({
    requiresWorktree: false,
    requiresCommits: false,
    requiresClean: false,
    requiresHeadMatch: true,
    requiresTrackedStatus: true,
    check: /** @type {(ctx: any) => { commits: number }} */ (checkCompletion),
  }),
  completionBlockers,
  dependencySatisfied,
  spawn,
  briefing,
  summary,
  describe,
})
