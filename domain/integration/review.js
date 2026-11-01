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
// `review.requireReview` stays accepted for one release as a normalized alias:
// true -> required, false -> optional. Precedence for one raw config object is
// deterministic:
//
//   * only the alias set: the alias decides;
//   * only the mode set: the mode decides;
//   * both set: an alias of `true` next to any mode other than `required` is a
//     contradiction and is rejected naming both keys. An alias of `false` stays
//     compatible with `off` because both mean "not required by merge" and the
//     mode is the more specific policy. That asymmetry is also what keeps the
//     resolver idempotent: it materializes the alias from the mode it resolved,
//     and `required` is the only mode that mirrors back to `true`.
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
 * The mode the deprecated boolean alias means.
 * @param {boolean} requireReview
 */
export function legacyReviewMode(requireReview) {
  return requireReview === true ? 'required' : DEFAULT_REVIEW_MODE
}

/**
 * The resolved mode for any config object the runtime may hold: a resolved
 * config, a raw profile/repo layer, or a hand-built test fixture. An explicit
 * `mode` always wins; otherwise the deprecated alias decides; otherwise the
 * documented default applies.
 * @param {{ review?: any } | null | undefined} [config]
 * @returns {'off' | 'optional' | 'required'}
 */
export function reviewModeOf(config) {
  const review = config?.review ?? {}
  const mode = unwrapVolatile(review.mode)
  if (isReviewMode(mode)) return mode
  const alias = unwrapVolatile(review.requireReview)
  if (typeof alias === 'boolean') return legacyReviewMode(alias)
  return DEFAULT_REVIEW_MODE
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
 * written config) into its mode. Rejects contradictory explicit values and an
 * unknown mode with an actionable `config-invalid` error.
 *
 * @param {any} rawReview
 * @returns {{ mode: 'off' | 'optional' | 'required', explicit: boolean, legacy: boolean }}
 */
export function resolveReviewPolicy(rawReview) {
  const review = rawReview && typeof rawReview === 'object' && !Array.isArray(rawReview) ? rawReview : {}
  const mode = unwrapVolatile(review.mode)
  const alias = unwrapVolatile(review.requireReview)
  if (mode !== undefined && !isReviewMode(mode)) {
    throw new TowerToolError(
      'config-invalid',
      `review.mode must be one of ${REVIEW_MODES.join('|')}, got ${JSON.stringify(mode)}`,
    )
  }
  if (alias !== undefined && typeof alias !== 'boolean') {
    throw new TowerToolError(
      'config-invalid',
      'review.requireReview must be a boolean (deprecated alias: true -> required, false -> optional)',
    )
  }
  if (mode !== undefined && alias === true && mode !== 'required') {
    throw new TowerToolError(
      'config-invalid',
      `review.mode is ${JSON.stringify(mode)} but review.requireReview is true; set only review.mode (off|optional|required) — review.requireReview is a deprecated alias (true -> required, false -> optional) and may not contradict it`,
    )
  }
  if (mode !== undefined) return { mode, explicit: true, legacy: alias !== undefined }
  if (alias !== undefined) return { mode: legacyReviewMode(alias), explicit: true, legacy: true }
  return { mode: DEFAULT_REVIEW_MODE, explicit: false, legacy: false }
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
 * The latest review round, or null when the branch has no reviews.
 * @param {Review[]} reviews
 * @returns {Review | null}
 */
export function latestReview(reviews) {
  return reviews.length > 0 ? reviews.reduce((left, right) => (left.round >= right.round ? left : right)) : null
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
