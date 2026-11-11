// The survey shape (#148/#149): a read of one commit, not a write of a branch.
//
// A survey has no worktree, no branch and no commit of its own. By default it
// runs in the shared checkout with a read-only preset allow-list. With
// `survey.sandbox: 'detached'` the read moves into a disposable detached git
// worktree at the recorded commit (#148 W2): the sandbox preset may write and
// run commands there, but the sandbox has no branch, never merges, is removed
// when the mission completes or is abandoned, and must still end at the
// recorded commit with zero commits. Both placements record the commit read
// plus the tracked-status fingerprint captured at plan time; only the shared
// placement enforces the fingerprint as a completion invariant.
// @ts-check
import { TowerToolError } from '../errors.js'
import { hasCheckEvidence } from '../evidence.js'
import { blocker } from './blockers.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').Blocker} Blocker */
/** @typedef {import('../../types/index.js').TowerConfig} TowerConfig */

/** @type {readonly string[]} */
export const SURVEY_STATUSES = Object.freeze(['planned', 'active', 'completed', 'blocked', 'paused', 'abandoned'])

/**
 * The evidence this shape accepts (#149 W4). A survey has no branch and no
 * tree tip, so a discovery receipt cannot appertain; its completion checks are
 * still accepted through the same one reader.
 * @type {import('../evidence.js').EvidenceContract}
 */
export const EVIDENCE = Object.freeze({
  completionChecks: true,
  testReceipts: /** @type {const} */ (false),
})

/**
 * The survey shape's path reach (#149 W4): a survey owns no paths. Its scope is
 * empty by construction and any changed path is a fence violation; the
 * placement (shared read-only checkout or detached disposable sandbox) changes
 * where it runs, not what it may change.
 * @type {{ ownsPaths: boolean, fence: 'scope' | 'read-only' }}
 */
export const REACH = Object.freeze({
  ownsPaths: false,
  fence: /** @type {const} */ ('read-only'),
})

/**
 * A survey has no `merged` row or column: it is never merged, only completed.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const SURVEY_TRANSITIONS = Object.freeze({
  planned: Object.freeze(['active', 'blocked', 'abandoned']),
  active: Object.freeze(['completed', 'blocked', 'paused', 'abandoned']),
  // W3: `blocked` is derived from open blockers; clearing them is the only way
  // out, and a blocker always wins over a pause (hence paused -> blocked).
  blocked: Object.freeze(['active', 'abandoned']),
  paused: Object.freeze(['active', 'blocked', 'abandoned']),
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
 * Completion invariants for a survey that reads the shared checkout: zero
 * commits, same HEAD, same tracked files. The app layer supplies the observed
 * primitives.
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
 * Completion invariants for a detached survey sandbox: the disposable checkout
 * is allowed to contain write/shell side effects, but it may not commit and it
 * must still be at the recorded commit. The sandbox itself is removed after a
 * successful completion.
 * @param {{ mission: Mission, head: string, readCommit: string, commits: number, sandbox: string }} context
 * @returns {{ commits: number }}
 */
export function checkSandboxCompletion({ mission, head, readCommit, commits, sandbox }) {
  if (!sandbox || sandbox !== mission.sandbox) {
    throw new TowerToolError(
      'invalid-argument',
      `detached survey ${mission.id} has no recorded sandbox; re-provision the survey or abandon it`,
      { nextAction: 'run tower_spawn to create the detached sandbox again, then complete' },
    )
  }
  if (commits !== 0) {
    throw new TowerToolError(
      'invalid-argument',
      `survey ${mission.id} made ${commits} commit(s) in its detached sandbox; a survey reads one commit and records no commit of its own`,
      { nextAction: `reset --hard ${String(readCommit).slice(0, 12)} in ${sandbox}; the sandbox is disposable but its HEAD must stay at the recorded commit` },
    )
  }
  if (head !== readCommit) {
    throw new TowerToolError(
      'invalid-argument',
      `survey ${mission.id} moved the detached sandbox HEAD from ${String(readCommit).slice(0, 12)} to ${String(head).slice(0, 12)}; a survey reads one commit and makes no commits`,
      { nextAction: `reset --hard ${String(readCommit).slice(0, 12)} in ${sandbox}; the sandbox is removed on completion` },
    )
  }
  return { commits: 0 }
}

/**
 * Resolve the survey placement (#148 W2). The shape owns the decision so
 * generic layers never compare `mission.kind` or read the raw key.
 *
 * A sandbox already recorded on the mission is authoritative: provisioned
 * state must win over current config, otherwise flipping `survey.sandbox`
 * between provision and completion would silently move the mission to the
 * shared checkout (or make the completion invariants disagree with the
 * checkout that actually exists). Config only decides initial provisioning.
 * @param {Mission | null | undefined} [mission]
 * @param {TowerConfig} [config]
 * @returns {'shared' | 'detached'}
 */
export function resolveProvisioning(mission, config = /** @type {TowerConfig} */ ({})) {
  const recorded = mission && typeof mission.sandbox === 'string' ? mission.sandbox.trim() : ''
  if (recorded.length > 0) return 'detached'
  return config.survey?.sandbox === 'detached' ? 'detached' : 'shared'
}

/**
 * The preset that executes a survey in the resolved placement. Shared surveys
 * stay strictly read-only; a detached sandbox gets a preset that may write and
 * run commands inside the disposable checkout.
 * @param {Mission | null | undefined} [mission]
 * @param {TowerConfig} [config]
 * @returns {'tower-survey' | 'tower-survey-sandbox'}
 */
export function resolvePreset(mission, config = /** @type {TowerConfig} */ ({})) {
  return resolveProvisioning(mission, config) === 'detached' ? 'tower-survey-sandbox' : 'tower-survey'
}

/** Shared-checkout completion invariants (the default placement). */
const SHARED_COMPLETION = Object.freeze({
  requiresWorktree: false,
  requiresSandbox: false,
  requiresCommits: false,
  requiresClean: false,
  requiresHeadMatch: true,
  requiresTrackedStatus: true,
  check: /** @type {(ctx: any) => { commits: number }} */ (checkCompletion),
})

/** Detached-sandbox completion invariants. */
const SANDBOX_COMPLETION = Object.freeze({
  requiresWorktree: false,
  requiresSandbox: true,
  requiresCommits: true,
  requiresClean: false,
  requiresHeadMatch: true,
  requiresTrackedStatus: false,
  check: /** @type {(ctx: any) => { commits: number }} */ (checkSandboxCompletion),
})

/**
 * The completion invariants for the checkout the mission was provisioned in.
 * Placement is read from the recorded `mission.sandbox`, never from current
 * config: a detached sandbox still enforces its HEAD/zero-commit invariants and
 * is removed after a config flip to `none`, and a survey that never got a
 * sandbox keeps the shared invariants even if config now asks for `detached`.
 * The config parameter stays in the shape contract for symmetry with other
 * hooks, but is intentionally not consulted here.
 * @param {Mission} mission
 * @param {TowerConfig} [_config]
 * @returns {typeof SHARED_COMPLETION | typeof SANDBOX_COMPLETION}
 */
export function resolveCompletion(mission, _config = /** @type {TowerConfig} */ ({})) {
  return resolveProvisioning(mission) === 'detached' ? SANDBOX_COMPLETION : SHARED_COMPLETION
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
 * A completed survey satisfies its dependents; its read commit is part of the
 * evidence, but the shape contract only needs the terminal status.
 * @param {Pick<Mission, 'status'>} dep
 * @returns {boolean}
 */
export function dependencySatisfied(dep) {
  return dep.status === 'completed' || dep.status === 'abandoned'
}

/**
 * Worker spawn constraints: a survey worker runs in the shared checkout (or,
 * with `survey.sandbox: 'detached'`, in a disposable detached worktree) and
 * never provisions a branch. The concrete placement/preset is resolved by
 * `resolveProvisioning`/`resolvePreset`.
 * @type {{ provisioning: 'shared', missionStatuses: readonly string[], worktree: false, defaultPreset: string, countsTowardWorkerBudget: boolean, model: string }}
 */
export const spawn = Object.freeze({
  provisioning: /** @type {const} */ ('shared'),
  missionStatuses: Object.freeze(['planned', 'active', 'blocked', 'paused']),
  worktree: /** @type {const} */ (false),
  defaultPreset: 'tower-survey',
  countsTowardWorkerBudget: false,
  model: 'survey',
})

/**
 * Mission briefing lines that are specific to the survey shape. A detached
 * sandbox is named explicitly so the worker never edits the main checkout and
 * knows the checkout is disposable but the recorded commit is pinned.
 * @param {Mission} mission
 * @param {{ repoRoot: string, worktree?: unknown }} context
 * @returns {string[]}
 */
export function briefing(mission, context) {
  const short = String(mission.readCommit ?? '').slice(0, 12)
  const fingerprint = (mission.readDirty ?? []).length
  if (mission.sandbox) {
    return [
      `Read and work in the disposable detached sandbox: ${mission.sandbox} (no branch, no commit of your own; the sandbox is removed when the mission completes)`,
      `The sandbox HEAD is pinned to ${short}. Write and shell side effects stay inside the sandbox; completion requires HEAD to still be ${short} and zero new commits.`,
      `Pass workdir="${mission.sandbox}" on every shell command; never modify the main checkout ${context.repoRoot}.`,
    ]
  }
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
    sandbox: mission.sandbox ?? null,
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
 * The commit a legacy (v3, branch-shaped) survey recorded, in fallback order:
 * the v4 field, the worktree it was based on, then the mission-level base
 * commit. A survey planned and never provisioned (or whose spawn failed before
 * provisioning) has none of the three.
 * @param {Record<string, any>} mission
 * @returns {string | null}
 */
export function legacyReadCommit(mission) {
  const recorded = mission.readCommit ?? mission.worktree?.baseCommit ?? mission.baseCommit
  return typeof recorded === 'string' && recorded.length > 0 ? recorded : null
}

/**
 * True when a legacy survey has no base of its own: the state loader must
 * resolve one from the repository before migration can anchor the survey.
 * @param {Record<string, any>} mission
 * @returns {boolean}
 */
export function needsLegacyRead(mission) {
  return legacyReadCommit(mission) === null
}

/**
 * @param {Record<string, any>} mission
 * @param {{ legacySurveyRead?: { readCommit?: unknown, readDirty?: unknown } | null }} [options]
 * @returns {Record<string, any>}
 */
export function migrateLegacy(mission, options = {}) {
  const recorded = legacyReadCommit(mission)
  // The loader resolves the state base once for the whole document; only a
  // survey that recorded no base of its own may consume that resolution. A
  // recorded commit always wins, so re-running the step is a fixed point.
  const resolved = recorded === null ? options.legacySurveyRead : null
  const readCommit = recorded ?? resolved?.readCommit
  if (typeof readCommit !== 'string' || readCommit.length === 0) {
    throw new Error(
      `survey ${String(mission.id)} has no recorded base commit to read; the state loader must resolve the base ref for a planned-but-never-provisioned survey`,
    )
  }
  const readDirty =
    recorded === null
      ? Array.isArray(resolved?.readDirty)
        ? resolved.readDirty.filter((entry) => typeof entry === 'string')
        : []
      : Array.isArray(mission.readDirty)
        ? [...mission.readDirty]
        : []
  const next = /** @type {Record<string, any>} */ ({
    ...mission,
    kind: 'survey',
    scope: [],
    readCommit,
    readDirty,
  })
  if (next.status === 'merged') next.status = 'completed'
  delete next.worktree
  delete next.worktreeRemovedAt
  delete next.sandbox
  delete next.sandboxCleanupError
  delete next.sandboxRemovedAt
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
  needsLegacyRead,
  canMerge: false,
  canRebase: false,
  provisioning: /** @type {const} */ ('shared'),
  reach: REACH,
  // Document dimensions this shape owns; the state validator reads these.
  fields: Object.freeze({ worktree: false, readCommit: true, merge: false, sandbox: true }),
  // A survey needs its optional component row; a build does not.
  requiredComponent: 'tower-survey',
  // Only a survey records `result` evidence on completion.
  acceptsResult: true,
  evidence: EVIDENCE,
  planFields,
  resolveProvisioning,
  resolvePreset,
  resolveCompletion,
  completion: SHARED_COMPLETION,
  completionBlockers,
  dependencySatisfied,
  spawn,
  briefing,
  summary,
  describe,
})
