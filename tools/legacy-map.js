// tower_legacy_map — map a legacy snapshot to a mission.
// 
// Input: LegacyMapInput (action, sourceHash, oldId) from contracts.
// Output: mapping record or mapping status.
// Authorization: tower only.
// Side effects: appends audit mapping to state; no adoption.
// Failure modes: unknown snapshot, duplicate mapping, invalid id.
// Pure mapping validation lives in the domain legacy layer.
// See docs/reference/tools.generated.md for the public shape.
// tower_legacy_map: audit-only legacy snapshot mapping.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { validateLegacyMap } from '../lib/legacy.js'
import { LegacyMapInput } from '../domain/contracts/tool-inputs/index.js'
import { LEGACY_MAP_ACTION } from '../domain/vocabulary.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, actorFor: any, requireTowerActor: any }} deps
 */
export function registerLegacyMapTool(ctx, deps) {
  const { define, actorFor, requireTowerActor } = deps
  define(ctx, {
    name: 'tower_legacy_map',
    description:
      'Audit-only mapping between a legacy snapshot id and a current mission. map records sourceHash/oldId/newMissionId; status lists mappings. Mapping never adopts or resumes a legacy mission.',
    parameters: LegacyMapInput,
    output: output(SCHEMAS.legacyMap),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const actor = await actorFor(tower, exec)
      const state = await tower.load()
      if (args.action === LEGACY_MAP_ACTION.status) {
        return { ok: true, maps: state.legacyMaps ?? [] }
      }
      requireTowerActor(actor, 'map a legacy mission')
      const validation = validateLegacyMap(state, args)
      const map = { ...validation.map, by: actor.name, at: Date.now() }
      const recorded = await tower.recordLegacyMap(map)
      return { ok: true, map: recorded.map, maps: [...(state.legacyMaps ?? []), recorded.map] }
    },
  })
}
