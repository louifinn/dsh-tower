// tower_send: durable inbox message delivery.
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
 * Stable code for "wake:true could not start a turn". Kept in one place so the
 * tool and its tests cannot drift while the catalogue entry is settled.
 */
const AGENT_NOT_RESUMABLE = 'agent-not-resumable'

/** @param {any} error */
function isNotResumable(error) {
  if (error?.code === 'NOT_RESUMABLE' || error?.code === 'subagent/not-resumable') return true
  return /not resumable|no supported continuation state/i.test(String(error?.message ?? error))
}

/**
 * @param {any} ctx
 * @param {{
 *   define: import('../types/index.js').DefineTool,
 *   openTower: any,
 *   actorFor: any,
 *   checkSendRate: any,
 * }} deps
 */
export function registerSendTool(ctx, deps) {
  const { define, actorFor, checkSendRate } = deps
  define(ctx, {
    name: 'tower_send',
    description:
      'Send a durable inbox message to a tower participant: a roster agent name, "tower", or "all" (broadcast). A running roster agent is steered into its current turn; a stopped one keeps the message queued unless wake:true starts a new turn. Returns delivery results.',
    parameters: SendInput,
    aliases: { consentRef: ['consent_ref'] },
    output: output(SCHEMAS.send),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
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
      const wake = args.wake === true
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
      /** Targets whose persisted message cannot start a turn. */
      const notResumable = []
      const fail = (target, reason, interrupted = false) => ({
        target,
        pushed: false,
        interrupted,
        woke: false,
        reason,
      })
      if (!subagents) {
        results.push(fail('*', 'subagents service unavailable; the message is persisted, but nothing can deliver or start a turn for it'))
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
        const targets = isBroadcast(args.to) ? roster.map((entry) => entry.name) : [args.to]
        for (const targetName of targets) {
          if (isTowerRecipient(targetName)) {
            results.push(fail(ROLE.tower, 'tower reads its inbox on its next turn; wake does not apply to the tower'))
            continue
          }
          const entry = roster.find((candidate) => candidate.name === targetName)
          if (!entry) {
            results.push(fail(targetName, 'not in roster; no agent will read this message and wake cannot start one'))
            continue
          }
          const running = isRunningActivity(activity.get(entry.agentId))
          if (!running && !wake) {
            results.push(
              fail(targetName, "not running; the message is persisted in its inbox for the agent's next turn — pass wake:true to start a turn now"),
            )
            continue
          }
          let interrupted = false
          if (interrupt && running) {
            try {
              subagents.interrupt(entry.agentId, { kind: 'ancestor', agent: exec.agent })
              interrupted = true
              await tower.recordInterrupt({
                agentId: entry.agentId,
                reason: `tower_send${message?.id ? ` ${message.id}` : ''}: ${args.subject.trim().slice(0, 120)}`,
              })
            } catch (error) {
              results.push(fail(targetName, `interrupt failed: ${String(error?.message ?? error)}; the message is persisted but not delivered`))
              continue
            }
          }
          try {
            await subagents.sendMessage(
              exec.agent,
              entry.agentId,
              [{ type: 'text', text: `[tower inbox ${message.id}] ${message.subject}\n\n${message.body}` }],
              { signal: exec.signal },
            )
            results.push({ target: targetName, pushed: true, interrupted, woke: !running })
          } catch (error) {
            const detail = String(error?.message ?? error)
            const unresumable = wake && !running && isNotResumable(error)
            if (unresumable) notResumable.push(targetName)
            const tail = running
              ? 'the message is persisted but was not steered into the running turn'
              : "the message is persisted in its inbox for the agent's next turn — pass wake:true to start a turn now"
            results.push(
              fail(targetName, unresumable ? `not resumable: ${detail}; the message is persisted but wake cannot start a turn` : `${detail}; ${tail}`, interrupted),
            )
          }
        }
      }
      if (results.length > 0) await tower.recordDelivery(message.id, results)
      if (notResumable.length > 0) {
        throw new TowerToolError(
          AGENT_NOT_RESUMABLE,
          `${notResumable.join(', ')} cannot be resumed, so wake:true cannot start a turn for the persisted message`,
          {
            details: { targets: notResumable, messageId: message.id },
            nextAction:
              'choose a running agent or a resumable direct child (tower_inspect view:"roster"), or omit wake:true to leave the message for the agent\'s next turn',
          },
        )
      }
      return {
        message: { id: message.id, from, to: message.to, subject: message.subject },
        deliveries: results,
      }
    },
  })
}
