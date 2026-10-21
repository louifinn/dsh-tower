// Mission context projection use case (reviews, findings, dependencies).
import { TowerToolError } from '../lib/errors.js'
import { fullMission, findingSummary } from '../domain/summary.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

export async function missionContext(tower, missionId) {
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === missionId)
  if (!mission) fail(`unknown mission "${missionId}"`, 'mission-not-found')
  const byId = new Map(state.missions.map((entry) => [entry.id, entry]))
  const branch = mission.worktree ? mission.worktree.branch : null
  const reviews = branch
    ? (state.reviews ?? [])
        .filter((review) => review.branch === branch)
        .slice()
        .sort((a, b) => b.round - a.round)
        .slice(0, 3)
    : []
  const findings = (state.findings ?? [])
    .filter((finding) => finding.missionId === mission.id)
    .slice()
    .sort((a, b) => b.seq - a.seq)
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
