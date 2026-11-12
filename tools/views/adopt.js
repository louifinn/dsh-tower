// tower_init view: adopt — reconcile the roster with the subagent catalog.
import { TowerToolError } from '../../domain/errors.js'
import { PARENT_STATUS_OK, ROSTER_ACTIVITY, ROSTER_STATE } from '../../domain/vocabulary.js'

/**
 * Post-authorization body of `tower_init({ op: 'adopt' })`.
 *
 * @param {any} ctx
 * @param {any} args
 * @param {any} exec
 * @param {{ openTower: any, actorFor: any, requireTowerActor: any }} deps
 */
export async function runAdoptView(ctx, args, exec, deps) {
  const tower = await deps.openTower(args.repoRoot)
  const actor = await deps.actorFor(tower, exec)
  deps.requireTowerActor(actor, 'adopt the roster')
  const view = await tower.rosterView()
  const subagents = ctx.get('subagents')
  if (!subagents) throw new TowerToolError('spawn-unavailable', 'subagents service is unavailable; cannot adopt')

  const parents = [...new Set(view.roster.map((entry) => entry.parentSessionId).filter(Boolean))]
  const activity = new Map()
  const parentStatus = {}
  for (const parent of parents) {
    try {
      const rows = await subagents.listDescendants(parent)
      for (const row of rows) activity.set(String(row.id), row.activity ?? ROSTER_ACTIVITY.unknown)
      parentStatus[parent] = PARENT_STATUS_OK
    } catch (error) {
      parentStatus[parent] = `unavailable: ${String(error?.message ?? error)}`
    }
  }

  const retiredCandidates = []
  const presentIds = []
  const absentIds = []
  for (const entry of view.roster) {
    if (entry.state === ROSTER_STATE.retired) continue
    if (parentStatus[entry.parentSessionId] !== PARENT_STATUS_OK) continue
    if (activity.has(entry.agentId)) {
      presentIds.push(entry.agentId)
    } else {
      absentIds.push(entry.agentId)
    }
  }
  const observations = await tower.recordRosterObservations({ present: presentIds, absent: absentIds, confirmations: 2 })
  retiredCandidates.push(...observations.candidates)
  const retireMissing = args.retire_missing !== false
  const { retired } = retireMissing ? await tower.markRetired(retiredCandidates) : { retired: [] }
  const { missing } = retireMissing ? { missing: [] } : await tower.markMissing(retiredCandidates)
  const after = await tower.rosterView()
  return {
    retired,
    missing,
    unconfirmed: absentIds.filter((agentId) => !retiredCandidates.includes(agentId)),
    skippedUnknownParents: Object.entries(parentStatus)
      .filter(([, status]) => status !== PARENT_STATUS_OK)
      .map(([parent]) => parent),
    roster: after.roster,
    parentStatus,
  }
}
