// #159: artifact-acceptance health for the read-only doctor.
//
// An artifact mission's merge gate is a human acceptance of the committed tip,
// never a review. A pending acceptance is a warning (the human decides when to
// accept it), and a recorded one is reported so the decision stays visible
// without running preflight. Kept out of host/doctor.js so the environment
// contract stays under its file-size ceiling.
import { shapeFor } from '../domain/shapes/index.js'

/**
 * One `artifact-acceptance` doctor check over the loaded state.
 * @param {{ missions?: any[] }} state
 */
export function artifactAcceptanceCheck(state) {
  const missions = (state.missions ?? []).filter((mission) => shapeFor(mission.kind).fields.acceptance)
  const pending = missions.filter((mission) => !shapeFor(mission.kind).isTerminal(mission.status) && !(/** @type {any} */ (mission).acceptance))
  const accepted = missions.filter((mission) => Boolean(/** @type {any} */ (mission).acceptance))
  if (pending.length > 0) {
    return {
      id: 'artifact-acceptance',
      status: 'warn',
      detail: `${pending.length} artifact mission(s) wait on a human acceptance of the committed tip (${pending.map((mission) => mission.id).join(', ')})`,
      action: 'the human accepts through the approval channel (tower_mission accept); no agent may self-accept and the merge gate refuses without it',
    }
  }
  return {
    id: 'artifact-acceptance',
    status: 'pass',
    detail:
      accepted.length > 0
        ? `${accepted.length} artifact mission(s) with a recorded human acceptance`
        : 'no artifact missions pending acceptance',
  }
}
