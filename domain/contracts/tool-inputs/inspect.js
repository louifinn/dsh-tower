// tower_inspect input contract (#163 Phase 3): one read-only tool whose `view`
// selects the five former dashboard tools. Pure TypeBox only; no I/O.
import { INSPECT_VIEWS, STATUS_FORMATS } from '../../vocabulary.js'
import { Type, enumOf } from './shared.js'

export const InspectInput = Type.Object({
  view: enumOf(INSPECT_VIEWS, { description: 'Which read-only view to return.' }),
  missionId: Type.Optional(Type.String({ description: 'Mission id for the diff/preflight views and the status detail form.' })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 1, description: 'Cap for the diff view patch.' })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Page offset for the status mission list.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Page size for the status mission list (max 100).' })),
  includeGate: Type.Optional(Type.Boolean({ description: 'Status: add preflight gate digests for the page.' })),
  includeArchived: Type.Optional(Type.Boolean({ description: 'Status: append archived mission summaries.' })),
  format: Type.Optional(enumOf(STATUS_FORMATS, { description: 'Status: "markdown" returns the human-readable board.' })),
}, { additionalProperties: false })
