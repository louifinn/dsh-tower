// tower_preflight: read-only merge gate digest.
import { Tower } from '../app/tower.js'
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { classifyError } from '../domain/errors.js'
import { Type } from './schema.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, observeActivity: any }} deps
 */
export function registerPreflightTool(ctx, deps) {
  const { define, observeActivity } = deps
  define(ctx, {
    name: 'tower_preflight',
    description:
      'Read-only merge gate for one mission: returns ok plus stable blocker codes (branch-missing, deps-unmerged, read-only-survey, stale-base, out-of-scope, base-dirty, branch-owned-by-closed-missions, and mission/worker guards). Review blockers (no-review, review-hold, not-clean, review-not-approved, tip-moved, review-mission-mismatch) apply only when review.requireReview is on. Never changes anything.',
    parameters: Type.Object({
      repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
      missionId: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: id).' })),
      id: Type.Optional(Type.String({ description: 'Alias for missionId; both are accepted.' })),
    }, { additionalProperties: false }),
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    output: output(SCHEMAS.preflight),
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      const { activity, parentStatus } = await observeActivity(ctx, tower)
      const gate = await tower.evaluateGate({ missionId: args.missionId, activity, parentStatus })
      return {
        ok: gate.ok,
        blockers: gate.blockers,
        missionId: args.missionId,
        branchTip: gate.branchTip ?? null,
        baseTip: gate.baseTip ?? null,
        changedFiles: gate.changedFiles ?? [],
        review: gate.review
          ? {
              round: gate.review.round,
              status: gate.review.status,
              mergeVerdict: gate.review.mergeVerdict,
              reviewer: gate.review.reviewer,
              reviewedCommit: gate.review.reviewedCommit,
            }
          : null,
      }
    },
  })
}
