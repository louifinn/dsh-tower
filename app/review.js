// Independent review submission use case.
import { withLock, writeJsonAtomic, appendJsonl } from '../lib/store.js'
import { validateState } from '../domain/state.js'
import { REVIEW_STATUS_RE, MERGE_VERDICTS } from '../domain/mission.js'
import { TowerToolError } from '../domain/errors.js'

const MAX_REVIEW_ROUNDS = 5
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
  if (!mission.worktree) fail(`mission ${mission.id} has no worktree to review`)

  const caller = (state.roster ?? []).find((entry) => entry.agentId === input.agentId)
  const actorRole = input.actor?.role
  let reviewerName
  let reviewerRole
  if (actorRole === 'tower') {
    if (typeof input.breakGlassReason !== 'string' || input.breakGlassReason.trim().length === 0) {
      fail('a tower-submitted review is break-glass and requires a non-empty breakGlassReason', 'not-authorized')
    }
    reviewerName = 'tower'
    reviewerRole = 'tower'
  } else if (caller) {
    if (caller.role !== 'reviewer') {
      fail(`agent ${caller.name} is a ${caller.role}; only an assigned reviewer or the tower (break-glass) may review`)
    }
    if (caller.missionId !== mission.id) {
      fail(`reviewer ${caller.name} was not assigned to mission ${mission.id}`)
    }
    if (mission.owner && caller.name === mission.owner) fail('the reviewer must differ from the worker', 'not-authorized')
    reviewerName = caller.name
    reviewerRole = 'reviewer'
  } else {
    // Fail closed: an unknown caller is not the tower, and a missing
    // roster row is not evidence of tower identity.
    fail(`agent ${input.agentId ?? '(unknown)'} is not a registered reviewer or the tower`)
  }

  if (mission.status !== 'completed') {
    fail(`mission ${mission.id} is ${mission.status}; only a completed mission can be reviewed`)
  }
  if (!REVIEW_STATUS_RE.test(String(input.status ?? ''))) {
    fail('status must be "clean", "p1-Nitems", or "p2-Nitems"')
  }
  if (!MERGE_VERDICTS.includes(input.merge)) {
    fail(`merge verdict must be one of ${MERGE_VERDICTS.join('|')}`)
  }
  const findingsText = String(input.findings ?? '').trim()
  if (!findingsText) fail('findings text is required; write "none" for a clean verdict')
  if (input.status === 'clean' && findingsText.toLowerCase() !== 'none') {
    fail('a clean verdict requires findings text "none"')
  }
  if (input.status !== 'clean' && findingsText.toLowerCase() === 'none') {
    fail('a non-clean verdict must describe its findings')
  }
  const decision = String(input.decision ?? '').trim()
  if (!decision) fail('decision (the reasoning behind the verdict) is required')
  let checks = []
  if (input.checks !== undefined) {
    if (!Array.isArray(input.checks)) fail('checks must be an array of strings')
    checks = input.checks.map((entry) => String(entry))
  }

  await tower.assertWorktree(mission.worktree)
  const tip = await tower.revParse(mission.worktree.path, 'HEAD')
  const branch = mission.worktree.branch
  if (caller && caller.role === 'reviewer' && !String(caller.spawnTip ?? '').trim()) {
    fail(`reviewer ${caller.name} has no recorded spawn tip; re-spawn the reviewer before reviewing`)
  }
  if (caller && caller.role === 'reviewer' && caller.spawnTip !== tip) {
    fail(
      `reviewer ${caller.name} modified the mission branch after it was spawned (${String(caller.spawnTip).slice(0, 7)} -> ${tip.slice(0, 7)}); reviewers must be read-only — spawn a fresh reviewer`,
    )
  }
  const prior = (state.reviews ?? []).filter((review) => review.branch === branch)
  const reviewerRounds = prior.filter((review) => review.reviewer === reviewerName).length
  const maxReviewRounds = Number(tower.config.review.maxRoundsPerReviewer) || MAX_REVIEW_ROUNDS
  if (reviewerRounds >= maxReviewRounds) {
    fail(
      `reviewer ${reviewerName} reached the ${maxReviewRounds}-round cap for ${branch}; continue with a different reviewer`,
    )
  }
  const round = prior.length === 0 ? 1 : Math.max(...prior.map((review) => review.round)) + 1

  return {
    stateRevision: state.revision,
    missionId: mission.id,
    branch,
    tip,
    status: input.status,
    merge: input.merge,
    findings: findingsText,
    checks,
    decision,
    reviewerName,
    reviewerRole,
    reviewerRounds,
    round,
    breakGlassReason: reviewerRole === 'tower' ? input.breakGlassReason.trim() : undefined,
  }
}

export async function submitReview(tower, input) {
  // Two-phase (#51): the lock is held only for the state reload, revision
  // revalidation, and write; every git call happens in prepareReview.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prepared = await prepareReview(tower, input)
    try {
      return await withLock(tower.paths, async () => {
    const state = await tower.load()
    if (state.revision !== prepared.stateRevision) {
      throw new TowerToolError('stale-base', 'tower state changed while the review was being prepared; retry')
    }
    const mission = state.missions.find((entry) => entry.id === input.missionId)
    if (!mission) fail(`unknown mission "${input.missionId}"`)

    const now = Date.now()
    const seq = (state.reviewSeq ?? 0) + 1
    state.reviewSeq = seq
    const review = {
      id: `R${seq}`,
      seq,
      missionId: mission.id,
      branch: prepared.branch,
      reviewedCommit: prepared.tip,
      status: prepared.status,
      mergeVerdict: prepared.merge,
      findings: prepared.findings,
      checks: prepared.checks,
      decision: prepared.decision,
      reviewer: prepared.reviewerName,
      reviewerRole: prepared.reviewerRole,
      round: prepared.round,
      at: now,
      ...(prepared.reviewerRole === 'tower' ? { breakGlassReason: prepared.breakGlassReason } : {}),
    }
    if (!Array.isArray(state.reviews)) state.reviews = []
    state.reviews.push(review)

    if (prepared.status !== 'clean') {
      mission.status = 'active'
      mission.notes.push(
        `review round ${prepared.round} by ${prepared.reviewerName}: ${prepared.status} (${prepared.merge}) — returned to active`,
      )
    } else {
      mission.notes.push(`review round ${prepared.round} by ${prepared.reviewerName}: clean (${prepared.merge})`)
    }
    mission.updatedAt = now
    state.revision += 1
    state.updatedAt = now

    validateState(state, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, state)
    await appendJsonl(tower.paths.activity, {
      at: now,
      type: 'review',
      missionId: mission.id,
      text: `round ${prepared.round} ${prepared.reviewerName}: ${prepared.status} / ${prepared.merge} @ ${prepared.tip.slice(0, 12)}`,
    })
    return {
      review,
      branchTip: prepared.tip,
      missionStatus: mission.status,
      round: prepared.round,
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
