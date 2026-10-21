// tower_roster: authoritative roster activity.
import { Tower } from '../app/tower.js'
import { SCHEMAS, output } from './output-schemas.js'
import { TowerToolError } from '../lib/errors.js'
import { Type } from './schema.js'

/**
 * @param {any} ctx
 * @param {{
 *   define: import('../types/index.js').DefineTool,
 *   workspaceHook: any,
 *   observeActivity: any,
 *   actorFor: any,
 *   requireTowerActor: any,
 *   interruptRosterAgent: any,
 * }} deps
 */
export function registerRosterTool(ctx, deps) {
  const { define, workspaceHook, observeActivity, actorFor, requireTowerActor, interruptRosterAgent } = deps
  define(ctx, {
    name: 'tower_roster',
    description:
      'List tower roster agents with authoritative live activity from the subagent catalog (running/inactive/missing/unknown). Read-only; never resumes children. Use before completion or merge decisions.',
    parameters: Type.Object({
      repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
    }, { additionalProperties: false }),
    output: output(SCHEMAS.roster),
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      const view = await tower.rosterView()
      const subagents = ctx.get('subagents')
      if (!subagents) throw new TowerToolError('spawn-unavailable', 'subagents service is unavailable; cannot observe roster')

      const parents = [...new Set(view.roster.map((entry) => entry.parentSessionId).filter(Boolean))]
      const activity = new Map()
      const parentStatus = {}
      for (const parent of parents) {
        try {
          const rows = await subagents.listDescendants(parent)
          for (const row of rows) activity.set(String(row.id), row.activity ?? 'unknown')
          parentStatus[parent] = 'ok'
        } catch (error) {
          parentStatus[parent] = `unavailable: ${String(error?.message ?? error)}`
        }
      }

      const staleMs = Number(tower.config.spawn?.staleMs) || 0
      const now = Date.now()
      const roster = view.roster.map((entry) => {
        const observed = activity.get(entry.agentId)
        const known = parentStatus[entry.parentSessionId] === 'ok'
        const stale =
          staleMs > 0 &&
          observed === undefined &&
          known &&
          !['retired', 'failed', 'interrupted', 'missing', 'stale'].includes(entry.state) &&
          now - Number(entry.spawnedAt ?? 0) > staleMs
        return {
          ...entry,
          activity: observed ?? (known ? 'missing' : 'unknown'),
          observed: observed !== undefined,
          stale,
        }
      })
      return { revision: view.revision, roster, parentStatus, missions: view.missions }
    },
  })

  define(ctx, {
    name: 'tower_interrupt',
    description:
      'Interrupt one running tower roster agent (worker or reviewer) and record it as interrupted in the roster. Only the tower may interrupt. Idempotent: an agent that is not running returns interrupted:false. Use it before takeover after a runaway worker, or to stop work that is no longer wanted.',
    parameters: Type.Object({
      repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
      to: Type.Optional(Type.String({ description: 'Roster name to interrupt.' })),
      agentId: Type.Optional(Type.String({ description: 'Agent/session id to interrupt (alternative to to).' })),
      agent_id: Type.Optional(Type.String({ description: 'Alias for agentId.' })),
      reason: Type.Optional(Type.String({ description: 'Why the agent is being interrupted (recorded in the roster).' })),
    }, { additionalProperties: false }),
    aliases: { agentId: ['agent_id'] },
    output: output(SCHEMAS.interrupt),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'interrupt tower agents')
      if (!args.to && !args.agentId) throw new TowerToolError('invalid-argument', 'tower_interrupt requires to (roster name) or agentId')
      const result = await interruptRosterAgent(ctx, tower, exec, {
        to: args.to,
        agentId: args.agentId,
        reason: args.reason,
      })
      return { ok: true, ...result }
    },
  })
}
