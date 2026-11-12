// The one completion-invariant vocabulary shared by every mission shape
// (#M65 W2-D). A shape still owns *its* check, but it may not own the shape of
// the invariant set: every completion contract declares the same six boolean
// flags, and the completion blockers both shapes share are built here once.
//
// Building the set through `completionInvariants()` is what keeps build and
// survey from drifting apart. A new flag must be added to
// `COMPLETION_INVARIANT_KEYS` (and therefore to the generated reference table),
// defaults are explicit, and an unknown or non-boolean flag fails closed at
// module load instead of silently becoming an always-false requirement.
// @ts-check
import { TowerToolError } from '../errors.js'
import { hasCheckEvidence } from '../evidence.js'
import { blocker } from './blockers.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').Blocker} Blocker */
/** @typedef {import('../../types/index.js').TowerConfig} TowerConfig */
/** @typedef {import('../evidence.js').EvidenceContract} EvidenceContract */

/**
 * The complete invariant vocabulary, in the order the generated reference table
 * and the completion tests use. A shape declares only the flags it turns on;
 * `completionInvariants` fills the rest with `false`.
 * @type {readonly string[]}
 */
export const COMPLETION_INVARIANT_KEYS = Object.freeze([
  'requiresWorktree',
  'requiresSandbox',
  'requiresCommits',
  'requiresClean',
  'requiresHeadMatch',
  'requiresTrackedStatus',
  'requiresArtifacts',
])

/**
 * @typedef {object} CompletionInvariants
 * @property {boolean} requiresWorktree
 * @property {boolean} requiresSandbox
 * @property {boolean} requiresCommits
 * @property {boolean} requiresClean
 * @property {boolean} requiresHeadMatch
 * @property {boolean} requiresTrackedStatus
 * @property {boolean} requiresArtifacts the declared deliverables must be inside the scope and committed at the branch tip (#159)
 * @property {(context: any) => { commits: number }} check
 */

/**
 * Build one shape's frozen completion contract. Every `requires*` flag in the
 * vocabulary is present afterwards, so a generic reader never has to ask
 * whether a shape remembered to declare a dimension.
 * @param {Record<string, boolean>} flags the invariants this shape turns on
 * @param {(context: any) => { commits: number }} check the shape's own check
 * @returns {Readonly<CompletionInvariants>}
 */
export function completionInvariants(flags, check) {
  if (flags === null || typeof flags !== 'object' || Array.isArray(flags)) {
    throw new TowerToolError('invalid-argument', 'completion invariants must be an object of requires* flags')
  }
  if (typeof check !== 'function') {
    throw new TowerToolError('invalid-argument', 'completion invariants need a check(context) function')
  }
  const declared = new Set(COMPLETION_INVARIANT_KEYS)
  for (const key of Object.keys(flags)) {
    if (!declared.has(key)) {
      throw new TowerToolError(
        'invalid-argument',
        `unknown completion invariant "${key}"; expected one of ${COMPLETION_INVARIANT_KEYS.join('|')}`,
        { nextAction: 'add the flag to COMPLETION_INVARIANT_KEYS in domain/shapes/completion.js first' },
      )
    }
    if (typeof flags[key] !== 'boolean') {
      throw new TowerToolError('invalid-argument', `completion invariant "${key}" must be a boolean`)
    }
  }
  /** @type {any} */
  const invariants = {}
  for (const key of COMPLETION_INVARIANT_KEYS) invariants[key] = flags[key] === true
  invariants.check = check
  return /** @type {Readonly<CompletionInvariants>} */ (Object.freeze(invariants))
}

/**
 * The completion blockers every shape shares: not completed, open tasks, open
 * blockers, and missing check evidence when the gate asks for it. A build turns
 * this list into its merge-gate list by prepending its shape-only
 * "branch owned by a closed mission" blocker; a survey uses it as-is.
 * @param {Mission} mission
 * @param {TowerConfig} config
 * @param {EvidenceContract} evidence the shape's evidence contract
 * @returns {Blocker[]}
 */
export function baseCompletionBlockers(mission, config, evidence) {
  /** @type {Blocker[]} */
  const blockers = []
  if (mission.status !== 'completed') {
    blockers.push(
      blocker(
        'mission-not-completed',
        mission.status === 'blocked'
          ? `mission ${mission.id} is blocked: ${(mission.blockers ?? []).join('; ')}; clear the blockers to resume it`
          : `mission ${mission.id} is ${mission.status}; completion is required`,
      ),
    )
  }
  const open = (mission.tasks ?? []).filter((task) => task.status === 'open')
  if (open.length > 0) {
    blockers.push(blocker('tasks-open', `${open.length} open task(s): ${open.map((task) => task.text).join('; ')}`))
  }
  if ((mission.blockers ?? []).length > 0) {
    blockers.push(blocker('blockers-present', (mission.blockers ?? []).join('; ')))
  }
  if (config.gates?.requireChecks && !hasCheckEvidence(evidence, mission)) {
    blockers.push(
      blocker('no-check-evidence', `mission ${mission.id} has no completion checks; gates.requireChecks is enabled`),
    )
  }
  return blockers
}
