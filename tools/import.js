// tower_import: read-only legacy snapshot import and audit-only mapping (#163 Phase 4).
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { IMPORT_OP } from '../domain/vocabulary.js'
import { ImportInput } from '../domain/contracts/tool-inputs/index.js'
import { runImportView } from './views/import.js'

/** @param {any} args */
function inferOp(args) {
  if (args.op) return args.op
  return typeof args.sourcePath === 'string' && args.sourcePath.trim().length > 0 ? IMPORT_OP.snapshot : IMPORT_OP.map
}

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, actorFor: any, requireTowerActor: any, importLegacySnapshot: any, validateLegacyMap: any }} deps
 */
export function registerImportTool(ctx, deps) {
  const { define, actorFor, requireTowerActor, importLegacySnapshot, validateLegacyMap } = deps
  define(ctx, {
    name: 'tower_import',
    description:
      'Import a legacy Tower/DSH state file read-only (op: snapshot, needs sourcePath) or record/serve audit-only legacy mission mappings (op: map, default). Never activates, adopts or resumes paused missions. Tower-only. Details: docs/reference/tools.md.',
    parameters: ImportInput,
    output: output(SCHEMAS.importOps),
    validateArgs(args) {
      const op = args.op ?? inferOp(args)
      if (op === IMPORT_OP.snapshot && (typeof args.sourcePath !== 'string' || args.sourcePath.trim().length === 0)) {
        throw new TowerToolError('invalid-argument', 'tower_import op "snapshot" requires sourcePath')
      }
    },
    async execute(args, exec) {
      const op = args.op ?? inferOp(args)
      return runImportView(
        ctx,
        args,
        exec,
        { openTower: deps.openTower, actorFor, requireTowerActor, importLegacySnapshot, validateLegacyMap },
        op,
      )
    },
  })
}
