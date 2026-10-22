// Mission planning use case.
import { nextMissionNumber, addAutoDeps, assertAcyclic } from '../domain/planning.js'
import {
  normalizePlanMissions,
  assignMissionIds,
  assertKnownDependencies,
  newMission,
} from '../domain/missions/plan.js'
import { validateState } from '../domain/state.js'
import { fullMission } from '../domain/summary.js'
import { withLock, writeJsonAtomic, appendJsonl } from '../lib/store.js'

export async function plan(tower, input = {}) {
  const prepared = normalizePlanMissions(input)
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    const now = Date.now()
    const assigned = assignMissionIds(prepared, nextMissionNumber(state.missions))

    assertKnownDependencies(assigned, state.missions)

    addAutoDeps(assigned, state.missions, { caseInsensitive: state.caseInsensitive === true })
    assertAcyclic([...state.missions, ...assigned])

    const created = assigned.map((mission) => newMission(mission.id, mission, now))
    state.missions.push(...created)
    state.revision += 1
    state.updatedAt = now

    validateState(state, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, state)
    await appendJsonl(tower.paths.activity, {
      at: now,
      type: 'plan',
      text: `created ${created.map((mission) => mission.id).join(', ')}`,
    })
    return {
      revision: state.revision,
      missions: created.map((mission) => fullMission(mission)),
    }
  })
}
