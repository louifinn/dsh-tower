// Explicit, audited Tower ownership transfer.
//
// Tower state is bound to one owning session (state.towerAgentId). When that
// session is gone there was no supported way to claim the repository without
// deleting .git/dsh-tower and losing the mission history. This module is the
// single decision surface for a takeover: it builds a read-only snapshot from
// state + the persisted mode store + the advisory workspace lock, refuses
// transfers that would race a live owner or live roster agent, and finally
// writes the new owner under the state lock with one activity line.
//
// Since the W1-D debt pass no caller-supplied (pre-lock) facts can authorize a
// transfer: `transferOwnership` takes a `readFacts` callback that is invoked
// only while the state lock is held, so a mode/lock/roster change between the
// approval dialog and the write is observed and refused instead of raced.
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
 * Normalize `loadModesDetailed`'s result. An unknown status fails closed: only
 * a valid store (`ok`) or a first-run store (`missing`) proves the owner's mode
 * is off; everything else is treated as corrupt, because silently reading an
 * unreadable store as "no modes" is what authorized transfers to a live owner.
 *
 * @param {{ status?: string, file?: string, error?: string } | null | undefined} modeStore
 * @returns {{ status: 'missing' | 'ok' | 'corrupt', file: string | null, error: string | null }}
 */
function modeStoreFacts(modeStore) {
  const status = typeof modeStore?.status === 'string' ? modeStore.status : 'missing'
  const known = status === 'ok' || status === 'missing'
  return {
    status: known ? status : 'corrupt',
    file: typeof modeStore?.file === 'string' && modeStore.file ? modeStore.file : null,
    error: typeof modeStore?.error === 'string' && modeStore.error ? modeStore.error : null,
  }
}

/**
 * Read-only ownership decision facts. `modes` is the fresh persisted mode map;
 * `modeStore` is `loadModesDetailed`'s result (status/file/error); `lock` is
 * `inspectWorkspaceLock`'s result; `liveRoster` is the roster view's list. No
 * I/O here, so status/doctor/tests can share the exact same rules.
 *
 * @param {{
 *   state: any,
 *   modes: Map<string, any> | null | undefined,
 *   modeStore?: { status?: string, file?: string, error?: string } | null,
 *   caller: string | null,
 *   lock: any,
 *   liveRoster?: any[],
 * }} input
 */
export function ownershipSnapshot({ state, modes, modeStore = null, caller, lock, liveRoster = [] }) {
  const owner = state?.towerAgentId ? String(state.towerAgentId) : null
  const callerId = caller ? String(caller) : null
  const sameOwner = owner !== null && owner === callerId
  const store = modeStoreFacts(modeStore)
  const modeStoreStatus = store.status
  // A corrupt store cannot say whether the owner's mode is on; `unknown` is
  // deliberately not `off`, so no human-facing line claims the owner is gone.
  const ownerMode = !owner
    ? 'missing'
    : modeStoreStatus === 'corrupt'
      ? 'unknown'
      : modes?.get(owner)?.on === true
        ? 'on'
        : 'off'
  const ownerLock = ownerLocked(lock, owner)
  const foreignLock = Boolean(lock?.held && !ownerLock && !lock?.self)
  const live = (liveRoster ?? []).filter((entry) => !ROSTER_INACTIVE_STATES.includes(entry.state))
  const liveNames = live.map((entry) => String(entry.name ?? entry.agentId ?? 'unknown'))
  const blockers = []

  // Fail closed before every other ownership rule: a corrupt mode store means
  // the owner's mode is unknown, so `ownerMode === 'off'` would be a guess.
  if (modeStoreStatus === 'corrupt') {
    const where = store.file ? ` at ${store.file}` : ''
    const why = store.error ? `: ${store.error}` : ''
    blockers.push({
      code: 'mode-store-corrupt',
      detail:
        `the persisted Tower mode store${where} is unreadable or corrupt${why}; ownership cannot be decided because the current owner's Tower mode is unknown. ` +
        'Back up and repair the file, or move it aside and re-enter Tower mode in the owning session, then retry the takeover',
      action: `repair or move aside the mode store${where}, then retry the takeover with the owning session identified`,
    })
  }
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
    modeStoreStatus,
    modeStoreFile: store.file,
    modeStoreError: modeStoreStatus === 'corrupt' ? store.error : null,
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
  if (!blocker) return
  throw new TowerToolError(blocker.code, blocker.detail, {
    retryable: false,
    ...(blocker.action ? { nextAction: blocker.action } : {}),
    details: { blockers: snapshot.blockers.map((item) => ({ code: item.code, detail: item.detail })) },
  })
}

/**
 * Transfer ownership under the state lock. The caller's approval (model path)
 * or the human command is the authorization; this function only enforces the
 * mechanical preconditions and records the audit line.
 *
 * `readFacts` is the only source of modes/lock/roster and is called while the
 * state lock is held. There is no argument for pre-read facts on purpose: the
 * approval dialog's snapshot may be stale by the time the write happens, and a
 * stale "owner is off" fact must not authorize a transfer.
 *
 * @param {any} tower
 * @param {{
 *   caller: string,
 *   reason: string,
 *   readFacts: () => Promise<{
 *     modes?: Map<string, any>,
 *     modeStore?: { status?: string, file?: string, error?: string } | null,
 *     lock?: any,
 *     liveRoster?: any[],
 *   }>,
 * }} input
 */
export async function transferOwnership(tower, { caller, reason, readFacts }) {
  if (!caller) {
    throw new TowerToolError('invalid-argument', 'ownership transfer needs a non-empty caller')
  }
  if (typeof readFacts !== 'function') {
    throw new TowerToolError(
      'invalid-argument',
      'ownership transfer requires readFacts so modes/lock/roster are read under the state lock',
    )
  }
  return tower.deps.store.withLock(tower.paths, async (_paths, held) => {
    const state = await tower.load()
    const facts = (await readFacts()) ?? {}
    const snapshot = ownershipSnapshot({
      state,
      modes: facts.modes,
      modeStore: facts.modeStore ?? null,
      caller,
      lock: facts.lock,
      liveRoster: facts.liveRoster ?? [],
    })
    const factsReport = {
      ownerMode: snapshot.ownerMode,
      modeStoreStatus: snapshot.modeStoreStatus,
      orphanLock: snapshot.orphanLock,
    }
    // Same-owner is a no-op before the blockers: nothing is transferred, so a
    // live roster or a corrupt mode store must not turn an idempotent retry
    // into an error.
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
        ...factsReport,
      }
    }
    if (snapshot.blockers.length > 0) assertTransferAllowed(snapshot)
    const previousOwner = snapshot.owner
    const now = Date.now()
    state.towerAgentId = String(caller)
    state.revision += 1
    state.updatedAt = now
    validateState(state, tower.paths.state)
    await tower.writeState(state, held)
    await tower.appendActivity({
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
      ...factsReport,
    }
  })
}
