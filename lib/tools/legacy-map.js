// tower_legacy_map: audit-only legacy snapshot mapping.
import { Tower } from '../tower.js'
import { SCHEMAS, output } from '../schemas.js'
import { TowerToolError } from '../errors.js'
import { validateLegacyMap } from '../legacy.js'

export function registerLegacyMapTool(ctx, deps) {
  const { define, actorFor, requireTowerActor } = deps
  define(ctx, {
    name: 'tower_legacy_map',
    description:
      'Audit-only mapping between a legacy snapshot id and a current mission. map records sourceHash/oldId/newMissionId; status lists mappings. Mapping never adopts or resumes a legacy mission.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        action: { type: 'string', enum: ['map', 'status'], description: 'Mapping operation.' },
        sourceHash: { type: 'string', description: 'Legacy snapshot sha256 (map).' },
        oldId: { type: 'string', description: 'Legacy mission id (map).' },
        newMissionId: { type: 'string', description: 'Current mission id; optional audit pointer.' },
      },
      required: ['repoRoot', 'action'],
      additionalProperties: false,
    },
    output: output(SCHEMAS.legacyMap),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      const state = await tower.load()
      if (args.action === 'status') {
        return { ok: true, maps: state.legacyMaps ?? [] }
      }
      requireTowerActor(actor, 'map a legacy mission')
      const validation = validateLegacyMap(state, args)
      if (validation.ok !== true) {
        throw new TowerToolError('invalid-argument', validation.error ?? 'invalid legacy mapping')
      }
      const map = { ...validation.map, by: actor.name, at: Date.now() }
      const recorded = await tower.recordLegacyMap(map)
      return { ok: true, map: recorded.map, maps: [...(state.legacyMaps ?? []), recorded.map] }
    },
  })
}
