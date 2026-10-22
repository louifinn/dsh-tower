// Dashboard mission enrichment use case.
import {
  enrichedMissionView,
  latestReviewForMission,
  missionsToEnrich,
} from '../domain/read/enrichedMissions.js'

export async function enrichedMissions(tower, state, onlyIds) {
  const out = []
  for (const mission of missionsToEnrich(state.missions, onlyIds)) {
    const latest = latestReviewForMission(state, mission)
    let tipMoved = false
    if (latest && mission.worktree && (await tower.deps.store.exists(mission.worktree.path))) {
      try {
        const tip = await tower.deps.vcs.revParse(mission.worktree.path, 'HEAD')
        tipMoved = tip !== latest.reviewedCommit
      } catch {
        tipMoved = false
      }
    }
    out.push(enrichedMissionView({ mission, latest, tipMoved }))
  }
  return out
}
