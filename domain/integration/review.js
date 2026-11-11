// Pure review-selection, review-policy resolution and exemption decisions
// shared by the merge/gate/read projections and the config layer. No repository
// I/O and no process state.
//
// REVIEW POLICY (#M39)
// --------------------
// `review.mode` is the single policy with exactly three independent values:
//
//   off       review is intentionally unavailable: recording a review is
//             refused, `tower_spawn` refuses the reviewer role, and the merge
//             gate ignores review blockers. Registration is profile-time: a
//             profile-level off does not mount `tower_review`, while a
//             repository-level off over a profile that mounted it refuses the
//             submission with `review-disabled`;
//   optional  review is available but never blocks a merge (the default, and the
//             2.0.3+ behavior of `review.requireReview:false`);
//   required  a clean review bound to the branch tip is a merge blocker (the
//             old `review.requireReview:true` behavior).
//
// `review.requireReview` was accepted as a normalized alias for one release
// (2.6): true meant `required`, false meant `optional`. It was physically
// removed in 2.8.0 — a config that still sets it fails as an unknown key with
// an upgrade note naming `review.mode`. The alias was never a second policy,
// and the resolved config no longer mirrors it.
// @ts-check
import { TowerToolError } from '../errors.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').Review} Review */
/** @typedef {import('../../types/index.js').TowerConfig} TowerConfig */

export const REVIEW_MODES = Object.freeze(['off', 'optional', 'required'])
export const DEFAULT_REVIEW_MODE = 'optional'

// Cordis materializes a `.volatile()` schema field as a live reference object
// (`{ get() }` plus a non-enumerable `Symbol.for('cosmokit.volatile.write')`).
// Settings forms hand the runtime these references, not plain values, so every
// consumer below unwraps them before validating or comparing. Keeping the
// helpers here (instead of a new config module) lets the schema import them
// without a cycle: review.js has no dependency on schema.js.
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * True for the live reference Cordis/Schemastery creates for a volatile field.
 * @param {unknown} value
 * @returns {value is { get: () => unknown }}
 */
export function isVolatileRef(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof /** @type {{ get?: unknown }} */ (value).get === 'function' &&
    Object.getOwnPropertySymbols(value).includes(VOLATILE_WRITE)
  )
}

/**
 * Read a volatile reference once; other values pass through unchanged.
 * @template T
 * @param {T | { get: () => T }} value
 * @returns {T}
 */
export function unwrapVolatile(value) {
  return /** @type {any} */ (isVolatileRef(value) ? value.get() : value)
}

/**
 * Deep-copy a raw config object, replacing every volatile reference with its
 * current value. Non-plain objects (for example a class instance) are returned
 * as-is; Tower config is JSON-shaped plain data.
 * @param {unknown} value
 * @returns {any}
 */
export function materializeVolatile(value) {
  const plain = unwrapVolatile(value)
  if (Array.isArray(plain)) return plain.map((entry) => materializeVolatile(entry))
  if (plain === null || typeof plain !== 'object') return plain
  const proto = Object.getPrototypeOf(plain)
  if (proto !== Object.prototype && proto !== null) return plain
  /** @type {Record<string, unknown>} */
  const copy = {}
  for (const [key, entry] of Object.entries(plain)) copy[key] = materializeVolatile(entry)
  return copy
}

/**
 * @param {unknown} value
 * @returns {value is 'off' | 'optional' | 'required'}
 */
export function isReviewMode(value) {
  return typeof value === 'string' && REVIEW_MODES.includes(value)
}

/**
 * The resolved mode for any config object the runtime may hold: a resolved
 * config, a raw profile/repo layer, or a hand-built test fixture. `review.mode`
 * is the only review policy key since 2.8.0; an absent or invalid value falls
 * back to the documented default.
 * @param {{ review?: any } | null | undefined} [config]
 * @returns {'off' | 'optional' | 'required'}
 */
export function reviewModeOf(config) {
  const review = config?.review ?? {}
  const mode = unwrapVolatile(review.mode)
  return isReviewMode(mode) ? mode : DEFAULT_REVIEW_MODE
}

/**
 * The review gate is enforced only in `required`. `off` and `optional` both
 * ignore review at the merge gate; they differ in availability, not strictness.
 * @param {{ review?: any } | null | undefined} [config]
 */
export function reviewRequired(config) {
  return reviewModeOf(config) === 'required'
}

/**
 * True when review is intentionally switched off (`tower_review` absent,
 * reviewer spawn refused, merge gate ignores review).
 * @param {{ review?: any } | null | undefined} [config]
 */
export function reviewUnavailable(config) {
  return reviewModeOf(config) === 'off'
}

/**
 * Resolve one raw `review` object (a profile, a repository layer, or a single
 * written config) into its mode. Rejects an unknown mode with an actionable
 * `config-invalid` error. Since 2.8.0 `review.mode` is the only policy key; the
 * retired `review.requireReview` boolean is rejected earlier as an unknown key
 * by `assertKnownKeys`, so this resolver never accepts it.
 *
 * @param {any} rawReview
 * @returns {{ mode: 'off' | 'optional' | 'required', explicit: boolean }}
 */
export function resolveReviewPolicy(rawReview) {
  const review = rawReview && typeof rawReview === 'object' && !Array.isArray(rawReview) ? rawReview : {}
  const mode = unwrapVolatile(review.mode)
  if (mode !== undefined && !isReviewMode(mode)) {
    throw new TowerToolError(
      'config-invalid',
      `review.mode must be one of ${REVIEW_MODES.join('|')}, got ${JSON.stringify(mode)}`,
    )
  }
  if (mode !== undefined) return { mode, explicit: true }
  return { mode: DEFAULT_REVIEW_MODE, explicit: false }
}

/**
 * The small read-only projection reported by `tower_status` and the doctor's
 * `review` check. `detail` is the one sentence both surfaces share.
 * @param {{ review?: any } | null | undefined} [config]
 */
export function reviewPolicyView(config) {
  const mode = reviewModeOf(config)
  const detail =
    mode === 'off'
      ? 'review.mode:off — review is intentionally unavailable: recording a review is refused, reviewer spawn is refused, and the merge gate ignores review; a profile-level off does not register tower_review'
      : mode === 'required'
        ? 'review.mode:required — a clean review bound to the branch tip is a merge blocker'
        : 'review.mode:optional — review is available but never blocks a merge'
  return { mode, available: mode !== 'off', required: mode === 'required', detail }
}

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
 * Order two review rows from older to newer. A higher round is always newer; two
 * routes that share a round are ordered by submission sequence, so the most
 * recently recorded verdict of a round is newer than an earlier one (#108). The
 * comparison is strict: rows with equal round and sequence are equally recent
 * and a caller keeping the first maximum does not swap them.
 * @param {Review} left
 * @param {Review} right
 * @returns {number}
 */
export function compareReviewsByRecency(left, right) {
  const round = (Number(left.round) || 0) - (Number(right.round) || 0)
  if (round !== 0) return round
  return (Number(left.seq) || 0) - (Number(right.seq) || 0)
}

/**
 * The latest review row, or null when there is none. This is the single
 * definition of "latest" shared by the merge gate, landed-merge detection, the
 * status/briefing projections and review admission.
 * @param {Review[]} reviews
 * @returns {Review | null}
 */
export function latestReview(reviews) {
  /** @type {Review | null} */
  let latest = null
  for (const review of reviews) {
    if (!latest || compareReviewsByRecency(review, latest) > 0) latest = review
  }
  return latest
}

/**
 * Reviews ordered newest first, for read projections that display a short
 * history. Equal rows keep their stored order.
 * @param {Review[]} reviews
 * @returns {Review[]}
 */
export function reviewsNewestFirst(reviews) {
  return [...reviews].sort((left, right) => compareReviewsByRecency(right, left))
}

/**
 * A mission skips the review gate unless `review.mode` is `required`. In
 * `required`, it may still skip with both the exemption gate and a reason.
 * `off` and `optional` both bypass the gate; they differ only in whether the
 * review tools/spawn role exist.
 * @param {Mission} mission
 * @param {TowerConfig} [config]
 * @returns {boolean}
 */
export function isReviewExempt(mission, config = {}) {
  if (!reviewRequired(config)) return true
  return (
    mission.reviewPolicy === 'none' &&
    config.gates?.allowReviewExemption === true &&
    String(mission.reviewExemptionReason ?? '').trim().length > 0
  )
}

/**
 * `reviewPolicy: none` is invalid when the reviewer gate does not allow it.
 * Only `review.mode:required` can make the request invalid; with review off or
 * optional no review blocker is produced at all.
 * @param {Mission} mission
 * @param {TowerConfig} [config]
 * @returns {boolean}
 */
export function reviewExemptionInvalid(mission, config = {}) {
  return (
    reviewRequired(config) &&
    mission.reviewPolicy === 'none' &&
    config.gates?.allowReviewExemption !== true
  )
}
