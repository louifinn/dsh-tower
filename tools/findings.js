// tower_finding and tower_findings.
import { Tower, FINDING_TYPES, FINDING_SEVERITIES, FINDING_STATUSES } from '../app/tower.js'
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { Type, enumOf } from './schema.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, actorFor: any, requireKnownActor: any }} deps
 */
export function registerFindingTools(ctx, deps) {
  const { define, actorFor, requireKnownActor } = deps
  define(ctx, {
    name: 'tower_finding',
    description:
      'File a structured finding (bug / improve / vuln / idea) for the tower to route. Use this for anything notable OUTSIDE your mission scope instead of editing out-of-scope files. Severity is one of low|medium|high|critical. Use tower_findings to list, read, or close findings later.',
    parameters: Type.Object({
      repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
      type: enumOf([...FINDING_TYPES], { description: 'Finding category.' }),
      title: Type.String({ description: 'Short finding title.' }),
      severity: Type.Optional(enumOf([...FINDING_SEVERITIES], { description: 'Optional severity.' })),
      summary: Type.String({ description: 'What was found, in a sentence or two.' }),
      location: Type.Optional(Type.String({ description: 'File/symbol the finding concerns.' })),
      details: Type.String({ description: 'Full details: evidence, reproduction, impact.' }),
      suggested_fix: Type.String({ description: 'What you would do about it.' }),
      missionId: Type.Optional(Type.String({ description: 'Optional mission this finding relates to (alias: mission_id).' })),
      mission_id: Type.Optional(Type.String({ description: 'Alias for missionId.' })),
    }, { additionalProperties: false }),
    aliases: {"missionId":["mission_id"]},
    board: true,
    output: output(SCHEMAS.finding),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireKnownActor(actor, 'tower_finding')
      const view = await tower.rosterView()
      const self = view.roster.find((entry) => entry.agentId === String(exec.agent.id))
      return tower.addFinding({
        type: args.type,
        title: args.title,
        severity: args.severity,
        summary: args.summary,
        location: args.location,
        details: args.details,
        suggested_fix: args.suggested_fix,
        missionId: args.missionId,
        reportedBy: self ? self.name : 'tower',
      })
    },
  })

  define(ctx, {
    name: 'tower_findings',
    description:
      'List, read, or update findings for a repository. Without id it lists findings newest-first with counts by status (filters: status, type, severity, missionId, open, limit). With id it returns that finding; with id plus status and/or note it records a lifecycle transition. Statuses are open -> triaged -> fixed|wontfix, and fixed/wontfix can be reopened to open. Only the tower or a worker may change a finding; reviewers may only list and read. Read-only when no id is given.',
    parameters: Type.Object({
      repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
      id: Type.Optional(Type.String({ description: 'Finding id, e.g. F1. When present the call reads or updates that finding.' })),
      status: Type.Optional(enumOf([...FINDING_STATUSES, 'all'], { description: 'With id: target status. Without id: filter (default all).' })),
      note: Type.Optional(Type.String({ description: 'Optional note recorded together with an update.' })),
      type: Type.Optional(enumOf([...FINDING_TYPES], { description: 'Filter by finding type.' })),
      severity: Type.Optional(enumOf([...FINDING_SEVERITIES], { description: 'Filter by severity.' })),
      missionId: Type.Optional(Type.String({ description: 'Filter by mission id (alias: mission_id).' })),
      mission_id: Type.Optional(Type.String({ description: 'Alias for missionId.' })),
      open: Type.Optional(Type.Boolean({ description: 'Only findings that are not fixed or wontfix.' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: 'Max findings to list (default 50).' })),
    }, { additionalProperties: false }),
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
