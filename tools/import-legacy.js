// tower_import_legacy: read-only legacy snapshot import.
import { Tower } from '../app/tower.js'
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { importLegacySnapshot } from '../lib/legacy.js'
import { ImportLegacyInput } from '../domain/contracts/tool-inputs/index.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, actorFor: any, requireTowerActor: any }} deps
 */
export function registerImportLegacyTool(ctx, deps) {
  const { define, actorFor, requireTowerActor } = deps
  define(ctx, {
    name: 'tower_import_legacy',
    description:
      'Read-only import of a Tower Codex (schemaVersion 1) or DSH legacy state file. Stores the full payload under <common>/dsh-tower/legacy/<sha256>.json and records only a summary in state.legacySnapshots; never activates, adopts, or resumes paused missions.',
    parameters: ImportLegacyInput,
    board: true,
    output: output(SCHEMAS.importLegacy),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'import a legacy snapshot')
      const imported = await importLegacySnapshot({
        repoRoot: tower.root,
        commonDir: tower.commonDir,
        sourcePath: args.sourcePath,
      })
      const recorded = await tower.recordLegacySnapshot(imported.snapshot)
      return { ok: true, summary: imported.summary, snapshot: recorded.snapshot }
    },
  })
}
