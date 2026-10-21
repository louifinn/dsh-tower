// Merge use case, split into three phases (#51):
//
//   prepare — outside the state lock: load/reconcile state (a short lock keeps
//             the reconciliation read-modify-write safe), evaluate the gate,
//             capture the exact base/branch tips, and build the merge plan.
//   act     — record the merge intent under a short state lock, then run the
//             exact captured `git merge` and its failure cleanup outside the
//             state lock but under the repo-scoped git mutex (`withGitLock`).
//   commit  — reload state under a short state lock, verify the state revision
//             policy and the observed merge parents, then write the same
//             merged/blocked/notes outcome the single-phase implementation did.
//
// The only git calls that still run under the state lock are the bounded
// intent/landed reconciliation reads that `tower.js` owns (rev-parse,
// merge-base, rev-list); the long merge subprocess and every cleanup operation
// never run under it.
import path from 'node:path'
import { withLock, withGitLock, writeJsonAtomic, appendJsonl, exists } from '../store.js'
import { validateState } from '../domain/state.js'

function missionMissing(missionId) {
  return { ok: false, blockers: [{ code: 'mission-missing', detail: `unknown mission "${missionId}"` }] }
}

function staleBaseResult(missionId, detail) {
  return { ok: false, missionId, blockers: [{ code: 'stale-base', detail }] }
}

function intentMatches(current, intent) {
  return Boolean(
    current &&
      current.missionId === intent.missionId &&
      current.baseTip === intent.baseTip &&
      current.branchTip === intent.branchTip,
  )
}

function isExpectedShape(parents, baseTip, branchTip) {
  return Array.isArray(parents) && parents.length === 2 && parents[0] === baseTip && parents[1] === branchTip
}

async function dirtyPaths(tower) {
  const text = await tower.git(tower.root, ['status', '--porcelain'])
  return text.split('\n').filter(Boolean).map((line) => line.slice(3).trim())
}

/**
 * Phase 1: everything that can be decided without holding the state lock.
 *
 * Reconciliation is the one mutation that must happen before the gate: a stale
 * merge intent (crashed merge, merge that landed before it was recorded) would
 * otherwise surface as a permanent `merge-intent-pending` blocker. It is kept
 * behind a short lock so its read-modify-write cannot lose a concurrent update;
 * the long merge work below never runs under that lock.
 */
async function prepareMerge(tower, input, deps) {
  const { mergeTimeoutMs, MERGE_MAX_BUFFER } = deps

  const reconciled = await withLock(tower.paths, async () => {
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === input.missionId)
    if (!mission) return { result: missionMissing(input.missionId) }
    if (state.mergeIntent && state.mergeIntent.missionId === mission.id) {
      await tower.reconcileMergeIntent(state, mission)
    }
    if (mission.status === 'merged') {
      return {
        result: {
          ok: true,
          alreadyMerged: true,
          mergedCommit: mission.mergedCommit ?? null,
          baseTip: await tower.revParse(tower.root, state.base),
        },
      }
    }
    const landed = await tower.reconcileLandedMerge(state, mission)
    if (landed) return { result: landed }
    return { state, mission, stateRevision: state.revision }
  })
  if (reconciled.result) return reconciled

  const gate = await tower.evaluateGate(input)
  if (!gate.ok) return { result: { ok: false, blockers: gate.blockers, missionId: input.missionId } }

  const mission = reconciled.mission
  const worktree = mission.worktree
  // Capture the exact commits this merge is allowed to integrate. The merge
  // command below uses the captured branch SHA, never the mutable branch name.
  const baseTip = await tower.revParse(tower.root, 'HEAD')
  const branchTip = await tower.revParse(worktree.path, 'HEAD')
  if (gate.baseTip && gate.baseTip !== baseTip) {
    return {
      result: staleBaseResult(
        mission.id,
        `base moved after gate (${gate.baseTip.slice(0, 7)} -> ${baseTip.slice(0, 7)}); re-run preflight`,
      ),
    }
  }
  if (gate.branchTip && gate.branchTip !== branchTip) {
    return {
      result: {
        ok: false,
        missionId: mission.id,
        blockers: [
          {
            code: 'tip-moved',
            detail: `branch moved after gate (${gate.branchTip.slice(0, 7)} -> ${branchTip.slice(0, 7)}); re-run preflight`,
          },
        ],
      },
    }
  }

  return {
    stateRevision: reconciled.stateRevision,
    missionId: mission.id,
    missionTitle: mission.title,
    baseTip,
    branchTip,
    gateTip: gate.branchTip ?? branchTip,
    changedFiles: gate.changedFiles ?? [],
    timeoutMs: mergeTimeoutMs(input.timeoutMs, tower.config),
    maxBuffer: tower.config.merge.maxBufferBytes || MERGE_MAX_BUFFER,
  }
}

/**
 * Record the intent under a short state lock, immediately before Git runs.
 * A crash between the merge commit and the outcome write is reconciled by the
 * next tower_merge/preflight instead of leaving an unexplained base tip.
 */
async function recordMergeIntent(tower, plan) {
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    // State revision policy: the plan was built from `plan.stateRevision`; a
    // writer that slipped in before any Git mutation makes the plan stale and
    // the operation safely retryable.
    if (state.revision !== plan.stateRevision) {
      return {
        result: staleBaseResult(
          plan.missionId,
          `tower state changed while the merge was being prepared (${plan.stateRevision} -> ${state.revision}); retry`,
        ),
      }
    }
    const mission = state.missions.find((entry) => entry.id === plan.missionId)
    if (!mission) return { result: missionMissing(plan.missionId) }
    if (mission.status === 'merged') {
      return {
        result: {
          ok: true,
          alreadyMerged: true,
          mergedCommit: mission.mergedCommit ?? null,
          baseTip: plan.baseTip,
        },
      }
    }
    // Only one merge may be in flight: two prepared merges would otherwise
    // capture the same base tip and the second would build a merge on a moved
    // base. Leave the recorded intent alone for the next reconcile.
    if (state.mergeIntent) {
      return {
        result: {
          ok: false,
          missionId: plan.missionId,
          blockers: [
            {
              code: 'merge-intent-pending',
              detail: `a merge intent for ${state.mergeIntent.missionId} is recorded; run tower_merge to reconcile it before starting another merge`,
            },
          ],
        },
      }
    }
    const now = Date.now()
    state.mergeIntent = {
      missionId: mission.id,
      baseTip: plan.baseTip,
      branchTip: plan.branchTip,
      gateTip: plan.gateTip,
      startedAt: now,
    }
    state.revision += 1
    state.updatedAt = now
    await writeJsonAtomic(tower.paths.state, state)
    return { intent: state.mergeIntent, intentRevision: state.revision }
  })
}

/**
 * Phase 2: run the exact captured merge and its failure cleanup. No state lock
 * is held here; `withGitLock` serializes this against other Tower git mutations.
 */
async function runMergeGit(tower, plan, intent, deps) {
  const { describeGitFailure, commitParents, removeStaleGitLocks } = deps
  let failure = null
  try {
    // Merge the exact reviewed commit, never a mutable branch name. A branch
    // move after the gate must not smuggle extra commits into base.
    await tower.git(
      tower.root,
      ['merge', '--no-ff', intent.branchTip, '-m', `tower: merge ${plan.missionId} — ${plan.missionTitle}`],
      { timeoutMs: plan.timeoutMs, maxBuffer: plan.maxBuffer },
    )
  } catch (error) {
    failure = error
  }

  const newTip = await tower.revParse(tower.root, 'HEAD')
  const parents = await commitParents(tower.root, newTip)
  const expectedShape = isExpectedShape(parents, intent.baseTip, intent.branchTip)
  const warnings = []

  if (failure && expectedShape) {
    warnings.push(
      `merge command reported a failure (${describeGitFailure(failure)}) but merge commit ${newTip.slice(0, 7)} exists; treated as merged`,
    )
    const dirty = await dirtyPaths(tower)
    if (dirty.length > 0) {
      const changed = new Set(plan.changedFiles)
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
          await tower.git(tower.root, ['reset', '--hard', intent.baseTip]).catch(() => {})
          cleanup = 'reset'
        }
      }
    } else if (newTip !== intent.baseTip) {
      // HEAD moved without Tower's expected merge shape. This may be a
      // concurrent commit; never hard-reset it away. Leave a visible
      // manual-recovery state instead.
      cleanup = 'manual-required'
      warnings.push('HEAD moved unexpectedly during a failed merge; left in place for manual recovery')
    }
    // A killed git process can leave the index staged even without MERGE_HEAD.
    // Restore only when every dirty path belongs to this merge.
    const dirtyAfter = await dirtyPaths(tower)
    if (dirtyAfter.length > 0) {
      const changed = new Set(plan.changedFiles)
      if (newTip === intent.baseTip && dirtyAfter.every((file) => changed.has(file))) {
        await removeStaleGitLocks(tower.commonDir)
        await tower.git(tower.root, ['reset', '--hard', intent.baseTip]).catch(() => {})
        cleanup = cleanup === 'none' ? 'reset' : `${cleanup}+reset`
      } else {
        warnings.push(`cleanup left changes for manual review: ${dirtyAfter.slice(0, 5).join(', ')}`)
      }
    }
    return {
      kind: conflict ? 'merge-conflict' : 'merge-hook-failed',
      detail: describeGitFailure(failure).slice(0, 2000),
      cleanup,
      warnings,
      timeout: failure.timedOut === true,
    }
  }

  if (!expectedShape) {
    return { kind: 'merge-shape', newTip, parents, warnings }
  }
  return { kind: 'merged', newTip, parents, warnings }
}

/** Phase 3: apply the observed outcome under a short state lock. */
async function commitMerge(tower, plan, recorded, outcome) {
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === plan.missionId)
    if (!mission) return missionMissing(plan.missionId)
    // State revision policy: another writer changed the state while Git was
    // running. Do not overwrite their update and do not guess: keep the merge
    // intent (the pending marker) so the next tower_merge/preflight reconciles
    // the landed commit. Nothing has been written by this call yet.
    if (state.revision !== recorded.intentRevision) {
      return staleBaseResult(
        plan.missionId,
        `tower state changed while the merge was running (${recorded.intentRevision} -> ${state.revision}); the merge intent is retained — retry tower_merge to reconcile`,
      )
    }
    const intentActive = intentMatches(state.mergeIntent, recorded.intent)
    // The parents were read from HEAD immediately after the merge while the git
    // mutex was still held. Re-verify them here: recording a "merged" mission is
    // only safe when HEAD is [intent.baseTip, intent.branchTip].
    const expectedShape =
      outcome.kind === 'merged' && isExpectedShape(outcome.parents, recorded.intent.baseTip, recorded.intent.branchTip)
    const kind = outcome.kind === 'merged' && !expectedShape ? 'merge-shape' : outcome.kind

    if (kind === 'merged') {
      const now = Date.now()
      if (intentActive) delete state.mergeIntent
      mission.status = 'merged'
      mission.mergedAt = now
      mission.mergedCommit = outcome.newTip
      mission.updatedAt = now
      mission.notes.push(
        `merged ${recorded.intent.branchTip.slice(0, 7)} into ${state.base} as ${outcome.newTip.slice(0, 7)}`,
      )
      state.revision += 1
      state.updatedAt = now
      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
      await appendJsonl(tower.paths.activity, {
        at: now,
        type: 'merge',
        missionId: mission.id,
        text: `${recorded.intent.branchTip.slice(0, 7)} -> ${outcome.newTip.slice(0, 7)} on ${state.base}`,
      })
      return {
        ok: true,
        mergedCommit: outcome.newTip,
        baseTip: recorded.intent.baseTip,
        branchTip: recorded.intent.branchTip,
        parents: outcome.parents,
        ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings, recoveredFromFailure: true } : {}),
      }
    }

    if (kind === 'merge-shape') {
      // Keep the intent and the observed tip. A shape mismatch means Tower
      // cannot prove what landed; deleting the intent here would make the
      // moved base unreconcilable and could discard a real commit.
      const detail = `unexpected merge parents [${outcome.parents.join(', ')}], expected [${recorded.intent.baseTip}, ${recorded.intent.branchTip}]`
      if (intentActive) {
        state.mergeIntent.problem = { code: 'merge-shape', newTip: outcome.newTip, parents: outcome.parents, at: Date.now() }
        state.revision += 1
        state.updatedAt = Date.now()
        await writeJsonAtomic(tower.paths.state, state)
        await appendJsonl(tower.paths.activity, {
          at: state.updatedAt,
          type: 'merge',
          missionId: mission.id,
          text: `shape-mismatch newTip=${outcome.newTip.slice(0, 12)} parents=${outcome.parents.length}`,
        })
      }
      return {
        ok: false,
        missionId: mission.id,
        blockers: [{ code: 'merge-shape', detail, cleanup: 'manual-required' }],
        newTip: outcome.newTip,
        parents: outcome.parents,
        intentRetained: true,
      }
    }

    // merge-conflict / merge-hook-failed: the merge created no commit.
    const conflict = kind === 'merge-conflict'
    const now = Date.now()
    if (intentActive) delete state.mergeIntent
    if (conflict) {
      mission.status = 'blocked'
      mission.blockers.push(`merge conflict: ${outcome.detail.slice(0, 240)}`)
    } else {
      mission.notes.push(
        `merge command failed before creating a commit (${outcome.detail.slice(0, 240)}); mission left ${mission.status} for retry`,
      )
    }
    mission.updatedAt = now
    state.revision += 1
    state.updatedAt = now
    await writeJsonAtomic(tower.paths.state, state)
    await appendJsonl(tower.paths.activity, {
      at: now,
      type: 'merge',
      missionId: mission.id,
      text: `${conflict ? 'conflict' : 'failed-before-commit'} (${outcome.cleanup})`,
    })
    return {
      ok: false,
      missionId: mission.id,
      blockers: [
        {
          code: conflict ? 'merge-conflict' : 'merge-hook-failed',
          detail: outcome.detail,
          ...(outcome.timeout === true ? { timeout: true } : {}),
          cleanup: outcome.cleanup,
        },
      ],
      ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
    }
  })
}

export async function merge(tower, input, deps) {
  const plan = await prepareMerge(tower, input, deps)
  if (plan.result) return plan.result

  const acted = await withGitLock(tower.paths, async () => {
    // No Git mutation has happened yet: a base that moved after prepare is a
    // clean retryable stale-base rejection, with no intent left behind.
    const head = await tower.revParse(tower.root, 'HEAD')
    if (head !== plan.baseTip) {
      return {
        result: staleBaseResult(
          plan.missionId,
          `base moved after gate (${plan.baseTip.slice(0, 7)} -> ${head.slice(0, 7)}); re-run preflight`,
        ),
      }
    }
    const recorded = await recordMergeIntent(tower, plan)
    if (recorded.result) return recorded
    const outcome = await runMergeGit(tower, plan, recorded.intent, deps)
    return { recorded, outcome }
  })
  if (acted.result) return acted.result

  return commitMerge(tower, plan, acted.recorded, acted.outcome)
}
