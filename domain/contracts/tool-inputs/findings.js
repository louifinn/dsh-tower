// tower_finding / tower_findings input contracts. Pure TypeBox only; no I/O.
import { FINDING_FILTER_STATUSES, FINDING_SEVERITIES, FINDING_TYPES } from '../../vocabulary.js'
import { Type, enumOf } from './shared.js'

export const FindingInput = Type.Object({
  repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
  type: enumOf(FINDING_TYPES, { description: 'Finding category.' }),
  title: Type.String({ description: 'Short finding title.' }),
  severity: Type.Optional(enumOf(FINDING_SEVERITIES, { description: 'Optional severity.' })),
  summary: Type.String({ description: 'What was found, in a sentence or two.' }),
  location: Type.Optional(Type.String({ description: 'File/symbol the finding concerns.' })),
  details: Type.String({ description: 'Full details: evidence, reproduction, impact.' }),
  suggested_fix: Type.String({ description: 'What you would do about it.' }),
  missionId: Type.Optional(Type.String({ description: 'Optional mission this finding relates to (alias: mission_id).' })),
  mission_id: Type.Optional(Type.String({ description: 'Alias for missionId.' })),
}, { additionalProperties: false })

export const FindingsInput = Type.Object({
  repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
  id: Type.Optional(Type.String({ description: 'Finding id, e.g. F1. When present the call reads or updates that finding.' })),
  status: Type.Optional(enumOf(FINDING_FILTER_STATUSES, { description: 'With id: target status. Without id: filter (default all).' })),
  note: Type.Optional(Type.String({ description: 'Optional note recorded together with an update.' })),
  type: Type.Optional(enumOf(FINDING_TYPES, { description: 'Filter by finding type.' })),
  severity: Type.Optional(enumOf(FINDING_SEVERITIES, { description: 'Filter by severity.' })),
  missionId: Type.Optional(Type.String({ description: 'Filter by mission id (alias: mission_id).' })),
  mission_id: Type.Optional(Type.String({ description: 'Alias for missionId.' })),
  open: Type.Optional(Type.Boolean({ description: 'Only findings that are not fixed or wontfix.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: 'Max findings to list (default 50).' })),
}, { additionalProperties: false })
