// Pure rebase decisions: the prepared snapshot, durable-intent classification,
// replay/conflict outcomes, and the strings recorded for reconciliation.
// Git reads/writes and persistence stay in app/rebase.js.
// @ts-check

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').RosterEntry} RosterEntry */

export const STALE_PREPARE = 'tower state changed while the rebase was being prepared; retry'
export const STALE_ACT =
  'tower state changed while the rebase was running; the rebase intent is retained so the next tower_rebase can reconcile it; retry'

/**
 * @param {string | null | undefined} tip
 * @returns {string}
 */
export function shortTip(tip) {
  return String(tip ?? '').slice(0, 7)
}

/**
 * @param {RosterEntry} agent
 * @returns {{ ok: false, blockers: Array<{ code: string, detail: string }> }}
 */
export function workerBusyResult(agent) {
  return { ok: false, blockers: [{ code: 'worker-busy', detail: `agent ${agent.name} is running; rebase refused` }] }
}

/**
 * @param {string} path
 * @returns {{ ok: false, blockers: Array<{ code: string, detail: string }> }}
 */
export function dirtyWorktreeResult(path) {
  return { ok: false, blockers: [{ code: 'worktree-dirty', detail: `${path} has uncommitted changes` }] }
}

/**
 * Rewriting an already-landed branch would destroy the reviewed tip.
 * @param {object} input
 * @param {string} input.oldTip
 * @param {string} input.baseTip
 * @param {string} input.base
 * @returns {object}
 */
export function alreadyMergedRebaseResult({ oldTip, baseTip, base }) {
  return {
    ok: true,
    alreadyMerged: true,
    skipped: true,
    oldTip,
    newTip: oldTip,
    baseTip,
    note: `${oldTip.slice(0, 7)} is already contained in ${base} ${baseTip.slice(0, 7)}; branch left untouched — call tower_merge to record the landed merge`,
  }
}

/**
 * @param {object} input
 * @param {string} input.oldTip
 * @param {string} input.baseTip
 * @returns {object}
 */
export function alreadyUpToDateResult({ oldTip, baseTip }) {
  return { ok: true, alreadyUpToDate: true, oldTip, newTip: oldTip, baseTip }
}

/**
 * Both tips must still match the prepared snapshot before the branch rewrite.
 * @param {object} input
 * @param {string} input.oldTip
 * @param {string} input.baseTip
 * @param {string} input.currentTip
 * @param {string} input.currentBase
 * @returns {boolean}
 */
export function rebaseTipsMoved({ oldTip, baseTip, currentTip, currentBase }) {
  return currentTip !== oldTip || currentBase !== baseTip
}

/**
 * @param {object} input
 * @param {string} input.oldTip
 * @param {string} input.baseTip
 * @param {string} input.currentTip
 * @param {string} input.currentBase
 * @returns {string}
 */
export function rebaseTipsMovedDetail({ oldTip, baseTip, currentTip, currentBase }) {
  return `tips moved after preparation (${shortTip(oldTip)}/${shortTip(baseTip)} -> ${shortTip(currentTip)}/${shortTip(currentBase)}), so nothing was rebased`
}

/**
 * Malformed durable intents are refused rather than guessed.
 * @param {unknown} intent
 * @returns {boolean}
 */
export function malformedRebaseIntent(intent) {
  const record = /** @type {Record<string, unknown> | null} */ (intent)
  return (
    typeof record !== 'object' ||
    record === null ||
    typeof record.missionId !== 'string' ||
    typeof record.token !== 'string'
  )
}

/**
 * Classify the durable intent from the observed worktree tip. Only the two
 * unambiguous outcomes are recordable; anything else stays pending.
 * @param {object} input
 * @param {{ oldTip: string, baseTip: string, commits?: number | null }} input.intent
 * @param {Mission | undefined} input.mission
 * @param {string} [input.tip]
 * @param {boolean} input.tipReadable
 * @param {boolean} input.baseIsAncestor
 * @param {number | null} [input.actualCommits]
 * @returns {{ action: 'clear' | 'ambiguous' | 'record', reason?: string, tip?: string }}
 */
export function classifyRebaseIntent({ intent, mission, tip, tipReadable, baseIsAncestor, actualCommits = null }) {
  if (!mission || !mission.worktree || typeof mission.worktree.path !== 'string') {
    return { action: 'clear', reason: 'the mission has no worktree' }
  }
  if (!tipReadable) return { action: 'clear', reason: 'the worktree is not readable' }
  if (tip === intent.oldTip) {
    return { action: 'clear', reason: 'the branch tip is unchanged (the rebase never ran)' }
  }
  if (!baseIsAncestor) return { action: 'ambiguous', tip }
  if (intent.commits !== null && intent.commits !== undefined) {
    if (actualCommits !== Number(intent.commits)) return { action: 'ambiguous', tip }
  }
  return { action: 'record', tip }
}

/**
 * @param {{ missionId: string, startedAt?: number }} intent
 * @param {string | undefined} tip
 * @returns {string}
 */
export function ambiguousRebaseIntentMessage(intent, tip) {
  return `a rebase intent for ${intent.missionId} from ${new Date(Number(intent.startedAt) || 0).toISOString()} is pending and cannot be reconciled automatically (tip ${shortTip(tip)} does not match the prepared snapshot); finish or abort the rebase in that worktree, then retry`
}

/**
 * @param {object} input
 * @param {string} input.token
 * @param {string} input.missionId
 * @param {string} input.base
 * @param {string} input.oldTip
 * @param {string} input.baseTip
 * @param {number | null} input.commits
 * @param {number} input.startedAt
 * @returns {object}
 */
export function buildRebaseIntent({ token, missionId, base, oldTip, baseTip, commits, startedAt }) {
  return { token, missionId, base, oldTip, baseTip, commits, startedAt }
}

/**
 * @param {string} base
 * @param {string} baseTip
 * @returns {string}
 */
export function rebaseConflictNote(base, baseTip) {
  return `rebase conflict onto ${base} @ ${baseTip.slice(0, 12)}`
}

/**
 * @param {string} detail
 * @returns {{ ok: false, blockers: Array<{ code: string, detail: string }> }}
 */
export function rebaseConflictResult(detail) {
  return { ok: false, blockers: [{ code: 'rebase-conflict', detail }] }
}

/**
 * @param {object} input
 * @param {string} input.oldTip
 * @param {string} input.newTip
 * @param {string} input.baseTip
 * @returns {{ ok: true, oldTip: string, newTip: string, baseTip: string, reviewWaived: true }}
 */
export function rebaseSuccessResult({ oldTip, newTip, baseTip }) {
  return { ok: true, oldTip, newTip, baseTip, reviewWaived: true }
}

/**
 * @param {object} input
 * @param {string} input.oldTip
 * @param {string} input.newTip
 * @param {string} input.baseTip
 * @returns {string}
 */
export function rebaseSuccessNote({ oldTip, newTip, baseTip }) {
  return `rebased ${shortTip(oldTip)} -> ${shortTip(newTip)} onto ${shortTip(baseTip)}; conflict-free rebase waives re-review`
}

/**
 * @param {object} input
 * @param {string} input.oldTip
 * @param {string} input.newTip
 * @param {string} input.baseTip
 * @returns {string}
 */
export function rebaseReconcileNote({ oldTip, newTip, baseTip }) {
  return `reconciled interrupted rebase ${shortTip(oldTip)} -> ${shortTip(newTip)} onto ${shortTip(baseTip)}; the clean rebase waiver is preserved`
}

/**
 * @param {object} input
 * @param {string} input.oldTip
 * @param {string} input.newTip
 * @param {string} input.baseTip
 * @returns {string}
 */
export function rebaseActivityText({ oldTip, newTip, baseTip }) {
  return `${shortTip(oldTip)} -> ${shortTip(newTip)} onto ${shortTip(baseTip)}`
}

/**
 * @param {object} input
 * @param {string} input.oldTip
 * @param {string} input.newTip
 * @param {string} input.baseTip
 * @returns {string}
 */
export function rebaseReconcileActivityText({ oldTip, newTip, baseTip }) {
  return `reconciled ${shortTip(oldTip)} -> ${shortTip(newTip)} onto ${shortTip(baseTip)}`
}

/**
 * @param {string | undefined} reason
 * @returns {string}
 */
export function clearedRebaseIntentActivityText(reason) {
  return `cleared a stale rebase intent (${reason})`
}
