// tower_finding views: report, list/read, and update findings.
import { TowerToolError } from '../../domain/errors.js'
import { ROLE } from '../../domain/vocabulary.js'

/**
 * Post-authorization body of `tower_finding({ op: 'report'|'list'|'update' })`.
 *
 * @param {any} ctx
 * @param {any} args
 * @param {any} exec
 * @param {{ openTower: any, actorFor: any, requireKnownActor: any }} deps
 * @param {'report'|'list'|'update'} op
 */
export async function runFindingView(ctx, args, exec, deps, op) {
  const tower = await deps.openTower(args.repoRoot)
  const actor = await deps.actorFor(tower, exec)
  deps.requireKnownActor(actor, 'tower_finding')
  const view = await tower.rosterView()
  const self = view.roster.find((entry) => entry.agentId === String(exec.agent.id))

  if (op === 'report') {
    const missing = ['type', 'title', 'summary', 'details', 'suggested_fix'].filter((key) => {
      const value = args[key]
      return typeof value !== 'string' || value.trim().length === 0
    })
    if (missing.length > 0) {
      throw new TowerToolError('invalid-argument', `tower_finding op "report" requires ${missing.join(', ')}`)
    }
    return tower.addFinding({
      type: args.type,
      title: args.title,
      severity: args.severity,
      summary: args.summary,
      location: args.location,
      details: args.details,
      suggested_fix: args.suggested_fix,
      missionId: args.missionId,
      reportedBy: self ? self.name : ROLE.tower,
    })
  }

  if (op === 'update' && (typeof args.id !== 'string' || args.id.trim().length === 0)) {
    throw new TowerToolError('invalid-argument', 'tower_finding op "update" requires id')
  }
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
}
