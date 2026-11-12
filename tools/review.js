// tower_review: independent review verdict.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { ReviewInput } from '../domain/contracts/tool-inputs/index.js'
import { isReviewerRole, isTowerRole } from '../domain/vocabulary.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, actorFor: any }} deps
 */
export function registerReviewTool(ctx, deps) {
  const { define, actorFor } = deps
  define(ctx, {
    name: 'tower_review',
    description:
      'Submit a review verdict bound to the current tip: status clean|p1-N|p2-N, merge merge|fix-then-merge|hold. Non-clean returns the mission to active; only clean + merge approves. Reviewers are capped per branch; breakGlassReason is tower-only. Unregistered when review.mode is off.',
    parameters: ReviewInput,
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    board: true,
    output: output(SCHEMAS.review),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const actor = await actorFor(tower, exec)
      if (!isReviewerRole(actor.role) && !isTowerRole(actor.role)) {
        throw new TowerToolError('not-authorized', `only an assigned reviewer or the tower may review; ${actor.name} is ${actor.role}`)
      }
      if (isTowerRole(actor.role) && (typeof args.breakGlassReason !== 'string' || args.breakGlassReason.trim().length === 0)) {
        throw new TowerToolError('not-authorized', 'a tower-submitted review is break-glass and requires a non-empty breakGlassReason')
      }
      return tower.submitReview({
        missionId: args.missionId,
        agentId: String(exec.agent.id),
        actor,
        status: args.status,
        merge: args.merge,
        findings: args.findings,
        checks: args.checks,
        decision: args.decision,
        breakGlassReason: args.breakGlassReason,
      })
    },
  })
}
