// Independent reference tables for the mission state machine (M25, #130).
//
// WHY THIS FILE EXISTS
// --------------------
// The model-based property in `../state-machine.prop.mjs` drives the real pure
// domain functions and checks them against this *reference model*. To be a real
// oracle the model must not share its source of truth with the implementation:
// it imports nothing from `domain/` — no `TRANSITIONS`, no `FINDING_TRANSITIONS`,
// no `canTransition` — and carries its own hand-written literal tables.
//
// The tables below are a transcription of the state machine as *documented* in
// `docs/reference/errors.md` / `domain/mission.js` (#130), written down by hand
// from the spec rather than derived from the code. That is what makes the model
// able to disagree with the implementation.
//
// MAINTENANCE
// -----------
// When the status/verdict vocabulary or a transition edge changes on purpose,
// update the literal table here in the same commit. Until then
// `assertModelVocabulary()` fails loudly while reading a generated state, so a
// silent vocabulary drift cannot make the model vacuously pass.
// @ts-check

/** Mission lifecycle statuses, in lifecycle order. @type {readonly string[]} */
export const MODEL_STATUSES = Object.freeze([
  'planned',
  'active',
  'completed',
  'blocked',
  'paused',
  'merged',
  'abandoned',
])

/**
 * The only legal status edges. A status that is absent from this table is not a
 * lifecycle status at all; a present status with an empty list is terminal.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const MODEL_TRANSITIONS = Object.freeze({
  planned: Object.freeze(['active', 'abandoned']),
  active: Object.freeze(['completed', 'blocked', 'paused', 'abandoned']),
  blocked: Object.freeze(['active', 'paused', 'completed', 'abandoned']),
  paused: Object.freeze(['active', 'abandoned']),
  completed: Object.freeze(['active', 'abandoned']),
  merged: Object.freeze([]),
  abandoned: Object.freeze([]),
})

/** Statuses no command can move a mission out of. @type {ReadonlySet<string>} */
export const MODEL_TERMINAL_STATUSES = Object.freeze(new Set(['merged', 'abandoned']))

/** Why a mission is paused; only meaningful for status `paused`. */
export const MODEL_PAUSE_CAUSES = Object.freeze(['user', 'failure', 'resource', 'dependency'])

/** Finding lifecycle statuses. */
export const MODEL_FINDING_STATUSES = Object.freeze(['open', 'triaged', 'fixed', 'wontfix'])

/**
 * The only legal finding edges. `fixed`/`wontfix` can only be reopened to
 * `open`; nothing moves back to `triaged` directly.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const MODEL_FINDING_TRANSITIONS = Object.freeze({
  open: Object.freeze(['triaged', 'fixed', 'wontfix']),
  triaged: Object.freeze(['open', 'fixed', 'wontfix']),
  fixed: Object.freeze(['open']),
  wontfix: Object.freeze(['open']),
})

/** Review verdict vocabulary: every verdict is a priority + item count, or clean. */
export const MODEL_REVIEW_STATUSES = Object.freeze([
  'clean',
  'p1-1items',
  'p1-2items',
  'p1-3items',
  'p1-4items',
  'p1-5items',
  'p2-1items',
  'p2-2items',
  'p2-3items',
  'p2-4items',
  'p2-5items',
])

/** Merge recommendations a review can carry. */
export const MODEL_MERGE_VERDICTS = Object.freeze(['merge', 'fix-then-merge', 'hold'])

/**
 * The gate configuration every command runs under. Kept in the model (not read
 * from the repo config) so the property is self-contained and deterministic.
 * `requireReview: true` + `allowReviewExemption: true` exercises both the
 * "review required" path and the "mission is exempt" path.
 */
export const MODEL_CONFIG = Object.freeze({
  mode: Object.freeze({ requireResumeAuthorization: true }),
  review: Object.freeze({ requireReview: true, maxRoundsPerReviewer: 5 }),
  gates: Object.freeze({ requireChecks: false, requireTests: false, allowReviewExemption: true }),
})

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function modelCanTransition(from, to) {
  const edges = MODEL_TRANSITIONS[from]
  return Array.isArray(edges) ? edges.includes(to) : false
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function modelCanTransitionFinding(from, to) {
  const edges = MODEL_FINDING_TRANSITIONS[from]
  return Array.isArray(edges) ? edges.includes(to) : false
}

/**
 * Findings without an explicit status behave as `open` (legacy rows).
 * @param {{ status?: unknown }} finding
 * @returns {string}
 */
export function modelFindingStatus(finding) {
  return typeof finding.status === 'string' ? finding.status : 'open'
}

/**
 * Guard against silent vocabulary drift: a generated state must only contain
 * statuses this model knows about. Throws (failing the property run) instead of
 * pretending the unknown status has no transitions.
 * @param {Record<string, any>} state
 * @returns {void}
 */
export function assertModelVocabulary(state) {
  for (const mission of state.missions ?? []) {
    const status = mission?.status
    if (!MODEL_STATUSES.includes(status)) {
      throw new Error(
        `reference model does not know mission status ${JSON.stringify(status)} of ${mission?.id}; ` +
          'update tests/property/model/tables.mjs together with the domain vocabulary',
      )
    }
    const policy = mission.reviewPolicy ?? 'required-clean'
    if (!['required-clean', 'none'].includes(policy)) {
      throw new Error(
        `reference model does not know reviewPolicy ${JSON.stringify(policy)} of ${mission?.id}; ` +
          'update tests/property/model/tables.mjs together with the domain vocabulary',
      )
    }
  }
  for (const review of state.reviews ?? []) {
    if (!MODEL_REVIEW_STATUSES.includes(review?.status)) {
      throw new Error(
        `reference model does not know review status ${JSON.stringify(review?.status)} of ${review?.id}; ` +
          'update tests/property/model/tables.mjs together with the domain vocabulary',
      )
    }
    if (!MODEL_MERGE_VERDICTS.includes(review?.mergeVerdict)) {
      throw new Error(
        `reference model does not know merge verdict ${JSON.stringify(review?.mergeVerdict)} of ${review?.id}; ` +
          'update tests/property/model/tables.mjs together with the domain vocabulary',
      )
    }
  }
  for (const finding of state.findings ?? []) {
    const status = modelFindingStatus(finding)
    if (!MODEL_FINDING_STATUSES.includes(status)) {
      throw new Error(
        `reference model does not know finding status ${JSON.stringify(status)} of ${finding?.id}; ` +
          'update tests/property/model/tables.mjs together with the domain vocabulary',
      )
    }
  }
}

/**
 * The ten commands the model-based property drives, and the status each one is
 * allowed to produce. The model owns this table: a command that is not listed
 * here is not part of the modelled state machine, and a status effect that is
 * not listed here is not one this model predicts.
 *
 * `kind` selects which domain entry point the property uses:
 *   - `status`     — the recorded status edges plus the resume authorization rule,
 *   - `completion` — the completion admission + `applyCompletion`,
 *   - `review`     — admission, reviewer round cap, verdict and outcome,
 *   - `merge`      — the merge gate + `applyMergeSuccess`,
 *   - `rebase`     — state-neutral apart from the caller's revision bump,
 *   - `plan`       — `normalizeMissionInput` + `newMission` + `applyPlan`,
 *   - `finding`    — the finding edges.
 * @type {Readonly<Record<string, {kind: string, command: string, target: string | null}>>}
 */
export const MODEL_COMMANDS = Object.freeze({
  plan: Object.freeze({ kind: 'plan', command: 'tower_plan', target: 'planned' }),
  activate: Object.freeze({ kind: 'status', command: 'tower_mission', target: 'active' }),
  complete: Object.freeze({ kind: 'completion', command: 'tower_complete', target: 'completed' }),
  review: Object.freeze({ kind: 'review', command: 'tower_review', target: null }),
  merge: Object.freeze({ kind: 'merge', command: 'tower_merge', target: 'merged' }),
  abandon: Object.freeze({ kind: 'abandon', command: 'tower_mission', target: 'abandoned' }),
  rebase: Object.freeze({ kind: 'rebase', command: 'tower_rebase', target: null }),
  pause: Object.freeze({ kind: 'status', command: 'tower_mission', target: 'paused' }),
  resume: Object.freeze({ kind: 'status', command: 'tower_mission', target: 'active' }),
  'findings.transition': Object.freeze({ kind: 'finding', command: 'tower_findings', target: null }),
})

/** The command names in registration order. @type {readonly string[]} */
export const MODEL_COMMAND_NAMES = Object.freeze(Object.keys(MODEL_COMMANDS))

/**
 * Rejection codes the model expects from the domain, written down independently
 * of the implementation. A rejected command must carry exactly one of these.
 */
export const MODEL_REJECTION_CODES = Object.freeze({
  /** `applyMissionUpdate` / `applyFindingUpdate` refuse a status edge. */
  status: 'invalid-transition',
  /** `applyFindingUpdate` refuses a finding edge. */
  finding: 'invalid-transition',
  /** Resuming a user-paused mission without an authorization reference. */
  authorization: 'invalid-argument',
  /** `assertCompletionRequest` refuses an admission request. */
  completion: 'invalid-argument',
})
