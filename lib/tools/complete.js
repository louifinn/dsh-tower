// tower_complete: worker completion admission.
import { Tower } from '../tower.js'
import { SCHEMAS, output } from '../schemas.js'
import { TowerToolError } from '../errors.js'

export function registerCompleteTool(ctx, deps) {
  const { define, runMissionDiscovery } = deps
  define(ctx, {
    name: 'tower_complete',
    description:
      'Worker-only: report mission completion. Enforced by the store: every task done or dropped, no blockers, the current owner, the mission branch has at least one commit since its spawn base, and no unread inbox messages. checks records verifiable evidence (name/command/exitCode/evidence); gates.requireChecks can require at least one before merge. Stores the full report; completion means ready for preflight and optional review, not merged.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missionId: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: id).' },
        id: { type: 'string', description: 'Alias for missionId; both are accepted.' },
        report: { type: 'string', description: 'Full completion report for the tower and the next review round.' },
        checks: {
          type: 'array',
          description: 'Optional evidence ledger entries: {name, command?, exitCode?, evidence?}.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'What was checked.' },
              command: { type: 'string', description: 'Command or method used.' },
              exitCode: { type: 'integer', description: 'Observed exit code.' },
              evidence: { type: 'string', description: 'Short evidence line/log reference.' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
      required: ['repoRoot', 'report'],
      additionalProperties: false,
    },
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
      const testsConfig = tower.config.tests ?? {}
      if (testsConfig.enabled !== false && testsConfig.admission === 'complete') {
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
