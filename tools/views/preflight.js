// tower_inspect view: preflight — read-only merge gate digest.
import { resolutionPlan } from '../../domain/gate.js'
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
  // #208: the gate assembles blockers in code order, which is not the order a
  // human can act on: a dependency merge comes before the rebase that must
  // follow it, and a dependency chain is resolved ancestor-first. Resolve the
  // ordering from the same state snapshot, without executing anything.
  const state = await tower.load()
  const archive = await tower.archiveIndex()
  const mission =
    gate.mission ?? state.missions.find((entry) => entry.id === args.missionId) ?? { id: args.missionId, deps: [] }
  const plan = resolutionPlan({
    blockers: gate.blockers,
    mission,
    missions: state.missions,
    archived: archive.ok ? archive.missions : [],
  })
  return {
    ok: gate.ok,
    blockers: plan.blockers,
    order: plan.order,
    cycle: plan.cycle,
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
