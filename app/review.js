// Independent review submission use case.
import { sweepArchive } from './archive.js'
import { validateState } from '../domain/state.js'
import { TowerToolError } from '../domain/errors.js'
import {
  assertReviewableMission,
  resolveReviewActor,
  normalizeReviewVerdict,
  assertReviewerSpawnTip,
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
  const tip = await tower.revParse(mission.worktree.path, 'HEAD')
  const branch = mission.worktree.branch
  assertReviewerSpawnTip(caller, tip)
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
  // Two-phase (#51): the lock is held only for the state reload, revision
  // revalidation, and write; every git call happens in prepareReview.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prepared = await prepareReview(tower, input)
    try {
      return await tower.deps.store.withLock(tower.paths, async () => {
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
    await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
    await tower.deps.store.appendJsonl(tower.paths.activity, {
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
    } catch (error) {
      if (error.code === 'stale-base' && attempt === 0) continue
      throw error
    }
  }
  throw new TowerToolError('stale-base', 'tower state kept changing while the review was being prepared; retry')
}
