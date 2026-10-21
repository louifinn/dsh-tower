// Dashboard mission enrichment use case.
import { missionSummary } from '../domain/summary.js'
import { exists } from '../lib/store.js'
import { revParse } from '../lib/git.js'

export async function enrichedMissions(tower, state, onlyIds) {
  const wanted = onlyIds ? new Set(onlyIds) : null
  const out = []
  for (const mission of state.missions) {
    if (wanted && !wanted.has(mission.id)) continue
    const summary = missionSummary(mission)
    const branch = mission.worktree ? mission.worktree.branch : null
    const reviews = branch ? (state.reviews ?? []).filter((review) => review.branch === branch) : []
    const latest = reviews.length > 0 ? reviews.reduce((a, b) => (a.round >= b.round ? a : b)) : null
    let tipMoved = false
    if (latest && mission.worktree && (await exists(mission.worktree.path))) {
      try {
        const tip = await revParse(mission.worktree.path, 'HEAD')
        tipMoved = tip !== latest.reviewedCommit
      } catch {
        tipMoved = false
      }
    }
    out.push({
      ...summary,
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
    })
  }
  return out
}
