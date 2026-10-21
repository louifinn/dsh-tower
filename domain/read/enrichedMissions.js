// Pure dashboard mission enrichment: select the latest review, project the
// review view, and merge it into the mission summary. The worktree existence
// check and `rev-parse HEAD` that detect a moved tip stay in
// app/enrichedMissions.js.
// @ts-check
import { missionSummary } from '../summary.js'
import { latestReview, reviewsForBranch } from '../integration/review.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').Review} Review */
/** @typedef {import('../../types/index.js').TowerState} TowerState */

/**
 * Filter the missions the caller asked for, preserving state order.
 * @param {Mission[]} missions
 * @param {string[] | null | undefined} onlyIds
 * @returns {Mission[]}
 */
export function missionsToEnrich(missions, onlyIds) {
  const wanted = onlyIds ? new Set(onlyIds) : null
  return wanted ? missions.filter((mission) => wanted.has(mission.id)) : missions
}

/**
 * @param {TowerState} state
 * @param {Mission} mission
 * @returns {Review | null}
 */
export function latestReviewForMission(state, mission) {
  const branch = mission.worktree ? mission.worktree.branch : null
  return latestReview(reviewsForBranch(state.reviews, branch))
}

/**
 * @param {object} input
 * @param {Mission} input.mission
 * @param {Review | null} input.latest
 * @param {boolean} input.tipMoved
 * @returns {object}
 */
export function enrichedMissionView({ mission, latest, tipMoved }) {
  return {
    ...missionSummary(mission),
    review: latest
      ? {
          id: latest.id,
          round: latest.round,
          status: latest.status,
          mergeVerdict: latest.mergeVerdict,
          reviewer: latest.reviewer,
          reviewerRole: latest.reviewerRole,
          reviewedCommit: latest.reviewedCommit,
          at: latest.at,
        }
      : null,
    tipMoved,
  }
}
