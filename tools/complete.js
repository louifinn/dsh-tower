// tower_complete: worker completion admission.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { CompleteInput } from '../domain/contracts/tool-inputs/index.js'
import { Type } from '../domain/contracts/tool-inputs/shared.js'
import { isCompleteAdmission } from '../domain/vocabulary.js'

// #206: a check may cite the recorded test run that backs it. The shared
// CompleteInput schema is defined in domain/contracts/tool-inputs/missions.js,
// which is outside this mission's fence, so the field is added to the same
// exported object here. The registry and the ToolInputs map both hold this
// reference, so runtime validation and tests/tool-contracts.test.mjs agree.
// Move the field into missions.js once that contract file is in scope.
const checkItem = /** @type {any} */ (CompleteInput).properties?.checks?.items
if (checkItem && checkItem.properties && !checkItem.properties.runId) {
  checkItem.properties.runId = Type.String({
    description: 'Id of a recorded test run of this mission (an entry in testRuns, e.g. run-3) returned by tower_test.',
  })
}

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, runMissionDiscovery: any }} deps
 */
export function registerCompleteTool(ctx, deps) {
  const { define, runMissionDiscovery } = deps
  define(ctx, {
    name: 'tower_complete',
    description:
      'Worker-only: report mission completion: all tasks done or dropped, no blockers, the current owner, a commit (survey/sandbox use their recorded commit), no unread inbox; an artifact mission also needs its declared deliverables committed at the tip. checks records evidence; result is survey-only.',
    parameters: CompleteInput,
    aliases: {"missionId":["id"]},
    roles: ['worker', 'survey'],
    requiresMissionId: true,
    board: true,
    output: output(SCHEMAS.complete),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const agentId = String(exec.agent.id)
      const missionId = String(args.missionId)
      // #F73: a worker that calls this tool is alive. If the watchdog marked its
      // row stale (empty/partial catalog or a single missed sweep), its own row
      // may still complete: the completion transaction revives the row and closes
      // it as `inactive` inside the same state lock, so a concurrent sweep can
      // never observe it as an active-but-unobserved row. Every other terminal
      // state still refuses before any repository-controlled work runs.
      const options = { allowStaleSelfReport: true }
      // Validate authorization/state before executing repository-controlled
      // test code or writing a test receipt.
      await tower.checkCompletion(
        {
          missionId: missionId,
          agentId,
          report: args.report,
        },
        options,
      )
      const context = await tower.missionContext(missionId)
      const checks = [...(Array.isArray(args.checks) ? args.checks : [])]
      const testsConfig = /** @type {any} */ (tower.config.tests ?? {})
      // #136: the `tower-tests` component row is the only switch; admission
      // decides when discovery runs, not whether it may run.
      if (isCompleteAdmission(testsConfig.admission)) {
        const discovery = await runMissionDiscovery(tower, { id: missionId, worktree: context.mission.worktree })
        if (discovery.configured && discovery.receipt.ok !== true) {
          throw new TowerToolError('tests-failed', `test discovery failed for ${missionId}: ${discovery.receipt.error}`)
        }
      }
      // #149 W4: the receipt already lives in mission.testRuns and is read by
      // domain/evidence.js. Copying a `tests` projection into the completion
      // report would be a second evidence shape, so it is not done here.
      const result = await tower.complete(
        {
          missionId: missionId,
          agentId,
          report: args.report,
          result: args.result,
          checks,
        },
        options,
      )
      return result
    },
  })
}
