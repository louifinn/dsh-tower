// Mission planning use case.
import { TowerToolError } from '../domain/errors.js'
import { nextMissionNumber, addAutoDeps, assertAcyclic } from '../domain/planning.js'
import {
  normalizePlanMissions,
  assignMissionIds,
  assertKnownDependencies,
  newMission,
  applyPlan,
} from '../domain/missions/plan.js'
import { shapeFor } from '../domain/shapes/index.js'
import { validateState } from '../domain/state.js'
import { fullMission } from '../domain/summary.js'
import { sweepArchive } from './archive.js'
import { surveyStaleWarnings } from './freshness.js'
import { readFacts } from './sharedCheckout.js'

/**
 * Planning a shape whose optional component is off must fail with an actionable
 * message, not silently plan work nothing can execute. Preset rows are only
 * visible through the async probe: the synchronous `enabled` switch cannot see
 * a declarative agent-preset registration.
 * @param {any} tower
 * @param {any} input
 * @returns {Promise<void>}
 */
async function assertShapeComponents(tower, input) {
  const components = tower.deps?.components
  if (!components) return
  for (const mission of input?.missions ?? []) {
    const shape = shapeFor(mission?.kind)
    const required = shape.requiredComponent
    if (!required) continue
    if (typeof components.available === 'function') {
      // null means "cannot tell" (no agent-presets service): let the plan pass,
      // exactly as a host without the component port did before shapes existed.
      if ((await components.available(required)) !== false) continue
    } else if (components.enabled(required) === true) continue
    throw new TowerToolError(
      'invalid-argument',
      `the ${required} component is off: ${shape.kind} missions cannot be planned; the other kinds are unaffected`,
      { nextAction: `enable the ${required} component and plan the ${shape.kind} mission again` },
    )
  }
}

/**
 * @param {any} input
 * @returns {boolean}
 */
function planNeedsRead(input) {
  return (input?.missions ?? []).some((mission) => shapeFor(mission?.kind).fields.readCommit)
}

export async function plan(tower, input = {}) {
  return tower.withStateLock(async (_paths, held) => {
    const state = await tower.load()
    const now = Date.now()
    // A survey records the commit it reads and the tracked-status fingerprint at
    // plan time; a build plan reads nothing extra.
    await assertShapeComponents(tower, input)
    const read = planNeedsRead(input) ? await readFacts(tower, state.base) : {}
    const prepared = normalizePlanMissions(input, read)
    // Archived ids stay in the known set: a new mission must not reuse an id
    // and a merged dependency may live in the archive index (#73).
    const archive = await tower.archiveIndex()
    const known = [...state.missions, ...(archive.ok ? archive.missions : [])]
    const assigned = assignMissionIds(prepared, nextMissionNumber(known))

    assertKnownDependencies(assigned, known)

    addAutoDeps(assigned, known, { caseInsensitive: state.caseInsensitive === true })
    assertAcyclic([...known, ...assigned])

    const created = assigned.map((mission) => newMission(mission.id, mission, now))
    const applied = applyPlan(state, created)
    // #148 W2: report survey evidence freshness at plan time. New builds have no
    // provisioned base yet, so the warning compares against the state base; it
    // is advisory here and never blocks the plan. Archived survey dependencies
    // keep their read commit on the archive index, so they are checked too.
    const archivedMissions = new Map(
      (archive.ok ? archive.missions : []).map((entry) => [entry.id, entry]),
    )
    const warnings = []
    for (const mission of created) {
      warnings.push(
        ...(await surveyStaleWarnings(tower, {
          mission,
          state,
          missions: state.missions,
          archived: archivedMissions,
        })),
      )
    }
    const swept = await sweepArchive(tower, state, { now })
    state.revision += 1
    state.updatedAt = now

    validateState(state, tower.paths.state)
    await tower.writeState(state, held)
    await tower.appendActivity({
      at: now,
      type: 'plan',
      text: `created ${created.map((mission) => mission.id).join(', ')}`,
    })
    // Persist first, then describe: the event carries the revision the caller
    // can read back from state.json (#75).
    tower.emitEvents(applied.events, { revision: state.revision, at: now })
    return {
      revision: state.revision,
      missions: created.map((mission) => fullMission(mission)),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(swept.archived.length > 0 ? { archived: swept.archived } : {}),
      ...(swept.error ? { archiveError: swept.error } : {}),
    }
  })
}
