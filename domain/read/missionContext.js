// Pure mission-context projection: reviews, findings, and dependency statuses
// for one mission. Loading state and activity stays in app/missionContext.js.
// @ts-check
import { reviewsForBranch, reviewsNewestFirst } from '../integration/review.js'
import { fullMission, findingSummary } from '../summary.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').TowerState} TowerState */

/**
 * @param {object} input
 * @param {TowerState} input.state
 * @param {Mission} input.mission
 * @param {Array<Record<string, any>> | Map<string, Record<string, any>>} [input.archived] archive index entries (or a by-id map) so a dependency that has already been archived keeps its evidence
 * @returns {object}
 */
export function missionContextView({ state, mission, archived = [] }) {
  const byId = new Map(state.missions.map((entry) => [entry.id, entry]))
  const archivedById =
    archived instanceof Map ? archived : new Map(archived.map((entry) => [entry.id, entry]))
  const branch = mission.worktree ? mission.worktree.branch : null
  // The shared review ordering is round newest-first and, inside one round, the
  // most recently recorded verdict first — never raw storage order.
  const reviews = branch ? reviewsNewestFirst(reviewsForBranch(state.reviews, branch)).slice(0, 3) : []
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
      const dep = byId.get(id) ?? archivedById.get(id)
      if (!dep) return { id, title: null, status: 'unknown' }
      return {
        id,
        title: dep.title,
        kind: dep.kind,
        status: dep.status,
        readCommit: dep.readCommit ?? null,
        // #148 D6: a survey's completion evidence travels with the dependency
        // context so a dependent build worker sees what was found, not only that
        // the survey finished. Formatting/clipping is the briefing's job.
        result: dep.result ?? null,
      }
    }),
  }
}
