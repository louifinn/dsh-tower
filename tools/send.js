// tower_send: durable inbox message delivery.
import { Tower } from '../app/tower.js'
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { SendInput } from '../domain/contracts/tool-inputs/index.js'
import {
  ROLE,
  ROSTER_ACTIVITY,
  isBroadcast,
  isRunningActivity,
  isTowerRecipient,
  isTowerRole,
  isUnknownRole,
} from '../domain/vocabulary.js'

/**
 * @param {any} ctx
 * @param {{
 *   define: import('../types/index.js').DefineTool,
 *   actorFor: any,
 *   checkSendRate: any,
 * }} deps
 */
export function registerSendTool(ctx, deps) {
  const { define, actorFor, checkSendRate } = deps
  define(ctx, {
    name: 'tower_send',
    description:
      'Send a durable inbox message to a tower participant: a roster agent name, "tower", or "all" (broadcast). The message is persisted first; when the recipient is a currently running roster agent the tower also steers it into that child\'s current turn. Returns delivery results.',
    parameters: SendInput,
    aliases: { consentRef: ['consent_ref'] },
    output: output(SCHEMAS.send),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      checkSendRate(tower.config, args.repoRoot)
      const actor = await actorFor(tower, exec)
      const view = await tower.rosterView()
      const from = isTowerRole(actor.role) ? ROLE.tower : actor.name
      if (isUnknownRole(actor.role)) {
        throw new TowerToolError('not-authorized', 'tower_send requires a registered roster agent or the tower')
      }
      if (isBroadcast(args.to) && !isTowerRole(actor.role)) {
        throw new TowerToolError('not-authorized', 'only the tower may broadcast to "all"')
      }
      const sendConfig = tower.config.send ?? {}
      const interrupt =
        args.interrupt === undefined ? sendConfig.interruptDefault === true : args.interrupt === true
      if (interrupt && !isTowerRole(actor.role)) {
        throw new TowerToolError('not-authorized', 'only the tower may interrupt a recipient with tower_send')
      }
      if (!isTowerRole(actor.role)) {
        const self = view.roster.find((entry) => entry.agentId === actor.agentId)
        const target = view.roster.find((entry) => entry.name === args.to)
        const allowed =
          isTowerRecipient(args.to) ||
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
            for (const row of rows) activity.set(String(row.id), row.activity ?? ROSTER_ACTIVITY.unknown)
          } catch {
            // an unreadable parent catalog only means "do not wake it"
          }
        }
        const targets =
          isBroadcast(args.to) ? roster.map((entry) => entry.name) : [args.to]
        for (const targetName of targets) {
          if (isTowerRecipient(targetName)) {
            results.push({ target: ROLE.tower, pushed: false, reason: 'tower reads its inbox' })
            continue
          }
          const entry = roster.find((candidate) => candidate.name === targetName)
          if (!entry) {
            results.push({ target: targetName, pushed: false, reason: 'not in roster' })
            continue
          }
          if (!isRunningActivity(activity.get(entry.agentId))) {
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
}
