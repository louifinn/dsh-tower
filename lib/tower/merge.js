// Merge use case.
import path from 'node:path'
import { withLock, writeJsonAtomic, appendJsonl, exists } from '../store.js'
import { revParse } from '../git.js'
import { validateState } from '../domain/state.js'

export async function merge(tower, input, deps) {
  const { describeGitFailure, mergeTimeoutMs, commitParents, removeStaleGitLocks, MERGE_MAX_BUFFER } = deps
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      const mission = state.missions.find((entry) => entry.id === input.missionId)
      if (!mission) {
        return { ok: false, blockers: [{ code: 'mission-missing', detail: `unknown mission "${input.missionId}"` }] }
      }
      await tower.reconcileMergeIntent(state, mission)
      const baseTip = await revParse(tower.root, state.base)
      if (mission.status === 'merged') {
        return { ok: true, alreadyMerged: true, mergedCommit: mission.mergedCommit ?? null, baseTip }
      }
      const reconciled = await tower.reconcileLandedMerge(state, mission)
      if (reconciled) return reconciled
      const gate = await tower.evaluateGate(input)
      if (!gate.ok) return { ok: false, blockers: gate.blockers, missionId: input.missionId }

      const worktree = mission.worktree
      const baseTipBefore = await revParse(tower.root, 'HEAD')
      const branchTip = await revParse(worktree.path, 'HEAD')
      if (gate.baseTip && gate.baseTip !== baseTipBefore) {
        return {
          ok: false,
          missionId: mission.id,
          blockers: [{ code: 'stale-base', detail: `base moved after gate (${gate.baseTip.slice(0, 7)} -> ${baseTipBefore.slice(0, 7)}); re-run preflight` }],
        }
      }
      if (gate.branchTip && gate.branchTip !== branchTip) {
        return {
          ok: false,
          missionId: mission.id,
          blockers: [{ code: 'tip-moved', detail: `branch moved after gate (${gate.branchTip.slice(0, 7)} -> ${branchTip.slice(0, 7)}); re-run preflight` }],
        }
      }
      // Record the intent before touching Git; a crash between merge and state
      // write can be reconciled by the next tower_merge/preflight instead of
      // leaving an unexplained base tip.
      state.mergeIntent = {
        missionId: mission.id,
        baseTip: baseTipBefore,
        branchTip,
        gateTip: gate.branchTip ?? branchTip,
        startedAt: Date.now(),
      }
      state.revision += 1
      state.updatedAt = state.mergeIntent.startedAt
      await writeJsonAtomic(tower.paths.state, state)
      const timeoutMs = mergeTimeoutMs(input.timeoutMs, tower.config)
      let failure = null
      try {
        // Merge the exact reviewed commit, never a mutable branch name. A
        // branch move after the gate must not smuggle extra commits into base.
        await tower.git(
          tower.root,
          ['merge', '--no-ff', branchTip, '-m', `tower: merge ${mission.id} — ${mission.title}`],
          { timeoutMs, maxBuffer: tower.config.merge.maxBufferBytes || MERGE_MAX_BUFFER },
        )
      } catch (error) {
        failure = error
      }

      const newTip = await revParse(tower.root, 'HEAD')
      const parents = await commitParents(tower.root, newTip)
      const expectedShape = parents.length === 2 && parents[0] === baseTipBefore && parents[1] === branchTip
      const warnings = []

      if (failure && expectedShape) {
        warnings.push(
          `merge command reported a failure (${describeGitFailure(failure)}) but merge commit ${newTip.slice(0, 7)} exists; treated as merged`,
        )
        const dirty = (await tower.git(tower.root, ['status', '--porcelain']))
          .split('\n')
          .filter(Boolean)
          .map((line) => line.slice(3).trim())
        if (dirty.length > 0) {
          const changed = new Set(gate.changedFiles ?? [])
          if (dirty.every((file) => changed.has(file))) {
            await tower.git(tower.root, ['reset', '--hard', 'HEAD'])
            warnings.push('restored index/worktree to the merge commit (only merge-related paths were dirty)')
          } else {
            warnings.push('working tree still has unrelated changes; left untouched — inspect it before the next Git operation')
          }
        }
      } else if (failure) {
        const unmerged = (await tower.tryGit(tower.root, ['ls-files', '-u'])) ?? ''
        const conflict = unmerged.trim().length > 0
        let cleanup = 'none'
        const mergeHeadPath = path.join(tower.commonDir, 'MERGE_HEAD')
        if (await exists(mergeHeadPath)) {
          try {
            await tower.git(tower.root, ['merge', '--abort'])
            cleanup = 'aborted'
          } catch {
            await removeStaleGitLocks(tower.commonDir)
            try {
              await tower.git(tower.root, ['merge', '--abort'])
              cleanup = 'aborted-after-lock-cleanup'
            } catch {
              await tower.git(tower.root, ['reset', '--hard', baseTipBefore]).catch(() => {})
              cleanup = 'reset'
            }
          }
        } else if (newTip !== baseTipBefore) {
          // HEAD moved without Tower's expected merge shape. This may be a
          // concurrent commit; never hard-reset it away. Leave a visible
          // manual-recovery state instead.
          cleanup = 'manual-required'
          warnings.push('HEAD moved unexpectedly during a failed merge; left in place for manual recovery')
        }
        // A killed git process can leave the index staged even without
        // MERGE_HEAD. Restore only when every dirty path belongs to this merge.
        const dirtyAfter = (await tower.git(tower.root, ['status', '--porcelain']))
          .split('\n')
          .filter(Boolean)
          .map((line) => line.slice(3).trim())
        if (dirtyAfter.length > 0) {
          const changed = new Set(gate.changedFiles ?? [])
          if (newTip === baseTipBefore && dirtyAfter.every((file) => changed.has(file))) {
            await removeStaleGitLocks(tower.commonDir)
            await tower.git(tower.root, ['reset', '--hard', baseTipBefore]).catch(() => {})
            cleanup = cleanup === 'none' ? 'reset' : `${cleanup}+reset`
          } else {
            warnings.push(`cleanup left changes for manual review: ${dirtyAfter.slice(0, 5).join(', ')}`)
          }
        }
        const detail = describeGitFailure(failure).slice(0, 2000)
        const now = Date.now()
        delete state.mergeIntent
        if (conflict) {
          mission.status = 'blocked'
          mission.blockers.push(`merge conflict: ${detail.slice(0, 240)}`)
        } else {
          mission.notes.push(`merge command failed before creating a commit (${detail.slice(0, 240)}); mission left ${mission.status} for retry`)
        }
        mission.updatedAt = now
        state.revision += 1
        state.updatedAt = now
        await writeJsonAtomic(tower.paths.state, state)
        await appendJsonl(tower.paths.activity, { at: now, type: 'merge', missionId: mission.id, text: `${conflict ? 'conflict' : 'failed-before-commit'} (${cleanup})` })
        return {
          ok: false,
          missionId: mission.id,
          blockers: [
            {
              code: conflict ? 'merge-conflict' : 'merge-hook-failed',
              detail,
              ...(failure.timedOut === true ? { timeout: true } : {}),
              cleanup,
            },
          ],
          ...(warnings.length > 0 ? { warnings } : {}),
        }
      }

      if (!expectedShape) {
        // Keep the intent and the observed tip. A shape mismatch means Tower
        // cannot prove what landed; deleting the intent here would make the
        // moved base unreconcilable and could discard a real commit.
        const detail = `unexpected merge parents [${parents.join(', ')}], expected [${baseTipBefore}, ${branchTip}]`
        state.mergeIntent.problem = { code: 'merge-shape', newTip, parents, at: Date.now() }
        state.revision += 1
        state.updatedAt = Date.now()
        await writeJsonAtomic(tower.paths.state, state)
        await appendJsonl(tower.paths.activity, {
          at: state.updatedAt,
          type: 'merge',
          missionId: mission.id,
          text: `shape-mismatch newTip=${newTip.slice(0, 12)} parents=${parents.length}`,
        })
        return {
          ok: false,
          missionId: mission.id,
          blockers: [
            {
              code: 'merge-shape',
              detail,
              cleanup: 'manual-required',
            },
          ],
          newTip,
          parents,
          intentRetained: true,
        }
      }

      const now = Date.now()
      delete state.mergeIntent
      mission.status = 'merged'
      mission.mergedAt = now
      mission.mergedCommit = newTip
      mission.updatedAt = now
      mission.notes.push(`merged ${branchTip.slice(0, 7)} into ${state.base} as ${newTip.slice(0, 7)}`)
      state.revision += 1
      state.updatedAt = now
      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
      await appendJsonl(tower.paths.activity, {
        at: now,
        type: 'merge',
        missionId: mission.id,
        text: `${branchTip.slice(0, 7)} -> ${newTip.slice(0, 7)} on ${state.base}`,
      })
      return {
        ok: true,
        mergedCommit: newTip,
        baseTip: baseTipBefore,
        branchTip,
        parents,
        ...(warnings.length > 0 ? { warnings, recoveredFromFailure: true } : {}),
      }
    })
  }
