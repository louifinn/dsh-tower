// Mission lifecycle update use case.
import { TowerToolError } from '../domain/errors.js'
import { applyMissionUpdate } from '../domain/missions/lifecycle.js'
import { validateState } from '../domain/state.js'
import { fullMission } from '../domain/summary.js'
import { sweepArchive } from './archive.js'
import { cleanupSandbox } from './sandbox.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

export async function updateMission(tower, input = {}) {
  const missionId = typeof input.id === 'string' ? input.id.trim() : input.id
  if (typeof missionId !== 'string' || missionId.length === 0) fail('tower_mission requires id')
  const result = await tower.deps.store.withLock(tower.paths, async () => {
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === missionId)
    if (!mission) fail(`unknown mission "${missionId}"`, 'mission-not-found')
    const { changes, events } = applyMissionUpdate({ mission, state, input, config: tower.config })
    const now = Date.now()
    mission.updatedAt = now
    await sweepArchive(tower, state, { now })
    state.revision += 1
    state.updatedAt = now

    validateState(state, tower.paths.state)
    await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
    await tower.deps.store.appendJsonl(tower.paths.activity, {
      at: now,
      type: 'mission',
      missionId: mission.id,
      text: changes.join('; '),
    })
    tower.emitEvents(events, { revision: state.revision, at: now })
    return { revision: state.revision, mission: fullMission(mission) }
  })
  // Abandoning a detached survey disposes its sandbox. The state transition is
  // already durable; cleanup is advisory and reports rather than throws.
  let sandboxCleanup = null
  if (result.mission.status === 'abandoned' && result.mission.sandbox) {
    const sandbox = result.mission.sandbox
    try {
      sandboxCleanup = await cleanupSandbox(tower, missionId)
    } catch (error) {
      sandboxCleanup = {
        ok: false,
        removed: false,
        attempts: 0,
        path: sandbox,
        error: String(error?.message ?? error).slice(0, 400),
      }
    }
    if (sandboxCleanup?.ok) {
      delete result.mission.sandbox
      delete result.mission.sandboxCleanupError
    }
  }
  return { ...result, ...(sandboxCleanup ? { sandboxCleanup } : {}) }
}
