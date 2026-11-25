// Pure review submission policy: actor resolution, verdict validation, round
// accounting, and the resulting mission/record projections.
//
// app/review.js owns loading state, the worktree/tip Git reads, the lock, and
// persistence. Everything here is deterministic and repository-free.
// @ts-check
import { TowerToolError } from '../errors.js'
import { reviewedEvent } from '../events.js'
import { latestReview, reviewsForBranch } from '../integration/review.js'
import { MERGE_VERDICTS, REVIEW_STATUS_RE } from '../mission.js'
import { isReviewerRole } from '../roles.js'
import { shapeFor } from '../shapes/index.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').RosterEntry} RosterEntry */
/** @typedef {import('../../types/index.js').Review} Review */

export const MAX_REVIEW_ROUNDS = 5

/** Hard cap on non-blocking notes per verdict (#221). */
export const MAX_REVIEW_NOTES = 10

/** Hard cap on one note's length, in characters (#221). */
export const REVIEW_NOTE_MAX_CHARS = 400

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
 * that its status is `completed`. An acceptance-gated shape is never
 * reviewable: its verdict channel is the human acceptance record, so a review
 * submitted for one is refused rather than recorded and ignored (#159 D4).
 * @param {Mission} mission
 * @returns {void}
 */
export function assertReviewableMission(mission) {
  const shape = shapeFor(mission.kind)
  if (shape.fields.acceptance) {
    fail(
      `mission ${mission.id} is a ${shape.kind}: its gate is a human acceptance of the committed tip, not a review; record the acceptance instead of a verdict`,
      'invalid-transition',
    )
  }
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
    if (!isReviewerRole(caller.role)) {
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
 * Validate the non-blocking note channel (#221). A note is an observation that
 * must not change the verdict: it is recorded next to the review, never folded
 * into `findings`, and never consulted by the merge gate. The shape is
 * deliberately narrow (a list of short strings) so it can never smuggle a
 * status or a merge verdict.
 * @param {unknown} input
 * @returns {string[]}
 */
export function normalizeReviewNotes(input) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) fail('notes must be an array of short strings')
  if (input.length > MAX_REVIEW_NOTES) {
    fail(`a review carries at most ${MAX_REVIEW_NOTES} notes; fold the rest into one note or file a finding`)
  }
  return input.map((entry) => {
    if (typeof entry !== 'string') fail('each review note must be a string')
    const text = entry.trim()
    if (!text) fail('a review note must not be empty')
    if (text.length > REVIEW_NOTE_MAX_CHARS) {
      fail(`a review note may not exceed ${REVIEW_NOTE_MAX_CHARS} characters (got ${text.length})`)
    }
    return text
  })
}

/**
 * Validate the verdict payload fields that are independent of Git.
 * @param {any} input
 * @returns {{ status: string, merge: string, findings: string, decision: string, checks: string[], notes?: string[] }}
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
  const notes = normalizeReviewNotes(input.notes)
  // #221: a verdict without notes keeps the pre-#221 shape exactly, so legacy
  // callers and stored rows are untouched.
  return { status: input.status, merge: input.merge, findings, decision, checks, ...(notes.length > 0 ? { notes } : {}) }
}

/**
 * The recency round recorded on a review row, or 0 when a legacy row predates
 * the key. State semantics keep rows without `round` readable (schema v5), and
 * the shared resolver already coalesces the key the same way; the round
 * accounting must not turn a missing key into `NaN`.
 * @param {Review} review
 * @returns {number}
 */
function storedReviewRound(review) {
  return Number(review.round) || 0
}

/**
 * Decide whether this submission starts a new review round or appends to the
 * current one (#108). A completed mission always starts a new round. A mission
 * that is `active` accepts a later route for the tip that its current round
 * reviewed: the first non-clean verdict already returned it to `active`, and the
 * remaining routes spawned against the same tip must still record their
 * verdicts. A verdict for a tip that moved is rejected with an explanation.
 *
 * A legacy latest row without a `round` is treated as round 0: it appends to the
 * recorded (round-less) round and `reviewRound` opens the next positive round
 * rather than persisting 0 or `NaN`.
 * @param {{ mission: Mission, reviews: Review[] | undefined, branch: string, tip: string }} params
 * @returns {{ appended: boolean, round: number | null }}
 */
export function reviewAdmission({ mission, reviews, branch, tip }) {
  if (mission.status === 'completed') return { appended: false, round: null }
  if (mission.status !== 'active') {
    fail(`mission ${mission.id} is ${mission.status}; only a completed mission can be reviewed`)
  }
  // The same resolver the merge gate and the read projections use: the most
  // recently recorded verdict of the highest round, then its next tip check.
  const latest = latestReview(reviewsForBranch(reviews, branch))
  if (!latest) {
    fail(`mission ${mission.id} is active and has no review round to append to; only a completed mission can be reviewed`)
  }
  const latestRound = storedReviewRound(latest)
  const roundText = latestRound > 0 ? `round ${latestRound}` : 'the recorded round (legacy row without a round)'
  if (latest.reviewedCommit !== tip) {
    const cause =
      latest.status === 'clean'
        ? 'the reviewed tip moved'
        : `review ${roundText} (${latest.status}) returned it to active and the reviewed tip moved`
    fail(
      `mission ${mission.id} is active: ${cause} (${String(latest.reviewedCommit).slice(0, 7)} -> ${tip.slice(0, 7)}); only review routes for the same reviewed tip can append to ${roundText} — return the mission to completed before starting a new round`,
    )
  }
  return { appended: true, round: latestRound }
}

/**
 * Compute the review round and enforce the per-reviewer cap. `round` joins the
 * round `reviewAdmission` selected for an appended route; omitted (or 0/absent
 * for a legacy row) the submission opens the next round.
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
  const round =
    typeof sharedRound === 'number' && Number.isInteger(sharedRound) && sharedRound > 0
      ? sharedRound
      : Math.max(0, ...prior.map(storedReviewRound)) + 1
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
 * Project every note of a verdict, preserving the reviewer's order. The id is
 * derived from the review sequence so it stays stable across replays and reads
 * in a report (`N3.2` = the second note of review R3).
 * @param {{ notes: string[], seq: number, round: number, reviewerName: string, now: number }} params
 * @returns {any[]}
 */
export function reviewNoteRecords({ notes, seq, round, reviewerName, now }) {
  return notes.map((text, index) => ({
    id: `N${seq}.${index + 1}`,
    reviewId: `R${seq}`,
    round,
    reviewer: reviewerName,
    at: now,
    text,
    state: 'open',
  }))
}

/**
 * Project the persisted review record.
 * @param {{ seq: number, missionId: string, branch: string, tip: string, verdict: { status: string, merge: string, findings: string, checks: string[], decision: string, notes?: string[] }, reviewerName: string, reviewerRole: string, round: number, now: number, breakGlassReason?: string }} params
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
  /** @type {any} */
  const record = {
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
  // #221: the note channel is optional and additive. Rows written before it
  // existed stay shape-identical, so legacy snapshots keep validating.
  const notes = Array.isArray(verdict.notes) ? verdict.notes : []
  if (notes.length > 0) {
    record.notes = reviewNoteRecords({ notes, seq, round, reviewerName, now })
  }
  return record
}

/**
 * The notes of one review row that are still open, in recorded order.
 * @param {any} review
 * @returns {any[]}
 */
export function openReviewNotes(review) {
  return Array.isArray(review?.notes) ? review.notes.filter((note) => note.state === 'open') : []
}

/**
 * Aggregate the open notes across review rows for the doctor surface (#221).
 * Pure and bounded: `sample` names at most three `missionId:noteId` pairs so a
 * release sweep stays actionable without serializing every note.
 * @param {any[] | undefined} reviews
 * @returns {{ total: number, missions: string[], sample: string }}
 */
export function summarizeOpenReviewNotes(reviews) {
  const open = (Array.isArray(reviews) ? reviews : []).flatMap((review) =>
    openReviewNotes(review).map((note) => ({ review, note })),
  )
  const missions = [...new Set(open.map(({ review }) => review.missionId))].sort()
  const sample = open.slice(0, 3).map(({ review, note }) => `${review.missionId}:${note.id}`).join(', ')
  return { total: open.length, missions, sample: `${sample}${open.length > 3 ? ', …' : ''}` }
}

/**
 * Plan the fold of one mission's open review notes into its task list (#221).
 * Pure: it reports what would change; app/mission.js applies it. A fold is an
 * audit record, never a gate: it never reopens a mission, never adds a blocker,
 * and never touches the review verdict. A note recorded on the same branch but
 * owned by another mission is refused rather than folded, so a fold can never
 * claim another mission's history.
 * @param {{ mission: Mission, reviews: any[] | undefined }} params
 * @returns {{ tasks: Array<{ text: string, status: string, note: string }>, folded: Array<{ review: any, note: any }>, change: string }}
 */
export function foldReviewNotes({ mission, reviews }) {
  const branch = mission.worktree?.branch
  const relevant = (reviews ?? []).filter(
    (review) => review.missionId === mission.id || (branch && review.branch === branch),
  )
  const foreign = relevant.find((review) => review.missionId !== mission.id && openReviewNotes(review).length > 0)
  if (foreign) {
    const note = openReviewNotes(foreign)[0]
    fail(
      `review note ${note.id} belongs to mission ${foreign.missionId}, not ${mission.id}; a mission folds only the notes its own reviews recorded`,
    )
  }
  const own = relevant.filter((review) => review.missionId === mission.id)
  /** @type {Array<{ review: any, note: any }>} */
  const folded = []
  for (const review of own) {
    for (const note of openReviewNotes(review)) folded.push({ review, note })
  }
  if (folded.length === 0) fail(`mission ${mission.id} has no open review notes to fold`)
  const tasks = folded.map(({ review, note }) => ({
    text: `folded review note ${note.id}: ${String(note.text).slice(0, 200)}`,
    status: 'done',
    note: `folded from review ${review.id} (round ${review.round}) by the tower`,
  }))
  return {
    tasks,
    folded,
    change: `folded ${folded.length} review note${folded.length === 1 ? '' : 's'} into the task list`,
  }
}

