// tower_complete: worker completion admission.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { CompleteInput } from '../domain/contracts/tool-inputs/index.js'
import { isCompleteAdmission } from '../domain/vocabulary.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, runMissionDiscovery: any }} deps
 */
export function registerCompleteTool(ctx, deps) {
  const { define, runMissionDiscovery } = deps
  define(ctx, {
    name: 'tower_complete',
    description:
      'Worker-only: report mission completion. Requires every task done or dropped, no blockers, the current owner, at least one commit (survey/sandbox use their recorded commit), and no unread inbox. checks records evidence; result is survey-only. The report is capped by gates.maxReportBytes.',
    parameters: CompleteInput,
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    board: true,
    output: output(SCHEMAS.complete),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      // Validate authorization/state before executing repository-controlled
      // test code or writing a test receipt.
      await tower.checkCompletion({
        missionId: args.missionId,
        agentId: String(exec.agent.id),
        report: args.report,
      })
      const context = await tower.missionContext(args.missionId)
      const checks = [...(Array.isArray(args.checks) ? args.checks : [])]
      const testsConfig = /** @type {any} */ (tower.config.tests ?? {})
      // #136: the `tower-tests` component row is the only switch; admission
      // decides when discovery runs, not whether it may run.
      if (isCompleteAdmission(testsConfig.admission)) {
        const discovery = await runMissionDiscovery(tower, { id: args.missionId, worktree: context.mission.worktree })
        if (discovery.configured && discovery.receipt.ok !== true) {
          throw new TowerToolError('tests-failed', `test discovery failed for ${args.missionId}: ${discovery.receipt.error}`)
        }
      }
      // #149 W4: the receipt already lives in mission.testRuns and is read by
      // domain/evidence.js. Copying a `tests` projection into the completion
      // report would be a second evidence shape, so it is not done here.
      return tower.complete({
        missionId: args.missionId,
        agentId: String(exec.agent.id),
        report: args.report,
        result: args.result,
        checks,
      })
    },
  })
}
