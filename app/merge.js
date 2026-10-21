// Merge use case, split into three phases (#51):
//
//   prepare — outside the state lock: load state, reconcile a stale merge
//             intent / an already-landed merge (Git is only read here, never
//             under the state lock), evaluate the gate, capture the exact
//             base/branch tips, and build the merge plan.
//   act     — record the merge intent under a short state lock, then run the
//             exact captured `git merge` and its failure cleanup outside the
//             state lock but under the repo-scoped git mutex (`withGitLock`).
//   commit  — reload state under a short state lock, verify the state revision
//             policy and the observed merge parents, then write the same
//             merged/blocked/notes outcome the single-phase implementation did.
//
// No git call or process spawn runs inside a `withLock` scope. Reconciliation
// is two-phase too: observe Git unlocked, then write the resulting state
// mutation under a short lock that revalidates the revision it was prepared
// from. A writer that slipped in between observation and write makes the
// prepare stale, so the whole prepare is retried, never partially applied.
import path from 'node:path'
import { withLock, withGitLock, writeJsonAtomic, appendJsonl, exists } from '../lib/store.js'
import { validateState } from '../domain/state.js'
import {
  alreadyMergedResult,
  buildMergeIntent,
  classifyCommitOutcome,
  gateTipDrift,
  intentMatches,
  isExpectedMergeShape,
  landedMergeCandidate,
  landedMergeEvidence,
  landedMergeNote,
  landedMergeResult,
  mergeBlockedResult,
  mergeConflictNote,
  mergeFailureKind,
  mergeHookFailureNote,
  mergeIntentEvidence,
  mergeIntentReconcileNote,
  mergeShapeDetail,
  mergeSuccessNote,
  missionMissingResult,
  pendingMergeIntentResult,
  staleBaseResult,
} from '../domain/integration/merge.js'

// A revision CAS that loses a race is retried this many times before the merge
// reports the same retryable stale-base the previous revision policy produced.
const PREPARE_ATTEMPTS = 3

/** `rev-list --parents -n 1` through the Tower git port (never under the state lock). */
async function readCommitParents(tower, sha) {
  const line = await tower.tryGit(tower.root, ['rev-list', '--parents', '-n', '1', sha])
  return line ? line.trim().split(/\s+/).slice(1) : []
}

/**
 * Find a reachable merge commit whose second parent is one of the known tips.
 * `--no-ff` merges put the integrated branch on the second parent, so this is
 * the concrete evidence that a mission's work already landed in the base.
 * Callers must not hold the state lock: this runs Git.
 */
async function findLandedMerge(tower, baseTip, tips) {
  const revs = (await tower.tryGit(tower.root, ['rev-list', '--merges', baseTip])) ?? ''
  for (const sha of revs.split('\n').filter(Boolean)) {
    const parents = await readCommitParents(tower, sha)
    if (parents.length >= 2 && tips.has(parents[1])) return { commit: sha, parents }
  }
  return null
}

/**
 * Unlocked observation half of `reconcileMergeIntent`: decide from Git whether
 * a recorded intent can be consumed. Returns null when it cannot: the merge is
 * still in progress, HEAD cannot be read, or no evidence shows the intent's
 * merge landed.
 */
async function observeMergeIntent(tower, state, mission) {
  const intent = state.mergeIntent
  if (!intent || intent.missionId !== mission.id || !mission.worktree) return null
  let head
  try {
    head = await tower.revParse(tower.root, 'HEAD')
  } catch {
    return null
  }
  const mergeInProgress = await exists(path.join(tower.commonDir, 'MERGE_HEAD'))
  if (mergeInProgress) return null
  if (head === intent.baseTip) return mergeIntentEvidence({ head, baseTip: intent.baseTip, mergeInProgress, landed: null })
  const tips = new Set([intent.branchTip, intent.baseTip].filter(Boolean))
  const landed = await findLandedMerge(tower, head, tips)
  return mergeIntentEvidence({ head, baseTip: intent.baseTip, mergeInProgress, landed })
}

/**
 * Locked write half of `reconcileMergeIntent`: consume the intent exactly as
 * observed. The revision check makes the write a CAS: if any writer changed
 * state after the observation the reconcile is abandoned and retried against
 * the new state instead of overwriting it.
 */
async function applyMergeIntentReconcile(tower, stateRevision, missionId, evidence) {
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    if (state.revision !== stateRevision) return { retry: true }
    const mission = state.missions.find((entry) => entry.id === missionId)
    if (!mission) return { result: missionMissingResult(missionId) }
    if (!state.mergeIntent || state.mergeIntent.missionId !== mission.id) return { state }
    const now = Date.now()
    delete state.mergeIntent
    state.revision += 1
    state.updatedAt = now
    await writeJsonAtomic(tower.paths.state, state)
    await appendJsonl(tower.paths.activity, {
      at: now,
      type: 'merge',
      missionId: mission.id,
      text: mergeIntentReconcileNote(evidence),
    })
    return { state }
  })
}

/**
 * Unlocked observation half of `reconcileLandedMerge`: the same review /
 * exemption / ancestry evidence rules the domain reconciler applies, but only
 * reading Git. Returns null when there is nothing to reconcile, a
 * `reviewStale` blocker when only the reviewed commit landed, or the evidence
 * needed by the locked write half.
 */
async function observeLandedMerge(tower, state, mission) {
  const candidate = landedMergeCandidate(mission, state.reviews, tower.config)
  if (!candidate) return null
  const { latest } = candidate
  let baseTip
  let branchTip
  try {
    baseTip = await tower.revParse(tower.root, state.base)
    branchTip = await tower.revParse(mission.worktree.path, 'HEAD')
  } catch {
    return null
  }
  const reviewedTip = latest?.reviewedCommit ?? null
  const branchLanded = await tower.isAncestor(tower.root, branchTip, baseTip)
  const reviewedLanded = reviewedTip ? await tower.isAncestor(tower.root, reviewedTip, baseTip) : false
  if (!branchLanded) {
    const evidence = landedMergeEvidence({
      missionId: mission.id,
      base: state.base,
      baseTip,
      branchTip,
      reviewedTip,
      branchLanded,
      reviewedLanded,
      found: null,
      latest,
    })
    return 'reviewStale' in evidence ? { reviewStale: evidence.reviewStale } : null
  }
  const tips = new Set([branchTip, reviewedTip].filter(Boolean))
  const found = await findLandedMerge(tower, baseTip, tips)
  const evidence = landedMergeEvidence({
    missionId: mission.id,
    base: state.base,
    baseTip,
    branchTip,
    reviewedTip,
    branchLanded,
    reviewedLanded,
    found,
    latest,
  })
  return 'measured' in evidence ? evidence.measured : null
}

/** Locked write half of `reconcileLandedMerge`, guarded by the revision CAS. */
async function applyLandedMergeReconcile(tower, stateRevision, missionId, observed) {
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    if (state.revision !== stateRevision) return { retry: true }
    const mission = state.missions.find((entry) => entry.id === missionId)
    if (!mission) return { result: missionMissingResult(missionId) }
    const now = Date.now()
    if (state.mergeIntent?.missionId === mission.id) delete state.mergeIntent
    mission.status = 'merged'
    mission.mergedAt = now
    mission.mergedCommit = observed.mergedCommit
    mission.blockers = []
    mission.notes.push(
      landedMergeNote({ found: observed.found, mergedCommit: observed.mergedCommit, base: state.base }),
    )
    mission.updatedAt = now
    state.revision += 1
    state.updatedAt = now
    validateState(state, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, state)
    await appendJsonl(tower.paths.activity, {
      at: now,
      type: 'merge',
      missionId: mission.id,
      text: `reconciled already-landed ${observed.mergedCommit.slice(0, 7)} on ${state.base}`,
    })
    return { result: landedMergeResult(observed) }
  })
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
 * otherwise surface as a permanent `merge-intent-pending` blocker. Git evidence
 * is gathered unlocked; the state write happens under a short lock that
 * revalidates the revision the observation was made from. A writer that slipped
 * in between makes the prepare stale and it is simply retried, never partially
 * applied and never overwritten.
 */
async function prepareMerge(tower, input, deps) {
  for (let attempt = 0; attempt < PREPARE_ATTEMPTS; attempt += 1) {
    const prepared = await prepareFromState(tower, input, deps)
    if (!prepared.retry) return prepared
  }
  return {
    result: staleBaseResult(input.missionId, 'tower state changed while the merge was being prepared; retry'),
  }
}

async function prepareFromState(tower, input, deps) {
  const { mergeTimeoutMs, MERGE_MAX_BUFFER } = deps
  let state = await tower.load()
  let mission = state.missions.find((entry) => entry.id === input.missionId)
  if (!mission) return { result: missionMissingResult(input.missionId) }

  // Reconcile a stale merge intent: Git runs here, outside every state lock.
  if (state.mergeIntent && state.mergeIntent.missionId === mission.id) {
    const evidence = await observeMergeIntent(tower, state, mission)
    if (evidence) {
      const applied = await applyMergeIntentReconcile(tower, state.revision, mission.id, evidence)
      if (applied.retry) return applied
      if (applied.result) return applied
      state = applied.state
      mission = state.missions.find((entry) => entry.id === input.missionId)
      if (!mission) return { result: missionMissingResult(input.missionId) }
    }
  }

  if (mission.status === 'merged') {
    return { result: alreadyMergedResult(mission, await tower.revParse(tower.root, state.base)) }
  }

  // Reconcile a merge that already landed in Git: observe unlocked, write CAS.
  const landed = await observeLandedMerge(tower, state, mission)
  if (landed) {
    if (landed.reviewStale) return { result: landed.reviewStale }
    const applied = await applyLandedMergeReconcile(tower, state.revision, mission.id, landed)
    if (applied.retry) return applied
    return applied
  }

  const gate = await tower.evaluateGate(input)
  if (!gate.ok) return { result: { ok: false, blockers: gate.blockers, missionId: input.missionId } }

  const worktree = mission.worktree
  // Capture the exact commits this merge is allowed to integrate. The merge
  // command below uses the captured branch SHA, never the mutable branch name.
  const baseTip = await tower.revParse(tower.root, 'HEAD')
  const branchTip = await tower.revParse(worktree.path, 'HEAD')
  const drift = gateTipDrift({
    missionId: mission.id,
    gateBaseTip: gate.baseTip,
    gateBranchTip: gate.branchTip,
    baseTip,
    branchTip,
  })
  if (drift) return { result: drift }

  return {
    stateRevision: state.revision,
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
    if (!mission) return { result: missionMissingResult(plan.missionId) }
    if (mission.status === 'merged') {
      return { result: alreadyMergedResult(mission, plan.baseTip) }
    }
    // Only one merge may be in flight: two prepared merges would otherwise
    // capture the same base tip and the second would build a merge on a moved
    // base. Leave the recorded intent alone for the next reconcile.
    if (state.mergeIntent) {
      return { result: pendingMergeIntentResult(plan.missionId, state.mergeIntent) }
    }
    const now = Date.now()
    state.mergeIntent = buildMergeIntent({
      missionId: mission.id,
      baseTip: plan.baseTip,
      branchTip: plan.branchTip,
      gateTip: plan.gateTip,
      startedAt: now,
    })
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
  const expectedShape = isExpectedMergeShape(parents, intent.baseTip, intent.branchTip)
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
      kind: mergeFailureKind(conflict),
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
    if (!mission) return missionMissingResult(plan.missionId)
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
    const kind = classifyCommitOutcome(
      outcome.kind,
      outcome.parents,
      recorded.intent.baseTip,
      recorded.intent.branchTip,
    )

    if (kind === 'merged') {
      const now = Date.now()
      if (intentActive) delete state.mergeIntent
      mission.status = 'merged'
      mission.mergedAt = now
      mission.mergedCommit = outcome.newTip
      mission.updatedAt = now
      mission.notes.push(mergeSuccessNote(recorded.intent.branchTip, state.base, outcome.newTip))
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
      const detail = mergeShapeDetail(outcome.parents, recorded.intent.baseTip, recorded.intent.branchTip)
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
      mission.blockers.push(mergeConflictNote(outcome.detail))
    } else {
      mission.notes.push(mergeHookFailureNote(outcome.detail, mission.status))
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
    return mergeBlockedResult({
      missionId: mission.id,
      code: conflict ? 'merge-conflict' : 'merge-hook-failed',
      detail: outcome.detail,
      timeout: outcome.timeout === true,
      cleanup: outcome.cleanup,
      warnings: outcome.warnings,
    })
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
