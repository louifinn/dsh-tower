// Pure merge decisions: merge-intent / parent / tip validation, commit-stage
// classification, and already-landed reconciliation decisions. Git reads and
// writes, the state lock, and persistence stay in app/merge.js.
// @ts-check
import { isReviewExempt, latestReview, reviewsForBranch } from './review.js'
import { mergedEvent } from '../events.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').Review} Review */
/** @typedef {import('../../types/index.js').TowerConfig} TowerConfig */

/**
 * @typedef {object} MergeIntent
 * @property {string} missionId
 * @property {string} baseTip
 * @property {string} branchTip
 * @property {string} [gateTip]
 * @property {number} [startedAt]
 */

/**
 * @typedef {object} LandedMerge
 * @property {string} commit
 * @property {string[]} parents
 */

/**
 * Normalized shape of the optional `record` argument on `tower_merge` (#248).
 * A `record` call is the one documented way to write `merged` for a branch
 * whose landable work is already in the base but whose review can no longer be
 * reconciled automatically: the reviewer's last verdict is a p2 / fix-then-merge
 * and the tower fixed the finding afterwards, or the content landed as a
 * cherry-pick and the branch tip is therefore not an ancestor of the base.
 * @typedef {object} MergeRecord
 * @property {string} reason
 * @property {string[]} [commits]
 */

/**
 * @param {string} missionId
 * @returns {{ ok: false, blockers: Array<{ code: string, detail: string }> }}
 */
export function missionMissingResult(missionId) {
  return { ok: false, blockers: [{ code: 'mission-missing', detail: `unknown mission "${missionId}"` }] }
}

/**
 * @param {string} missionId
 * @param {string} detail
 * @returns {{ ok: false, missionId: string, blockers: Array<{ code: string, detail: string }> }}
 */
export function staleBaseResult(missionId, detail) {
  return { ok: false, missionId, blockers: [{ code: 'stale-base', detail }] }
}

/**
 * @param {string} missionId
 * @param {string} detail
 * @returns {{ ok: false, missionId: string, blockers: Array<{ code: string, detail: string }> }}
 */
export function tipMovedResult(missionId, detail) {
  return { ok: false, missionId, blockers: [{ code: 'tip-moved', detail }] }
}

/**
 * @param {Mission} mission
 * @param {string} baseTip
 * @returns {{ ok: true, alreadyMerged: true, mergedCommit: string | null, baseTip: string }}
 */
export function alreadyMergedResult(mission, baseTip) {
  return { ok: true, alreadyMerged: true, mergedCommit: mission.mergedCommit ?? null, baseTip }
}

/**
 * The gate captured exact tips; a moved tip invalidates the prepared merge.
 * Base drift keeps the historical `stale-base` code, branch drift `tip-moved`.
 * @param {object} input
 * @param {string} input.missionId
 * @param {string | null} [input.gateBaseTip]
 * @param {string | null} [input.gateBranchTip]
 * @param {string} input.baseTip
 * @param {string} input.branchTip
 * @returns {ReturnType<typeof staleBaseResult> | ReturnType<typeof tipMovedResult> | null}
 */
export function gateTipDrift({ missionId, gateBaseTip = null, gateBranchTip = null, baseTip, branchTip }) {
  if (gateBaseTip && gateBaseTip !== baseTip) {
    return staleBaseResult(
      missionId,
      `base moved after gate (${gateBaseTip.slice(0, 7)} -> ${baseTip.slice(0, 7)}); re-run preflight`,
    )
  }
  if (gateBranchTip && gateBranchTip !== branchTip) {
    return tipMovedResult(
      missionId,
      `branch moved after gate (${gateBranchTip.slice(0, 7)} -> ${branchTip.slice(0, 7)}); re-run preflight`,
    )
  }
  return null
}

/**
 * @param {MergeIntent | null | undefined} current
 * @param {MergeIntent} intent
 * @returns {boolean}
 */
export function intentMatches(current, intent) {
  return Boolean(
    current &&
      current.missionId === intent.missionId &&
      current.baseTip === intent.baseTip &&
      current.branchTip === intent.branchTip,
  )
}

/**
 * `--no-ff` puts the integrated branch on the second parent.
 * @param {string[] | null | undefined} parents
 * @param {string} baseTip
 * @param {string} branchTip
 * @returns {boolean}
 */
export function isExpectedMergeShape(parents, baseTip, branchTip) {
  return Array.isArray(parents) && parents.length === 2 && parents[0] === baseTip && parents[1] === branchTip
}

/**
 * Only one merge may be in flight at a time.
 * @param {string} missionId
 * @param {MergeIntent} existing
 * @returns {{ ok: false, missionId: string, blockers: Array<{ code: string, detail: string }> }}
 */
export function pendingMergeIntentResult(missionId, existing) {
  return {
    ok: false,
    missionId,
    blockers: [
      {
        code: 'merge-intent-pending',
        detail: `a merge intent for ${existing.missionId} is recorded; run tower_merge to reconcile it before starting another merge`,
      },
    ],
  }
}

/**
 * @param {object} input
 * @param {string} input.missionId
 * @param {string} input.baseTip
 * @param {string} input.branchTip
 * @param {string} input.gateTip
 * @param {number} input.startedAt
 * @returns {MergeIntent}
 */
export function buildMergeIntent({ missionId, baseTip, branchTip, gateTip, startedAt }) {
  return { missionId, baseTip, branchTip, gateTip, startedAt }
}

/**
 * A "merged" observation only counts when the parents are the captured tips.
 * @param {string} kind
 * @param {string[]} parents
 * @param {string} baseTip
 * @param {string} branchTip
 * @returns {string}
 */
export function classifyCommitOutcome(kind, parents, baseTip, branchTip) {
  return kind === 'merged' && !isExpectedMergeShape(parents, baseTip, branchTip) ? 'merge-shape' : kind
}

/**
 * @param {boolean} conflict
 * @returns {'merge-conflict' | 'merge-hook-failed'}
 */
export function mergeFailureKind(conflict) {
  return conflict ? 'merge-conflict' : 'merge-hook-failed'
}

/**
 * @param {string[]} parents
 * @param {string} baseTip
 * @param {string} branchTip
 * @returns {string}
 */
export function mergeShapeDetail(parents, baseTip, branchTip) {
  return `unexpected merge parents [${parents.join(', ')}], expected [${baseTip}, ${branchTip}]`
}

/**
 * @param {string} branchTip
 * @param {string} base
 * @param {string} newTip
 * @returns {string}
 */
export function mergeSuccessNote(branchTip, base, newTip) {
  return `merged ${branchTip.slice(0, 7)} into ${base} as ${newTip.slice(0, 7)}`
}

/**
 * Apply a successful two-phase merge to the mission draft and describe the
 * domain fact, including the commit that landed. Persistence stays in
 * app/merge.js at the commit phase.
 * @param {{ mission: Mission, branchTip: string, base: string, newTip: string, now: number }} params
 * @returns {{ state: Mission, events: Array<{ type: string, missionId: string, commit: string }> }}
 */
export function applyMergeSuccess({ mission, branchTip, base, newTip, now }) {
  mission.status = 'merged'
  mission.mergedAt = now
  mission.mergedCommit = newTip
  mission.updatedAt = now
  mission.notes = mission.notes ?? []
  mission.notes.push(mergeSuccessNote(branchTip, base, newTip))
  return { state: mission, events: [mergedEvent(mission, newTip)] }
}

/**
 * Apply an already-landed merge reconciliation to the mission draft. `note` is
 * the evidence line the caller built from the observed commit and parents.
 * @param {{ mission: Mission, mergedCommit: string, note: string, now: number }} params
 * @returns {{ state: Mission, events: Array<{ type: string, missionId: string, commit: string }> }}
 */
export function applyLandedMerge({ mission, mergedCommit, note, now }) {
  mission.status = 'merged'
  mission.mergedAt = now
  mission.mergedCommit = mergedCommit
  mission.blockers = []
  mission.notes = mission.notes ?? []
  mission.notes.push(note)
  mission.updatedAt = now
  return { state: mission, events: [mergedEvent(mission, mergedCommit)] }
}

/**
 * @param {string} detail
 * @returns {string}
 */
export function mergeConflictNote(detail) {
  return `merge conflict: ${detail.slice(0, 240)}`
}

/**
 * @param {string} detail
 * @param {string} status
 * @returns {string}
 */
export function mergeHookFailureNote(detail, status) {
  return `merge command failed before creating a commit (${detail.slice(0, 240)}); mission left ${status} for retry`
}

/**
 * @param {object} input
 * @param {string} input.missionId
 * @param {string} input.code
 * @param {string} input.detail
 * @param {string[]} [input.warnings]
 * @param {boolean} [input.timeout]
 * @param {string} [input.cleanup]
 * @returns {object}
 */
export function mergeBlockedResult({ missionId, code, detail, warnings = [], timeout = false, cleanup }) {
  return {
    ok: false,
    missionId,
    blockers: [
      {
        code,
        detail,
        ...(timeout === true ? { timeout: true } : {}),
        ...(cleanup === undefined ? {} : { cleanup }),
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/**
 * Already-landed reconciliation only considers completed/blocked missions with
 * a worktree whose review rules can be satisfied by the snapshot.
 * @param {Mission} mission
 * @param {Review[] | null | undefined} reviews
 * @param {TowerConfig} [config]
 * @returns {{ exempt: boolean, latest: Review | null } | null}
 */
export function landedMergeCandidate(mission, reviews, config = {}) {
  if (!['completed', 'blocked'].includes(mission.status)) return null
  if (!mission.worktree) return null
  const branchReviews = reviewsForBranch(reviews, mission.worktree.branch)
  const exempt = isReviewExempt(mission, config)
  if (branchReviews.length === 0 && !exempt) return null
  const latest = latestReview(branchReviews)
  if (latest && !exempt && (latest.status !== 'clean' || latest.mergeVerdict !== 'merge')) return null
  if (!latest && !exempt) return null
  return { exempt, latest }
}

/**
 * @param {object} input
 * @param {string} input.missionId
 * @param {string} input.base
 * @param {string} input.branchTip
 * @param {string} input.reviewedTip
 * @returns {object}
 */
export function reviewStaleResult({ missionId, base, branchTip, reviewedTip }) {
  return {
    ok: false,
    missionId,
    blockers: [
      {
        code: 'review-stale',
        detail: `reviewed commit ${reviewedTip.slice(0, 7)} is contained in ${base}, but branch tip ${branchTip.slice(0, 7)} is not; the branch was partially landed or moved — re-review or repair manually`,
      },
    ],
  }
}

/**
 * The one blocker for "the work is in the base but the record cannot be
 * reconciled automatically" (#248). Two situations produce it, and the detail
 * says which:
 *
 *   - the latest review is not clean because the tower fixed the reviewer's
 *     finding after the review, so no review covers the tip;
 *   - every commit's patch is already in the base by equivalence (the work
 *     landed as a cherry-pick), so the branch tip is not an ancestor.
 *
 * Both remedies are the same one call, which is why they share a code: the
 * caller states who resolved what and at which commits, and `tower_merge`
 * records the merge with that statement instead of inventing a clean review.
 * @param {object} input
 * @param {string} input.missionId
 * @param {string} input.base
 * @param {string} input.branchTip
 * @param {string | null} input.reviewedTip
 * @param {Review | null} input.latest
 * @param {'review-superseded' | 'content-equivalent'} input.basis
 * @param {string[]} [input.commits] cherry-picks that reproduced the branch
 * @returns {{ ok: false, missionId: string, blockers: Array<{ code: string, detail: string }> }}
 */
export function landedUnrecordedResult({ missionId, base, branchTip, reviewedTip, latest, basis, commits = [] }) {
  const remedy = `state who resolved what and retry: tower_merge({ missionId, record: { reason, commits } })`
  const detail =
    basis === 'content-equivalent'
      ? `the branch's work is already in ${base} (every commit's patch is present by equivalence${commits.length > 0 ? `: ${commits.map((entry) => entry.slice(0, 7)).join(', ')}` : ''}), but branch tip ${branchTip.slice(0, 7)} is not an ancestor; ${remedy}`
      : `review round ${latest?.round ?? '?'} is "${latest?.status ?? 'unknown'}" at ${String(reviewedTip ?? '').slice(0, 7)}${reviewedTip === branchTip ? '' : `, and ${branchTip.slice(0, 7)} came after it`}; the branch is contained in ${base} so the work shipped, but no review covers the tip; ${remedy}`
  return { ok: false, missionId, blockers: [{ code: 'landed-unrecorded', detail }] }
}

/**
 * @typedef {object} LandedRecordFacts
 * @property {string} base
 * @property {string} baseTip
 * @property {string} branchTip
 * @property {string | null} reviewedTip
 * @property {boolean} branchLanded tip is an ancestor of the base
 * @property {boolean} reviewedLanded reviewed tip is an ancestor of the base
 * @property {Array<{ commit: string, landed: boolean }>} commits the caller's
 *   `record.commits`, each answered by `git merge-base --is-ancestor`
 * @property {{ commit: string, parents: string[] } | null} [found] the merge
 *   commit that integrated the branch, when `git rev-list --merges` found one
 */

/**
 * Decide whether a `record` call may write `merged` (#248). The decision is
 * structural plus ancestry only — it never runs Git, and it never overrides a
 * branch whose work is absent from the base: `record` adds a path for work that
 * already shipped, it does not approve work that did not.
 *
 * Returns `{ applicable: false }` when nothing about this mission is already
 * landed, so the caller falls through to the ordinary gate (which produces the
 * `not-clean` / `tip-moved` diagnosis for a branch that still needs re-review).
 * @param {object} input
 * @param {Mission} input.mission
 * @param {Review[] | null | undefined} input.reviews
 * @param {TowerConfig} [input.config]
 * @param {MergeRecord} input.record
 * @param {LandedRecordFacts} input.facts
 * @returns {{ applicable: false } | { blocker: object } | { measured: object }}
 */
export function landedRecordDecision({ mission, reviews, config = {}, record, facts }) {
  if (!['completed', 'blocked'].includes(mission.status)) return { applicable: false }
  if (!mission.worktree) return { applicable: false }
  const branchReviews = reviewsForBranch(reviews, mission.worktree.branch)
  const latest = latestReview(branchReviews)
  const reviewedTip = latest?.reviewedCommit ?? null
  const clean =
    latest !== null && (isReviewExempt(mission, config) || (latest.status === 'clean' && latest.mergeVerdict === 'merge'))
  const commitsLanded = facts.commits.length > 0 && facts.commits.every((entry) => entry.landed === true)
  // A `record` whose named commits are not in the base is refused in so many
  // words: this call may only state that shipped work shipped, so naming a
  // commit that did not land must never fall through to a tip/review diagnosis
  // that reads like a re-review request (#248 acceptance 2).
  if (facts.commits.length > 0 && !commitsLanded) {
    const missing = facts.commits.filter((entry) => entry.landed !== true).map((entry) => entry.commit.slice(0, 7))
    const partial = facts.branchLanded || missing.length < facts.commits.length
    return {
      blocker: {
        code: 'landed-unrecorded',
        detail: partial
          ? `record.commits names ${missing.length} commit(s) that are not in ${facts.base}: ${missing.join(', ')}; record only commits that already landed, or re-review the branch`
          : `none of record.commits is in ${facts.base} (${missing.join(', ')}), and branch tip ${facts.branchTip.slice(0, 7)} is not an ancestor, so this work has not landed; record cannot approve it — re-review and merge the branch`,
      },
    }
  }
  if (!facts.branchLanded && !commitsLanded) {
    // Nothing of this mission is in the base: the ordinary gate owns the answer.
    return { applicable: false }
  }
  if (facts.branchLanded && clean) {
    // A clean review at the tip is the ordinary reconciliation; do not shadow it.
    return { applicable: false }
  }
  const basis = facts.branchLanded ? 'review-superseded' : 'content-equivalent'
  if (basis === 'review-superseded' && latest === null) {
    // Landed with no review at all: review is required and nothing records why
    // it was skipped, so the honest answer is the ordinary gate's no-review.
    return { applicable: false }
  }
  const mergedCommit =
    facts.found?.commit ?? (facts.commits.length > 0 ? String(facts.commits[facts.commits.length - 1].commit) : facts.branchTip)
  return {
    measured: {
      base: facts.base,
      baseTip: facts.baseTip,
      branchTip: facts.branchTip,
      reviewedTip,
      latest,
      basis,
      record,
      commits: facts.commits.map((entry) => entry.commit),
      mergedCommit,
      found: facts.found ?? null,
    },
  }
}

/**
 * @param {object} input
 * @param {string} input.base
 * @param {string} input.mergedCommit
 * @param {MergeRecord} input.record
 * @param {'review-superseded' | 'content-equivalent'} input.basis
 * @param {string | null} input.reviewedTip
 * @param {Review | null} input.latest
 * @param {string[]} [input.commits]
 * @returns {string}
 */
export function recordedMergeNote({ base, mergedCommit, record, basis, reviewedTip, latest, commits = [] }) {
  const who = basis === 'content-equivalent' ? 'content already in' : 'branch contained in'
  const review =
    latest === null
      ? 'no review was recorded'
      : `review round ${latest.round} was "${latest.status}" at ${String(reviewedTip ?? '').slice(0, 7)}`
  const picks = commits.length > 0 ? `; recorded commits ${commits.map((entry) => entry.slice(0, 7)).join(', ')}` : ''
  return `recorded landed merge at ${mergedCommit.slice(0, 7)} (${who} ${base}; ${review}${picks}): ${record.reason}`
}

/**
 * The payload of a `record` reconciliation. `recorded` distinguishes it from
 * the automatic path so a caller can see that a human statement, not a review,
 * authorised the record.
 * @param {object} observed
 * @returns {object}
 */
export function recordedMergeResult(observed) {
  return {
    ok: true,
    reconciled: true,
    alreadyLanded: true,
    recorded: true,
    basis: observed.basis,
    reason: observed.record.reason,
    commits: observed.commits ?? [],
    mergedCommit: observed.mergedCommit,
    baseTip: observed.baseTip,
    branchTip: observed.branchTip,
    parents: observed.found ? observed.found.parents : null,
    review: observed.latest
      ? {
          round: observed.latest.round,
          status: observed.latest.status,
          mergeVerdict: observed.latest.mergeVerdict,
          reviewer: observed.latest.reviewer,
          reviewedCommit: observed.reviewedTip,
        }
      : null,
  }
}


/**
 * Decide what a landed-merge observation means from the two ancestry answers.
 * `skip` means there is nothing safe to reconcile yet.
 * @param {object} input
 * @param {string} input.missionId
 * @param {string} input.base
 * @param {string} input.baseTip
 * @param {string} input.branchTip
 * @param {string | null} input.reviewedTip
 * @param {boolean} input.branchLanded
 * @param {boolean} input.reviewedLanded
 * @param {LandedMerge | null} input.found
 * @param {Review | null} input.latest
 * @returns {{ skip: true } | { reviewStale: object } | { measured: object }}
 */
export function landedMergeEvidence({
  missionId,
  base,
  baseTip,
  branchTip,
  reviewedTip,
  branchLanded,
  reviewedLanded,
  found,
  latest,
}) {
  if (!branchLanded) {
    if (!reviewedLanded) return { skip: true }
    return { reviewStale: reviewStaleResult({ missionId, base, branchTip, reviewedTip: /** @type {string} */ (reviewedTip) }) }
  }
  return {
    measured: {
      baseTip,
      branchTip,
      reviewedTip,
      found,
      mergedCommit: found ? found.commit : branchTip,
      latest,
    },
  }
}

/**
 * @param {object} observed
 * @param {string} observed.mergedCommit
 * @param {string} observed.baseTip
 * @param {string} observed.branchTip
 * @param {LandedMerge | null} observed.found
 * @param {Review | null} observed.latest
 * @param {string | null} observed.reviewedTip
 * @returns {object}
 */
export function landedMergeResult(observed) {
  return {
    ok: true,
    reconciled: true,
    alreadyLanded: true,
    mergedCommit: observed.mergedCommit,
    baseTip: observed.baseTip,
    branchTip: observed.branchTip,
    parents: observed.found ? observed.found.parents : null,
    review: observed.latest
      ? {
          round: observed.latest.round,
          status: observed.latest.status,
          mergeVerdict: observed.latest.mergeVerdict,
          reviewer: observed.latest.reviewer,
          reviewedCommit: observed.reviewedTip,
        }
      : null,
  }
}

/**
 * @param {object} input
 * @param {LandedMerge | null} input.found
 * @param {string} input.mergedCommit
 * @param {string} input.base
 * @returns {string}
 */
export function landedMergeNote({ found, mergedCommit, base }) {
  return found
    ? `reconciled already-landed merge ${mergedCommit.slice(0, 7)} with parents [${found.parents.map((parent) => parent.slice(0, 7)).join(', ')}]`
    : `reconciled already-landed merge: ${mergedCommit.slice(0, 7)} is contained in ${base} (no merge commit found)`
}

/**
 * @param {object} input
 * @param {string} input.head
 * @param {string} input.baseTip
 * @param {boolean} input.mergeInProgress
 * @param {LandedMerge | null} input.landed
 * @returns {{ landed: LandedMerge | null } | null}
 */
export function mergeIntentEvidence({ head, baseTip, mergeInProgress, landed }) {
  if (mergeInProgress) return null
  if (head === baseTip) return { landed: null }
  return landed ? { landed } : null
}

/**
 * @param {{ landed: LandedMerge | null } | null} evidence
 * @returns {string}
 */
export function mergeIntentReconcileNote(evidence) {
  return evidence && evidence.landed
    ? `reconciled merge intent; found landed commit ${String(evidence.landed.commit).slice(0, 7)}`
    : 'cleared a merge intent that created no commit'
}
