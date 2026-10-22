// Pure preflight/gate blocker computation from state snapshots plus the Git
// facts the app already read (tips, changed files, checkout branch). The app
// performs every read and owns the result assembly.
// @ts-check
import { caseInsensitiveScopeMatch, fileInScope } from '../scope.js'

/** @typedef {import('../../types/index.js').Blocker} Blocker */
/** @typedef {import('../../types/index.js').Mission} Mission */
/** @typedef {import('../../types/index.js').TowerState} TowerState */

/**
 * @param {string} missionId
 * @returns {object}
 */
export function missingMissionGateResult(missionId) {
  return {
    ok: false,
    blockers: [{ code: 'mission-missing', detail: `unknown mission "${missionId}"` }],
    missionId,
    branchTip: null,
    baseTip: null,
    changedFiles: [],
    review: null,
  }
}

/**
 * @param {{ missionId: string, startedAt?: number }} mergeIntent
 * @returns {Blocker}
 */
export function mergeIntentPendingBlocker(mergeIntent) {
  return {
    code: 'merge-intent-pending',
    detail: `a merge intent for ${mergeIntent.missionId} was recorded at ${new Date(Number(mergeIntent.startedAt) || 0).toISOString()}; run tower_merge to reconcile it`,
  }
}

/**
 * @param {string} missionId
 * @returns {Blocker}
 */
export function noWorktreeBlocker(missionId) {
  return { code: 'branch-missing', detail: `mission ${missionId} has no worktree or branch` }
}

/**
 * @param {object} input
 * @param {string} input.branch
 * @param {string} input.base
 * @param {string} input.baseTip
 * @returns {Blocker}
 */
export function staleBaseBlocker({ branch, base, baseTip }) {
  return {
    code: 'stale-base',
    detail: `${branch} does not contain base "${base}" tip ${baseTip.slice(0, 12)}; run tower_rebase first`,
  }
}

/**
 * @param {object} input
 * @param {string} input.missionId
 * @param {string[]} input.changedFiles
 * @returns {Blocker | null}
 */
export function surveyChangedFilesBlocker({ missionId, changedFiles }) {
  return changedFiles.length > 0
    ? {
        code: 'read-only-survey',
        detail: `survey ${missionId} is read-only but ${changedFiles.length} file(s) changed: ${changedFiles.slice(0, 5).join(', ')}`,
      }
    : null
}

/**
 * @param {object} input
 * @param {Mission} input.mission
 * @param {string[]} input.changedFiles
 * @param {boolean} [input.caseInsensitive] the checkout's detected comparison mode
 * @returns {Blocker | null}
 */
export function outOfScopeBlocker({ mission, changedFiles, caseInsensitive = false }) {
  const outOfScope = changedFiles.filter((file) => !fileInScope(mission.scope, file, { caseInsensitive }))
  if (outOfScope.length === 0) return null
  const parts = [`changed files outside scope (${mission.scope.join(', ')}): ${outOfScope.slice(0, 8).join(', ')}`]
  // On a case-sensitive checkout a case-only mismatch is a human error worth
  // naming, but it stays a rejection: folding here would make src/Api and
  // src/api the same directory on a filesystem where they are not (#90).
  if (!caseInsensitive) {
    const hints = outOfScope
      .map((file) => {
        const pattern = caseInsensitiveScopeMatch(mission.scope, file)
        return pattern
          ? `${file} matches "${pattern}" only when case is folded; this checkout is case-sensitive`
          : null
      })
      .filter(Boolean)
      .slice(0, 3)
    if (hints.length > 0) parts.push(`case mismatch: ${hints.join('; ')}`)
  }
  return { code: 'out-of-scope', detail: parts.join('. ') }
}

/**
 * @param {string[]} changedFiles
 * @param {string[]} dirty
 * @returns {string[]}
 */
export function overwrittenPaths(changedFiles, dirty) {
  return changedFiles.filter((file) => dirty.includes(file))
}

/**
 * @param {string[]} wouldOverwrite
 * @returns {Blocker | null}
 */
export function baseDirtyBlocker(wouldOverwrite) {
  return wouldOverwrite.length > 0
    ? {
        code: 'base-dirty',
        detail: `main checkout has uncommitted changes this merge would overwrite: ${wouldOverwrite.slice(0, 8).join(', ')}`,
      }
    : null
}

/**
 * @param {object} input
 * @param {string[]} input.deps
 * @param {TowerState} input.state
 * @param {Map<string, { status: string }>} [input.archived] compact archived missions (#73)
 * @returns {Blocker[]}
 */
export function dependencyBlockers({ deps = [], state, archived = new Map() }) {
  /** @type {Blocker[]} */
  const blockers = []
  for (const depId of deps) {
    const dep = state.missions.find((entry) => entry.id === depId) ?? archived.get(depId)
    if (!dep || !['merged', 'abandoned'].includes(dep.status)) {
      blockers.push({ code: 'deps-unmerged', detail: `${depId} is ${dep ? dep.status : 'missing'}` })
    }
  }
  return blockers
}

/**
 * @param {object} input
 * @param {string | null} input.checkoutBranch
 * @param {string} input.base
 * @returns {Blocker | null}
 */
export function baseWrongBranchBlocker({ checkoutBranch, base }) {
  return checkoutBranch !== base
    ? { code: 'base-wrong-branch', detail: `main checkout is on ${checkoutBranch ?? 'detached HEAD'}, expected "${base}"` }
    : null
}

/**
 * Append every blocker produced by a decision helper.
 * @param {Blocker[]} blockers
 * @param {Blocker | null} blocker
 * @returns {Blocker[]}
 */
export function pushBlocker(blockers, blocker) {
  if (blocker) blockers.push(blocker)
  return blockers
}

/**
 * @param {object} input
 * @param {object} input.mission full mission projection
 * @param {object | null} input.worktree
 * @param {string | null} input.branchTip
 * @param {string | null} input.baseTip
 * @param {string[]} input.changedFiles
 * @param {object | null} input.review
 * @param {Blocker[]} input.blockers
 * @returns {object}
 */
export function gateResult({ mission, worktree, branchTip, baseTip, changedFiles, review, blockers }) {
  return {
    ok: blockers.length === 0,
    blockers,
    mission,
    worktree,
    branchTip,
    baseTip,
    changedFiles,
    review,
  }
}
