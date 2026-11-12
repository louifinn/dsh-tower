// tower_spawn / tower_roster / tower_interrupt / tower_send / tower_inbox /
// tower_adopt input contracts. Pure TypeBox only; no I/O.
//
// #163: no schema advertises `repoRoot` (the runtime resolves the calling
// session's repository) and alias fields are no longer advertised; the server
// still accepts them through the tool definitions' `aliases` maps.
import { ROLES } from '../../vocabulary.js'
import { Type, enumOf } from './shared.js'

export const SpawnInput = Type.Object({
  missionId: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: id).' })),
  role: Type.Optional(enumOf(ROLES, { description: 'worker executes; reviewer audits the mission branch.' })),
  name: Type.Optional(Type.String({ description: 'Unique roster name; defaults to <role>-<missionId>.' })),
  instructions: Type.Optional(Type.String({ description: 'Extra tower instructions appended to the briefing.' })),
  worktreeRoot: Type.Optional(Type.String({ description: 'Optional absolute parent directory for the worktree.' })),
  wait: Type.Optional(Type.Boolean({ description: 'Wait for the child result instead of returning immediately (testing/debug).' })),
  waitMs: Type.Optional(Type.Number({ description: 'Max wait with wait=true, default 180000; clamped to spawn.maxWaitMs (default 90000).' })),
  takeover: Type.Optional(Type.Boolean({ description: 'Replace a live worker entry that is no longer running (increments ownerGeneration).' })),
  includeDirtyBase: Type.Optional(Type.Boolean({ description: 'Use the recorded snapshotCommit baseline when true (default true).' })),
}, { additionalProperties: false })

export const RosterInput = Type.Object({}, { additionalProperties: false })

export const InterruptInput = Type.Object({
  to: Type.Optional(Type.String({ description: 'Roster name to interrupt.' })),
  agentId: Type.Optional(Type.String({ description: 'Agent/session id to interrupt (alternative to to).' })),
  reason: Type.Optional(Type.String({ description: 'Why the agent is being interrupted (recorded in the roster).' })),
}, { additionalProperties: false })

export const SendInput = Type.Object({
  to: Type.String({ description: 'Recipient: a roster agent name, "tower", or "all".' }),
  subject: Type.String({ description: 'One-line subject.' }),
  body: Type.String({ description: 'Full message body (markdown).' }),
  scope: Type.Optional(Type.String({ description: 'Optional scope tag, e.g. the mission id.' })),
  interrupt: Type.Optional(
    Type.Boolean({
      description: 'Interrupt the recipient\'s current turn before delivering (Kimi-style "message interrupts the running turn"); default false = queue at the next step boundary.',
    }),
  ),
  consentRef: Type.Optional(Type.String({ description: 'Optional audit reference recording who consented to this instruction.' })),
}, { additionalProperties: false })

export const InboxInput = Type.Object({
  limit: Type.Optional(Type.Number({ description: 'Max messages to return (default 20), newest first.' })),
  include_read: Type.Optional(Type.Boolean({ description: 'Include previously acknowledged messages for history lookup.' })),
}, { additionalProperties: false })

export const AdoptInput = Type.Object({
  retire_missing: Type.Optional(Type.Boolean({ description: 'Retire provably gone agents (default true); false marks them missing instead.' })),
}, { additionalProperties: false })
