// The one shape registry (#149). A *shape* is the contract a mission kind
// carries: its status vocabulary and transitions, what it provisions, how it
// completes, how dependencies are satisfied, and what its briefing and summary
// say. Generic layers resolve a shape once through `shapeFor()` and never
// compare `mission.kind`.
//
// `isTerminal(kind, status)` and `canTransition(kind, from, to)` are the only
// entry points for status policy; the old global `TERMINAL_STATUSES` and
// `TRANSITIONS` tables are gone.
// @ts-check
import { TowerToolError } from '../errors.js'
import { buildShape } from './build.js'
import { surveyShape } from './survey.js'

/** @typedef {import('../../types/index.js').Mission} Mission */

/** @type {Readonly<Record<string, typeof buildShape | typeof surveyShape>>} */
export const SHAPES = Object.freeze({
  build: buildShape,
  survey: surveyShape,
})

/** Ordered kind vocabulary; the first kind is the default for absent kinds. */
/** @type {readonly string[]} */
export const SHAPE_KINDS = Object.freeze(Object.keys(SHAPES))

/**
 * Resolve a mission kind to its shape.
 *
 * A document written before schema v4 may omit `kind`; the v3 -> v4 migration
 * stamps `build`, and pure helpers that tolerate partial mission snapshots still
 * resolve an absent kind as the build shape. An unknown non-empty kind is never
 * guessed.
 * @param {string | null | undefined} kind
 * @returns {typeof buildShape | typeof surveyShape}
 */
export function shapeFor(kind) {
  if (kind === undefined || kind === null || kind === '') return SHAPES.build
  const shape = SHAPES[kind]
  if (!shape) {
    throw new TowerToolError('invalid-argument', `unknown mission kind "${kind}"; expected one of ${SHAPE_KINDS.join('|')}`)
  }
  return shape
}

/**
 * @param {unknown} kind
 * @returns {boolean}
 */
export function isShapeKind(kind) {
  return typeof kind === 'string' && Object.hasOwn(SHAPES, kind)
}

/**
 * The only terminality entry point.
 * @param {string | null | undefined} kind
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminal(kind, status) {
  return shapeFor(kind).isTerminal(status)
}

/**
 * The only transition entry point.
 * @param {string | null | undefined} kind
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(kind, from, to) {
  return shapeFor(kind).canTransition(from, to)
}

/**
 * @param {string | null | undefined} kind
 * @returns {boolean}
 */
export function canMerge(kind) {
  return shapeFor(kind).canMerge
}

/**
 * @param {string | null | undefined} kind
 * @returns {boolean}
 */
export function canRebase(kind) {
  return shapeFor(kind).canRebase
}

/**
 * Resolve how a mission of this kind is provisioned. A shape may resolve the
 * placement from tuning config (#148 W2: a survey is `shared` by default and
 * `detached` with `survey.sandbox: 'detached'`); a shape without a resolver keeps
 * its static placement. When a mission is supplied, a placement already recorded
 * on it (a provisioned detached sandbox) wins over config.
 * @param {string | null | undefined} kind
 * @param {import('../../types/index.js').TowerConfig} [config]
 * @param {import('../../types/index.js').Mission | null | undefined} [mission]
 * @returns {'branch-worktree' | 'shared' | 'detached'}
 */
export function provisioningFor(kind, config = {}, mission = null) {
  const shape = shapeFor(kind)
  if ('resolveProvisioning' in shape && typeof shape.resolveProvisioning === 'function') {
    return shape.resolveProvisioning(mission, config)
  }
  return shape.provisioning
}

/**
 * Resolve the agent preset that executes this kind in the configured placement.
 * A build keeps its `spawn.defaultPreset`; a survey switches between the
 * read-only preset and the sandbox preset so the allow-list follows the
 * resolved placement rather than a hard-coded kind.
 * @param {string | null | undefined} kind
 * @param {import('../../types/index.js').TowerConfig} [config]
 * @param {import('../../types/index.js').Mission | null | undefined} [mission]
 * @returns {string | null}
 */
export function defaultPresetFor(kind, config = {}, mission = null) {
  const shape = shapeFor(kind)
  if ('resolvePreset' in shape && typeof shape.resolvePreset === 'function') {
    return shape.resolvePreset(mission, config)
  }
  return 'defaultPreset' in shape.spawn ? shape.spawn.defaultPreset : null
}

/**
 * Refuse branch-shaped actions for a shape that has no branch. The message tells
 * the caller what to do instead, so the refusal is actionable rather than a bare
 * "invalid transition".
 * @param {Mission} mission
 * @param {'merge' | 'rebase' | 'preflight' | 'diff'} action
 * @returns {void}
 */
export function assertActionSupported(mission, action) {
  const shape = shapeFor(mission.kind)
  // Derived from the shape, never from a hard-coded kind: a new shape that has
  // no branch gets the same refusals without touching this function.
  const evidence = shape.fields.readCommit
    ? `readCommit ${String(mission.readCommit ?? '').slice(0, 12)}`
    : 'recorded evidence'
  if (action === 'merge' && !shape.canMerge) {
    throw new TowerToolError(
      'invalid-transition',
      `mission ${mission.id} is a ${shape.kind}: it has no branch to merge and is never merged; a completed ${shape.kind} already satisfies its dependents`,
      { nextAction: `use tower_complete to finish the ${shape.kind}; its ${evidence} is the evidence` },
    )
  }
  if (action === 'rebase' && !shape.canRebase) {
    throw new TowerToolError(
      'invalid-transition',
      `mission ${mission.id} is a ${shape.kind}: it has no branch to rebase; a ${shape.kind} does not move`,
      { nextAction: `re-plan the ${shape.kind} if the base moved; the recorded ${evidence} is immutable` },
    )
  }
  if (action === 'preflight' && !shape.canMerge) {
    throw new TowerToolError(
      'invalid-transition',
      `mission ${mission.id} is a ${shape.kind}: it has no merge gate; tower_complete checks HEAD, tracked files and zero commits`,
      { nextAction: `use tower_complete to finish the ${shape.kind}; ${shape.kind}s are not preflighted or merged` },
    )
  }
  if (action === 'diff' && !shape.canMerge) {
    throw new TowerToolError(
      'invalid-transition',
      `mission ${mission.id} is a ${shape.kind}: it has no branch diff; its ${evidence} is the evidence`,
      { nextAction: `inspect the recorded ${evidence} directly, or the ${shape.kind} result recorded at completion` },
    )
  }
}
