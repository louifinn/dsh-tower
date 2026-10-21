// tower_complete: worker completion admission.
import { Tower } from '../app/tower.js'
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { CompleteInput } from '../domain/contracts/tool-inputs/index.js'
import { isCompleteAdmission } from '../domain/vocabulary.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, runMissionDiscovery: any }} deps
 */
export function registerCompleteTool(ctx, deps) {
  const { define, runMissionDiscovery } = deps
  define(ctx, {
    name: 'tower_complete',
    description:
      'Worker-only: report mission completion. Enforced by the store: every task done or dropped, no blockers, the current owner, the mission branch has at least one commit since its spawn base, and no unread inbox messages. checks records verifiable evidence (name/command/exitCode/evidence); gates.requireChecks can require at least one before merge. Stores the full report; completion means ready for preflight and optional review, not merged.',
    parameters: CompleteInput,
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    board: true,
    output: output(SCHEMAS.complete),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
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
      if (testsConfig.enabled !== false && isCompleteAdmission(testsConfig.admission)) {
        const discovery = await runMissionDiscovery(tower, { id: args.missionId, worktree: context.mission.worktree })
        if (discovery.configured && discovery.receipt.ok !== true) {
          throw new TowerToolError('tests-failed', `test discovery failed for ${args.missionId}: ${discovery.receipt.error}`)
        }
        if (discovery.configured && testsConfig.autoChecks !== false && discovery.check) {
          if (checks.length >= 20) checks[19] = discovery.check
          else checks.push(discovery.check)
        }
      }
      return tower.complete({
        missionId: args.missionId,
        agentId: String(exec.agent.id),
        report: args.report,
        checks,
      })
    },
  })
}
