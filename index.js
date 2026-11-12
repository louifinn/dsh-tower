// dsh-tower — Host entry.
//
// Tower mode is a session-level stance. It is intentionally operable by both
// sides: the `/tower` command (bare `/tower`, `/tower on [message]`, `/tower
// off [message]`, and `/tower <message>`; trailing text is forwarded to the
// model as the next user message) and, when config.allowAgentControl is true
// (the default), the model through `tower_control`. Every change is recorded
// with its actor and reason; set allowAgentControl:false for human-only mode
// control.
//
// `/tower reload` asks DSH HMR to reconcile this profile and reload the Tower
// plugin from disk when the HMR service is present (dev/linked installs).
//
// W5-A: this file is the Cordis apply/effect glue only. The mode state and
// transitions live in `host/mode-state.js`, the `/tower` command in
// `host/mode-command.js`, and the two session-tool bodies in
// `host/session-tools.js`.
import fs from 'node:fs'
import { authorizeSessionCall, registerCoreTowerTools, recordToolRegistration } from './host/tool-registry.js'
import { createDefaultDeps } from './adapters/default.js'
import { Config as ConfigSchema, configureRuntime } from './host/config.js'
import {
  agentCwd,
  agentKey,
  configSection,
  createWorkspaceHook,
  isDeniedTool,
  loadModes,
  modeOn,
  modeState,
  planModeState,
  releaseOwnedLocks,
  setDenyTools,
} from './host/mode-state.js'
import { registerTowerCommand } from './host/mode-command.js'
import { registerTasksCommand } from './host/tasks-command.js'
import { runTowerControl, runTowerMode } from './host/session-tools.js'
import { inspectWorkspaceLockSync, touchWorkspaceLock } from './adapters/workspaceLock.js'
import { resolveCommonDirSync } from './adapters/git.js'

export const name = 'dsh-tower'
export const inject = ['tools', 'systemPrompt']
export const Config = ConfigSchema

// The plugin version is read by the composition entry because `host/` modules
// may not touch `fs` (architecture `fs-surface`); it is passed into the
// `tower_mode` body. The value and its failure behavior are unchanged.
let pluginVersion = null
function readPluginVersion() {
  if (pluginVersion !== null) return pluginVersion
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    pluginVersion = typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    pluginVersion = null
  }
  return pluginVersion
}

export function apply(ctx, rawConfig) {
  const config = configureRuntime(rawConfig)
  const allowAgentControl = config.mode.allowAgentControl === true
  const reminder = configSection(config, allowAgentControl)
  const loadedModes = loadModes(config)
  if (loadedModes.status === 'corrupt') {
    console.warn(
      `[dsh-tower] the mode store is corrupt and was not loaded (${loadedModes.file}): ${loadedModes.error}; sessions start with Tower mode off until the file is repaired`,
    )
  }
  if (typeof ctx.provide === 'function') ctx.provide('tower', modeState)
  setDenyTools(config.mode.denyTools)

  const workspace = createWorkspaceHook()

  // #69: the host entry is the composition root — the adapters are constructed
  // once here and injected into the tool layer and every Tower instance.
  // #121: only the mandatory host surface is registered here. The optional
  // capability rows (batch/import/leases/tests/hmr) are separate loader entries
  // and register their own tools, so a disabled row removes exactly one
  // capability.
  registerCoreTowerTools(ctx, { workspace, deps: createDefaultDeps() })

  // #118/#121: tower_mode/tower_control are registered directly here instead of
  // through define(), so record them through the same recorder the registry
  // uses. tower_control is recorded before the allowAgentControl gate: the
  // concept budget measures the surface this build can register, not only the
  // tools one profile exposes (#84). Together with the capability-tool names the
  // registry records before row gating, these are the shipped 29.
  recordToolRegistration('tower_mode')
  recordToolRegistration('tower_control')

  // On dispose (including an HMR reload) release advisory workspace locks this
  // process still owns; a reloaded plugin restores the entries from modes.json.
  ctx.effect(() => () => releaseOwnedLocks())

  // #161: the deny set is owned, not named — `isDeniedTool` answers from the
  // component-owner registry (domain/deny-owners.js), so an upstream
  // orchestration tool is denied the day it ships. Two scopes deny:
  // the tower's own session, and — D4 — any agent whose repository is under
  // the workspace lock (a teammate spawned before entry, or a second session
  // on the same checkout). Every refusal names a runnable next step.
  const workspaceTowerHolder = (agent) => {
    try {
      const cwd = agentCwd(agent)
      if (!cwd) return null
      const commonDir = resolveCommonDirSync(cwd)
      if (!commonDir) return null
      const info = inspectWorkspaceLockSync(commonDir)
      return info.held ? info : null
    } catch {
      // An unexpected read error must not crash the pipeline; the workspace
      // lock itself remains enforced where it is acquired (mode-state.js).
      return null
    }
  }
  ctx.effect(() =>
    ctx.tools.guard((execution) => {
      if (!isDeniedTool(execution.name)) return undefined
      const key = agentKey(execution.agent)
      if (key && modeOn(key)) {
        return `tower mode: ${execution.name} is disabled while Tower mode is active; use the Tower tools or run /tower off`
      }
      const holder = workspaceTowerHolder(execution.agent)
      if (holder) {
        const id = String(holder.holder?.sessionId ?? holder.holder?.agentId ?? '').trim()
        const who = holder.corrupt || id === '' ? 'another Tower session' : `Tower session ${id.slice(0, 12)}`
        return `tower mode: ${execution.name} is disabled because this repository is under Tower mode (${who}); run /tower off in that session first, or /tower takeover <reason> here once it is gone`
      }
      return undefined
    }),
  )

  // Plan mode and Tower mode are mutually exclusive. Clearing at entry covers
  // the normal path; this pre-step listener also clears a plan activated later
  // in the same session, before the next step can run plan-policy tooling.
  ctx.effect(() =>
    typeof ctx.on === 'function'
      ? ctx.on('agent/pre-step', (payload, next) => {
          const key = agentKey(payload?.agent)
          if (key && modeOn(key)) {
            // Once Tower is active, Tower wins regardless of entry policy: clear
            // any plan state so the two policies cannot coexist.
            const state = planModeState(ctx, payload.agent)
            if (state.available && (state.active || state.pending)) state.service.set(payload.agent, false)
          }
          return next()
        })
      : () => {},
  )

  // #139: same leak as the skills provider — the section belongs to the plugin
  // lifetime, so registration goes through `ctx.effect`.
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'tower:mode',
      order: 15000,
      text: (context) => (context && modeOn(agentKey(context.agent)) ? reminder : ''),
    }),
  )

  // Workspace-lock heartbeat; only sessions holding a lock do I/O.
  ctx.effect(() => {
    const timer = setInterval(() => {
      for (const entry of modeState.values()) {
        if (!entry?.lock) continue
        touchWorkspaceLock(entry.lock.commonDir, { token: entry.lock.token }).catch(() => {})
      }
    }, Math.max(1000, Number(config.mode.heartbeatMs) || 10000))
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  })

  // The two session tools below are registered directly instead of through the
  // define() aggregate, so each handler authorizes first through the same
  // default-deny kernel (host/authorization.js). The matrix covers all 29
  // shipped tools, including these two; no tool bypasses the decision point.
  // The post-authorization body lives in host/session-tools.js.
  ctx.effect(() =>
    ctx.tools.register({
      name: 'tower_mode',
      description:
        'Report whether Tower mode is active for the calling agent, who changed it last, whether the model may toggle it, any goal paused and any Agent Team left on entry, the workspace lock, HMR availability and the plugin version.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['on', 'off', 'unknown'] },
            agentId: {},
            allowAgentControl: { type: 'boolean' },
            lastChange: {},
            pausedGoal: {},
            releasedTeam: {},
            deniedWhileActive: { type: 'array', items: { type: 'string' } },
            persistedAt: { type: 'string' },
            pluginVersion: {},
            hotReload: {},
            workspaceLock: {},
          },
          required: ['mode', 'allowAgentControl', 'deniedWhileActive'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(_args, exec) {
        await authorizeSessionCall('tower_mode', exec, agentCwd(exec.agent))
        return runTowerMode(ctx, exec, { config, allowAgentControl, workspace, pluginVersion: readPluginVersion() })
      },
    }),
  )

  if (allowAgentControl) {
    ctx.effect(() =>
      ctx.tools.register({
        name: 'tower_control',
        description:
          'Enter, leave, or take over Tower mode for the calling agent. `takeover` transfers repository ownership from an inactive owner to this session after explicit user approval. Allowed only when the deployment enables allowAgentControl; use it when the user intent or task state clearly calls for Tower orchestration or a return to normal collaboration, and always state a concrete reason.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['enter', 'exit', 'takeover'],
              description: 'enter = Tower mode on; exit = Tower mode off; takeover = transfer repository ownership to this session after approval.',
            },
            reason: { type: 'string', description: 'Why this mode change or ownership transfer is warranted (user intent or task state).' },
          },
          required: ['action', 'reason'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              action: { type: 'string', enum: ['enter', 'exit', 'takeover'] },
              mode: { type: 'string', enum: ['on', 'off'] },
              changed: { type: 'boolean' },
              changedBy: { type: 'string', enum: ['agent', 'user'] },
              reason: { type: 'string' },
              approved: { type: 'boolean' },
              transferred: { type: 'boolean' },
              alreadyOwner: { type: 'boolean' },
              owner: { type: 'string' },
              previousOwner: {},
              unreadMessages: { type: 'number' },
              pausedGoal: {},
              releasedTeam: {},
              goalNote: {},
              teamNote: {},
              error: { type: 'string' },
            },
            required: ['ok'],
            additionalProperties: true,
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          await authorizeSessionCall('tower_control', exec, agentCwd(exec.agent))
          return runTowerControl(ctx, args, exec, { config })
        },
      }),
    )
  }

  registerTowerCommand(ctx, { config, allowAgentControl })
  // #160: the read-only `/tasks` panel registers only when the host profile
  // has no other `tasks` command; `/tower tasks` always carries the same view.
  registerTasksCommand(ctx)
}
