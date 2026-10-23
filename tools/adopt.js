// tower_adopt: reconcile the roster with the subagent catalog.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { AdoptInput } from '../domain/contracts/tool-inputs/index.js'
import { PARENT_STATUS_OK, ROSTER_ACTIVITY, ROSTER_STATE } from '../domain/vocabulary.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, actorFor: any, requireTowerActor: any }} deps
 */
export function registerAdoptTool(ctx, deps) {
  const { define, actorFor, requireTowerActor } = deps
  define(ctx, {
    name: 'tower_adopt',
    description:
      'Reconcile the roster with the durable subagent catalog after a restart or new session. Agents that are provably gone are marked retired (records are kept) or missing (retireMissing:false, so the tower can inspect/take over); agents whose parent catalog cannot be read stay unknown and are never changed. Only the tower may adopt.',
    parameters: AdoptInput,
    aliases: { retire_missing: ['retireMissing'] },
    output: output(SCHEMAS.adopt),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'adopt the roster')
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
      const retireMissing = args.retireMissing !== false
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
    },
  })
}
