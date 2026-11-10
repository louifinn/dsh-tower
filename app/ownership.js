// Explicit, audited Tower ownership transfer.
//
// Tower state is bound to one owning session (state.towerAgentId). When that
// session is gone there was no supported way to claim the repository without
// deleting .git/dsh-tower and losing the mission history. This module is the
// single decision surface for a takeover: it builds a read-only snapshot from
// state + the persisted mode store + the advisory workspace lock, refuses
// transfers that would race a live owner or live roster agent, and finally
// writes the new owner under the state lock with one activity line.
import { TowerToolError } from '../domain/errors.js'
import { validateState } from '../domain/state.js'
import { unreadMessages } from '../domain/collab/messages.js'
import { ROSTER_INACTIVE_STATES } from '../domain/roster.js'
import { takeoverActivityText } from '../domain/integration/init.js'

/**
 * @param {any} lock
 * @param {string | null} owner
 */
function ownerLocked(lock, owner) {
  if (!lock?.held || !owner) return false
  const holder = lock.holder ?? {}
  return String(holder.agentId ?? '') === owner || String(holder.sessionId ?? '') === owner
}

/**
 * Read-only ownership decision facts. `modes` is the fresh persisted mode map;
 * `lock` is `inspectWorkspaceLock`'s result; `liveRoster` is the roster view's
 * list. No I/O here, so status/doctor/tests can share the exact same rules.
 *
 * @param {{
 *   state: any,
 *   modes: Map<string, any>,
 *   caller: string | null,
 *   lock: any,
 *   liveRoster?: any[],
 * }} input
 */
export function ownershipSnapshot({ state, modes, caller, lock, liveRoster = [] }) {
  const owner = state?.towerAgentId ? String(state.towerAgentId) : null
  const callerId = caller ? String(caller) : null
  const sameOwner = owner !== null && owner === callerId
  const ownerMode = owner ? (modes?.get(owner)?.on === true ? 'on' : 'off') : 'missing'
  const ownerLock = ownerLocked(lock, owner)
  const foreignLock = Boolean(lock?.held && !ownerLock && !lock?.self)
  const live = (liveRoster ?? []).filter((entry) => !ROSTER_INACTIVE_STATES.includes(entry.state))
  const liveNames = live.map((entry) => String(entry.name ?? entry.agentId ?? 'unknown'))
  const blockers = []

  if (live.length > 0) {
    blockers.push({
      code: 'owner-busy',
      detail: `live roster ${live.length === 1 ? 'agent' : 'agents'} still running: ${liveNames.join(', ')}`,
    })
  }
  if (foreignLock) {
    const holder = lock?.holder ?? {}
    blockers.push({
      code: 'owner-busy',
      detail: `workspace lock is held by ${holder.sessionId ?? holder.agentId ?? 'another session'}`,
    })
  }
  if (owner && !sameOwner && ownerMode === 'on' && !(ownerLock && lock?.stale)) {
    blockers.push({
      code: 'owner-live',
      detail: `current owner ${owner} still has Tower mode on${ownerLock ? ' with a live workspace lock' : ''}`,
    })
  }

  return {
    owner,
    caller: callerId,
    sameOwner,
    ownerMode,
    ownerLock,
    foreignLock,
    liveRoster: liveNames,
    unreadMessages: unreadMessages(state, 'tower').length,
    orphanLock: Boolean(ownerLock && !lock?.self && (ownerMode !== 'on' || lock?.stale)),
    blockers,
    takeoverAvailable: !sameOwner && blockers.length === 0,
  }
}

/**
 * Markdown shown to the human before a model-initiated transfer.
 * @param {ReturnType<typeof ownershipSnapshot>} snapshot
 * @param {string} reason
 */
export function takeoverQuestionDetail(snapshot, reason) {
  const lock = snapshot.ownerLock
    ? snapshot.orphanLock
      ? 'held by the previous owner, but stale or from a Tower mode that is off'
      : 'held by the previous owner'
    : snapshot.foreignLock
      ? 'held by another session'
      : 'free'
  return [
    '## Tower ownership transfer',
    '',
    `- Current owner: ${snapshot.owner ?? '(none)'}`,
    `- Requested by: ${snapshot.caller ?? '(unknown)'}`,
    `- Reason: ${reason}`,
    `- Previous Tower mode: ${snapshot.ownerMode}`,
    `- Workspace lock: ${lock}`,
    `- Live roster agents: ${snapshot.liveRoster.length === 0 ? 'none' : snapshot.liveRoster.join(', ')}`,
    `- Unread messages preserved: ${snapshot.unreadMessages}`,
    '',
    'Transferring ownership keeps the full mission history. It does not enter or leave Tower mode for either session.',
  ].join('\n')
}

function assertTransferAllowed(snapshot) {
  const blocker = snapshot.blockers[0]
  if (blocker) throw new TowerToolError(blocker.code, blocker.detail)
}

/**
 * Transfer ownership under the state lock. The caller's approval (model path)
 * or the human command is the authorization; this function only enforces the
 * mechanical preconditions and records the audit line.
 *
 * @param {any} tower
 * @param {{
 *   caller: string,
 *   reason: string,
 *   modes: Map<string, any>,
 *   lock: any,
 *   liveRoster?: any[],
 * }} input
 */
export async function transferOwnership(tower, { caller, reason, modes, lock, liveRoster = [] }) {
  return tower.deps.store.withLock(tower.paths, async (_paths, held) => {
    const state = await tower.load()
    const snapshot = ownershipSnapshot({ state, modes, caller, lock, liveRoster })
    if (snapshot.blockers.length > 0) assertTransferAllowed(snapshot)
    if (snapshot.sameOwner) {
      return {
        ok: true,
        transferred: false,
        alreadyOwner: true,
        owner: snapshot.owner,
        previousOwner: null,
        revision: state.revision,
        unreadMessages: snapshot.unreadMessages,
        liveRoster: snapshot.liveRoster,
      }
    }
    const previousOwner = snapshot.owner
    const now = Date.now()
    state.towerAgentId = String(caller)
    state.revision += 1
    state.updatedAt = now
    validateState(state, tower.paths.state)
    await tower.writeState(state, held)
    await tower.deps.store.appendJsonl(tower.paths.activity, {
      at: now,
      type: 'takeover',
      text: takeoverActivityText({ from: previousOwner, to: String(caller), reason }),
    })
    return {
      ok: true,
      transferred: true,
      alreadyOwner: false,
      owner: String(caller),
      previousOwner,
      revision: state.revision,
      unreadMessages: snapshot.unreadMessages,
      liveRoster: snapshot.liveRoster,
    }
  })
}
