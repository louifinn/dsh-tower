// tower_inbox: read and acknowledge inbound messages.
import { Tower } from '../app/tower.js'
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { InboxInput } from '../domain/contracts/tool-inputs/index.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool }} deps
 */
export function registerInboxTool(ctx, deps) {
  const { define } = deps
  define(ctx, {
    name: 'tower_inbox',
    description:
      'Read your tower inbox: messages addressed to you plus broadcasts, newest first. Only returned messages are acknowledged; the result reports unreadRemaining, so keep reading until it reaches 0. Set include_read for history. Unread messages block tower_complete.',
    parameters: InboxInput,
    aliases: {"include_read":["includeRead"]},
    output: output(SCHEMAS.inbox),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const view = await tower.rosterView()
      const self = view.roster.find((entry) => entry.agentId === String(exec.agent.id))
      const reader = self ? self.name : 'tower'
      return tower.inbox({ reader, limit: args.limit, includeRead: args.include_read === true })
    },
  })
}
