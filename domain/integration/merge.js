// Pure merge decisions: merge-intent / parent / tip validation, commit-stage
// classification, and already-landed reconciliation decisions. Git reads and
// writes, the state lock, and persistence stay in app/merge.js.
// @ts-check
import { isReviewExempt, latestReview, reviewsForBranch } from './review.js'

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
