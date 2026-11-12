// Pure completion gate checks (#49). No repository I/O.
// @ts-check
import { shapeFor } from './shapes/index.js'
import { blocker as blockerRecord } from './shapes/blockers.js'
import { passingDiscovery } from './evidence.js'
import { isReviewExempt, reviewExemptionInvalid, reviewRequired } from './integration/review.js'

/** @typedef {import('../types/index.js').Blocker} Blocker */
/** @typedef {import('../types/index.js').MergeGateOptions} MergeGateOptions */
/** @typedef {import('../types/index.js').Mission} Mission */
/** @typedef {import('../types/index.js').Review} Review */
/** @typedef {import('../types/index.js').TowerConfig} TowerConfig */

/**
 * Pre-merge completion blockers. The shape owns the vocabulary: a survey is
 * terminal when completed and is never merged, so it has no
 * "closed mission owns a branch" blocker.
 * @param {Mission} mission
 * @param {TowerConfig} [config]
 * @returns {Blocker[]}
 */
export function completionBlockers(mission, config = {}) {
  return shapeFor(mission.kind).completionBlockers(mission, config)
}

/**
 * Review, roster, and test-evidence blockers; all inputs are snapshots.
 * `testsComponent` is the optional `tower-tests` row state (#140). It is passed
 * through the options bag rather than declared on `MergeGateOptions` because the
 * domain may not read the component registry itself: the composition root
 * publishes the probe on the port bag and `app/gate.js` forwards the snapshot.
 * @param {MergeGateOptions & { testsComponent?: ({ enabled?: boolean, reason?: string } | null) }} options
 * @returns {Blocker[]}
 */
export function mergeGateBlockers({
  mission,
  roster = [],
  branch = null,
  branchTip = null,
  review = null,
  config = {},
  activity = {},
  parentStatus = null,
  inactiveStates = [],
  rebaseWaived = false,
  testsComponent = null,
}) {
  /** @type {Blocker[]} */
  const blockers = []
  /** @type {(code: string, detail: string) => void} */
  const push = (code, detail) => {
    blockers.push(blockerRecord(code, detail))
  }
  const inactive = new Set(inactiveStates)
  const shape = shapeFor(mission.kind)
  // #M39: only `review.mode:required` produces review blockers. `optional`
  // records reviews without gating, and `off` disables review entirely (no
  // tower_review, no reviewer spawn), so both skip this whole block.
  const requireReview = reviewRequired(config)
  const exempt = isReviewExempt(mission, config)
  // #159 D4: the review contract does not apply to a shape whose gate is a
  // human acceptance. The exemption is structural — the shape owns the
  // acceptance dimension — so `review.mode:required` cannot force an artifact
  // mission through a reviewer that cannot judge its deliverables. No review
  // blocker is produced for it; the tip-bound acceptance record takes the
  // review's place and any new commit makes it stale.
  if (shape.fields.acceptance) {
    const acceptance = /** @type {{ acceptance?: { tip?: string } | null }} */ (/** @type {any} */ (mission)).acceptance
    if (!acceptance) {
      push('acceptance-missing', `mission ${mission.id} has no human acceptance; only a human can accept the whole committed tip (tower_mission accept)`)
    } else if (branchTip && acceptance.tip !== branchTip) {
      push(
        'acceptance-stale',
        `accepted ${String(acceptance.tip ?? '').slice(0, 7)} but tip is ${branchTip.slice(0, 7)}; the acceptance binds one tip — new commits or a rebase need a fresh human acceptance`,
      )
    }
  } else {
    if (reviewExemptionInvalid(mission, config)) {
      push('review-exemption-invalid', `mission ${mission.id} requests no review but gates.allowReviewExemption is disabled`)
    }
    if (requireReview && !exempt && !review) {
      push('no-review', `branch ${branch ?? '(none)'} has no review; assign a reviewer first (or set review.mode:optional)`)
    } else if (requireReview && !exempt) {
      const latest = /** @type {Review} */ (review)
      if (latest.missionId !== mission.id) push('review-mission-mismatch', `latest review belongs to mission ${latest.missionId}`)
      if (latest.status !== 'clean') push('not-clean', `latest review round ${latest.round} is "${latest.status}"`)
      if (latest.mergeVerdict === 'hold') {
        push('review-hold', 'latest review recommends hold — a later clean review must supersede it')
      } else if (latest.status === 'clean' && latest.mergeVerdict !== 'merge') {
        push('review-not-approved', `latest clean review recommends "${latest.mergeVerdict}" — only "merge" approves`)
      }
      if (branchTip && latest.reviewedCommit !== branchTip && !rebaseWaived) {
        push('tip-moved', `reviewed ${latest.reviewedCommit.slice(0, 7)} but tip is ${branchTip.slice(0, 7)}; re-review required`)
      }
    }
  }
  for (const entry of (roster ?? []).filter((row) => row.missionId === mission.id && !inactive.has(row.state))) {
    // Reserved rows can lack an agent id; indexing with undefined is a miss.
    const agentId = /** @type {string} */ (entry.agentId)
    if (activity[agentId] === 'running') push('worker-busy', `agent ${entry.name} is still running`)
    else if (parentStatus && entry.parentSessionId && parentStatus[entry.parentSessionId] !== 'ok') {
      push('worker-status-unknown', `cannot prove agent ${entry.name} is stopped: its parent catalog is unavailable`)
    }
  }
  const staleWorkers = (roster ?? []).filter(
    (row) => row.missionId === mission.id && (row.state === 'stale' || (row.stale === true && !inactive.has(row.state))),
  )
  if (staleWorkers.length > 0) {
    push('worker-stale', `stale worker(s) for ${mission.id}: ${staleWorkers.map((row) => row.name).join(', ')}; adopt or interrupt before merge`)
  }
  if (config.gates?.requireTests === true) {
    // #149 W4: the receipt question is answered by the one evidence reader, not
    // by a second filter here. The shape decides whether a receipt appertains;
    // a receipt is evidence only for the tip it ran on.
    const receipt = passingDiscovery(shapeFor(mission.kind).evidence, mission, branchTip)
    if (!receipt) {
      // #140: name the component cause when the row is off. Without this the
      // blocker reads as a repository mistake ("no passing discovery") when the
      // real cause is a disabled row and no tower_test tool exists to produce a
      // receipt. The component state is a snapshot on the options bag.
      const tip = branchTip ? branchTip.slice(0, 7) : '(none)'
      const cause =
        testsComponent && testsComponent.enabled !== true
          ? `; ${testsComponent.reason ?? 'disabled by component tower-tests'} so no receipt can exist: ` +
            're-enable the tower-tests component (or set gates.requireTests:false) and re-record discovery'
          : ''
      push('tests-missing', `mission ${mission.id} has no passing test discovery for tip ${tip}${cause}`)
    }
  }
  return blockers
}

/**
 * A conflict-free rebase after the reviewed tip waives the stale-tip blocker.
 * @param {Mission} mission
 * @param {Review} review
 * @returns {boolean}
 */
export function rebaseWaived(mission, review) {
  const rebase = mission.rebase
  if (!rebase) return false
  return review.at <= rebase.at && review.reviewedCommit === rebase.oldTip
}
