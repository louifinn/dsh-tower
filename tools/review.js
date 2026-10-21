// tower_review: independent review verdict.
import { Tower } from '../app/tower.js'
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { Type, enumOf } from './schema.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, actorFor: any }} deps
 */
export function registerReviewTool(ctx, deps) {
  const { define, actorFor } = deps
  define(ctx, {
    name: 'tower_review',
    description:
      'Submit an independent review verdict for a completed mission, bound to the current branch tip. status is "clean", "p1-Nitems", or "p2-Nitems"; merge is "merge", "fix-then-merge", or "hold" (only clean + merge is later approval). Non-clean returns the mission to active. Reviewers are capped at 5 rounds per branch; a tower-submitted review is break-glass and requires breakGlassReason.',
    parameters: Type.Object({
      repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
      missionId: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: id).' })),
      id: Type.Optional(Type.String({ description: 'Alias for missionId; both are accepted.' })),
      status: Type.String({ description: 'Verdict: "clean", or "p1-Nitems" / "p2-Nitems" with the number of findings at that priority.' }),
      merge: enumOf(['merge', 'fix-then-merge', 'hold'], { description: 'Merge recommendation for the tower.' }),
      findings: Type.String({ description: 'Full findings text (markdown); write "none" when clean.' }),
      checks: Type.Optional(Type.Array(Type.String(), { description: 'Checklist items you verified.' })),
      decision: Type.String({ description: 'The reasoning behind your verdict.' }),
      breakGlassReason: Type.Optional(Type.String({ description: 'Tower-only exceptional self-review: why no independent reviewer was used.' })),
    }, { additionalProperties: false }),
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    board: true,
    output: output(SCHEMAS.review),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      if (!['reviewer', 'tower'].includes(actor.role)) {
        throw new TowerToolError('not-authorized', `only an assigned reviewer or the tower may review; ${actor.name} is ${actor.role}`)
      }
      if (actor.role === 'tower' && (typeof args.breakGlassReason !== 'string' || args.breakGlassReason.trim().length === 0)) {
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
