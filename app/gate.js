// Merge/preflight gate evaluation.
import { ROSTER_INACTIVE_STATES } from '../domain/roster.js'
import { completionBlockers, mergeGateBlockers } from '../domain/gate.js'
import { fullMission } from '../domain/summary.js'
import { latestReview, reviewsForBranch } from '../domain/integration/review.js'
import { assertActionSupported } from '../domain/shapes/index.js'
import {
  baseDirtyBlocker,
  baseWrongBranchBlocker,
  dependencyBlockers,
  gateResult,
  mergeIntentPendingBlocker,
  missingMissionGateResult,
  noWorktreeBlocker,
  outOfScopeBlocker,
  overwrittenPaths,
  staleBaseBlocker,
} from '../domain/integration/gate.js'
import { surveyStaleWarnings } from './freshness.js'

/**
 * @typedef {{ status: string, path: string, origPath: string | null }} GitPathChange
 */

/**
 * All paths a change touched, both sides of a rename/copy included. Dropping
 * the source would let a branch move an out-of-scope file into scope and pass
 * the fence while still having changed the source tree.
 * @param {GitPathChange[]} changes
 * @returns {string[]}
 */
export function changePaths(changes) {
  /** @type {string[]} */
  const paths = []
  const seen = new Set()
  for (const change of changes) {
    for (const value of [change.path, change.origPath]) {
      if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
      seen.add(value)
      paths.push(value)
    }
  }
  return paths
}

/**
 * Changed paths for a revision range. The structured reader is preferred
 * because it retains rename sources; the legacy name-only output is kept for
 * vcs ports that do not implement it (scripted/in-memory test doubles).
 * @param {import('./tower.js').Tower} tower
 * @param {string} cwd
 * @param {string} range
 * @returns {Promise<string[]>}
 */
export async function changedPaths(tower, cwd, range) {
  const reader = tower.deps?.vcs?.diffChanges
  if (typeof reader === 'function') {
    return changePaths(await reader.call(tower.deps.vcs, cwd, range))
  }
  const text = await tower.git(cwd, ['diff', '--name-only', range])
  return text.split('\n').filter(Boolean)
}

/**
 * Paths with uncommitted worktree changes, including both sides of a rename.
 * @param {import('./tower.js').Tower} tower
 * @returns {Promise<string[]>}
 */
export async function dirtyPaths(tower) {
  const reader = tower.deps?.vcs?.worktreeChanges
  if (typeof reader === 'function') {
    return changePaths(await reader.call(tower.deps.vcs, tower.root))
  }
  const text = await tower.git(tower.root, ['status', '--porcelain'])
  return text.split('\n').filter(Boolean).map((line) => line.slice(3).trim())
}

export async function evaluateGate(tower, input) {
    const state = await tower.load()
    let mission = state.missions.find((entry) => entry.id === input.missionId)
    let archivedEntry = null
    if (!mission) {
      // A completed mission may have been archived by policy; preflight and
      // merge must behave the same for it as before the move (#73).
      const archived = await tower.archivedMission(input.missionId)
      if (archived.ok && archived.entry) {
        archivedEntry = archived.entry
        mission = archived.entry.mission
      }
    }
    if (!mission) return missingMissionGateResult(input.missionId)
    // A shape without a branch has no merge gate at all; refuse before doing
    // any git work so the caller gets one actionable code (#148 D4).
    assertActionSupported(mission, input.action === 'merge' ? 'merge' : 'preflight')
    const archiveIndex = await tower.archiveIndex()
    const archivedMissions = new Map(
      (archiveIndex.ok ? archiveIndex.missions : []).map((entry) => [entry.id, entry]),
    )
    const reviews = archivedEntry ? [...(state.reviews ?? []), ...(archivedEntry.reviews ?? [])] : state.reviews
    const activity = input.activity ?? {}
    const blockers = []
    const push = (code, detail) => blockers.push({ code, detail })

    for (const blocker of completionBlockers(mission, tower.config)) push(blocker.code, blocker.detail)
    if (state.mergeIntent && state.mergeIntent.missionId === mission.id) {
      const blocker = mergeIntentPendingBlocker(state.mergeIntent)
      push(blocker.code, blocker.detail)
    }

    const worktree = mission.worktree ?? null
    let branchTip = null
    let baseTip = null
    let changedFiles = []
    if (!worktree) {
      const blocker = noWorktreeBlocker(mission.id)
      push(blocker.code, blocker.detail)
    } else {
      try {
        await tower.assertWorktree(worktree)
        branchTip = await tower.branchTip(mission)
        baseTip = await tower.revParse(tower.root, state.base)
        const mergeBase = (await tower.git(worktree.path, ['merge-base', baseTip, branchTip])).trim()
        changedFiles = await changedPaths(tower, worktree.path, `${mergeBase}..${branchTip}`)
        if (!(await tower.isAncestor(tower.root, baseTip, branchTip))) {
          const blocker = staleBaseBlocker({ branch: worktree.branch, base: state.base, baseTip })
          push(blocker.code, blocker.detail)
        }
        const scopeBlocker = outOfScopeBlocker({ mission, changedFiles, caseInsensitive: state.caseInsensitive === true })
        if (scopeBlocker) push(scopeBlocker.code, scopeBlocker.detail)
        const dirty = await dirtyPaths(tower)
        const dirtyBlocker = baseDirtyBlocker(overwrittenPaths(changedFiles, dirty))
        if (dirtyBlocker) push(dirtyBlocker.code, dirtyBlocker.detail)
      } catch (error) {
        push('branch-missing', String(error?.message ?? error))
      }
    }

    for (const blocker of dependencyBlockers({ deps: mission.deps ?? [], state, archived: archivedMissions })) {
      push(blocker.code, blocker.detail)
    }

    // #148 W2: survey evidence freshness is advisory by default. The stable
    // warning shape is what plan/preflight report; `gates.requireFreshSurvey`
    // promotes the same code to a blocker for repositories that need the read
    // to describe the exact base they start from.
    const sandboxWarnings = await surveyStaleWarnings(tower, {
      mission,
      state,
      missions: state.missions,
      archived: archivedMissions,
      baseCommit: mission.baseCommit ?? null,
    })
    if (tower.config.gates?.requireFreshSurvey === true) {
      for (const warning of sandboxWarnings) blockers.push({ ...warning, detail: warning.message })
    }

    const branch = worktree ? worktree.branch : null
    const latest = latestReview(reviewsForBranch(reviews, branch))
    // #140: `mergeGateBlockers` is pure and may not read the component registry, so
    // the composition root publishes `deps.components` and this layer snapshots the
    // one fact the gate needs. Absent (unit tests, custom port bags) means unknown,
    // and the blocker keeps its generic wording.
    const components = /** @type {{ enabled?: (id: string) => boolean, reason?: (id: string) => string } | undefined} */ (
      tower.deps?.components
    )
    const testsComponent = components
      ? {
          enabled: typeof components.enabled === 'function' ? components.enabled('tower-tests') === true : false,
          reason: typeof components.reason === 'function' ? components.reason('tower-tests') : 'disabled by component tower-tests',
        }
      : null
    for (const blocker of mergeGateBlockers({
      mission,
      roster: state.roster ?? [],
      branch,
      branchTip,
      review: latest,
      config: tower.config,
      activity,
      parentStatus: input.parentStatus,
      inactiveStates: ROSTER_INACTIVE_STATES,
      rebaseWaived: latest ? tower.rebaseWaived(mission, latest) : false,
      testsComponent,
    })) push(blocker.code, blocker.detail)

    const checkoutBranch = await tower.deps.vcs.currentBranch(tower.root)
    const wrongBranch = baseWrongBranchBlocker({ checkoutBranch, base: state.base })
    if (wrongBranch) push(wrongBranch.code, wrongBranch.detail)

    return {
      ...gateResult({
        mission: fullMission(mission),
        worktree,
        branchTip,
        baseTip,
        changedFiles,
        review: latest,
        blockers,
      }),
      warnings: sandboxWarnings,
      ...(archivedEntry ? { archived: true } : {}),
    }
  }

  /** Read-only mission diff for reviewers: branch changes against the merge base. */
