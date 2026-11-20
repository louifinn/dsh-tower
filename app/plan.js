// Mission planning use case.
import { TowerToolError } from '../domain/errors.js'
import { PLAN_WARNING_BROAD_SCOPE } from '../domain/contracts/outputs.js'
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
    // #F80: the required component is a capability row id. Name the capability,
    // not the row: the plugin page shows titles, and the gate that checks copy
    // for internal identifiers has no business accepting this one just because
    // the sentence is built here rather than in a copy table.
    throw new TowerToolError(
      'invalid-argument',
      `the capability this mission kind needs is turned off: ${shape.kind} missions cannot be planned; the other kinds still can`,
      { nextAction: `turn that capability back on in the plugin page, then plan the ${shape.kind} mission again` },
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

/**
 * #205: a mission that claims the whole repository (`**`) fences every later
 * planned edit and widening. When other owning missions are still in flight,
 * the plan is legal but the ordering trap is worth naming: the broad mission is
 * usually release preparation, and it belongs last, not in front of live work.
 * The warning never blocks the plan.
 * @param {import('../types/index.js').Mission[]} created
 * @param {import('../types/index.js').Mission[]} existing
 * @returns {Array<{ code: string, missionId: string, missionIds: string[], message: string }>}
 */
function broadScopeWarnings(created, existing) {
  const inFlight = [...existing, ...created].filter((mission) => {
    const shape = shapeFor(mission.kind)
    if (!shape.reach.ownsPaths) return false
    if (!['planned', 'active'].includes(mission.status)) return false
    return /** @type {any} */ (mission).deferred !== true
  })
  /** @type {Array<{ code: string, missionId: string, missionIds: string[], message: string }>} */
  const warnings = []
  for (const mission of created) {
    if (!shapeFor(mission.kind).reach.ownsPaths || !mission.scope.includes('**')) continue
    const others = inFlight.filter((entry) => entry.id !== mission.id)
    if (others.length === 0) continue
    const ids = others.map((entry) => entry.id).join(', ')
    warnings.push({
      code: PLAN_WARNING_BROAD_SCOPE,
      missionId: mission.id,
      missionIds: others.map((entry) => entry.id),
      message: `mission ${mission.id} claims the whole repository ("**") while ${ids} ${others.length === 1 ? 'is' : 'are'} still planned or active; it will fence any later planned edit or widening — plan the release-preparation mission last, or mark it deferred or pause it before another mission widens`,
    })
  }
  return warnings
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
    warnings.push(...broadScopeWarnings(created, state.missions))
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
