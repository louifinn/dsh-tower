// tower_import views: snapshot (read-only legacy import) and map (audit-only).
import { TowerToolError } from '../../domain/errors.js'
import { LEGACY_MAP_ACTION } from '../../domain/vocabulary.js'

/**
 * Post-authorization body of `tower_import({ op: 'snapshot'|'map' })`.
 *
 * @param {any} ctx
 * @param {any} args
 * @param {any} exec
 * @param {{ openTower: any, actorFor: any, requireTowerActor: any, importLegacySnapshot: any, validateLegacyMap: any }} deps
 * @param {'snapshot'|'map'} op
 */
export async function runImportView(ctx, args, exec, deps, op) {
  const tower = await deps.openTower(args.repoRoot)
  const actor = await deps.actorFor(tower, exec)

  if (op === 'snapshot') {
    deps.requireTowerActor(actor, 'import a legacy snapshot')
    if (typeof args.sourcePath !== 'string' || args.sourcePath.trim().length === 0) {
      throw new TowerToolError('invalid-argument', 'tower_import op "snapshot" requires sourcePath')
    }
    const imported = await deps.importLegacySnapshot({
      repoRoot: tower.root,
      commonDir: tower.commonDir,
      sourcePath: args.sourcePath,
    })
    const recorded = await tower.recordLegacySnapshot(imported.snapshot)
    return { ok: true, summary: imported.summary, snapshot: recorded.snapshot }
  }

  const state = await tower.load()
  if (args.action === LEGACY_MAP_ACTION.status) {
    return { ok: true, maps: state.legacyMaps ?? [] }
  }
  deps.requireTowerActor(actor, 'map a legacy mission')
  const validation = deps.validateLegacyMap(state, args)
  const map = { ...validation.map, by: actor.name, at: Date.now() }
  const recorded = await tower.recordLegacyMap(map)
  return { ok: true, map: recorded.map, maps: [...(state.legacyMaps ?? []), recorded.map] }
}
