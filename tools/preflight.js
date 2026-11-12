// tower_preflight: read-only merge gate digest.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { classifyError } from '../domain/errors.js'
import { PreflightInput } from '../domain/contracts/tool-inputs/index.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, observeActivity: any }} deps
 */
export function registerPreflightTool(ctx, deps) {
  const { define, observeActivity } = deps
  define(ctx, {
    name: 'tower_preflight',
    description:
      'Read-only merge gate for one mission: returns ok plus stable blocker codes (branch-missing, deps-unmerged, stale-base, out-of-scope, base-dirty, branch-owned-by-closed-missions, and mission/worker guards) and warnings (survey-stale). Review blockers (no-review, review-hold, not-clean, review-not-approved, tip-moved, review-mission-mismatch) apply only when review.mode is required; review.mode off and optional skip them. An artifact mission is structurally exempt from review blockers whatever the mode: its gate is acceptance-missing / acceptance-stale — the human acceptance record binds one tip, and any new commit or rebase makes it stale (the blocker names the accepted sha and the current one). survey-stale reports a build dependency on a survey whose readCommit is not an ancestor-or-equal of the build base; it is a warning by default and a blocker only when gates.requireFreshSurvey is true. A survey has no merge gate: it is refused with invalid-transition (tower_complete checks HEAD/readCommit and zero commits). Never changes anything.',
    parameters: PreflightInput,
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    output: output(SCHEMAS.preflight),
    async execute(args) {
      const tower = await deps.openTower(args.repoRoot)
      const { activity, parentStatus } = await observeActivity(ctx, tower)
      const gate = await tower.evaluateGate({ missionId: args.missionId, activity, parentStatus, action: 'preflight' })
      return {
        ok: gate.ok,
        blockers: gate.blockers,
        warnings: gate.warnings ?? [],
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
        ...(gate.archived ? { archived: true } : {}),
      }
    },
  })
}
