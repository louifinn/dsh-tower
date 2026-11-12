// tower_findings: list, read, or update findings.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { FindingsInput } from '../domain/contracts/tool-inputs/index.js'
import { ROLE } from '../domain/vocabulary.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, actorFor: any, requireKnownActor: any }} deps
 */
export function registerFindingsTool(ctx, deps) {
  // openTower is injected by the composition root (#69).
  const { define, actorFor, requireKnownActor } = deps
  define(ctx, {
    name: 'tower_findings',
    description:
      'List, read, or update findings. Without id: newest-first with counts and filters (status, type, severity, missionId, open, limit). With id: the finding; id plus status/note records open -> triaged -> fixed|wontfix. Only tower and workers may change.',
    parameters: FindingsInput,
    aliases: {"missionId":["mission_id"]},
    output: output(SCHEMAS.findings),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireKnownActor(actor, 'tower_findings')
      const view = await tower.rosterView()
      const self = view.roster.find((entry) => entry.agentId === String(exec.agent.id))
      return tower.findings({
        id: args.id,
        status: args.status,
        note: args.note,
        type: args.type,
        severity: args.severity,
        missionId: args.missionId,
        open: args.open,
        limit: args.limit,
        actor: { name: self ? self.name : ROLE.tower, role: self ? self.role : ROLE.tower },
      })
    },
  })
}
