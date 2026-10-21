// Pure mission-context projection: reviews, findings, and dependency statuses
// for one mission. Loading state and activity stays in app/missionContext.js.
// @ts-check
import { fullMission, findingSummary } from '../summary.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').TowerState} TowerState */

/**
 * @param {object} input
 * @param {TowerState} input.state
 * @param {Mission} input.mission
 * @returns {object}
 */
export function missionContextView({ state, mission }) {
  const byId = new Map(state.missions.map((entry) => [entry.id, entry]))
  const branch = mission.worktree ? mission.worktree.branch : null
  const reviews = branch
    ? (state.reviews ?? [])
        .filter((review) => review.branch === branch)
        .slice()
        .sort((left, right) => right.round - left.round)
        .slice(0, 3)
    : []
  const findings = (state.findings ?? [])
    .filter((finding) => finding.missionId === mission.id)
    .slice()
    .sort((left, right) => (right.seq ?? 0) - (left.seq ?? 0))
    .slice(0, 10)
  return {
    base: state.base,
    mission: fullMission(mission),
    snapshotCommit: state.snapshotCommit ?? null,
    completionReport: mission.completionReport ?? null,
    reviews: reviews.map((review) => ({
      id: review.id,
      round: review.round,
      status: review.status,
      mergeVerdict: review.mergeVerdict,
      reviewer: review.reviewer,
      findings: review.findings,
      checks: review.checks ?? [],
      decision: review.decision,
      reviewedCommit: review.reviewedCommit,
      at: review.at,
    })),
    findings: findings.map((finding) => findingSummary(finding)),
    deps: (mission.deps ?? []).map((id) => {
      const dep = byId.get(id)
      return dep ? { id, title: dep.title, status: dep.status } : { id, title: null, status: 'unknown' }
    }),
  }
}
