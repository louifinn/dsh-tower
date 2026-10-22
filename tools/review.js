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
      'Submit an independent review verdict bound to the current branch tip: a completed mission starts a review round, and while the mission is active a later route may still record a verdict for that same reviewed tip, appending to the same round without changing the status (a moved tip is rejected with an explanation). status is "clean", "p1-Nitems", or "p2-Nitems"; merge is "merge", "fix-then-merge", or "hold" (only clean + merge is later approval). Non-clean returns the mission to active. Reviewers are capped at 5 rounds per branch; a tower-submitted review is break-glass and requires breakGlassReason.',
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
