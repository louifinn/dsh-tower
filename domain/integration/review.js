// Pure review-selection and exemption decisions shared by the merge/gate/read
// projections. No repository I/O.
// @ts-check

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').Review} Review */
/** @typedef {import('../../types/index.js').TowerConfig} TowerConfig */

/**
 * Reviews are branch-scoped; a missing branch has no reviews.
 * @param {Review[] | null | undefined} reviews
 * @param {string | null} branch
 * @returns {Review[]}
 */
export function reviewsForBranch(reviews, branch) {
  return branch ? (reviews ?? []).filter((review) => review.branch === branch) : []
}

/**
 * The latest review round, or null when the branch has no reviews.
 * @param {Review[]} reviews
 * @returns {Review | null}
 */
export function latestReview(reviews) {
  return reviews.length > 0 ? reviews.reduce((left, right) => (left.round >= right.round ? left : right)) : null
}

/**
 * A mission may skip review only with both the exemption gate and a reason.
 * @param {Mission} mission
 * @param {TowerConfig} [config]
 * @returns {boolean}
 */
export function isReviewExempt(mission, config = {}) {
  return (
    config.review?.requireReview === false ||
    (mission.reviewPolicy === 'none' &&
      config.gates?.allowReviewExemption === true &&
      String(mission.reviewExemptionReason ?? '').trim().length > 0)
  )
}

/**
 * `reviewPolicy: none` is invalid when the reviewer gate does not allow it.
 * @param {Mission} mission
 * @param {TowerConfig} [config]
 * @returns {boolean}
 */
export function reviewExemptionInvalid(mission, config = {}) {
  const requireReview = config.review?.requireReview !== false
  return requireReview && mission.reviewPolicy === 'none' && config.gates?.allowReviewExemption !== true
}
