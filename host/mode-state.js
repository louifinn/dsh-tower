// Tower mode state and transitions (W5-A).
//
// Owns the per-agent mode entries, the persisted mode-store view, the deny list,
// and the transitions the `/tower` command, `tower_control`, and the host
// effects share. `index.js` builds the Cordis workspace hook from
// `createWorkspaceHook()`; `host/mode-command.js` owns the `/tower` command and
// `host/session-tools.js` owns the two tool handler bodies. Behavior, output
// shapes and state keys are unchanged from the single-file host entry.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { loadModesDetailed, saveModesDetailed, storePath } from './modeStore.js'
import { ModeState } from './modeState.js'
import { DEFAULT_DENY_TOOLS, runtimeConfig } from './config.js'
import { TowerToolError } from '../domain/errors.js'
import { resolveRepo } from '../adapters/git.js'
import { fsp } from '../adapters/store-fs.js'
import { Tower } from './tower.js'
import { createDefaultDeps } from '../adapters/default.js'
import {
  acquireWorkspaceLock,
  inspectWorkspaceLock,
  releaseWorkspaceLock,
  workspaceLockToken,
} from '../adapters/workspaceLock.js'

export const modeState = new ModeState()
/** @type {{ status: 'missing'|'ok'|'corrupt', file: string|null, error: string|null }} */
export let modeStoreLoad = { status: 'missing', file: null, error: null }
let denyTools = new Set(DEFAULT_DENY_TOOLS)

/** The mode-store view reported by tower_mode (read-only copy for callers). */
export function modeStoreView() {
  return { ...modeStoreLoad }
}

export function setDenyTools(names) {
  denyTools = new Set(names)
}

export function deniedToolNames() {
  return [...denyTools]
}

export function isDeniedTool(name) {
  return denyTools.has(name)
}

const READ_ONLY_TOOL_NAMES = new Set([
  'tower_status',
  'tower_roster',
  'tower_diff',
  'tower_preflight',
  'tower_doctor',
])

const BASE_REMINDER = [
  'Tower mode is active for this session. You are the control tower: plan missions, spawn workers and reviewers, and integrate only through the Tower tools.',
  'Mission tracking lives in tower_plan / tower_mission / tower_status, not todo_write or the Team task board.',
  'Do not create or resume goals, do not spawn teammates, and never merge without a green tower_preflight.',
  'Tower mode changes are explicit and recorded; the user can always use /tower on|off.',
].join(' ')

const AGENT_CONTROL_NOTE =
  'You may also enter or leave Tower mode with tower_control when the user intent or task state clearly calls for it; always state a concrete reason.'

export function modeOn(key) {
  const entry = key ? modeState.get(key) : undefined
  return Boolean(entry && entry.on === true)
}

/**
 * Load the persisted mode store into the live state. Returns the detailed load
 * result so `apply()` can warn on a corrupt store and report it in tower_mode.
 */
export function loadModes(config) {
  const loadedModes = loadModesDetailed(config.mode.storePath || undefined)
  modeState.replace(loadedModes.modes)
  modeStoreLoad = {
    status: loadedModes.status,
    file: loadedModes.file,
    error: loadedModes.error ?? null,
  }
  return loadedModes
}

export function agentKey(agent) {
  if (!agent) return null
  const key = agent.id ?? agent.session
  return key === undefined || key === null ? null : String(key)
}

/** The session's working directory; DSH keeps it in the session header. */
export function agentCwd(agent) {
  return agent?.session?.header?.cwd ?? agent?.cwd ?? null
}

export async function openTowerFor(agent) {
  const cwd = agentCwd(agent)
  if (!cwd) throw new TowerToolError('invalid-argument', 'this command needs a session with a working directory')
  return Tower.open(cwd, createDefaultDeps())
}

export function configSection(config, allowAgentControl) {
  const configured = config.mode.promptSection && config.mode.promptSection.trim().length > 0
    ? config.mode.promptSection
    : BASE_REMINDER
  const appended = config.mode.sectionAppend && config.mode.sectionAppend.trim().length > 0
    ? ` ${config.mode.sectionAppend.trim()}`
    : ''
  const control = allowAgentControl ? ` ${AGENT_CONTROL_NOTE}` : ''
  return `${configured}${appended}${control}`
}

export function persistModes() {
  const config = runtimeConfig()
  return saveModesDetailed(modeState, config.mode.storePath || undefined, config.mode.maxEntries, {
    timeoutMs: config.mode.lockTimeoutMs,
  })
}

/** Parse `/tower` arguments: bare and free text both mean "ensure on". */
export function parseTowerInput(rawInput) {
  const raw = String(rawInput ?? '').trim()
  const takeover = /^takeover(?:\s+([\s\S]+))?$/i.exec(raw)
  if (takeover) return { action: 'takeover', reason: (takeover[1] ?? '').trim() }
  if (/^reload$/i.test(raw)) return { action: 'reload' }
  // #160: the read-only roster panel rides the tower-scoped alias so it stays
  // reachable even when the host profile owns the `/tasks` name.
  if (/^tasks$/i.test(raw)) return { action: 'tasks' }
  const match = /^(on|off)(?:\s+([\s\S]*))?$/i.exec(raw)
  if (match) return { action: 'mode', active: match[1].toLowerCase() === 'on', message: (match[2] ?? '').trim() }
  return { action: 'mode', active: true, message: raw }
}

/**
 * Pause an active goal through the goals service when Tower mode starts.
 * DSH exposes `ctx.goals.get/pause`, so no projection guesswork is needed.
 */
export function pauseActiveGoal(ctx, agent) {
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

export function planModeState(ctx, agent) {
  const service = ctx.get?.('planMode')
  if (!service || !agent) return { available: false, active: false, pending: false, service: null }
  try {
    const state = service.get(agent) ?? {}
    return { available: true, active: state.active === true, pending: state.pending === true, service }
  } catch {
    return { available: false, active: false, pending: false, service: null }
  }
}

/** Tower and plan mode are mutually exclusive; clearing is the default policy. */
export function clearPlanModeForTower(ctx, agent) {
  const state = planModeState(ctx, agent)
  if (!state.available || (!state.active && !state.pending)) {
    return { attempted: state.available, cleared: false, refused: false, result: null }
  }
  if (runtimeConfig().mode.planModePolicy === 'refuse') {
    return { attempted: true, cleared: false, refused: true, result: null }
  }
  try {
    const result = state.service.set(agent, false)
    return { attempted: true, cleared: true, refused: false, result }
  } catch (error) {
    return { attempted: true, cleared: false, refused: false, error: String(error?.message ?? error) }
  }
}

/**
 * #161 D3: reconcile the session's Agent Team stance before Tower mode turns
 * on. An active team is left: the roster is snapshotted, running teammates are
 * suspended (an interrupt keeps their pending inbox, so nothing is lost),
 * the released roster is written to the repository activity log, and the mode
 * entry records it so `tower_mode` / `tower_status` report the new state.
 * Nothing is ever resumed on `/tower off` — the exit response names what was
 * released and a person decides.
 *
 * Only the Team Lead may suspend members (the service enforces it), so a
 * teammate entering Tower mode records the roster and a note instead; the deny
 * guard still blocks every team tool for the workspace while Tower mode is on.
 *
 * @param {any} ctx
 * @param {any} agent
 * @returns {Promise<{ attempted: boolean, ok?: boolean, reason?: string, released?: any, note?: string | null }>}
 */
export async function reconcileAgentTeam(ctx, agent) {
  const teams = typeof ctx?.get === 'function' ? ctx.get('agentTeams') : null
  if (!teams || typeof teams.tryMembership !== 'function' || !agent) {
    return { attempted: false, reason: 'no agentTeams service' }
  }
  let membership
  try {
    membership = teams.tryMembership(agent)
  } catch {
    membership = undefined
  }
  if (!membership) return { attempted: false, reason: 'no active team' }
  const role = membership.role === 'lead' ? 'lead' : 'teammate'
  let rows = []
  try {
    rows = typeof teams.listMembers === 'function' ? teams.listMembers(agent) : []
  } catch (error) {
    return { attempted: true, ok: false, reason: `the team roster could not be read: ${String(error?.message ?? error)}` }
  }
  const members = rows
    .filter((member) => member && typeof member === 'object')
    .map((member) => ({
      name: String(member.name ?? member.id ?? 'unknown'),
      role: member.role === 'lead' ? 'lead' : 'teammate',
      status: String(member.status ?? 'unknown'),
    }))
  const suspended = []
  const failed = []
  if (role === 'lead' && typeof teams.interrupt === 'function') {
    for (const member of members) {
      if (member.role !== 'teammate' || member.status !== 'running') continue
      try {
        teams.interrupt(agent, member.name)
        suspended.push(member.name)
      } catch (error) {
        failed.push({ name: member.name, error: String(error?.message ?? error) })
      }
    }
  }
  const released = { role, members, suspended, failed, at: Date.now() }
  // The roster release is part of the repository's activity trail; a
  // repository Tower cannot open (no repo yet) keeps the in-memory record.
  // The state directory may not exist before tower_init, so it is created the
  // same way the workspace lock creates <common-dir>/dsh-tower.
  let activityNote = null
  try {
    const tower = await openTowerFor(agent)
    await fsp.mkdir(path.dirname(tower.paths.activity), { recursive: true })
    await tower.appendActivity({
      at: released.at,
      type: 'mode',
      text: [
        `tower mode entry left the active agent team (role ${role})`,
        `members: ${members.map((member) => `${member.name}=${member.status}`).join(', ') || '(none)'}`,
        suspended.length > 0 ? `suspended: ${suspended.join(', ')}` : null,
        failed.length > 0 ? `suspend-failed: ${failed.map((entry) => entry.name).join(', ')}` : null,
      ]
        .filter(Boolean)
        .join(' — '),
    })
  } catch (error) {
    activityNote = `activity log not written: ${String(error?.message ?? error)}`
  }
  return {
    attempted: true,
    ok: failed.length === 0,
    reason: failed.length > 0 ? `suspending ${failed.map((entry) => entry.name).join(', ')} failed` : undefined,
    released,
    note: [role !== 'lead' ? 'only the Team Lead can suspend members' : null, activityNote]
      .filter(Boolean)
      .join('; ') || null,
  }
}

export async function enterMode(ctx, key, agent, by, reason) {
  const previous = modeState.get(key)
  const wasOn = Boolean(previous && previous.on)
  const plan = clearPlanModeForTower(ctx, agent)
  if (plan.refused) {
    throw new TowerToolError(
      'invalid-transition',
      'plan mode is active and mode.planModePolicy is "refuse"; exit plan mode before entering Tower',
    )
  }
  const autoPauseGoal = runtimeConfig().mode.autoPauseGoal !== false
  let pausedGoal = previous?.pausedGoal ?? null
  let goalNote = null
  if (!wasOn && autoPauseGoal) {
    const paused = pauseActiveGoal(ctx, agent)
    if (paused.attempted && paused.ok) pausedGoal = paused.goal
    else if (paused.attempted && !paused.ok) goalNote = `pause-failed: ${paused.reason}`
    else if (paused.reason && paused.reason !== 'no goal' && paused.reason !== 'no goals service') {
      goalNote = paused.reason
    }
  }
  // #161 D3: an active Agent Team is left before Tower mode reports active.
  // A partial suspend still records the roster it did release; only a failed
  // roster read leaves nothing to record (the note says so instead).
  let releasedTeam = previous?.releasedTeam ?? null
  let teamNote = null
  if (!wasOn) {
    const team = await reconcileAgentTeam(ctx, agent)
    if (team.attempted && team.released) releasedTeam = team.released
    if (team.attempted && !team.ok) teamNote = `team-reconcile-failed: ${team.reason}`
    if (team.attempted && team.note) teamNote = teamNote ? `${teamNote}; ${team.note}` : team.note
  }
  const now = Date.now()
  modeState.set(key, {
    on: true,
    pausedGoal,
    releasedTeam,
    lock: previous?.lock ?? null,
    baseBranch: previous?.baseBranch ?? null,
    planModeCleared: plan.cleared,
    humanAckAt: by === 'user' ? previous?.humanAckAt ?? now : previous?.humanAckAt ?? null,
    lastDisclosure: previous?.lastDisclosure ?? 'full',
    lastChange: { by, action: 'on', reason: reason ?? null, at: now },
    at: now,
  })
  const saved = persistModes()
  return {
    wasOn,
    pausedGoal,
    releasedTeam: wasOn ? null : releasedTeam,
    goalNote,
    teamNote,
    planModeCleared: plan.cleared,
    planModeResult: plan.result ?? null,
    changed: !wasOn,
    mode: 'on',
    persisted: saved.ok === true,
    persistError: saved.ok === true ? null : saved.error ?? 'the mode store could not be saved',
  }
}

export async function exitMode(key, by, reason) {
  const previous = modeState.get(key)
  if (!previous) {
    return {
      wasOn: false,
      pausedGoal: null,
      releasedTeam: null,
      goalNote: null,
      by,
      reason: reason ?? null,
      changed: false,
      mode: 'off',
      persisted: true,
      persistError: null,
      error: null,
    }
  }
  const wasOn = previous.on === true
  // Keep a timestamped off tombstone so a concurrent save from another
  // session cannot resurrect this mode entry.
  modeState.set(key, { on: false, at: Date.now(), humanAckAt: previous.humanAckAt ?? null, lastDisclosure: previous.lastDisclosure ?? 'exit' })
  const saved = persistModes()
  if (!saved.ok) {
    // F33: a failed off is not an off. Restore the previous entry so memory
    // matches the last persisted state, keep the workspace lock (its token was
    // only observed in memory), and report an actionable failure. The disk
    // copy was never written, so releasing the lock here would strand it.
    modeState.set(key, previous)
    const saveError = saved.error ?? 'the mode store could not be saved'
    // The nested save error can carry its own `— next:` action (for example
    // state-corrupt); drop it so renderErrorMessage appends the mode code's
    // recovery action instead of hiding it.
    const detail = String(saveError).split(' — next:')[0]
    const lockNote = previous.lock ? '; the previous workspace lock was kept' : ''
    const error = new TowerToolError(
      'mode-persist-failed',
      `Tower mode remains ${wasOn ? 'ON' : 'OFF'} because the mode store could not be saved: ${detail}${lockNote}`,
      { details: { operation: 'off', saveError: String(saveError) } },
    )
    return {
      wasOn,
      pausedGoal: previous.pausedGoal ?? null,
      releasedTeam: previous.releasedTeam ?? null,
      goalNote: null,
      by,
      reason: reason ?? null,
      changed: false,
      mode: wasOn ? 'on' : 'off',
      persisted: false,
      persistError: saveError,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        nextAction: error.nextAction,
      },
    }
  }
  // Only a persisted off may release the workspace lock: the token came from
  // the entry that was just written to disk.
  if (previous.lock) {
    await releaseWorkspaceLock(previous.lock.commonDir, { token: previous.lock.token }).catch(() => {})
  }
  return {
    wasOn,
    pausedGoal: previous.pausedGoal ?? null,
    releasedTeam: previous.releasedTeam ?? null,
    goalNote: null,
    by,
    reason: reason ?? null,
    changed: wasOn,
    mode: 'off',
    persisted: true,
    persistError: null,
    error: null,
  }
}

export function forwardInstruction(agent, message, attachments) {
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

export function describeChange(active, outcome, forwarded, message, allowAgentControl) {
  const lines = []
  if (active) {
    lines.push(outcome.wasOn ? 'Tower mode remains on.' : 'Tower mode ON. Use the Tower tools; goal, todo, and Team delegation tools are disabled.')
  } else {
    lines.push(outcome.wasOn ? 'Tower mode OFF. Normal collaboration tools are available again.' : 'Tower mode is already off.')
  }
  if (outcome.pausedGoal) {
    lines.push(`A goal was paused on entry ("${outcome.pausedGoal.objective ?? outcome.pausedGoal.id}"); resume it yourself when ready.`)
  }
  // #161 D3: leaving Tower mode never resurrects the team that was left on
  // entry — the release is named so a person decides what to restart.
  const released = outcome.releasedTeam ?? null
  if (released && Array.isArray(released.members)) {
    const names = released.members.map((member) => member.name).join(', ')
    const suspended = Array.isArray(released.suspended) && released.suspended.length > 0 ? ` (suspended: ${released.suspended.join(', ')})` : ''
    lines.push(
      active
        ? `An Agent Team was left on entry (role ${released.role}; members: ${names || 'none'}${suspended}); the roster is in the activity log and nothing is resumed automatically.`
        : `The Agent Team left on Tower entry (members: ${names || 'none'}${suspended}) was not resumed; restart it yourself if you still want it.`,
    )
  }
  if (outcome.goalNote) lines.push(`Goal handling: ${outcome.goalNote}`)
  if (outcome.teamNote) lines.push(`Team handling: ${outcome.teamNote}`)
  if (forwarded) lines.push(message ? `Carried your instruction: ${message}` : 'Carried your attachments.')
  if (!allowAgentControl) lines.push('Only the human can change Tower mode.')
  return lines.join(' ')
}

/** Release every advisory workspace lock this process still holds (dispose). */
export function releaseOwnedLocks() {
  for (const entry of modeState.values()) {
    if (entry?.lock) {
      releaseWorkspaceLock(entry.lock.commonDir, { token: entry.lock.token }).catch(() => {})
    }
  }
}

/**
 * The workspace adapter the tool layer receives. It is the same object shape the
 * host entry built before the split: ensure/status/basePreference/modeInfo.
 */
export function createWorkspaceHook() {
  return {
    /** Lazily acquire the advisory workspace lock on the first repo-scoped tool. */
    async ensure(repoRoot, exec, toolName) {
      if (runtimeConfig().mode.workspaceLock !== true) return
      if (runtimeConfig().mode.workspaceLockScope === 'mutations' && READ_ONLY_TOOL_NAMES.has(toolName)) return
      const key = agentKey(exec?.agent)
      if (!key) return
      const entry = modeState.get(key)
      if (!entry || entry.on !== true) return
      const repo = await resolveRepo(repoRoot)
      const existing = entry.lock
      if (existing && existing.commonDir !== repo.commonDir) {
        throw new TowerToolError(
          'workspace-busy',
          `this Tower session already owns ${existing.commonDir}; /tower off before switching repositories`,
        )
      }
      const result = await acquireWorkspaceLock(repo.commonDir, {
        token: existing?.token ?? workspaceLockToken(),
        sessionId: key,
        agentId: key,
        staleMs: Number(runtimeConfig().mode.workspaceStaleMs) || 300000,
      })
      if (!result.acquired) {
        const holder = result.holder
          ? `session ${String(result.holder.sessionId).slice(0, 12)} (since ${
              Number.isFinite(Number(result.holder.at))
                ? new Date(Number(result.holder.at)).toISOString()
                : 'unknown'
            })`
          : 'an unreadable lock'
        throw new TowerToolError(
          'workspace-busy',
          `workspace ${repo.root} is locked by ${holder}; another Tower session must /tower off or set mode.workspaceLock:false`,
        )
      }
      entry.lock = { token: result.record.token, commonDir: repo.commonDir }
      const saved = persistModes()
      if (!saved.ok) {
        throw new Error(
          `workspace lock for ${repo.root} was acquired, but the mode store could not be saved: ${saved.error ?? 'unknown error'}`,
        )
      }
    },
    async status(entry, key) {
      if (!entry?.lock) return { enabled: runtimeConfig().mode.workspaceLock === true, held: false }
      const info = await inspectWorkspaceLock(entry.lock.commonDir, {
        sessionId: key ?? null,
        staleMs: Number(runtimeConfig().mode.workspaceStaleMs) || 300000,
      }).catch(() => null)
      return {
        enabled: runtimeConfig().mode.workspaceLock === true,
        held: info?.held === true,
        commonDir: entry.lock.commonDir,
        self: info?.self === true,
        stale: info?.stale === true || info === null,
        holder: info?.holder ?? null,
      }
    },
    basePreference(exec) {
      const key = agentKey(exec?.agent)
      return key && modeOn(key) ? modeState.get(key)?.baseBranch ?? null : null
    },
    modeInfo(exec) {
      const key = agentKey(exec?.agent)
      if (!key) return null
      const entry = modeState.get(key)
      const history = [...modeState.values()]
        .map((value) => value?.lastChange)
        .filter((change) => change && typeof change.at === 'number')
        .sort((a, b) => b.at - a.at)
        .slice(0, 10)
      return {
        mode: modeOn(key) ? 'on' : entry ? 'off' : 'unknown',
        allowAgentControl: runtimeConfig().mode.allowAgentControl === true,
        lastChange: entry?.lastChange ?? null,
        history,
        pausedGoal: entry?.pausedGoal ?? null,
        releasedTeam: entry?.releasedTeam ?? null,
        workspaceLock: entry?.lock
          ? { enabled: runtimeConfig().mode.workspaceLock === true, commonDir: entry.lock.commonDir }
          : null,
      }
    },
  }
}
