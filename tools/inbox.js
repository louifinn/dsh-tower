// Acknowledged messages are filtered from later unread counts.
// Delivery results are persisted by the registry.
// tower_inbox — read and acknowledge mission messages.
// 
// Input: InboxInput (name, limit) from domain contracts.
// Output: unread messages plus acknowledgement metadata.
// Authorization: the addressed roster agent or the tower.
// Side effects: marks delivered messages as read and persists state.
// Failure modes: unknown recipient, invalid limit.
// The unread calculation is a pure domain/collab projection.
// See docs/reference/tools.generated.md for the public shape.
// tower_inbox: read and acknowledge inbound messages.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { InboxInput } from '../domain/contracts/tool-inputs/index.js'
import { ROLE, isTowerRole, isUnknownRole } from '../domain/vocabulary.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any }} deps
 */
export function registerInboxTool(ctx, deps) {
  // openTower is injected by the composition root (#69).
  const { define } = deps
  define(ctx, {
    name: 'tower_inbox',
    description:
      'Read your tower inbox: messages addressed to you plus broadcasts, newest first. Only returned messages are acknowledged; the result reports unreadRemaining, so keep reading until it reaches 0. Set include_read for history. Unread messages block tower_complete.',
    parameters: InboxInput,
    aliases: {"include_read":["includeRead"]},
    output: output(SCHEMAS.inbox),
    async execute(args, _exec, actor) {
      // Defence in depth: the kernel already denied an unknown caller. There is
      // deliberately no fallback that promotes an unidentified caller to the
      // tower — the old fallback let any agent read and acknowledge all mail.
      if (!actor || isUnknownRole(actor.role) || typeof actor.name !== 'string' || actor.name.length === 0) {
        throw new TowerToolError('not-authorized', 'tower_inbox requires a registered roster agent or the tower')
      }
      // The reader is explicit: the tower reads the tower inbox; a known worker
      // or reviewer reads only messages addressed to its own roster name.
      const reader = isTowerRole(actor.role) ? ROLE.tower : actor.name
      const tower = await deps.openTower(args.repoRoot)
      return tower.inbox({ reader, limit: args.limit, includeRead: args.include_read === true })
    },
  })
}
