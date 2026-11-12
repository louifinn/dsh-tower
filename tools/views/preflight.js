// tower_inspect view: preflight — read-only merge gate digest.
import { SCHEMAS, output } from '../../domain/contracts/outputs.js'
import { classifyError } from '../../domain/errors.js'
import { PreflightInput } from '../../domain/contracts/tool-inputs/index.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../../types/index.js').DefineTool, openTower: any, observeActivity: any }} deps
 */
export async function runPreflightView(ctx, args, exec, deps) {
  const { observeActivity } = deps
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
}
