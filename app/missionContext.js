// Mission context projection use case (reviews, findings, dependencies).
import { TowerToolError } from '../domain/errors.js'
import { missionContextView } from '../domain/read/missionContext.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

export async function missionContext(tower, missionId) {
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === missionId)
  if (!mission) fail(`unknown mission "${missionId}"`, 'mission-not-found')
  return missionContextView({ state, mission })
}
