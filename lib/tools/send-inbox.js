// tower_send and tower_inbox.
import { Tower } from '../tower.js'
import { SCHEMAS, output } from '../schemas.js'
import { TowerToolError } from '../errors.js'
import { Type } from '../toolSchema.js'

/**
 * @param {any} ctx
 * @param {{
 *   define: import('../../types/index.js').DefineTool,
 *   actorFor: any,
 *   checkSendRate: any,
 *   interruptRosterAgent: any,
 * }} deps
 */
export function registerSendInboxTools(ctx, deps) {
  const { define, actorFor, checkSendRate, interruptRosterAgent } = deps
  define(ctx, {
    name: 'tower_send',
    description:
      'Send a durable inbox message to a tower participant: a roster agent name, "tower", or "all" (broadcast). The message is persisted first; when the recipient is a currently running roster agent the tower also steers it into that child\'s current turn. Returns delivery results.',
    parameters: Type.Object({
      repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
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
      consent_ref: Type.Optional(Type.String({ description: 'Alias for consentRef.' })),
    }, { additionalProperties: false }),
    aliases: { consentRef: ['consent_ref'] },
    output: output(SCHEMAS.send),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      checkSendRate(tower.config, args.repoRoot)
      const actor = await actorFor(tower, exec)
      const view = await tower.rosterView()
      const from = actor.role === 'tower' ? 'tower' : actor.name
      if (actor.role === 'unknown') {
        throw new TowerToolError('not-authorized', 'tower_send requires a registered roster agent or the tower')
      }
      if (args.to === 'all' && actor.role !== 'tower') {
        throw new TowerToolError('not-authorized', 'only the tower may broadcast to "all"')
      }
      const sendConfig = tower.config.send ?? {}
      const interrupt =
        args.interrupt === undefined ? sendConfig.interruptDefault === true : args.interrupt === true
      if (interrupt && actor.role !== 'tower') {
        throw new TowerToolError('not-authorized', 'only the tower may interrupt a recipient with tower_send')
      }
      if (actor.role !== 'tower') {
        const self = view.roster.find((entry) => entry.agentId === actor.agentId)
        const target = view.roster.find((entry) => entry.name === args.to)
        const allowed =
          args.to === 'tower' ||
          (self && target && target.agentId !== self.agentId && target.missionId === self.missionId)
        if (!allowed) {
          throw new TowerToolError('not-authorized', `${actor.name} may only message the tower or agents on the same mission`)
        }
      }
      if (typeof args.subject !== 'string' || args.subject.trim().length === 0) {
        throw new TowerToolError('invalid-argument', 'tower_send requires a subject')
      }
      if (typeof args.body !== 'string' || args.body.trim().length === 0) {
        throw new TowerToolError('invalid-argument', 'tower_send requires a body')
      }
      const message = await tower.recordMessage({
        from,
        to: args.to,
        subject: args.subject.trim(),
        body: args.body,
        scope: args.scope,
        consentRef: args.consentRef,
      })

      const subagents = ctx.get('subagents')
      const results = []
      if (!subagents) {
        results.push({ target: '*', pushed: false, reason: 'subagents service unavailable; persisted only' })
      } else {
        const roster = view.roster
        const parents = [...new Set(roster.map((entry) => entry.parentSessionId).filter(Boolean))]
        const activity = new Map()
        for (const parent of parents) {
          try {
            const rows = await subagents.listDescendants(parent)
            for (const row of rows) activity.set(String(row.id), row.activity ?? 'unknown')
          } catch {
            // an unreadable parent catalog only means "do not wake it"
          }
        }
        const targets =
          args.to === 'all' ? roster.map((entry) => entry.name) : [args.to]
        for (const targetName of targets) {
          if (targetName === 'tower') {
            results.push({ target: 'tower', pushed: false, reason: 'tower reads its inbox' })
            continue
          }
          const entry = roster.find((candidate) => candidate.name === targetName)
          if (!entry) {
            results.push({ target: targetName, pushed: false, reason: 'not in roster' })
            continue
          }
          if (activity.get(entry.agentId) !== 'running') {
            results.push({ target: targetName, pushed: false, reason: 'not running; queued in inbox' })
            continue
          }
          let interrupted = false
          if (interrupt) {
            try {
              subagents.interrupt(entry.agentId, { kind: 'ancestor', agent: exec.agent })
              interrupted = true
              await tower.recordInterrupt({
                agentId: entry.agentId,
                reason: `tower_send${message?.id ? ` ${message.id}` : ''}: ${args.subject.trim().slice(0, 120)}`,
              })
            } catch (error) {
              results.push({ target: targetName, pushed: false, reason: `interrupt failed: ${String(error?.message ?? error)}` })
              continue
            }
          }
          try {
            await subagents.sendMessage(
              exec.agent,
              entry.agentId,
              [
                {
                  type: 'text',
                  text: `[tower inbox ${message.id}] ${message.subject}\n\n${message.body}`,
                },
              ],
              { signal: exec.signal },
            )
            results.push({ target: targetName, pushed: true, interrupted })
          } catch (error) {
            results.push({ target: targetName, pushed: false, reason: String(error?.message ?? error) })
          }
        }
      }
      if (results.length > 0) await tower.recordDelivery(message.id, results)
      return {
        message: { id: message.id, from, to: message.to, subject: message.subject },
        deliveries: results,
      }
    },
  })

  define(ctx, {
    name: 'tower_inbox',
    description:
      'Read your tower inbox: messages addressed to you plus broadcasts, newest first. Only returned messages are acknowledged; the result reports unreadRemaining, so keep reading until it reaches 0. Set include_read for history. Unread messages block tower_complete.',
    parameters: Type.Object({
      repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
      limit: Type.Optional(Type.Number({ description: 'Max messages to return (default 20), newest first.' })),
      include_read: Type.Optional(Type.Boolean({ description: 'Include previously acknowledged messages for history lookup.' })),
      includeRead: Type.Optional(Type.Boolean({ description: 'Alias for include_read.' })),
    }, { additionalProperties: false }),
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
