// Pure review submission policy: actor resolution, verdict validation, round
// accounting, and the resulting mission/record projections.
//
// app/review.js owns loading state, the worktree/tip Git reads, the lock, and
// persistence. Everything here is deterministic and repository-free.
// @ts-check
import { TowerToolError } from '../errors.js'
import { reviewedEvent } from '../events.js'
import { MERGE_VERDICTS, REVIEW_STATUS_RE } from '../mission.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').RosterEntry} RosterEntry */
/** @typedef {import('../../types/index.js').Review} Review */

export const MAX_REVIEW_ROUNDS = 5

/**
 * @param {string} message
 * @param {string} [code]
 * @returns {never}
 */
function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

/**
 * A mission with a worktree is the only reviewable subject; the caller checks
 * that its status is `completed`.
 * @param {Mission} mission
 * @returns {void}
 */
export function assertReviewableMission(mission) {
  if (!mission.worktree) fail(`mission ${mission.id} has no worktree to review`)
}

/**
 * Resolve who is submitting the review. An unregistered caller fails closed;
 * only an assigned reviewer or the tower (break-glass) may review.
 * @param {{ mission: Mission, caller: RosterEntry | undefined, actorRole: string | undefined, agentId: string | undefined, breakGlassReason: unknown }} params
 * @returns {{ reviewerName: string, reviewerRole: string }}
 */
export function resolveReviewActor({ mission, caller, actorRole, agentId, breakGlassReason }) {
  if (actorRole === 'tower') {
    if (typeof breakGlassReason !== 'string' || breakGlassReason.trim().length === 0) {
      fail('a tower-submitted review is break-glass and requires a non-empty breakGlassReason', 'not-authorized')
    }
    return { reviewerName: 'tower', reviewerRole: 'tower' }
  }
  if (caller) {
    if (caller.role !== 'reviewer') {
      fail(`agent ${caller.name} is a ${caller.role}; only an assigned reviewer or the tower (break-glass) may review`)
    }
    if (caller.missionId !== mission.id) {
      fail(`reviewer ${caller.name} was not assigned to mission ${mission.id}`)
    }
    if (mission.owner && caller.name === mission.owner) fail('the reviewer must differ from the worker', 'not-authorized')
    return { reviewerName: caller.name, reviewerRole: 'reviewer' }
  }
  // Fail closed: an unknown caller is not the tower, and a missing roster row
  // is not evidence of tower identity.
  fail(`agent ${agentId ?? '(unknown)'} is not a registered reviewer or the tower`)
}

/**
 * Validate the verdict payload fields that are independent of Git.
 * @param {any} input
 * @returns {{ status: string, merge: string, findings: string, decision: string, checks: string[] }}
 */
export function normalizeReviewVerdict(input) {
  if (!REVIEW_STATUS_RE.test(String(input.status ?? ''))) {
    fail('status must be "clean", "p1-Nitems", or "p2-Nitems"')
  }
  if (!MERGE_VERDICTS.includes(input.merge)) {
    fail(`merge verdict must be one of ${MERGE_VERDICTS.join('|')}`)
  }
  const findings = String(input.findings ?? '').trim()
  if (!findings) fail('findings text is required; write "none" for a clean verdict')
  if (input.status === 'clean' && findings.toLowerCase() !== 'none') {
    fail('a clean verdict requires findings text "none"')
  }
  if (input.status !== 'clean' && findings.toLowerCase() === 'none') {
    fail('a non-clean verdict must describe its findings')
  }
  const decision = String(input.decision ?? '').trim()
  if (!decision) fail('decision (the reasoning behind the verdict) is required')
  /** @type {string[]} */
  let checks = []
  if (input.checks !== undefined) {
    if (!Array.isArray(input.checks)) fail('checks must be an array of strings')
    checks = input.checks.map((entry) => String(entry))
  }
  return { status: input.status, merge: input.merge, findings, decision, checks }
}

/**
 * A reviewer may only review the tip it was spawned on.
 * @param {RosterEntry | undefined} caller
 * @param {string} tip
 * @returns {void}
 */
export function assertReviewerSpawnTip(caller, tip) {
  if (caller && caller.role === 'reviewer' && !String(caller.spawnTip ?? '').trim()) {
    fail(`reviewer ${caller.name} has no recorded spawn tip; re-spawn the reviewer before reviewing`)
  }
  if (caller && caller.role === 'reviewer' && caller.spawnTip !== tip) {
    fail(
      `reviewer ${caller.name} modified the mission branch after it was spawned (${String(caller.spawnTip).slice(0, 7)} -> ${tip.slice(0, 7)}); reviewers must be read-only — spawn a fresh reviewer`,
    )
  }
}

/**
 * The latest review of one branch. Higher rounds win; routes that share a round
 * are ordered by submission sequence, so "latest" is the most recently recorded
 * verdict (#108).
 * @param {Review[]} reviews
 * @returns {Review | null}
 */
function latestBranchReview(reviews) {
  /** @type {Review | null} */
  let latest = null
  for (const review of reviews) {
    if (!latest) {
      latest = review
      continue
    }
    const round = Number(review.round) || 0
    const latestRound = Number(latest.round) || 0
    if (round > latestRound) latest = review
    else if (round === latestRound && (Number(review.seq) || 0) > (Number(latest.seq) || 0)) latest = review
  }
  return latest
}

/**
 * Decide whether this submission starts a new review round or appends to the
 * current one (#108). A completed mission always starts a new round. A mission
 * that is `active` accepts a later route for the tip that its current round
 * reviewed: the first non-clean verdict already returned it to `active`, and the
 * remaining routes spawned against the same tip must still record their
 * verdicts. A verdict for a tip that moved is rejected with an explanation.
 * @param {{ mission: Mission, reviews: Review[] | undefined, branch: string, tip: string }} params
 * @returns {{ appended: boolean, round: number | null }}
 */
export function reviewAdmission({ mission, reviews, branch, tip }) {
  if (mission.status === 'completed') return { appended: false, round: null }
  if (mission.status !== 'active') {
    fail(`mission ${mission.id} is ${mission.status}; only a completed mission can be reviewed`)
  }
  const latest = latestBranchReview((reviews ?? []).filter((review) => review.branch === branch))
  if (!latest) {
    fail(`mission ${mission.id} is active and has no review round to append to; only a completed mission can be reviewed`)
  }
  if (latest.reviewedCommit !== tip) {
    const cause =
      latest.status === 'clean'
        ? 'the reviewed tip moved'
        : `review round ${latest.round} (${latest.status}) returned it to active and the reviewed tip moved`
    fail(
      `mission ${mission.id} is active: ${cause} (${String(latest.reviewedCommit).slice(0, 7)} -> ${tip.slice(0, 7)}); only review routes for the same reviewed tip can append to round ${latest.round} — return the mission to completed before starting a new round`,
    )
  }
  return { appended: true, round: latest.round }
}

/**
 * Compute the review round and enforce the per-reviewer cap. `round` joins the
 * round `reviewAdmission` selected for an appended route; omitted, the
 * submission opens the next round.
 * @param {{ reviews: Review[] | undefined, branch: string, reviewerName: string, maxRoundsPerReviewer: unknown, round?: number | null }} params
 * @returns {{ reviewerRounds: number, round: number }}
 */
export function reviewRound({ reviews, branch, reviewerName, maxRoundsPerReviewer, round: sharedRound }) {
  const prior = (reviews ?? []).filter((review) => review.branch === branch)
  const reviewerRounds = prior.filter((review) => review.reviewer === reviewerName).length
  const maxReviewRounds = Number(maxRoundsPerReviewer) || MAX_REVIEW_ROUNDS
  if (reviewerRounds >= maxReviewRounds) {
    fail(
      `reviewer ${reviewerName} reached the ${maxReviewRounds}-round cap for ${branch}; continue with a different reviewer`,
    )
  }
  const round = Number.isInteger(sharedRound)
    ? /** @type {number} */ (sharedRound)
    : prior.length === 0
      ? 1
      : Math.max(...prior.map((review) => review.round)) + 1
  return { reviewerRounds, round }
}

/**
 * A non-clean verdict returns the mission to active and records the note; a
 * clean verdict leaves the status untouched. An appended route records the
 * verdict without flipping the status again (#108).
 * @param {{ status: string, merge: string, round: number, reviewerName: string, appended?: boolean }} params
 * @returns {{ returnToActive: boolean, note: string }}
 */
export function reviewOutcome({ status, merge, round, reviewerName, appended = false }) {
  if (appended) {
    return {
      returnToActive: false,
      note: `review round ${round} by ${reviewerName}: ${status} (${merge}) — appended to the same round; the mission stays active until it is re-completed`,
    }
  }
  if (status !== 'clean') {
    return {
      returnToActive: true,
      note: `review round ${round} by ${reviewerName}: ${status} (${merge}) — returned to active`,
    }
  }
  return { returnToActive: false, note: `review round ${round} by ${reviewerName}: clean (${merge})` }
}

/**
 * Apply a recorded review's mission-level effect to the draft and describe the
 * domain fact. Persistence, the review record and the round accounting stay in
 * app/review.js.
 * @param {{ mission: Mission, outcome: { returnToActive: boolean, note: string }, now: number }} params
 * @returns {{ state: Mission, events: Array<{ type: string, missionId: string }> }}
 */
export function applyReviewOutcome({ mission, outcome, now }) {
  if (outcome.returnToActive) mission.status = 'active'
  mission.notes = mission.notes ?? []
  mission.notes.push(outcome.note)
  mission.updatedAt = now
  return { state: mission, events: [reviewedEvent(mission)] }
}

/**
 * Project the persisted review record.
 * @param {{ seq: number, missionId: string, branch: string, tip: string, verdict: { status: string, merge: string, findings: string, checks: string[], decision: string }, reviewerName: string, reviewerRole: string, round: number, now: number, breakGlassReason?: string }} params
 * @returns {Review}
 */
export function reviewRecord({
  seq,
  missionId,
  branch,
  tip,
  verdict,
  reviewerName,
  reviewerRole,
  round,
  now,
  breakGlassReason,
}) {
  return {
    id: `R${seq}`,
    seq,
    missionId,
    branch,
    reviewedCommit: tip,
    status: verdict.status,
    mergeVerdict: /** @type {import('../../types/index.js').MergeVerdict} */ (verdict.merge),
    findings: verdict.findings,
    checks: verdict.checks,
    decision: verdict.decision,
    reviewer: reviewerName,
    reviewerRole,
    round,
    at: now,
    ...(reviewerRole === 'tower' ? { breakGlassReason } : {}),
  }
}
