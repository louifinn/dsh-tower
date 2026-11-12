// tower_finding input contract (#163 Phase 4). Pure TypeBox only; no I/O.
//
// One tool covers the same resource through `op`:
//   report  file a finding (type/title/summary/details/suggested_fix)
//   list    list or read findings (id reads one; filters narrow the list)
//   update  change a finding's status and/or record a note (id required)
// `op` is optional and inferred from the arguments when omitted. Alias fields
// (`mission_id`) stay accepted through the tool definition's `aliases` map but
// are not advertised.
import {
  FINDING_FILTER_STATUSES,
  FINDING_OPS,
  FINDING_SEVERITIES,
  FINDING_TYPES,
} from '../../vocabulary.js'
import { Type, enumOf } from './shared.js'

export const FindingInput = Type.Object({
  op: Type.Optional(enumOf(FINDING_OPS, { description: 'report files a finding; list reads/filters; update changes status or note. Inferred when omitted.' })),
  id: Type.Optional(Type.String({ description: 'Finding id, e.g. F1 (list reads it; update requires it).' })),
  status: Type.Optional(enumOf(FINDING_FILTER_STATUSES, { description: 'With id: target status. Without id: filter (default all).' })),
  note: Type.Optional(Type.String({ description: 'Optional note recorded together with an update.' })),
  type: Type.Optional(enumOf(FINDING_TYPES, { description: 'Finding category (report) or filter (list).' })),
  title: Type.Optional(Type.String({ description: 'Short finding title (report).' })),
  severity: Type.Optional(enumOf(FINDING_SEVERITIES, { description: 'Optional severity (report) or filter (list).' })),
  summary: Type.Optional(Type.String({ description: 'What was found, in a sentence or two (report).' })),
  location: Type.Optional(Type.String({ description: 'File/symbol the finding concerns (report).' })),
  details: Type.Optional(Type.String({ description: 'Full details: evidence, reproduction, impact (report).' })),
  suggested_fix: Type.Optional(Type.String({ description: 'What you would do about it (report).' })),
  missionId: Type.Optional(Type.String({ description: 'Mission id to relate or filter by (alias: mission_id).' })),
  open: Type.Optional(Type.Boolean({ description: 'Only findings that are not fixed or wontfix (list).' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: 'Max findings to list (default 50).' })),
}, { additionalProperties: false })
