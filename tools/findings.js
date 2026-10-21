// tower_findings: list, read, or update findings.
import { Tower } from '../app/tower.js'
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { FindingsInput } from '../domain/contracts/tool-inputs/index.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, actorFor: any, requireKnownActor: any }} deps
 */
export function registerFindingsTool(ctx, deps) {
  const { define, actorFor, requireKnownActor } = deps
  define(ctx, {
    name: 'tower_findings',
    description:
      'List, read, or update findings for a repository. Without id it lists findings newest-first with counts by status (filters: status, type, severity, missionId, open, limit). With id it returns that finding; with id plus status and/or note it records a lifecycle transition. Statuses are open -> triaged -> fixed|wontfix, and fixed/wontfix can be reopened to open. Only the tower or a worker may change a finding; reviewers may only list and read. Read-only when no id is given.',
    parameters: FindingsInput,
    aliases: {"missionId":["mission_id"]},
    output: output(SCHEMAS.findings),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
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
        actor: { name: self ? self.name : 'tower', role: self ? self.role : 'tower' },
      })
    },
  })
}
