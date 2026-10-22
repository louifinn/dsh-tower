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
import { sweepArchive } from './archive.js'

export async function plan(tower, input = {}) {
  const prepared = normalizePlanMissions(input)
  return tower.deps.store.withLock(tower.paths, async () => {
    const state = await tower.load()
    const now = Date.now()
    // Archived ids stay in the known set: a new mission must not reuse an id
    // and a merged dependency may live in the archive index (#73).
    const archive = await tower.archiveIndex()
    const known = [...state.missions, ...(archive.ok ? archive.missions : [])]
    const assigned = assignMissionIds(prepared, nextMissionNumber(known))

    assertKnownDependencies(assigned, known)

    addAutoDeps(assigned, known, { caseInsensitive: state.caseInsensitive === true })
    assertAcyclic([...known, ...assigned])

    const created = assigned.map((mission) => newMission(mission.id, mission, now))
    state.missions.push(...created)
    const swept = await sweepArchive(tower, state, { now })
    state.revision += 1
    state.updatedAt = now

    validateState(state, tower.paths.state)
    await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
    await tower.deps.store.appendJsonl(tower.paths.activity, {
      at: now,
      type: 'plan',
      text: `created ${created.map((mission) => mission.id).join(', ')}`,
    })
    return {
      revision: state.revision,
      missions: created.map((mission) => fullMission(mission)),
      ...(swept.archived.length > 0 ? { archived: swept.archived } : {}),
      ...(swept.error ? { archiveError: swept.error } : {}),
    }
  })
}
