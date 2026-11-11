// tower_mode / tower_control handler bodies (W5-A).
//
// The two tools are registered directly by the Host entry (not through
// `define()`), so their definitions and their authorize-first call stay in
// `index.js`: the authorization matrix test and the docs surface scan read the
// composition entry. This module owns only the post-authorization bodies, which
// keeps index.js as Cordis apply/effect glue. No schema, output field, or error
// shape changed.
import { runtimeConfig } from './config.js'
import { TowerToolError } from '../domain/errors.js'
import { readOwnership, performTakeover } from './ownership.js'
import { takeoverQuestionDetail } from '../app/ownership.js'
import { assertRuntimePreconditions } from './presets.js'
import { storePath } from './modeStore.js'
import { currentHmrBridge } from './capability-registry.js'
import {
  agentKey,
  deniedToolNames,
  enterMode,
  exitMode,
  modeOn,
  modeState,
  modeStoreView,
  openTowerFor,
  planModeState,
} from './mode-state.js'

/** Body of `tower_mode`; the caller has already authorized the call. */
export async function runTowerMode(ctx, exec, { config, allowAgentControl, workspace, pluginVersion }) {
  const key = agentKey(exec.agent)
  const entry = key ? modeState.get(key) : undefined
  return {
    mode: entry && entry.on === true ? 'on' : key ? 'off' : 'unknown',
    agentId: key,
    allowAgentControl,
    lastChange: entry?.lastChange ?? null,
    lastDisclosure: entry?.lastDisclosure ?? null,
    pausedGoal: entry?.pausedGoal ?? null,
    deniedWhileActive: deniedToolNames(),
    persistedAt: storePath(config.mode.storePath || undefined),
    modeStore: modeStoreView(),
    pluginVersion,
    hotReload: (() => {
      // #121/#122: the tower-hmr component row owns the bridge. When the
      // row is off the capability is reported, never silently absent.
      const bridge = currentHmrBridge()
      return bridge ? bridge.status() : { available: false, disabled: true, component: 'tower-hmr' }
    })(),
    planMode: (() => {
      const state = planModeState(ctx, exec.agent)
      return { available: state.available, active: state.active, pending: state.pending }
    })(),
    baseBranch: entry?.baseBranch ?? null,
    workspaceLock: entry
      ? await workspace.status(entry, key)
      : { enabled: config.mode.workspaceLock === true, held: false },
  }
}

/** Body of `tower_control`; the caller has already authorized the call. */
export async function runTowerControl(ctx, args, exec, { config }) {
  const key = agentKey(exec.agent)
  if (!key) return { ok: false, error: 'tower_control requires a live calling agent' }
  if (typeof args.reason !== 'string' || args.reason.trim().length === 0) {
    throw new TowerToolError('invalid-argument', 'tower_control requires a non-empty reason')
  }
  const reason = args.reason.trim()
  if (args.action === 'takeover') {
    if (!modeOn(key)) {
      throw new TowerToolError('invalid-transition', 'takeover requires this session to be in Tower mode; run /tower on first')
    }
    const tower = await openTowerFor(exec.agent)
    const facts = await readOwnership(tower, { caller: key })
    if (facts.snapshot.sameOwner) {
      return {
        ok: true,
        action: 'takeover',
        approved: true,
        transferred: false,
        alreadyOwner: true,
        owner: key,
        previousOwner: null,
        unreadMessages: facts.snapshot.unreadMessages,
        reason,
        mode: 'on',
      }
    }
    const blocker = facts.snapshot.blockers[0]
    if (blocker) throw new TowerToolError(blocker.code, blocker.detail)
    const questions = ctx.get('userQuestions')
    if (!questions || typeof questions.ask !== 'function') {
      throw new TowerToolError(
        'approval-unavailable',
        'ownership transfer needs the DSH userQuestions service, which this profile does not expose',
      )
    }
    let answer
    try {
      answer = await questions.ask({
        agent: exec.agent,
        signal: exec.signal,
        questions: [
          {
            id: 'tower-ownership',
            header: 'Tower ownership',
            question: 'Transfer Tower ownership to this session?',
            detail: takeoverQuestionDetail(facts.snapshot, reason),
            options: [
              { label: 'Transfer ownership', description: 'Make this session the Tower owner; history and unread messages are kept.' },
              { label: 'Keep current owner', description: 'Leave ownership unchanged.' },
            ],
          },
        ],
      })
    } catch (error) {
      const code = error?.cause?.code ?? error?.code
      if (code === 'ASK_CANCELLED') {
        exec.concludeTurn?.()
        return { ok: true, action: 'takeover', approved: false, cancelled: true, reason, mode: 'on' }
      }
      throw error
    }
    const list = Array.isArray(answer?.answers) ? answer.answers : Array.isArray(answer) ? answer : []
    const choice = list.find((item) => item?.id === 'tower-ownership')
    const selected = Array.isArray(choice?.selected) ? choice.selected : []
    const approved = selected.length === 1 && selected[0] === 'Transfer ownership' && !choice?.custom
    if (!approved) {
      return { ok: true, action: 'takeover', approved: false, transferred: false, reason, mode: 'on', selected }
    }
    const result = await performTakeover(tower, { caller: key, reason })
    return {
      ...result,
      ok: true,
      action: 'takeover',
      approved: true,
      changedBy: 'agent',
      reason,
      mode: modeOn(key) ? 'on' : 'off',
    }
  }
  if (args.action === 'enter' && !modeOn(key)) {
    await assertRuntimePreconditions(ctx, config)
  }
  const outcome =
    args.action === 'enter'
      ? (() => {
          if (!modeOn(key) && runtimeConfig().mode.requireHumanAckOnFirstEntry === true && !modeState.get(key)?.humanAckAt) {
            throw new TowerToolError('not-authorized', 'this profile requires a human acknowledgement; run /tower ack first')
          }
          return enterMode(ctx, key, exec.agent, 'agent', reason)
        })()
      : await exitMode(key, 'agent', reason)
  const persisted = outcome.persisted !== false
  return {
    ok: persisted,
    action: args.action,
    mode: modeOn(key) ? 'on' : 'off',
    changed: outcome.changed ?? (args.action === 'enter' ? !outcome.wasOn : outcome.wasOn),
    changedBy: 'agent',
    reason,
    pausedGoal: outcome.pausedGoal ?? null,
    goalNote: outcome.goalNote ?? null,
    persisted,
    ...(persisted
      ? {}
      : {
          error: outcome.error?.message ?? outcome.persistError ?? 'the mode store could not be saved',
          ...(outcome.error?.code ? { errorCode: outcome.error.code } : {}),
        }),
  }
}
