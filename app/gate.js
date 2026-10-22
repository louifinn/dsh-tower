// Merge/preflight gate evaluation.
import { currentBranch } from '../lib/git.js'
import { ROSTER_INACTIVE_STATES } from '../domain/roster.js'
import { completionBlockers, mergeGateBlockers } from '../domain/gate.js'
import { fullMission } from '../domain/summary.js'
import { latestReview, reviewsForBranch } from '../domain/integration/review.js'
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
  surveyChangedFilesBlocker,
} from '../domain/integration/gate.js'

export async function evaluateGate(tower, input) {
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === input.missionId)
    if (!mission) return missingMissionGateResult(input.missionId)
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
        branchTip = await tower.revParse(worktree.path, 'HEAD')
        baseTip = await tower.revParse(tower.root, state.base)
        const mergeBase = (await tower.git(worktree.path, ['merge-base', baseTip, branchTip])).trim()
        changedFiles = (await tower.git(worktree.path, ['diff', '--name-only', `${mergeBase}..${branchTip}`]))
          .split('\n')
          .filter(Boolean)
        if (!(await tower.isAncestor(tower.root, baseTip, branchTip))) {
          const blocker = staleBaseBlocker({ branch: worktree.branch, base: state.base, baseTip })
          push(blocker.code, blocker.detail)
        }
        if (mission.kind === 'survey') {
          const blocker = surveyChangedFilesBlocker({ missionId: mission.id, changedFiles })
          if (blocker) push(blocker.code, blocker.detail)
        }
        if (mission.kind !== 'survey') {
          const blocker = outOfScopeBlocker({ mission, changedFiles, caseInsensitive: state.caseInsensitive === true })
          if (blocker) push(blocker.code, blocker.detail)
        }
        const dirty = (await tower.git(tower.root, ['status', '--porcelain']))
          .split('\n')
          .filter(Boolean)
          .map((line) => line.slice(3).trim())
        const blocker = baseDirtyBlocker(overwrittenPaths(changedFiles, dirty))
        if (blocker) push(blocker.code, blocker.detail)
      } catch (error) {
        push('branch-missing', String(error?.message ?? error))
      }
    }

    for (const blocker of dependencyBlockers({ deps: mission.deps ?? [], state })) {
      push(blocker.code, blocker.detail)
    }

    const branch = worktree ? worktree.branch : null
    const latest = latestReview(reviewsForBranch(state.reviews, branch))
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
    })) push(blocker.code, blocker.detail)

    const checkoutBranch = await currentBranch(tower.root)
    const wrongBranch = baseWrongBranchBlocker({ checkoutBranch, base: state.base })
    if (wrongBranch) push(wrongBranch.code, wrongBranch.detail)

    return gateResult({
      mission: fullMission(mission),
      worktree,
      branchTip,
      baseTip,
      changedFiles,
      review: latest,
      blockers,
    })
  }

  /** Read-only mission diff for reviewers: branch changes against the merge base. */
