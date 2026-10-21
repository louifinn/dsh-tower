// Dashboard mission enrichment use case.
import { exists } from '../lib/store.js'
import { revParse } from '../lib/git.js'
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
    if (latest && mission.worktree && (await exists(mission.worktree.path))) {
      try {
        const tip = await revParse(mission.worktree.path, 'HEAD')
        tipMoved = tip !== latest.reviewedCommit
      } catch {
        tipMoved = false
      }
    }
    out.push(enrichedMissionView({ mission, latest, tipMoved }))
  }
  return out
}
