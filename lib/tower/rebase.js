// Rebase use case.
import { withLock, writeJsonAtomic, appendJsonl } from '../store.js'
import { revParse, isAncestor, isClean } from '../git.js'
import { validateState } from '../domain/state.js'
import { ROSTER_INACTIVE } from '../domain/roster.js'

function fail(message) {
  throw new Error(message)
}

export async function rebase(tower, input) {
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      const mission = state.missions.find((entry) => entry.id === input.missionId)
      if (!mission) fail(`unknown mission "${input.missionId}"`)
      if (!mission.worktree) fail(`mission ${mission.id} has no worktree to rebase`)
      const activity = input.activity ?? {}
      for (const entry of (state.roster ?? []).filter((row) => row.missionId === mission.id && !ROSTER_INACTIVE.has(row.state))) {
        if (activity[entry.agentId] === 'running') {
          return { ok: false, blockers: [{ code: 'worker-busy', detail: `agent ${entry.name} is running; rebase refused` }] }
        }
      }
      await tower.assertWorktree(mission.worktree)
      if (!(await isClean(mission.worktree.path))) {
        return { ok: false, blockers: [{ code: 'worktree-dirty', detail: `${mission.worktree.path} has uncommitted changes` }] }
      }
      const oldTip = await revParse(mission.worktree.path, 'HEAD')
      const baseTip = await revParse(tower.root, state.base)
      if (await isAncestor(tower.root, oldTip, baseTip)) {
        // The branch is already contained in the base (manual merge, crashed
        // merge, earlier fast-forward). Rewriting the branch tip to the base
        // would destroy the reviewed tip and the ability to record the merge.
        return {
          ok: true,
          alreadyMerged: true,
          skipped: true,
          oldTip,
          newTip: oldTip,
          baseTip,
          note: `${oldTip.slice(0, 7)} is already contained in ${state.base} ${baseTip.slice(0, 7)}; branch left untouched — call tower_merge to record the landed merge`,
        }
      }
      if (await isAncestor(tower.root, baseTip, oldTip)) {
        return { ok: true, alreadyUpToDate: true, oldTip, newTip: oldTip, baseTip }
      }
      const now = Date.now()
      try {
        await tower.git(mission.worktree.path, ['rebase', baseTip])
      } catch (error) {
        await tower.git(mission.worktree.path, ['rebase', '--abort']).catch(() => {})
        mission.status = 'blocked'
        mission.blockers.push(`rebase conflict onto ${state.base} @ ${baseTip.slice(0, 12)}`)
        mission.updatedAt = now
        state.revision += 1
        state.updatedAt = now
        await writeJsonAtomic(tower.paths.state, state)
        await appendJsonl(tower.paths.activity, { at: now, type: 'rebase', missionId: mission.id, text: 'conflict' })
        return { ok: false, blockers: [{ code: 'rebase-conflict', detail: String(error?.message ?? error) }] }
      }
      const newTip = await revParse(mission.worktree.path, 'HEAD')
      mission.rebase = { at: now, oldTip, newTip, baseTip }
      if (mission.status === 'blocked') mission.status = 'active'
      mission.notes.push(
        `rebased ${oldTip.slice(0, 7)} -> ${newTip.slice(0, 7)} onto ${baseTip.slice(0, 7)}; conflict-free rebase waives re-review`,
      )
      mission.updatedAt = now
      state.revision += 1
      state.updatedAt = now
      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
      await appendJsonl(tower.paths.activity, {
        at: now,
        type: 'rebase',
        missionId: mission.id,
        text: `${oldTip.slice(0, 7)} -> ${newTip.slice(0, 7)} onto ${baseTip.slice(0, 7)}`,
      })
      return { ok: true, oldTip, newTip, baseTip, reviewWaived: true }
    })
  }
