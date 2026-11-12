// tower_finding: report, list/read, and update findings (#163 Phase 4).
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { FINDING_OP } from '../domain/vocabulary.js'
import { FindingInput } from '../domain/contracts/tool-inputs/index.js'
import { runFindingView } from './views/findings.js'

/** @param {any} args */
function inferOp(args) {
  if (args.op) return args.op
  if (typeof args.id === 'string' && args.id.trim().length > 0 && (args.status !== undefined || args.note !== undefined)) {
    return FINDING_OP.update
  }
  if (typeof args.title === 'string' || typeof args.type === 'string') return FINDING_OP.report
  return FINDING_OP.list
}

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, actorFor: any, requireKnownActor: any }} deps
 */
export function registerFindingTool(ctx, deps) {
  const { define, actorFor, requireKnownActor } = deps
  define(ctx, {
    name: 'tower_finding',
    description:
      'Report (op: report), list/read (op: list, default) or update (op: update) findings. report needs type bug|improve|vuln|idea, title, summary, details, suggested_fix; update needs id plus status/note. Use for anything outside your mission scope. Details: docs/reference/tools.md.',
    parameters: FindingInput,
    aliases: { missionId: ['mission_id'] },
    board: true,
    output: output(SCHEMAS.findingOps),
    validateArgs(args) {
      const op = args.op ?? inferOp(args)
      if (op === FINDING_OP.report) {
        const missing = ['type', 'title', 'summary', 'details', 'suggested_fix'].filter((key) => {
          const value = args[key]
          return typeof value !== 'string' || value.trim().length === 0
        })
        if (missing.length > 0) {
          throw new TowerToolError('invalid-argument', `tower_finding op "report" requires ${missing.join(', ')}`)
        }
      }
      if (op === FINDING_OP.update && (typeof args.id !== 'string' || args.id.trim().length === 0)) {
        throw new TowerToolError('invalid-argument', 'tower_finding op "update" requires id')
      }
    },
    async execute(args, exec) {
      const op = args.op ?? inferOp(args)
      return runFindingView(ctx, args, exec, { openTower: deps.openTower, actorFor, requireKnownActor }, op)
    },
  })
}
