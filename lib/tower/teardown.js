// Worktree teardown use case.
import { withLock, writeJsonAtomic, appendJsonl } from '../store.js'
import { isClean } from '../git.js'
import { validateState } from '../domain/state.js'
import { ROSTER_INACTIVE } from '../domain/roster.js'

export async function teardown(tower, input) {
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      const activity = input.activity ?? {}
      const exclude = new Set(input.exclude ?? [])
      const decisions = []
      const removed = []
      const now = Date.now()

      for (const mission of state.missions) {
        if (!mission.worktree || mission.worktreeRemovedAt) continue
        if (exclude.has(mission.id)) {
          decisions.push({ missionId: mission.id, action: 'keep', reason: 'excluded' })
          continue
        }
        const live = (state.roster ?? []).some(
          (entry) => entry.missionId === mission.id && !ROSTER_INACTIVE.has(entry.state) && activity[entry.agentId] === 'running',
        )
        if (live) {
          decisions.push({ missionId: mission.id, action: 'keep', reason: 'live agent' })
          continue
        }
        if (!['merged', 'abandoned'].includes(mission.status)) {
          decisions.push({ missionId: mission.id, action: 'keep', reason: `mission is ${mission.status}` })
          continue
        }
        try {
          await tower.assertWorktree(mission.worktree)
        } catch (error) {
          decisions.push({
            missionId: mission.id,
            action: 'keep',
            reason: `worktree ownership/registration unverified: ${String(error?.message ?? error).slice(0, 240)}`,
          })
          continue
        }
        let dirty = true
        try {
          dirty = !(await isClean(mission.worktree.path))
        } catch {
          dirty = true
        }
        if (dirty && input.force !== true) {
          decisions.push({ missionId: mission.id, action: 'keep', reason: 'uncommitted changes' })
          continue
        }
        if (input.dryRun === true) {
          decisions.push({ missionId: mission.id, action: 'remove', reason: 'eligible', forced: dirty })
          continue
        }
        try {
          await tower.git(tower.root, ['worktree', 'remove', ...(dirty ? ['--force'] : []), mission.worktree.path])
        } catch (error) {
          decisions.push({ missionId: mission.id, action: 'keep', reason: `remove failed: ${String(error?.message ?? error)}` })
          continue
        }
        let branchDeleteError = null
        try {
          await tower.git(tower.root, ['branch', '-d', mission.worktree.branch])
        } catch (error) {
          branchDeleteError = String(error?.message ?? error).slice(0, 240)
        }
        mission.worktreeRemovedAt = now
        mission.updatedAt = now
        if (branchDeleteError) mission.branchDeleteError = branchDeleteError
        else delete mission.branchDeleteError
        removed.push(mission.id)
        decisions.push({
          missionId: mission.id,
          action: 'removed',
          branch: mission.worktree.branch,
          ...(branchDeleteError ? { branchRetained: true, branchDeleteError } : {}),
        })
        await appendJsonl(tower.paths.activity, {
          at: now,
          type: 'teardown',
          missionId: mission.id,
          text: `${mission.worktree.branch}${branchDeleteError ? ' (branch retained)' : ''}`,
        })
      }

      if (!input.dryRun && removed.length > 0) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, tower.paths.state)
        await writeJsonAtomic(tower.paths.state, state)
      }
      return { ok: true, dryRun: input.dryRun === true, removed, decisions }
    })
  }
