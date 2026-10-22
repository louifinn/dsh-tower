// tower_roster: authoritative roster activity.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { RosterInput } from '../domain/contracts/tool-inputs/index.js'
import { PARENT_STATUS_OK, ROSTER_ACTIVITY, ROSTER_GONE_STATES } from '../domain/vocabulary.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any }} deps
 */
export function registerRosterTool(ctx, deps) {
  const { define } = deps
  define(ctx, {
    name: 'tower_roster',
    description:
      'List tower roster agents with authoritative live activity from the subagent catalog (running/inactive/missing/unknown). Read-only; never resumes children. Use before completion or merge decisions.',
    parameters: RosterInput,
    output: output(SCHEMAS.roster),
    async execute(args) {
      const tower = await deps.openTower(args.repoRoot)
      const view = await tower.rosterView()
      const subagents = ctx.get('subagents')
      if (!subagents) throw new TowerToolError('spawn-unavailable', 'subagents service is unavailable; cannot observe roster')

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

      const staleMs = Number(tower.config.spawn?.staleMs) || 0
      const now = Date.now()
      const roster = view.roster.map((entry) => {
        const observed = activity.get(entry.agentId)
        const known = parentStatus[entry.parentSessionId] === PARENT_STATUS_OK
        const stale =
          staleMs > 0 &&
          observed === undefined &&
          known &&
          !ROSTER_GONE_STATES.includes(entry.state) &&
          now - Number(entry.spawnedAt ?? 0) > staleMs
        return {
          ...entry,
          activity: observed ?? (known ? ROSTER_ACTIVITY.missing : ROSTER_ACTIVITY.unknown),
          observed: observed !== undefined,
          stale,
        }
      })
      return { revision: view.revision, roster, parentStatus, missions: view.missions }
    },
  })
}
