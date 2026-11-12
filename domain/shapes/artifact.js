// The artifact shape (#159): a mission that writes deliverables a code review
// cannot judge — a rendered report, a dataset, a training output, an exported
// analysis. It owns a private branch and worktree like a build, but its merge
// gate is an explicit human acceptance of the whole committed tip, not an
// independent review.
//
// Three contracts make the shape, and none of them is a flag on `build`:
//
//   * the mission declares its deliverables (`artifacts`) at plan time; every
//     path is inside the scope, and completion refuses a deliverable that is
//     not committed at the branch tip;
//   * a human acceptance record replaces the review: only a human can accept,
//     the record binds one tip, and any new commit or rebase makes it stale at
//     the merge gate (`acceptance-stale`);
//   * the review contract does not apply: the merge gate skips review blockers
//     for this shape and reports acceptance blockers instead, while
//     `tower_doctor` reports a missing acceptance as a warning.
//
// This module is the only place artifact-specific policy lives; generic layers
// resolve the shape through `./index.js` and never compare `mission.kind`.
// @ts-check
import { TowerToolError } from '../errors.js'
import { fileInScope } from '../scope.js'
import { completionInvariants } from './completion.js'
import {
  BUILD_STATUSES,
  BUILD_TRANSITIONS,
  completionBlockers as buildCompletionBlockers,
  dependencySatisfied as buildDependencySatisfied,
  isTerminal as buildIsTerminal,
  canTransition as buildCanTransition,
} from './build.js'

/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').Blocker} Blocker */
/** @typedef {import('../../types/index.js').TowerConfig} TowerConfig */

/**
 * It merges, so the status graph is build's: `merged` and `abandoned` are
 * terminal, and a completed artifact waits for acceptance before it lands.
 * @type {readonly string[]}
 */
export const ARTIFACT_STATUSES = BUILD_STATUSES

/** @type {Readonly<Record<string, readonly string[]>>} */
export const ARTIFACT_TRANSITIONS = BUILD_TRANSITIONS

/** The evidence this shape accepts: a build's contract — completion checks and
 * tip-bound test receipts. An acceptance is not evidence; it is the human's
 * decision, recorded on the mission and enforced by the merge gate.
 * @type {import('../evidence.js').EvidenceContract}
 */
export const EVIDENCE = Object.freeze({
  completionChecks: true,
  testReceipts: /** @type {const} */ ('tip-bound'),
})

/**
 * An artifact mission owns the scope it declared, exactly like a build: every
 * changed path — deliverable or not — must match it.
 * @type {{ ownsPaths: boolean, fence: 'scope' | 'read-only' }}
 */
export const REACH = Object.freeze({
  ownsPaths: true,
  fence: /** @type {const} */ ('scope'),
})

/** Deliverables are concrete paths, not patterns. */
const GLOB_META = /[*?[{]/

/** A mission declares a bounded deliverable set; references cap at 20. */
const MAX_ARTIFACTS = 20

/**
 * Normalize the declared deliverable paths: relative, no `..`, no drive, no
 * glob metacharacters, deduplicated. The same shape as a scope entry, because
 * each path must live inside the scope.
 * @param {unknown} artifacts
 * @returns {string[]}
 */
export function normalizeArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) {
    if (artifacts === undefined || artifacts === null) {
      throw new TowerToolError(
        'invalid-argument',
        'an artifact mission declares its deliverables: artifacts must list the committed deliverable paths',
      )
    }
    throw new TowerToolError('invalid-argument', 'artifacts must be an array of relative deliverable paths')
  }
  if (artifacts.length === 0) {
    throw new TowerToolError(
      'invalid-argument',
      'an artifact mission declares its deliverables: artifacts must list the committed deliverable paths',
    )
  }
  if (artifacts.length > MAX_ARTIFACTS) {
    throw new TowerToolError('invalid-argument', `artifacts supports at most ${MAX_ARTIFACTS} deliverable paths`)
  }
  /** @type {string[]} */
  const out = []
  for (const raw of artifacts) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new TowerToolError('invalid-argument', 'artifacts entries must be non-empty strings')
    }
    const value = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim()
    if (value.length === 0) throw new TowerToolError('invalid-argument', 'artifacts entries must be non-empty strings')
    if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
      throw new TowerToolError('invalid-argument', `artifacts must be relative: ${raw}`)
    }
    if (value.split('/').some((part) => part === '..')) {
      throw new TowerToolError('invalid-argument', `artifacts must not contain "..": ${raw}`)
    }
    if (GLOB_META.test(value)) {
      throw new TowerToolError(
        'invalid-argument',
        `artifacts entries are concrete deliverable paths, not globs: ${raw}`,
      )
    }
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/**
 * Plan fields: the scope plus the declared deliverables. Every deliverable must
 * already be inside the declared scope — a path outside it could never be
 * written legally, so the plan refuses it the moment it is declared.
 * @param {{ scope?: string[], artifacts?: unknown }} context
 * @returns {{ scope: string[], artifacts: string[] }}
 */
export function planFields(context) {
  const scope = Array.isArray(context.scope) ? context.scope : []
  const artifacts = normalizeArtifacts(context.artifacts)
  const outOfScope = artifacts.filter((artifact) => !fileInScope(scope, artifact))
  if (outOfScope.length > 0) {
    throw new TowerToolError(
      'invalid-argument',
      `declared artifacts outside the mission scope (${scope.join(', ') || 'empty'}): ${outOfScope.join(', ')}; widen the scope or move the deliverable`,
    )
  }
  return { scope, artifacts }
}

/**
 * Build one acceptance record. Only this module constructs one, and `by` is
 * always `human`: there is no tool argument that could set it to anything
 * else, and the recording path in the tool layer goes through the human
 * approval channel (#159 D3). The tip is validated at runtime because it
 * arrives from the tool layer's resolved decision, not from a typed caller.
 * @param {{ mission: Mission, tip: unknown, note?: string | null, now: number }} params
 * @returns {{ at: number, by: 'human', tip: string, artifacts: string[], note?: string }}
 */
export function acceptanceRecord({ mission, tip, note, now }) {
  if (typeof tip !== 'string' || tip.trim().length === 0) {
    throw new TowerToolError('invalid-argument', 'an acceptance binds a branch tip; tip must be the commit sha being accepted')
  }
  const artifacts = Array.isArray(/** @type {any} */ (mission).artifacts)
    ? /** @type {any} */ (mission).artifacts.filter((/** @type {unknown} */ entry) => typeof entry === 'string')
    : []
  /** @type {{ at: number, by: 'human', tip: string, artifacts: string[], note?: string }} */
  const record = { at: now, by: 'human', tip: tip.trim(), artifacts: [...artifacts] }
  const text = typeof note === 'string' ? note.trim() : ''
  if (text.length > 0) record.note = text.slice(0, 4000)
  return record
}

/**
 * True when a stored value is a well-formed acceptance record. The state
 * semantics layer calls this for the shape that owns the dimension.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAcceptanceRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = /** @type {Record<string, any>} */ (value)
  return (
    Number.isFinite(record.at) &&
    record.by === 'human' &&
    typeof record.tip === 'string' &&
    record.tip.length > 0 &&
    Array.isArray(record.artifacts) &&
    record.artifacts.every((entry) => typeof entry === 'string' && entry.length > 0) &&
    (record.note === undefined || typeof record.note === 'string')
  )
}

/**
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminal(status) {
  return buildIsTerminal(status)
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  return buildCanTransition(from, to)
}

/**
 * Completion invariants for an artifact mission: a build's (at least one commit
 * since the base, a clean worktree) plus the deliverable contract — every
 * declared artifact is inside the scope and exists at the branch tip, so the
 * deliverables are committed rather than left in the worktree (#159 D2). The
 * app layer resolves the worktree and collects the primitives.
 * @param {{ mission: Mission, commits: number, clean: boolean, dirtyPaths: string[], artifactTip?: string | null, artifactsMissingAtTip?: string[], caseInsensitive?: boolean }} context
 * @returns {{ commits: number }}
 */
export function checkCompletion({ mission, commits, clean, dirtyPaths, artifactTip, artifactsMissingAtTip, caseInsensitive }) {
  const base = mission.worktree?.baseCommit ?? ''
  if (commits < 1) {
    throw new TowerToolError('invalid-argument', `mission branch has no commits since ${String(base).slice(0, 12)}`)
  }
  if (!clean) {
    const shown = dirtyPaths.slice(0, 8).join(', ')
    const more = dirtyPaths.length > 8 ? ', …' : ''
    throw new TowerToolError(
      'worktree-dirty',
      `mission ${mission.id} worktree has uncommitted changes (${shown}${more}); commit the deliverables — an artifact mission completes only with every declared artifact committed`,
    )
  }
  const artifacts = Array.isArray(/** @type {any} */ (mission).artifacts) ? /** @type {any} */ (mission).artifacts : []
  const outOfScope = artifacts.filter(
    (/** @type {string} */ artifact) => !fileInScope(mission.scope ?? [], artifact, { caseInsensitive: caseInsensitive === true }),
  )
  if (outOfScope.length > 0) {
    throw new TowerToolError(
      'invalid-argument',
      `mission ${mission.id} declares artifacts outside its scope (${(mission.scope ?? []).join(', ') || 'empty'}): ${outOfScope.join(', ')}; widen the scope or move the deliverable`,
    )
  }
  if (typeof artifactTip !== 'string' || artifactTip.length === 0) {
    throw new TowerToolError(
      'invalid-argument',
      `mission ${mission.id} branch tip could not be resolved; the declared artifacts cannot be verified at the tip`,
    )
  }
  const missing = artifactsMissingAtTip ?? []
  if (missing.length > 0) {
    throw new TowerToolError(
      'invalid-argument',
      `mission ${mission.id} declares artifacts missing from the branch tip ${artifactTip.slice(0, 12)}: ${missing.join(', ')}; commit the deliverables — tower_complete refuses an uncommitted artifact`,
    )
  }
  return { commits }
}

/**
 * Pre-merge completion blockers: a build's list (the shape merges, so a closed
 * mission owning a branch is a blocker here too).
 * @param {Mission} mission
 * @param {TowerConfig} [config]
 * @returns {Blocker[]}
 */
export function completionBlockers(mission, config = /** @type {TowerConfig} */ ({})) {
  return buildCompletionBlockers(mission, config)
}

/**
 * An artifact mission's dependency is satisfied once it has landed or been
 * dropped — the same terminal statuses as a build (#159 D4).
 * @param {Pick<Mission, 'status'>} dep
 * @returns {boolean}
 */
export function dependencySatisfied(dep) {
  return buildDependencySatisfied(dep)
}

/**
 * Worker spawn constraints: an artifact worker gets its own branch and
 * worktree and uses the worker preset like a build worker.
 * @type {{ provisioning: 'branch-worktree', missionStatuses: readonly string[], worktree: true, countsTowardWorkerBudget: boolean, model: string }}
 */
export const spawn = Object.freeze({
  provisioning: /** @type {const} */ ('branch-worktree'),
  missionStatuses: Object.freeze(['planned', 'active', 'completed', 'blocked', 'paused']),
  worktree: /** @type {const} */ (true),
  countsTowardWorkerBudget: true,
  model: 'worker',
})

/**
 * Mission briefing lines that are specific to the artifact shape: the
 * deliverables are named so the worker knows what must exist at the tip, and
 * the acceptance contract is stated so nobody waits for a reviewer round.
 * @param {Mission} mission
 * @param {{ worktree?: { path: string, branch: string, baseCommit?: string } | null, base: string, repoRoot?: string, readCommit?: string, readDirty?: string[] }} context
 * @returns {string[]}
 */
export function briefing(mission, context) {
  const worktree = context.worktree
  if (!worktree) return []
  const artifacts = /** @type {any} */ (mission).artifacts ?? []
  return [
    `Work ONLY in this git worktree: ${worktree.path}`,
    `Branch: ${worktree.branch} (based on ${context.base} @ ${String(worktree.baseCommit ?? '').slice(0, 12)})`,
    `Declared deliverables (every path must be committed at the branch tip): ${artifacts.join(', ') || '(none — the plan refused an empty list)'}`,
    'A human accepts the whole committed tip of this branch — there is no reviewer round. Commit every deliverable and leave the worktree clean.',
  ]
}

/**
 * Projection of the artifact-specific mission fields for summaries/board rows.
 * @param {Mission} mission
 * @returns {Record<string, any>}
 */
export function summary(mission) {
  return {
    worktree: mission.worktree ? { path: mission.worktree.path, branch: mission.worktree.branch, baseCommit: mission.worktree.baseCommit } : null,
    mergedCommit: mission.mergedCommit ?? null,
    mergedAt: mission.mergedAt ?? null,
    artifacts: [...(/** @type {any} */ (mission).artifacts ?? [])],
    acceptance: /** @type {any} */ (mission).acceptance
      ? {
          at: /** @type {any} */ (mission).acceptance.at,
          by: 'human',
          tip: /** @type {any} */ (mission).acceptance.tip,
          artifacts: [...(/** @type {any} */ (mission).acceptance.artifacts ?? [])],
          ...(/** @type {any} */ (mission).acceptance.note ? { note: /** @type {any} */ (mission).acceptance.note } : {}),
        }
      : null,
  }
}

/**
 * One-line human description of where the mission writes, used by reports.
 * @param {Mission} mission
 * @returns {string | null}
 */
export function describe(mission) {
  return mission.worktree?.branch ? `branch ${mission.worktree.branch}` : null
}

/**
 * #159 is a new kind: no pre-v4 document can be an artifact, so it is never
 * legacy and the migration never claims it.
 * @param {Record<string, any>} _mission
 * @returns {boolean}
 */
export function isLegacy(_mission) {
  return false
}

/**
 * Never reached (`isLegacy` is false for every document); kept so the shape
 * interface stays uniform across the registry.
 * @param {Record<string, any>} mission
 * @returns {Record<string, any>}
 */
export function migrateLegacy(mission) {
  return { ...mission, kind: 'artifact' }
}

export const artifactShape = Object.freeze({
  kind: /** @type {const} */ ('artifact'),
  statuses: ARTIFACT_STATUSES,
  transitions: ARTIFACT_TRANSITIONS,
  isTerminal,
  canTransition,
  isLegacy,
  needsLegacyRead: () => false,
  migrateLegacy,
  canMerge: true,
  canRebase: true,
  provisioning: /** @type {const} */ ('branch-worktree'),
  reach: REACH,
  // Document dimensions this shape owns; the state validator reads these. An
  // artifact owns the declared deliverables and the acceptance record; a build
  // and a survey own neither.
  fields: Object.freeze({ worktree: true, readCommit: false, merge: true, sandbox: false, artifacts: true, acceptance: true }),
  requiredComponent: 'tower-artifact',
  acceptsResult: false,
  evidence: EVIDENCE,
  planFields,
  completion: completionInvariants(
    {
      requiresWorktree: true,
      requiresCommits: true,
      requiresClean: true,
      requiresArtifacts: true,
    },
    /** @type {(ctx: any) => { commits: number }} */ (checkCompletion),
  ),
  completionBlockers,
  dependencySatisfied,
  spawn,
  briefing,
  summary,
  describe,
})
