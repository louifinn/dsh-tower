// `/tower` command registration (W5-A).
//
// Bare `/tower`, `on|off`, `ack`, `takeover <reason>`, `reload`, `base <branch>`
// and the read-only `tasks` alias (#160) are handled here; the host entry calls
// `registerTowerCommand` from its `ctx.inject(['commands'])` effect after the
// mode state is loaded.
import { currentHmrBridge } from './capability-registry.js'
import { performTakeover } from './ownership.js'
import { assertRuntimePreconditions } from './presets.js'
import { runTasksCommand } from './tasks-command.js'
import {
  agentKey,
  describeChange,
  enterMode,
  exitMode,
  forwardInstruction,
  modeOn,
  modeState,
  openTowerFor,
  parseTowerInput,
  persistModes,
  resolveEntryWorkspace,
} from './mode-state.js'
import { recordRalphRelease } from './ralph-release.js'

export function registerTowerCommand(ctx, { config, allowAgentControl }) {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'tower',
      description:
        'Enter or leave Tower mode, optionally carrying a user instruction; /tower tasks always lists the live roster read-only (it is the alias when a host command owns the /tasks name); /tower takeover <reason> transfers repository ownership from an inactive owner; /tower reload reloads via HMR; /tower base <branch> sets the next init base',
      input: { hint: '[on|off|reload|ack|tasks|takeover <reason>|base <branch>] [message]', attachments: true },
      handler: async ({ agent, rawInput, attachments }) => {
        const key = agentKey(agent)
        if (!key) return { kind: 'error', text: 'Tower mode requires a live agent.' }
        const raw = String(rawInput ?? '').trim()
        if (/^ack$/i.test(raw)) {
          const previous = modeState.get(key) ?? { on: false }
          modeState.set(key, { ...previous, on: previous.on === true, humanAckAt: Date.now(), at: Date.now() })
          const saved = persistModes()
          if (!saved.ok) {
            return {
              kind: 'error',
              text: `Human acknowledgement recorded in memory, but the mode store could not be saved: ${saved.error ?? 'unknown error'}. It may be lost on restart.`,
            }
          }
          return { kind: 'success', text: 'Human acknowledgement recorded; the model may now make the first Tower-mode entry in this session.' }
        }
        const baseMatch = raw.match(/^base\s+(\S+)\s*$/i)
        if (baseMatch) {
          const entry = modeState.get(key)
          if (!entry || entry.on !== true) return { kind: 'error', text: 'Run /tower on first, then /tower base <branch>.' }
          entry.baseBranch = baseMatch[1]
          const saved = persistModes()
          if (!saved.ok) {
            return {
              kind: 'error',
              text: `Tower base preference set to "${entry.baseBranch}" in memory, but the mode store could not be saved: ${saved.error ?? 'unknown error'}. It may be lost on restart.`,
            }
          }
          return { kind: 'success', text: `Tower base preference set to "${entry.baseBranch}"; tower_init without an explicit base will use it.` }
        }
        const parsed = parseTowerInput(rawInput)
        if (parsed.action === 'tasks') {
          // #160: the tower-scoped alias of the read-only roster panel. It is
          // a read, never a mode transition, so it skips the preconditions and
          // the steer/persist paths below.
          return runTasksCommand(ctx, agent)
        }
        if (parsed.action === 'reload') {
          // #121: /tower reload is the tower-hmr component. The row is shipped
          // off, so the error names the component instead of an invisible key.
          const bridge = currentHmrBridge()
          if (!bridge) {
            return { kind: 'error', text: 'Tower reload is disabled by component tower-hmr; enable the tower-hmr row in the plugin page and restart DSH.' }
          }
          if (!bridge.available) {
            return { kind: 'error', text: 'Tower reload is unavailable: this DSH profile has no HMR service. Restart DSH instead.' }
          }
          const outcome = bridge.schedule()
          return {
            kind: 'success',
            text: `Tower reload scheduled in ${outcome.delayMs}ms (required entries: ${outcome.requiredIds.join(', ')}). If the new code does not appear, restart DSH.`,
          }
        }
        if (parsed.action === 'takeover') {
          if (!parsed.reason) return { kind: 'error', text: 'Usage: /tower takeover <reason>. The reason is recorded in the activity log.' }
          try {
            const tower = await openTowerFor(agent)
            const result = await performTakeover(tower, { caller: key, reason: parsed.reason })
            if (result.alreadyOwner) {
              return { kind: 'success', text: 'This session already owns this repository; no transfer was needed.' }
            }
            const previous = result.previousOwner ?? '(none)'
            return {
              kind: 'success',
              text: `Tower ownership transferred from ${previous} to ${result.owner}; ${result.unreadMessages} unread message(s) preserved. Run /tower on to start working in this session.`,
            }
          } catch (error) {
            const code = error?.code ? `[tower:${error.code}] ` : ''
            return { kind: 'error', text: `${code}${String(error?.message ?? error)}` }
          }
        }
        const { active, message } = parsed
        // #142: preconditions guard the *transition* into Tower mode, not every
        // `/tower` instruction. Re-validating on an already-active session meant a
        // row disabled later in the session (tower-hmr ships off) blocked
        // `/tower off` and ordinary forwarded text — the two commands a human
        // needs precisely when something is broken. Spawn/plan/merge keep their own
        // guards, so the capability checks still run before any real work.
        const transition = active && !modeOn(key)
        if (transition) await assertRuntimePreconditions(ctx, config)
        // #162: the workspace identity (repo root when resolvable) is resolved
        // once per transition so entry reconciliation can scope Ralph rounds
        // to this repository; a failed resolution degrades to the cwd.
        const entryWorkspace = transition ? await resolveEntryWorkspace(agent) : undefined
        const outcome = active
          ? await enterMode(ctx, key, agent, 'user', message || null, { workspace: entryWorkspace })
          : await exitMode(key, 'user', message || null)
        // D2: what Tower released is recorded in the repository's activity
        // log; the record is best-effort and never fails the mode change.
        if (active && outcome.ralphReleased) await recordRalphRelease(agent, outcome.ralphReleased)
        const persisted = outcome.persisted !== false
        let forwarded = false
        try {
          forwarded = forwardInstruction(agent, message, attachments)
        } catch (error) {
          return {
            kind: 'error',
            text: `Tower mode changed${persisted ? '' : ` in memory only (${outcome.persistError})`}, but the carried message could not be delivered: ${String(error?.message ?? error)}`,
          }
        }
        if (!persisted) {
          if (outcome.error) {
            // F33: the rollback changed nothing, so describeChange would claim
            // "Tower mode OFF" for a session that is still on. Report the real
            // failure and keep any carried instruction visible.
            const carried = forwarded ? (message ? ` Carried your instruction: ${message}` : ' Carried your attachments.') : ''
            return { kind: 'error', text: `${outcome.error.message}${carried}` }
          }
          return {
            kind: 'error',
            text: `${describeChange(active, outcome, forwarded, message, allowAgentControl)} The mode change was applied in memory but could not be persisted: ${outcome.persistError}; it may be lost on restart.`,
          }
        }
        return {
          kind: 'success',
          text: describeChange(active, outcome, forwarded, message, allowAgentControl),
        }
      },
    })
  })
}
