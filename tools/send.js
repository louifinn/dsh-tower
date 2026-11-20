// tower_send: durable inbox message delivery.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { SendInput } from '../domain/contracts/tool-inputs/index.js'
import { ROLE, ROSTER_ACTIVITY, isBroadcast, isRunningActivity, isTowerRecipient, isTowerRole, isUnknownRole } from '../domain/vocabulary.js'

// Stable code for "wake:true could not start a turn".
const AGENT_NOT_RESUMABLE = 'agent-not-resumable'

// Three-state activity: an unreadable or empty catalog is absence of evidence (#F73), never "stopped".
const ACTIVITY = Object.freeze({ running: 'running', stopped: 'stopped', unknown: 'unknown' })

/** @param {any} error */
function isNotResumable(error) {
  if (error?.code === 'NOT_RESUMABLE' || error?.code === 'subagent/not-resumable') return true
  return /not resumable|no supported continuation state/i.test(String(error?.message ?? error))
}

/** @param {any} ctx @param {{ define: import('../types/index.js').DefineTool, openTower: any, actorFor: any, checkSendRate: any }} deps */
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
      if (isUnknownRole(actor.role)) throw new TowerToolError('not-authorized', 'tower_send requires a registered roster agent or the tower')
      if (isBroadcast(args.to) && !isTowerRole(actor.role)) throw new TowerToolError('not-authorized', 'only the tower may broadcast to "all"')
      const interrupt = args.interrupt === undefined ? (tower.config.send ?? {}).interruptDefault === true : args.interrupt === true
      const wake = args.wake === true
      if (interrupt && !isTowerRole(actor.role)) throw new TowerToolError('not-authorized', 'only the tower may interrupt a recipient with tower_send')
      if (!isTowerRole(actor.role)) {
        const self = view.roster.find((entry) => entry.agentId === actor.agentId)
        const target = view.roster.find((entry) => entry.name === args.to)
        const allowed =
          isTowerRecipient(args.to) || (self && target && target.agentId !== self.agentId && target.missionId === self.missionId)
        if (!allowed) throw new TowerToolError('not-authorized', `${actor.name} may only message the tower or agents on the same mission`)
      }
      if (typeof args.subject !== 'string' || args.subject.trim().length === 0) throw new TowerToolError('invalid-argument', 'tower_send requires a subject')
      if (typeof args.body !== 'string' || args.body.trim().length === 0) throw new TowerToolError('invalid-argument', 'tower_send requires a body')
      const message = await tower.recordMessage({
        from, to: args.to, subject: args.subject.trim(), body: args.body, scope: args.scope, consentRef: args.consentRef,
      })

      const subagents = ctx.get('subagents')
      const results = []
      /** Targets whose persisted message cannot start a turn. */
      const notResumable = []
      const fail = (target, reason, interrupted = false) => ({ target, pushed: false, interrupted, woke: false, reason })
      if (!subagents) {
        results.push(fail('*', 'subagents service unavailable; the message is persisted, but nothing can deliver or start a turn for it'))
      } else {
        const roster = view.roster
        const parents = [...new Set(roster.map((entry) => entry.parentSessionId).filter(Boolean))]
        const activity = new Map()
        const catalogs = new Map()
        for (const parent of parents) {
          try {
            const rows = await subagents.listDescendants(parent)
            for (const row of rows) activity.set(String(row.id), row.activity ?? ROSTER_ACTIVITY.unknown)
            // #F73: a reachable catalog that returns no rows is absence of evidence, not proof of stopped.
            catalogs.set(parent, { readable: true, rows: rows.length, error: null })
          } catch (error) {
            catalogs.set(parent, { readable: false, rows: 0, error: String(error?.message ?? error) })
          }
        }
        // Only an observed, non-running catalog row proves stopped; a missing row is absence of evidence (#F73).
        const classify = (entry) => {
          const observed = activity.get(String(entry.agentId))
          if (observed === undefined || observed === ROSTER_ACTIVITY.unknown) return ACTIVITY.unknown
          return isRunningActivity(observed) ? ACTIVITY.running : ACTIVITY.stopped
        }
        const unknownDetail = (entry) => {
          const catalog = entry.parentSessionId ? catalogs.get(entry.parentSessionId) : undefined
          if (!catalog) return 'no parent session is recorded for this agent'
          if (!catalog.readable) return `activity catalog unavailable (${catalog.error})`
          return catalog.rows === 0 ? 'the activity catalog returned no descendants' : 'the agent is not in the live catalog'
        }
        const unknownReason = (entry) => `activity is unknown: ${unknownDetail(entry)}; cannot verify the recipient is stopped`
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
          const state = classify(entry)
          const notes = []
          if (state === ACTIVITY.unknown) {
            notes.push(unknownReason(entry))
            if (wake) notes.push('wake:true was requested, but no wake is claimed without an observed stopped state')
          }
          if (state === ACTIVITY.stopped && interrupt) {
            notes.push('the recipient is not running, so interrupt:true had nothing to interrupt')
          }
          let interrupted = false
          // An explicit interrupt is never silently skipped: unknown activity still receives the call.
          if (interrupt && state !== ACTIVITY.stopped) {
            try {
              subagents.interrupt(entry.agentId, { kind: 'ancestor', agent: exec.agent })
              interrupted = true
              const reason = `tower_send${message?.id ? ` ${message.id}` : ''}: ${args.subject.trim().slice(0, 120)}`
              await tower.recordInterrupt({ agentId: entry.agentId, reason })
              if (state === ACTIVITY.unknown) notes.push('interrupt:true was requested explicitly and was applied')
            } catch (error) {
              const detail = String(error?.message ?? error)
              const note = state === ACTIVITY.unknown ? `${unknownReason(entry)}; ` : ''
              results.push(fail(targetName, `interrupt failed: ${detail}; ${note}the message is persisted but not delivered`))
              continue
            }
          }
          // Known running => steer; known stopped => only an explicit wake; unknown => only
          // when wake/interrupt was explicit (never claim a wake the catalog cannot prove).
          const deliver =
            state === ACTIVITY.running ||
            (state === ACTIVITY.unknown && (wake || interrupted)) ||
            (state === ACTIVITY.stopped && wake)
          if (!deliver) {
            const reason =
              state === ACTIVITY.unknown
                ? `${unknownReason(entry)}; the message is persisted in its inbox and will not be read until the catalog is readable or the recipient runs again — wake:true would attempt delivery, but it cannot confirm a wake in this state`
                : `not running${
                    interrupt ? ', so interrupt:true had nothing to interrupt' : ''
                  }; the message is persisted in its inbox for the agent's next turn — pass wake:true to start a turn now`
            results.push(fail(targetName, reason))
            continue
          }
          try {
            await subagents.sendMessage(
              exec.agent,
              entry.agentId,
              [{ type: 'text', text: `[tower inbox ${message.id}] ${message.subject}\n\n${message.body}` }],
              { signal: exec.signal },
            )
            results.push({
              target: targetName,
              pushed: true,
              interrupted,
              // Only a known-stopped recipient can be said to have been woken.
              woke: state === ACTIVITY.stopped && wake,
              ...(notes.length > 0 ? { reason: notes.join('; ') } : {}),
            })
          } catch (error) {
            const detail = String(error?.message ?? error)
            const unresumable = wake && state === ACTIVITY.stopped && isNotResumable(error)
            if (unresumable) notResumable.push(targetName)
            const tail = unresumable
              ? 'the message is persisted but wake cannot start a turn'
              : state === ACTIVITY.running
                ? 'the message is persisted but was not steered into the running turn'
                : state === ACTIVITY.unknown
                  ? wake
                    ? `${unknownReason(entry)}; the delivery attempt failed, so the message is persisted but no wake can be claimed`
                    : `${unknownReason(entry)}; the delivery attempt failed and the message is persisted`
                  : wake
                    ? 'wake:true was requested but could not start a turn; the message is persisted in its inbox and will not be read until the agent runs again or is resumed'
                    : "the message is persisted in its inbox for the agent's next turn — pass wake:true to start a turn now"
            results.push(fail(targetName, `${detail}; ${tail}`, interrupted))
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
              'the message is persisted in the target\'s inbox but will not be read until that agent can be resumed; choose a running agent or a resumable direct child (tower_inspect view:"roster")',
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
