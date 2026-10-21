// Pure completion gate checks (#49). No repository I/O.
// @ts-check
import { isTerminal } from './mission.js'

/** @typedef {import('../types/index.js').Blocker} Blocker */
/** @typedef {import('../types/index.js').MergeGateOptions} MergeGateOptions */
/** @typedef {import('../types/index.js').Mission} Mission */
/** @typedef {import('../types/index.js').Review} Review */
/** @typedef {import('../types/index.js').TowerConfig} TowerConfig */

/**
 * @param {Mission} mission
 * @param {TowerConfig} [config]
 * @returns {Blocker[]}
 */
export function completionBlockers(mission, config = {}) {
  /** @type {Blocker[]} */
  const blockers = []
  /** @type {(code: string, detail: string) => void} */
  const push = (code, detail) => {
    blockers.push({ code, detail })
  }
  if (isTerminal(mission.status)) {
    push(
      'branch-owned-by-closed-missions',
      `mission ${mission.id} is ${mission.status}; a merge never flips a closed mission — re-plan the work under a new title`,
    )
  }
  if (mission.status !== 'completed') {
    push('mission-not-completed', `mission ${mission.id} is ${mission.status}; completion is required`)
  }
  const openTasks = (mission.tasks ?? []).filter((task) => task.status === 'open')
  if (openTasks.length > 0) {
    push('tasks-open', `${openTasks.length} open task(s): ${openTasks.map((task) => task.text).join('; ')}`)
  }
  const presentBlockers = mission.blockers ?? []
  if (presentBlockers.length > 0) push('blockers-present', presentBlockers.join('; '))
  if (config.gates?.requireChecks === true) {
    const checks = mission.completionReport?.checks ?? []
    if (checks.length === 0) {
      push('no-check-evidence', `mission ${mission.id} has no completion checks; gates.requireChecks is enabled`)
    }
  }
  return blockers
}

/**
 * Review, roster, and test-evidence blockers; all inputs are snapshots.
 * @param {MergeGateOptions} options
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
}) {
  /** @type {Blocker[]} */
  const blockers = []
  /** @type {(code: string, detail: string) => void} */
  const push = (code, detail) => {
    blockers.push({ code, detail })
  }
  const inactive = new Set(inactiveStates)
  const requireReview = config.review?.requireReview !== false
  const exempt =
    !requireReview ||
    (mission.reviewPolicy === 'none' &&
      config.gates?.allowReviewExemption === true &&
      String(mission.reviewExemptionReason ?? '').trim().length > 0)
  if (requireReview && mission.reviewPolicy === 'none' && config.gates?.allowReviewExemption !== true) {
    push('review-exemption-invalid', `mission ${mission.id} requests no review but gates.allowReviewExemption is disabled`)
  }
  if (requireReview && !exempt && !review) {
    push('no-review', `branch ${branch ?? '(none)'} has no review; assign a reviewer first (or set review.requireReview:false)`)
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
    const runs = (mission.testRuns ?? []).filter((run) => run.ok === true && run.treeTip && branchTip && run.treeTip === branchTip)
    if (runs.length === 0) {
      push('tests-missing', `mission ${mission.id} has no passing test discovery for tip ${branchTip ? branchTip.slice(0, 7) : '(none)'}`)
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
