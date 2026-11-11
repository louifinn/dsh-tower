// Independent review submission use case.
import { sweepArchive } from './archive.js'
import { validateState } from '../domain/state.js'
import { TowerToolError } from '../domain/errors.js'
import { reviewUnavailable } from '../domain/integration/review.js'
import { cleanupReviewCheckout } from './reviewCheckout.js'
import {
  assertReviewableMission,
  resolveReviewActor,
  normalizeReviewVerdict,
  reviewAdmission,
  reviewRound,
  reviewOutcome,
  reviewRecord,
  applyReviewOutcome,
} from '../domain/missions/review.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

/**
 * The commit a verdict is stamped with (#149 W3).
 *
 * A spawned reviewer is bound to the review commit recorded on its roster row
 * and reads it in a disposable detached checkout; that checkout must still be
 * at the recorded commit, so a verdict can never review a moving target. The
 * tower's break-glass review has no checkout and stamps the current branch tip.
 * @param {any} tower
 * @param {{ mission: any, caller: any, reviewerRole: string }} input
 * @returns {Promise<string>}
 */
async function reviewCommitFor(tower, { mission, caller, reviewerRole }) {
  if (reviewerRole === 'tower') return tower.branchTip(mission)
  const recorded = caller?.reviewCommit
  if (typeof recorded !== 'string' || recorded.length === 0) {
    fail(
      `reviewer ${caller?.name ?? '?'} has no recorded review commit; spawn reviewers through tower_spawn (a verdict is stamped with a commit, not a live branch tip)`,
    )
  }
  if (typeof caller.reviewCheckout === 'string' && caller.reviewCheckout.length > 0) {
    const head = await tower.revParse(caller.reviewCheckout, 'HEAD').catch(() => null)
    if (head !== recorded) {
      const where = head ? head.slice(0, 12) : 'a missing checkout'
      fail(
        `reviewer ${caller.name}'s checkout is at ${where} instead of the recorded review commit ${recorded.slice(0, 12)}; spawn a fresh reviewer`,
      )
    }
  }
  return recorded
}

/**
 * Phase 1 (#51): load state and capture everything the review needs — actor
 * checks, worktree ownership, branch tip, and round counters — without holding
 * the state lock. No git call may run inside the lock.
 */
async function prepareReview(tower, input) {
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === input.missionId)
  if (!mission) fail(`unknown mission "${input.missionId}"`)
  assertReviewableMission(mission)

  const caller = (state.roster ?? []).find((entry) => entry.agentId === input.agentId)
  const { reviewerName, reviewerRole } = resolveReviewActor({
    mission,
    caller,
    actorRole: input.actor?.role,
    agentId: input.agentId,
    breakGlassReason: input.breakGlassReason,
  })

  if (!['completed', 'active'].includes(mission.status)) {
    fail(`mission ${mission.id} is ${mission.status}; only a completed mission can be reviewed`)
  }
  const verdict = normalizeReviewVerdict(input)

  await tower.assertWorktree(mission.worktree)
  const tip = await reviewCommitFor(tower, { mission, caller, reviewerRole })
  const branch = mission.worktree.branch
  // #108: a later route may append to the round that returned the mission to
  // active, but only for the tip that round reviewed.
  const admission = reviewAdmission({ mission, reviews: state.reviews, branch, tip })
  const { reviewerRounds, round } = reviewRound({
    reviews: state.reviews,
    branch,
    reviewerName,
    maxRoundsPerReviewer: tower.config.review.maxRoundsPerReviewer,
    round: admission.round,
  })

  return {
    stateRevision: state.revision,
    missionId: mission.id,
    branch,
    tip,
    status: verdict.status,
    merge: verdict.merge,
    findings: verdict.findings,
    checks: verdict.checks,
    decision: verdict.decision,
    reviewerName,
    reviewerRole,
    reviewerRounds,
    round,
    appended: admission.appended,
    breakGlassReason: reviewerRole === 'tower' ? input.breakGlassReason.trim() : undefined,
  }
}

export async function submitReview(tower, input) {
  // #M39: `review.mode:off` means review is intentionally unavailable. The tool
  // is not registered in that profile, but the repository layer can also turn it
  // off, so the app layer refuses before any state is read.
  if (reviewUnavailable(tower.config)) {
    throw new TowerToolError('review-disabled', 'review.mode is off, so tower_review cannot record a verdict')
  }
  // Two-phase (#51): the lock is held only for the state reload, revision
  // revalidation, and write; every git call happens in prepareReview.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prepared = await prepareReview(tower, input)
    try {
      const result = await tower.withStateLock(async (_paths, held) => {
        const state = await tower.load()
        if (state.revision !== prepared.stateRevision) {
          throw new TowerToolError('stale-base', 'tower state changed while the review was being prepared; retry')
        }
        const mission = state.missions.find((entry) => entry.id === input.missionId)
        if (!mission) fail(`unknown mission "${input.missionId}"`)

        const now = Date.now()
        const seq = (state.reviewSeq ?? 0) + 1
        state.reviewSeq = seq
        const review = reviewRecord({
          seq,
          missionId: mission.id,
          branch: prepared.branch,
          tip: prepared.tip,
          verdict: {
            status: prepared.status,
            merge: prepared.merge,
            findings: prepared.findings,
            checks: prepared.checks,
            decision: prepared.decision,
          },
          reviewerName: prepared.reviewerName,
          reviewerRole: prepared.reviewerRole,
          round: prepared.round,
          now,
          breakGlassReason: prepared.breakGlassReason,
        })
        if (!Array.isArray(state.reviews)) state.reviews = []
        state.reviews.push(review)

        const outcome = reviewOutcome({
          status: prepared.status,
          merge: prepared.merge,
          round: prepared.round,
          reviewerName: prepared.reviewerName,
          appended: prepared.appended,
        })
        const applied = applyReviewOutcome({ mission, outcome, now })
        await sweepArchive(tower, state, { now })
        state.revision += 1
        state.updatedAt = now

        validateState(state, tower.paths.state)
        await tower.writeState(state, held)
        await tower.appendActivity({
          at: now,
          type: 'review',
          missionId: mission.id,
          text: `round ${prepared.round} ${prepared.reviewerName}: ${prepared.status} / ${prepared.merge} @ ${prepared.tip.slice(0, 12)}`,
        })
        tower.emitEvents(applied.events, { revision: state.revision, at: now })
        return {
          review,
          branchTip: prepared.tip,
          missionStatus: mission.status,
          round: prepared.round,
          appended: prepared.appended,
          reviewerRounds: prepared.reviewerRounds + 1,
        }
      })
      // The verdict is recorded, so the reviewer's evidence checkout has served
      // its purpose. Removal is advisory: a failed cleanup is retried by teardown.
      if (prepared.reviewerRole === 'reviewer') {
        await cleanupReviewCheckout(tower, { name: prepared.reviewerName, missionId: prepared.missionId }).catch(() => {})
      }
      return result
    } catch (error) {
      if (error.code === 'stale-base' && attempt === 0) continue
      throw error
    }
  }
  throw new TowerToolError('stale-base', 'tower state kept changing while the review was being prepared; retry')
}
