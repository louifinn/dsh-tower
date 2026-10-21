// Independent review submission use case.
import { withLock, writeJsonAtomic, appendJsonl } from '../store.js'
import { validateState } from '../domain/state.js'
import { REVIEW_STATUS_RE, MERGE_VERDICTS } from '../domain/mission.js'
import { TowerToolError } from '../errors.js'

const MAX_REVIEW_ROUNDS = 5
function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

export async function submitReview(tower, input) {
    return withLock(tower.paths, async () => {
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

      const now = Date.now()
      const seq = (state.reviewSeq ?? 0) + 1
      state.reviewSeq = seq
      const review = {
        id: `R${seq}`,
        seq,
        missionId: mission.id,
        branch,
        reviewedCommit: tip,
        status: input.status,
        mergeVerdict: input.merge,
        findings: findingsText,
        checks,
        decision,
        reviewer: reviewerName,
        reviewerRole,
        round,
        at: now,
        ...(reviewerRole === 'tower' ? { breakGlassReason: input.breakGlassReason.trim() } : {}),
      }
      if (!Array.isArray(state.reviews)) state.reviews = []
      state.reviews.push(review)

      if (input.status !== 'clean') {
        mission.status = 'active'
        mission.notes.push(
          `review round ${round} by ${reviewerName}: ${input.status} (${input.merge}) — returned to active`,
        )
      } else {
        mission.notes.push(`review round ${round} by ${reviewerName}: clean (${input.merge})`)
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
        text: `round ${round} ${reviewerName}: ${input.status} / ${input.merge} @ ${tip.slice(0, 12)}`,
      })
      return {
        review,
        branchTip: tip,
        missionStatus: mission.status,
        round,
        reviewerRounds: reviewerRounds + 1,
      }
    })
  }
