// dsh-tower — Host entry.
//
// Tower mode is a session-level stance. The human owns it through the
// `/tower` command: bare `/tower`, `/tower on [message]`, `/tower off
// [message]`, and `/tower <message>` all work, and any trailing text is
// forwarded to the model as the next user message. With
// config.allowAgentControl the model may also enter or leave the mode through
// `tower_control` when the user intent or task state clearly calls for it.
import { randomUUID } from 'node:crypto'
import { registerTowerTools } from './lib/tools.js'
import { loadModes, saveModes, storePath } from './lib/modeStore.js'

export const name = 'dsh-tower'
export const inject = ['tools', 'systemPrompt']

const MODE = loadModes()

const DENY_TOOLS = new Set([
  'create_goal',
  'todo_write',
  'team_task_create',
  'team_task_update',
  'team_task_reopen',
  'spawn_teammate',
])

const BASE_REMINDER = [
  'Tower mode is active for this session. You are the control tower: plan missions, spawn workers and reviewers, and integrate only through the Tower tools.',
  'Mission tracking lives in tower_plan / tower_mission / tower_status, not todo_write or the Team task board.',
  'Do not create or resume goals, do not spawn teammates, and never merge without a green tower_preflight.',
  'Only the human can normally change this mode with /tower on|off.',
].join(' ')

const AGENT_CONTROL_NOTE =
  'If tower_control is available you may also enter or leave Tower mode yourself when the user intent or task state clearly calls for it, and you must state a concrete reason.'

function agentKey(agent) {
  if (!agent) return null
  const key = agent.id ?? agent.session
  return key === undefined || key === null ? null : String(key)
}

function resolveConfig(config) {
  const input = config ?? {}
  const unknown = Object.keys(input).filter((key) => !['section', 'allowAgentControl'].includes(key))
  if (unknown.length > 0) {
    throw new Error(
      `Tower config has unknown key(s) ${unknown.join(', ')} — config is { section?, allowAgentControl? }`,
    )
  }
  const section = typeof input.section === 'string' && input.section.trim().length > 0
    ? input.section
    : BASE_REMINDER
  return { section, allowAgentControl: input.allowAgentControl === true }
}

/** Parse `/tower` arguments: bare and free text both mean "ensure on". */
function parseTowerInput(rawInput) {
  const raw = String(rawInput ?? '').trim()
  const match = /^(on|off)(?:\s+([\s\S]*))?$/i.exec(raw)
  if (match) return { active: match[1].toLowerCase() === 'on', message: (match[2] ?? '').trim() }
  return { active: true, message: raw }
}

/**
 * Pause an active goal through the goals service when Tower mode starts.
 * DSH exposes `ctx.goals.get/pause`, so no projection guesswork is needed.
 */
function pauseActiveGoal(ctx, agent) {
  const goals = ctx.get('goals')
  if (!goals || typeof goals.get !== 'function' || typeof goals.pause !== 'function') {
    return { attempted: false, reason: 'no goals service' }
  }
  try {
    const view = goals.get(agent)
    if (!view) return { attempted: false, reason: 'no goal' }
    if (view.phase !== 'active') return { attempted: false, reason: `goal is ${view.phase}` }
    const paused = goals.pause(agent, { id: view.id, revision: view.revision })
    return {
      attempted: true,
      ok: true,
      goal: {
        id: String(paused.id),
        revision: paused.revision,
        objective: paused.objective,
        phase: paused.phase,
      },
    }
  } catch (error) {
    return { attempted: true, ok: false, reason: String(error?.message ?? error) }
  }
}

function enterMode(ctx, key, agent, by, reason) {
  const previous = MODE.get(key)
  const wasOn = Boolean(previous && previous.on)
  let pausedGoal = previous?.pausedGoal ?? null
  let goalNote = null
  if (!wasOn) {
    const paused = pauseActiveGoal(ctx, agent)
    if (paused.attempted && paused.ok) pausedGoal = paused.goal
    else if (paused.attempted && !paused.ok) goalNote = `pause-failed: ${paused.reason}`
    else if (paused.reason && paused.reason !== 'no goal' && paused.reason !== 'no goals service') {
      goalNote = paused.reason
    }
  }
  const now = Date.now()
  MODE.set(key, {
    on: true,
    pausedGoal,
    lastChange: { by, action: 'on', reason: reason ?? null, at: now },
    at: now,
  })
  saveModes(MODE)
  return { wasOn, pausedGoal, goalNote }
}

function exitMode(key, by, reason) {
  const previous = MODE.get(key)
  if (!previous) return { wasOn: false, pausedGoal: null, goalNote: null }
  MODE.delete(key)
  saveModes(MODE)
  return { wasOn: true, pausedGoal: previous.pausedGoal ?? null, goalNote: null, by, reason: reason ?? null }
}

function forwardInstruction(agent, message, attachments) {
  const content = [...(Array.isArray(attachments) ? attachments : [])]
  if (message) content.push({ type: 'text', text: message })
  if (content.length === 0) return false
  if (!agent || typeof agent.steer !== 'function') {
    throw new Error('the calling agent cannot accept a steering message')
  }
  // `Agent.steer` takes a COMPLETE UserMessage (`id` + `role` + `content` +
  // `source`), not a `{content, source}` init. Passing the init shape used to
  // insert a role-less message into the inbox; the next model request then
  // failed with 422 "messages[N]: missing field `role`" and the session could
  // no longer produce valid requests. Mirror `createUserMessage()` here, since
  // a local bundle cannot import `@deepseek-ai/dsh-llm` from the installation.
  agent.steer({
    id: randomUUID(),
    role: 'user',
    content,
    source: { kind: 'user' },
  })
  return true
}

function describeChange(active, outcome, forwarded, message, allowAgentControl) {
  const lines = []
  if (active) {
    lines.push(outcome.wasOn ? 'Tower mode remains on.' : 'Tower mode ON. Use the Tower tools; goal, todo, and Team delegation tools are disabled.')
  } else {
    lines.push(outcome.wasOn ? 'Tower mode OFF. Normal collaboration tools are available again.' : 'Tower mode is already off.')
  }
  if (outcome.pausedGoal) {
    lines.push(`A goal was paused on entry ("${outcome.pausedGoal.objective ?? outcome.pausedGoal.id}"); resume it yourself when ready.`)
  }
  if (outcome.goalNote) lines.push(`Goal handling: ${outcome.goalNote}`)
  if (forwarded) lines.push(message ? `Carried your instruction: ${message}` : 'Carried your attachments.')
  if (!allowAgentControl) lines.push('Only the human can change Tower mode.')
  return lines.join(' ')
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  registerTowerTools(ctx)

  ctx.effect(() =>
    ctx.tools.guard((execution) => {
      const key = agentKey(execution.agent)
      if (!key || !MODE.has(key)) return undefined
      if (DENY_TOOLS.has(execution.name)) {
        return `tower mode: ${execution.name} is disabled while Tower mode is active; use the Tower tools or /tower off`
      }
      if (execution.name === 'update_goal') {
        const args = execution.arguments
        if (args && typeof args === 'object' && args.action === 'resume') {
          return 'tower mode: goals cannot be resumed while Tower mode is active; use /tower off first'
        }
      }
      return undefined
    }),
  )

  ctx.systemPrompt.section({
    name: 'tower:mode',
    order: 15000,
    text: (context) =>
      context && MODE.has(agentKey(context.agent))
        ? config.allowAgentControl
          ? `${config.section} ${AGENT_CONTROL_NOTE}`
          : config.section
        : '',
  })

  ctx.effect(() =>
    ctx.tools.register({
      name: 'tower_mode',
      description:
        'Report whether Tower mode is active for the calling agent, who changed it last, whether the model may toggle it, and any goal paused on entry.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(_args, exec) {
        const key = agentKey(exec.agent)
        const entry = key ? MODE.get(key) : undefined
        return {
          mode: entry && entry.on === true ? 'on' : key ? 'off' : 'unknown',
          agentId: key,
          allowAgentControl: config.allowAgentControl,
          lastChange: entry?.lastChange ?? null,
          pausedGoal: entry?.pausedGoal ?? null,
          deniedWhileActive: [...DENY_TOOLS],
          persistedAt: storePath(),
        }
      },
    }),
  )

  if (config.allowAgentControl) {
    ctx.effect(() =>
      ctx.tools.register({
        name: 'tower_control',
        description:
          'Enter or leave Tower mode for the calling agent. Allowed only when the deployment enables allowAgentControl; use it when the user intent or task state clearly calls for Tower orchestration or a return to normal collaboration, and always state a concrete reason.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['enter', 'exit'], description: 'enter = Tower mode on; exit = Tower mode off.' },
            reason: { type: 'string', description: 'Why this mode change is warranted (user intent or task state).' },
          },
          required: ['action', 'reason'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          const key = agentKey(exec.agent)
          if (!key) return { ok: false, error: 'tower_control requires a live calling agent' }
          if (typeof args.reason !== 'string' || args.reason.trim().length === 0) {
            throw new Error('tower_control requires a non-empty reason')
          }
          const reason = args.reason.trim()
          const outcome =
            args.action === 'enter'
              ? enterMode(ctx, key, exec.agent, 'agent', reason)
              : exitMode(key, 'agent', reason)
          return {
            ok: true,
            action: args.action,
            mode: MODE.has(key) ? 'on' : 'off',
            changed: args.action === 'enter' ? !outcome.wasOn : outcome.wasOn,
            changedBy: 'agent',
            reason,
            pausedGoal: outcome.pausedGoal ?? null,
            goalNote: outcome.goalNote ?? null,
          }
        },
      }),
    )
  }

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'tower',
      description: 'Enter or leave Tower mode, optionally carrying a user instruction',
      input: { hint: '[on|off] [message]', attachments: true },
      handler: async ({ agent, rawInput, attachments }) => {
        const key = agentKey(agent)
        if (!key) return { kind: 'error', text: 'Tower mode requires a live agent.' }
        const { active, message } = parseTowerInput(rawInput)
        const outcome = active
          ? enterMode(ctx, key, agent, 'user', message || null)
          : exitMode(key, 'user', message || null)

        let forwarded = false
        try {
          forwarded = forwardInstruction(agent, message, attachments)
        } catch (error) {
          return {
            kind: 'error',
            text: `Tower mode changed, but the carried message could not be delivered: ${String(error?.message ?? error)}`,
          }
        }
        return {
          kind: 'success',
          text: describeChange(active, outcome, forwarded, message, config.allowAgentControl),
        }
      },
    })
  })
}
