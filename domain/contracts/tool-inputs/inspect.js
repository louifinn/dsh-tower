// tower_inspect input contract (#163 Phase 3): one read-only tool whose `view`
// selects the five former dashboard tools. Pure TypeBox only; no I/O.
import { INSPECT_VIEWS, STATUS_FORMATS } from '../../vocabulary.js'
import { Type, enumOf } from './shared.js'

export const InspectInput = Type.Object({
  view: enumOf(INSPECT_VIEWS, { description: 'View to return.' }),
  missionId: Type.Optional(Type.String({ description: 'Mission id for diff/preflight and status detail.' })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 1, description: 'Cap for the diff patch.' })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Page offset for the status list.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Page size for the status list (max 100).' })),
  includeGate: Type.Optional(Type.Boolean({ description: 'Status: add preflight gate digests.' })),
  includeArchived: Type.Optional(Type.Boolean({ description: 'Status: append archived summaries.' })),
  format: Type.Optional(enumOf(STATUS_FORMATS, { description: 'Status: "markdown" returns the board.' })),
  checks: Type.Optional(Type.Boolean({ description: 'Doctor: only the check rows, without the diagnostics.' })),
  compact: Type.Optional(Type.Boolean({ description: 'Doctor: only {ok, checks}; pass rows keep {id,status}, others add detail.' })),
  fields: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: 'Status: keep exactly these keys.' })),
  sinceRevision: Type.Optional(Type.Integer({ minimum: 0, description: "Status: mission rows and the roster count only, filtered by spawn/interrupt/roster stamps after this revision (0 = all); roster rows come from the roster view's agent/tail, which ignores this. Plan/mission/complete/merge/review/worktree writes and tower_test receipts are unstamped and omitted (testRuns appear only in missionId detail)." })),
  agent: Type.Optional(Type.String({ minLength: 1, description: 'Roster: a name or agent id.' })),
  tail: Type.Optional(Type.Integer({ minimum: 1, description: 'Roster: newest N rows.' })),
  stat: Type.Optional(Type.Boolean({ description: 'Diff: per-file counts, no patch.' })),
}, { additionalProperties: false })
