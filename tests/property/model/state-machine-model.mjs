// Reference model for the mission state machine (M25, #130).
//
// The model is deliberately a plain, self-contained data structure: a Map of
// missions, a Map of findings, and the ordered list of reviews. It knows the
// lifecycle rules from ./tables.mjs only; everything else (notes, timestamps,
// scope generations, completion reports) is out of scope for the model and is
// covered by the schema/semantics properties instead.
//
// The model tracks exactly what the properties need to predict a command
// outcome:
//   - mission status and kind,
//   - task texts/statuses (a command may complete a single task, which can
//     unblock `complete`),
//   - blockers (a blocker blocks `complete` and flips the mission to blocked),
//   - the owner (completion admission requires the caller to be the owner),
//   - review policy + exemption reason (merge exemption),
//   - the worktree branch and the reviewed tip (review/merge/rebase),
//   - pause cause (resume authorization),
//   - the last successful rebase record (merge tip waiver),
//   - findings status.
// @ts-check
import {
  MODEL_CONFIG,
  MODEL_FINDING_STATUSES,
  MODEL_REJECTION_CODES,
  assertModelVocabulary,
  modelCanTransition,
  modelCanTransitionFinding,
  modelFindingStatus,
} from './tables.mjs'

/**
 * @typedef {object} ModelTask
 * @property {string} text
 * @property {string} status
 */

/**
 * @typedef {object} ModelMission
 * @property {string} id
 * @property {string} status
 * @property {string} kind
 * @property {ModelTask[]} tasks
 * @property {string[]} blockers
 * @property {string | null} owner
 * @property {string} reviewPolicy
 * @property {string} reviewExemptionReason
 * @property {boolean} hasWorktree
 * @property {string | null} branch
 * @property {string | null} tip
 * @property {string | null} pauseCause
 * @property {{ at: number, oldTip: string } | null} rebase
 */

/**
 * @typedef {object} ModelReview
 * @property {string} id
 * @property {string} missionId
 * @property {string | null} branch
 * @property {number} round
 * @property {string} status
 * @property {string} merge
 * @property {string | null} tip
 * @property {number} at
 * @property {string | null} reviewer
 */

/**
 * @typedef {object} Model
 * @property {Map<string, ModelMission>} missions
 * @property {Map<string, string>} findings
 * @property {ModelReview[]} reviews
 */

/**
 * @param {Record<string, any>} mission
 * @returns {ModelMission}
 */
function missionModel(mission) {
  const worktree = mission.worktree && typeof mission.worktree === 'object' ? mission.worktree : null
  const branch = worktree && typeof worktree.branch === 'string' ? worktree.branch : null
  const tip = worktree && typeof worktree.baseCommit === 'string' ? worktree.baseCommit : null
  return {
    id: mission.id,
    status: mission.status,
    kind: mission.kind === 'survey' ? 'survey' : 'build',
    tasks: Array.isArray(mission.tasks)
      ? mission.tasks.map((task) => ({
          text: typeof task?.text === 'string' ? task.text : '',
          status: task?.status === 'done' || task?.status === 'dropped' ? task.status : 'open',
        }))
      : [],
    blockers: Array.isArray(mission.blockers) ? mission.blockers.map((entry) => String(entry)) : [],
    owner: typeof mission.owner === 'string' ? mission.owner : null,
    reviewPolicy: mission.reviewPolicy === 'none' ? 'none' : 'required-clean',
    reviewExemptionReason:
      typeof mission.reviewExemptionReason === 'string' ? mission.reviewExemptionReason : '',
    hasWorktree: worktree !== null,
    branch,
    tip,
    pauseCause: typeof mission.pauseCause === 'string' ? mission.pauseCause : null,
    // Generated missions never carry a `rebase` record (the arbitrary does not
    // generate one), and only this property's `rebase` command writes it.
    rebase:
      mission.rebase && typeof mission.rebase === 'object' && typeof mission.rebase.oldTip === 'string'
        ? { at: Number(mission.rebase.at), oldTip: mission.rebase.oldTip }
        : null,
  }
}

/**
 * @param {Record<string, any>} review
 * @returns {ModelReview}
 */
function reviewModel(review) {
  return {
    id: String(review.id),
    missionId: String(review.missionId),
    branch: typeof review.branch === 'string' ? review.branch : null,
    round: Number.isInteger(review.round) ? review.round : 0,
    status: review.status,
    merge: review.mergeVerdict,
    tip: typeof review.reviewedCommit === 'string' ? review.reviewedCommit : null,
    at: Number.isFinite(review.at) ? Number(review.at) : 0,
    reviewer: typeof review.reviewer === 'string' ? review.reviewer : null,
  }
}

/**
 * Build the reference model from a generated real state. The model refuses a
 * state whose vocabulary it does not know, so a domain vocabulary change cannot
 * silently weaken the property.
 * @param {Record<string, any>} state
 * @returns {Model}
 */
export function createModel(state) {
  assertModelVocabulary(state)
  /** @type {Model} */
  const model = { missions: new Map(), findings: new Map(), reviews: [] }
  for (const mission of state.missions ?? []) model.missions.set(mission.id, missionModel(mission))
  for (const finding of state.findings ?? []) model.findings.set(finding.id, modelFindingStatus(finding))
  for (const review of state.reviews ?? []) model.reviews.push(reviewModel(review))
  return model
}

/**
 * @param {Model} model
 * @param {string} id
 * @returns {ModelMission}
 */
export function modelMission(model, id) {
  const mission = model.missions.get(id)
  if (!mission) throw new Error(`reference model has no mission ${id}`)
  return mission
}

/**
 * @param {ModelMission} mission
 * @returns {ModelTask[]}
 */
export function modelOpenTasks(mission) {
  return mission.tasks.filter((task) => task.status === 'open')
}

/**
 * @param {Model} model
 * @param {string | null} branch
 * @returns {ModelReview[]}
 */
export function modelBranchReviews(model, branch) {
  if (!branch) return []
  return model.reviews.filter((review) => review.branch === branch)
}

/**
 * The review a merge would gate on: highest round, and on a round tie the one
 * that appears first in the state's review list (the documented "latest review"
 * rule). Modeling it explicitly is what lets the property detect a change of
 * that rule.
 * @param {Model} model
 * @param {string | null} branch
 * @returns {ModelReview | null}
 */
export function modelLatestReview(model, branch) {
  let latest = null
  for (const review of modelBranchReviews(model, branch)) {
    if (latest === null || review.round > latest.round) latest = review
  }
  return latest
}

/**
 * @param {Model} model
 * @param {string | null} branch
 * @param {string} reviewer
 * @returns {number}
 */
export function modelReviewerRounds(model, branch, reviewer) {
  return modelBranchReviews(model, branch).filter((review) => review.reviewer === reviewer).length
}

/**
 * The round a *new* (not appended) review would get: the highest round on the
 * branch plus one, or 1 when the branch has no review yet.
 * @param {Model} model
 * @param {string | null} branch
 * @returns {number}
 */
export function modelNextReviewRound(model, branch) {
  let max = 0
  for (const review of modelBranchReviews(model, branch)) max = Math.max(max, review.round)
  return max + 1
}

/**
 * Mission ids are `M<number>`; a plan takes the first free number above the
 * highest existing one.
 * @param {Model} model
 * @returns {number}
 */
export function modelNextMissionNumber(model) {
  let max = 0
  for (const id of model.missions.keys()) {
    const match = /^M(\d+)$/.exec(id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

/**
 * @param {ModelMission} mission
 * @returns {boolean}
 */
export function modelReviewRequired(mission) {
  return MODEL_CONFIG.review.requireReview === true
}

/**
 * @param {ModelMission} mission
 * @returns {boolean}
 */
export function modelReviewExempt(mission) {
  if (MODEL_CONFIG.review.requireReview === false) return true
  return (
    mission.reviewPolicy === 'none' &&
    MODEL_CONFIG.gates.allowReviewExemption === true &&
    mission.reviewExemptionReason.trim().length > 0
  )
}

/**
 * @param {ModelMission} mission
 * @param {ModelReview | null} review
 * @returns {boolean}
 */
export function modelRebaseWaived(mission, review) {
  const rebase = mission.rebase
  if (!rebase) return false
  if (!review) return false
  return review.at <= rebase.at && review.tip === rebase.oldTip
}

/**
 * Predict the merge gate blockers for a mission. The roster/activity part of
 * the real gate is out of model scope: this property always passes an empty
 * activity map, a null parent catalog, no inactive states and synthesized
 * `running` workers, so the real gate cannot produce a worker blocker here.
 * The returned codes are the lifecycle blockers the model owns.
 * @param {Model} model
 * @param {ModelMission} mission
 * @returns {string[]}
 */
export function modelMergeBlockers(model, mission) {
  /** @type {string[]} */
  const blockers = []
  const requireReview = modelReviewRequired(mission)
  const exempt = modelReviewExempt(mission)
  if (mission.reviewPolicy === 'none' && MODEL_CONFIG.gates.allowReviewExemption !== true) {
    blockers.push('review-exemption-invalid')
  }
  const review = modelLatestReview(model, mission.branch)
  if (requireReview && !exempt && review === null) {
    blockers.push('no-review')
  } else if (requireReview && !exempt && review !== null) {
    if (review.missionId !== mission.id) blockers.push('review-mission-mismatch')
    if (review.status !== 'clean') blockers.push('not-clean')
    if (review.merge === 'hold') blockers.push('review-hold')
    else if (review.status === 'clean' && review.merge !== 'merge') blockers.push('review-not-approved')
    if (mission.tip && review.tip !== mission.tip && !modelRebaseWaived(mission, review)) {
      blockers.push('tip-moved')
    }
  }
  return blockers
}

/**
 * Whether a mission can be completed: the completion admission requires a
 * non-terminal, not-already-completed mission with a worktree, no open task and
 * no blocker.
 * @param {ModelMission} mission
 * @returns {boolean}
 */
export function modelCanComplete(mission) {
  return (
    (mission.status === 'active' || mission.status === 'planned') &&
    mission.hasWorktree &&
    modelOpenTasks(mission).length === 0 &&
    mission.blockers.length === 0
  )
}

/**
 * Whether a review can be recorded: only a completed mission with a worktree is
 * reviewable, and the per-reviewer round cap applies.
 * @param {Model} model
 * @param {ModelMission} mission
 * @param {string} reviewer
 * @returns {boolean}
 */
export function modelCanReview(model, mission, reviewer) {
  if (!mission.hasWorktree || !mission.branch || !mission.tip) return false
  if (mission.status !== 'completed') return false
  return modelReviewerRounds(model, mission.branch, reviewer) < MODEL_CONFIG.review.maxRoundsPerReviewer
}

/**
 * Whether a merge is reachable. The app route merges through the gate, which
 * combines the completion blockers (mission must be completed, no open task, no
 * blocker) with the merge gate blockers; the model owns both halves.
 * @param {Model} model
 * @param {ModelMission} mission
 * @returns {boolean}
 */
export function modelCanMerge(model, mission) {
  if (mission.status !== 'completed') return false
  if (!mission.hasWorktree) return false
  if (!mission.branch || !mission.tip) return false
  if (modelOpenTasks(mission).length > 0) return false
  if (mission.blockers.length > 0) return false
  return modelMergeBlockers(model, mission).length === 0
}

/**
 * Predict the outcome of a status patch (`applyMissionUpdate`) for a mission
 * that the property selected. Returns `null` when the model considers the
 * command inapplicable, so the command is never executed.
 * @param {Model} model
 * @param {string} missionId
 * @param {string} target
 * @param {{ authorization?: boolean }} [options]
 * @returns {{ accept: boolean, code?: string, reason: string } | null}
 */
export function modelStatusOutcome(model, missionId, target, options = {}) {
  const mission = modelMission(model, missionId)
  if (!modelCanTransition(mission.status, target)) {
    return {
      accept: false,
      code: MODEL_REJECTION_CODES.status,
      reason: `mission ${missionId} cannot move from ${mission.status} to ${target}`,
    }
  }
  const resuming = mission.status === 'paused' && target === 'active'
  const needsAuthorization =
    resuming &&
    MODEL_CONFIG.mode.requireResumeAuthorization === true &&
    (mission.pauseCause ?? 'user') === 'user'
  if (needsAuthorization && options.authorization !== true) {
    return {
      accept: false,
      code: MODEL_REJECTION_CODES.authorization,
      reason: `resuming the user-paused mission ${missionId} requires an authorization reference`,
    }
  }
  return { accept: true, reason: `mission ${missionId}: ${mission.status} -> ${target}` }
}

/**
 * Predict the outcome of `applyFindingUpdate` for one finding.
 * @param {Model} model
 * @param {string} findingId
 * @param {string} target
 * @returns {{ accept: boolean, code?: string, reason: string }}
 */
export function modelFindingOutcome(model, findingId, target) {
  if (!model.findings.has(findingId)) throw new Error(`reference model has no finding ${findingId}`)
  const current = model.findings.get(findingId)
  if (!modelCanTransitionFinding(current, target)) {
    return {
      accept: false,
      code: MODEL_REJECTION_CODES.finding,
      reason: `finding ${findingId} cannot move from ${current} to ${target}`,
    }
  }
  return { accept: true, reason: `finding ${findingId}: ${current} -> ${target}` }
}

/**
 * The model's window into a finding's current status.
 * @param {Model} model
 * @param {string} findingId
 * @returns {string}
 */
export function modelFindingStatusOf(model, findingId) {
  const status = model.findings.get(findingId)
  if (status === undefined) throw new Error(`reference model has no finding ${findingId}`)
  return status
}

// ---------------------------------------------------------------------------
// Model mutations. Every accepted command applies exactly one of these; a
// rejected command applies none, which is how the no-op property is expressed on
// the model side.
// ---------------------------------------------------------------------------

/**
 * @param {Model} model
 * @param {Record<string, any>} mission
 * @returns {ModelMission}
 */
export function modelPlan(model, mission) {
  const created = missionModel(mission)
  model.missions.set(created.id, created)
  return created
}

/**
 * @param {Model} model
 * @param {string} id
 * @param {string} status
 * @param {{ pauseCause?: string | null }} [options]
 * @returns {void}
 */
export function modelSetStatus(model, id, status, options = {}) {
  const mission = modelMission(model, id)
  mission.status = status
  if (status === 'paused') mission.pauseCause = options.pauseCause ?? 'user'
}

/**
 * @param {Model} model
 * @param {string} id
 * @returns {void}
 */
export function modelComplete(model, id) {
  modelMission(model, id).status = 'completed'
}

/**
 * @param {Model} model
 * @param {string} id
 * @returns {void}
 */
export function modelAbandon(model, id) {
  modelMission(model, id).status = 'abandoned'
}

/**
 * @param {Model} model
 * @param {string} id
 * @returns {void}
 */
export function modelMerge(model, id) {
  modelMission(model, id).status = 'merged'
}

/**
 * Apply the production rebase success effect: record the reviewed-tip waiver and
 * return a blocked mission to active. The rebased tip is recorded on the waiver
 * only; `mission.worktree.baseCommit` (the merge gate's branch tip) is left
 * untouched, exactly like app/rebase.js.
 * @param {Model} model
 * @param {string} id
 * @param {{ at: number, oldTip: string, newTip: string }} effect
 * @returns {void}
 */
export function modelRebase(model, id, effect) {
  const mission = modelMission(model, id)
  mission.rebase = { at: effect.at, oldTip: effect.oldTip }
  if (mission.status === 'blocked') mission.status = 'active'
}

/**
 * @param {Model} model
 * @param {ModelReview} review
 * @returns {void}
 */
export function modelRecordReview(model, review) {
  model.reviews.push(review)
  const mission = modelMission(model, review.missionId)
  // A verdict that is not clean returns a completed mission to active; a clean
  // verdict leaves it completed.
  if (review.status !== 'clean') mission.status = 'active'
}

/**
 * @param {Model} model
 * @param {string} id
 * @param {string} status
 * @returns {void}
 */
export function modelSetFinding(model, id, status) {
  if (!MODEL_FINDING_STATUSES.includes(status)) throw new Error(`model cannot set finding ${id} to ${status}`)
  model.findings.set(id, status)
}

/**
 * @param {Model} model
 * @param {string} id
 * @param {string} owner
 * @returns {void}
 */
export function modelSetOwner(model, id, owner) {
  modelMission(model, id).owner = owner
}

/**
 * Assert that the model and the committed real state agree on the facts the
 * model owns. Called after every accepted command (property 2, "model/actual
 * status agrees") and once more at the end of a run.
 * @param {Model} model
 * @param {Record<string, any>} state
 * @returns {void}
 */
export function assertModelAgrees(model, state) {
  const actualMissions = new Map((state.missions ?? []).map((mission) => [mission.id, mission]))
  if (actualMissions.size !== model.missions.size) {
    throw new Error(`model tracks ${model.missions.size} missions but the state has ${actualMissions.size}`)
  }
  for (const [id, mission] of model.missions) {
    const actual = actualMissions.get(id)
    if (!actual) throw new Error(`state lost mission ${id} tracked by the model`)
    if (actual.status !== mission.status) {
      throw new Error(`mission ${id}: model status ${mission.status} !== actual status ${actual.status}`)
    }
    const actualOpen = (actual.tasks ?? []).filter((task) => task?.status === 'open').length
    if (actualOpen !== modelOpenTasks(mission).length) {
      throw new Error(`mission ${id}: model open tasks ${modelOpenTasks(mission).length} !== actual ${actualOpen}`)
    }
    const actualBlockers = (actual.blockers ?? []).length
    if (actualBlockers !== mission.blockers.length) {
      throw new Error(`mission ${id}: model blockers ${mission.blockers.length} !== actual ${actualBlockers}`)
    }
  }
  const actualFindings = new Map((state.findings ?? []).map((finding) => [finding.id, modelFindingStatus(finding)]))
  if (actualFindings.size !== model.findings.size) {
    throw new Error(`model tracks ${model.findings.size} findings but the state has ${actualFindings.size}`)
  }
  for (const [id, status] of model.findings) {
    if (actualFindings.get(id) !== status) {
      throw new Error(`finding ${id}: model status ${status} !== actual status ${actualFindings.get(id)}`)
    }
  }
  if ((state.reviews ?? []).length !== model.reviews.length) {
    throw new Error(`model tracks ${model.reviews.length} reviews but the state has ${(state.reviews ?? []).length}`)
  }
}

/**
 * A short, deterministic rendering of the model for counterexample output.
 * @param {Model} model
 * @returns {string}
 */
export function describeModel(model) {
  const missions = [...model.missions.values()]
    .map((mission) => `${mission.id}:${mission.status}`)
    .join(' ')
  const findings = [...model.findings].map(([id, status]) => `${id}:${status}`).join(' ')
  return `missions[${missions}] findings[${findings}] reviews=${model.reviews.length}`
}
