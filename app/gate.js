// Merge/preflight gate evaluation.
import { currentBranch } from '../lib/git.js'
import { ROSTER_INACTIVE_STATES } from '../domain/roster.js'
import { completionBlockers, mergeGateBlockers } from '../domain/gate.js'
import { fullMission } from '../domain/summary.js'
import { fileInScope } from '../domain/scope.js'

export async function evaluateGate(tower, input) {
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === input.missionId)
    if (!mission) {
      return {
        ok: false,
        blockers: [{ code: 'mission-missing', detail: `unknown mission "${input.missionId}"` }],
        missionId: input.missionId,
        branchTip: null,
        baseTip: null,
        changedFiles: [],
        review: null,
      }
    }
    const activity = input.activity ?? {}
    const blockers = []
    const push = (code, detail) => blockers.push({ code, detail })

    for (const blocker of completionBlockers(mission, tower.config)) push(blocker.code, blocker.detail)
    if (state.mergeIntent && state.mergeIntent.missionId === mission.id) {
      push(
        'merge-intent-pending',
        `a merge intent for ${state.mergeIntent.missionId} was recorded at ${new Date(Number(state.mergeIntent.startedAt) || 0).toISOString()}; run tower_merge to reconcile it`,
      )
    }

    const worktree = mission.worktree ?? null
    let branchTip = null
    let baseTip = null
    let changedFiles = []
    if (!worktree) {
      push('branch-missing', `mission ${mission.id} has no worktree or branch`)
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
          push(
            'stale-base',
            `${worktree.branch} does not contain base "${state.base}" tip ${baseTip.slice(0, 12)}; run tower_rebase first`,
          )
        }
        if (mission.kind === 'survey' && changedFiles.length > 0) {
          push('read-only-survey', `survey ${mission.id} is read-only but ${changedFiles.length} file(s) changed: ${changedFiles.slice(0, 5).join(', ')}`)
        }
        if (mission.kind !== 'survey') {
          const outOfScope = changedFiles.filter((file) => !fileInScope(mission.scope, file))
          if (outOfScope.length > 0) {
            push('out-of-scope', `changed files outside scope (${mission.scope.join(', ')}): ${outOfScope.slice(0, 8).join(', ')}`)
          }
        }
        const dirty = (await tower.git(tower.root, ['status', '--porcelain']))
          .split('\n')
          .filter(Boolean)
          .map((line) => line.slice(3).trim())
        const wouldOverwrite = changedFiles.filter((file) => dirty.includes(file))
        if (wouldOverwrite.length > 0) {
          push('base-dirty', `main checkout has uncommitted changes this merge would overwrite: ${wouldOverwrite.slice(0, 8).join(', ')}`)
        }
      } catch (error) {
        push('branch-missing', String(error?.message ?? error))
      }
    }

    for (const depId of mission.deps ?? []) {
      const dep = state.missions.find((entry) => entry.id === depId)
      if (!dep || !['merged', 'abandoned'].includes(dep.status)) {
        push('deps-unmerged', `${depId} is ${dep ? dep.status : 'missing'}`)
      }
    }

    const branch = worktree ? worktree.branch : null
    const reviews = branch ? (state.reviews ?? []).filter((review) => review.branch === branch) : []
    const latest = reviews.length > 0 ? reviews.reduce((a, b) => (a.round >= b.round ? a : b)) : null
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
    if (checkoutBranch !== state.base) {
      push('base-wrong-branch', `main checkout is on ${checkoutBranch ?? 'detached HEAD'}, expected "${state.base}"`)
    }

    return {
      ok: blockers.length === 0,
      blockers,
      mission: fullMission(mission),
      worktree,
      branchTip,
      baseTip,
      changedFiles,
      review: latest,
    }
  }

  /** Read-only mission diff for reviewers: branch changes against the merge base. */
