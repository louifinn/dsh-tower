// tower_inspect input contract (#163 Phase 3): one read-only tool whose `view`
// selects the five former dashboard tools. Pure TypeBox only; no I/O.
import { INSPECT_VIEWS, STATUS_FORMATS } from '../../vocabulary.js'
import { Type, enumOf } from './shared.js'

export const InspectInput = Type.Object({
  view: enumOf(INSPECT_VIEWS, { description: 'Which read-only view to return.' }),
  missionId: Type.Optional(Type.String({ description: 'Mission id for diff/preflight and status detail.' })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 1, description: 'Cap for the diff view patch.' })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Page offset for the status mission list.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Page size for the status mission list (max 100).' })),
  includeGate: Type.Optional(Type.Boolean({ description: 'Status: add preflight gate digests for the page.' })),
  includeArchived: Type.Optional(Type.Boolean({ description: 'Status: append archived mission summaries.' })),
  format: Type.Optional(enumOf(STATUS_FORMATS, { description: 'Status: "markdown" returns the board.' })),
  checks: Type.Optional(Type.Boolean({ description: 'Doctor: only the check rows (id/status/detail/action), without the diagnostic sections.' })),
  compact: Type.Optional(Type.Boolean({ description: 'Doctor: only {ok, checks}; passing rows keep id/status, non-passing rows add detail.' })),
  fields: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: 'Status: project each mission to exactly these keys.' })),
  sinceRevision: Type.Optional(Type.Integer({ minimum: 0, description: 'Status: only rows stamped by spawn/interrupt/roster after this revision (0 = all); plan/mission/complete/merge/review/worktree writes are unstamped and omitted.' })),
  agent: Type.Optional(Type.String({ minLength: 1, description: 'Roster: only this name or agent id.' })),
  tail: Type.Optional(Type.Integer({ minimum: 1, description: 'Roster: the newest N rows.' })),
  stat: Type.Optional(Type.Boolean({ description: 'Diff: return per-file {path, added, deleted} counts instead of patch bytes.' })),
}, { additionalProperties: false })
