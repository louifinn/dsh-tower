// Pure decisions extracted from the integration use cases (P3b): merge
// intent/parent/tip validation, rebase intent classification, teardown
// eligibility, init/provision base/path decisions, and preflight blockers.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
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
  mergeIntentEvidence,
  mergeIntentReconcileNote,
  mergeShapeDetail,
  mergeSuccessNote,
  missionMissingResult,
  pendingMergeIntentResult,
  staleBaseResult,
} from '../domain/integration/merge.js'
import {
  alreadyMergedRebaseResult,
  alreadyUpToDateResult,
  ambiguousRebaseIntentMessage,
  buildRebaseIntent,
  classifyRebaseIntent,
  clearedRebaseIntentActivityText,
  malformedRebaseIntent,
  rebaseConflictNote,
  rebaseConflictResult,
  rebaseSuccessNote,
  rebaseSuccessResult,
  rebaseTipsMoved,
  rebaseTipsMovedDetail,
  shortTip,
} from '../domain/integration/rebase.js'
import {
  ownershipUnverifiedDecision,
  replaceDecision,
  revalidateTeardownCandidate,
  teardownActivityText,
  teardownDirtyDecision,
  teardownPrecheck,
  teardownRemoveDecision,
  teardownRemovedDecision,
} from '../domain/integration/teardown.js'
import {
  claimCaller,
  createdInitResult,
  existingInitResult,
  existingInitWriteResult,
  explicitBase,
  fallbackBase,
  initActivityText,
  initialState,
  invalidBaseMessage,
  ownedByOther,
  ownerClaimActivityText,
  reanchorActivityText,
  reanchorBlockedMessage,
  shouldReanchor,
  shouldSnapshot,
  snapshotRefFor,
} from '../domain/integration/init.js'
import { SCHEMA_VERSION } from '../domain/mission.js'
import {
  baseCommitChoice,
  createdWorktreeResult,
  existingWorktreeResult,
  hasMissionId,
  provisionActivityText,
  slugify,
  worktreeBranch,
  worktreePath,
  worktreeRecord,
  worktreeRoot,
} from '../domain/integration/provision.js'
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

test('merge results preserve the app-facing blocker codes and messages', () => {
  assert.deepEqual(missionMissingResult('M1'), {
    ok: false,
    blockers: [{ code: 'mission-missing', detail: 'unknown mission "M1"' }],
  })
  assert.equal(staleBaseResult('M1', 'base moved').blockers[0].code, 'stale-base')
  assert.equal(staleBaseResult('M1', 'base moved').missionId, 'M1')
  assert.deepEqual(alreadyMergedResult({ mergedCommit: 'abc' }, 'base'), {
    ok: true,
    alreadyMerged: true,
    mergedCommit: 'abc',
    baseTip: 'base',
  })
  assert.equal(alreadyMergedResult({}, 'base').mergedCommit, null)
  assert.deepEqual(gateTipDrift({ missionId: 'M1', gateBaseTip: 'a', gateBranchTip: 'b', baseTip: 'a', branchTip: 'b' }), null)
  assert.equal(
    gateTipDrift({ missionId: 'M1', gateBaseTip: 'old', gateBranchTip: 'b', baseTip: 'new', branchTip: 'b' }).blockers[0].code,
    'stale-base',
  )
  assert.equal(
    gateTipDrift({ missionId: 'M1', gateBaseTip: 'a', gateBranchTip: 'old', baseTip: 'a', branchTip: 'new' }).blockers[0].code,
    'tip-moved',
  )
})

test('merge intent and parent validation is pure', () => {
  const intent = buildMergeIntent({ missionId: 'M1', baseTip: 'a', branchTip: 'b', gateTip: 'b', startedAt: 7 })
  assert.equal(intentMatches(intent, intent), true)
  assert.equal(intentMatches({ ...intent, branchTip: 'c' }, intent), false)
  assert.equal(intentMatches(null, intent), false)
  assert.equal(isExpectedMergeShape(['a', 'b'], 'a', 'b'), true)
  assert.equal(isExpectedMergeShape(['b', 'a'], 'a', 'b'), false)
  assert.equal(isExpectedMergeShape(['a'], 'a', 'b'), false)
  assert.deepEqual(pendingMergeIntentResult('M2', { missionId: 'M1' }).blockers[0], {
    code: 'merge-intent-pending',
    detail: 'a merge intent for M1 is recorded; run tower_merge to reconcile it before starting another merge',
  })
  assert.equal(classifyCommitOutcome('merged', ['a', 'b'], 'a', 'b'), 'merged')
  assert.equal(classifyCommitOutcome('merged', ['a', 'x'], 'a', 'b'), 'merge-shape')
  assert.equal(classifyCommitOutcome('merge-conflict', ['a'], 'a', 'b'), 'merge-conflict')
  assert.equal(mergeFailureKind(true), 'merge-conflict')
  assert.equal(mergeFailureKind(false), 'merge-hook-failed')
})

test('merge result and activity strings stay byte-compatible', () => {
  assert.equal(mergeShapeDetail(['a', 'b'], 'a', 'b'), 'unexpected merge parents [a, b], expected [a, b]')
  assert.equal(mergeSuccessNote('branchtip', 'main', 'newtip'), 'merged brancht into main as newtip')
  assert.equal(mergeConflictNote('x'.repeat(300)).length, 'merge conflict: '.length + 240)
  assert.deepEqual(
    mergeBlockedResult({
      missionId: 'M1',
      code: 'merge-hook-failed',
      detail: 'boom',
      timeout: true,
      cleanup: 'reset',
      warnings: ['w'],
    }),
    {
      ok: false,
      missionId: 'M1',
      blockers: [{ code: 'merge-hook-failed', detail: 'boom', timeout: true, cleanup: 'reset' }],
      warnings: ['w'],
    },
  )
  assert.equal(mergeIntentReconcileNote({ landed: null }), 'cleared a merge intent that created no commit')
  assert.equal(
    mergeIntentReconcileNote({ landed: { commit: 'abcdef0123', parents: [] } }),
    'reconciled merge intent; found landed commit abcdef0',
  )
})

test('landed-merge reconciliation selects reviews and ancestry outcomes purely', () => {
  const mission = { id: 'M1', status: 'completed', worktree: { branch: 'tower/m1', path: 'x' }, reviewPolicy: 'required-clean' }
  const review = { missionId: 'M1', branch: 'tower/m1', round: 1, status: 'clean', mergeVerdict: 'merge', reviewedCommit: 'r1' }
  // #M39: review evidence is demanded only by `review.mode:required`; a bare
  // config resolves to the optional default.
  const required = { review: { mode: 'required' } }
  assert.equal(landedMergeCandidate({ ...mission, status: 'active' }, [review], required), null)
  assert.deepEqual(landedMergeCandidate(mission, [review], required), { exempt: false, latest: review })
  assert.equal(
    landedMergeCandidate(mission, [{ ...review, status: 'p1-1items' }], required),
    null,
  )
  assert.deepEqual(
    landedMergeCandidate({ ...mission, reviewPolicy: 'none', reviewExemptionReason: 'single file' }, [], {
      review: { mode: 'required' },
      gates: { allowReviewExemption: true },
    }),
    { exempt: true, latest: null },
  )
  // `off`/`optional` reconcile a landed branch without review evidence.
  for (const mode of ['off', 'optional']) {
    assert.deepEqual(landedMergeCandidate(mission, [], { review: { mode } }), { exempt: true, latest: null })
  }
  assert.deepEqual(
    landedMergeEvidence({
      missionId: 'M1',
      base: 'main',
      baseTip: 'base',
      branchTip: 'tip',
      reviewedTip: 'r1',
      branchLanded: false,
      reviewedLanded: false,
      found: null,
      latest: review,
    }),
    { skip: true },
  )
  const stale = landedMergeEvidence({
    missionId: 'M1',
    base: 'main',
    baseTip: 'base',
    branchTip: 'tip',
    reviewedTip: 'r1',
    branchLanded: false,
    reviewedLanded: true,
    found: null,
    latest: review,
  })
  assert.equal(stale.reviewStale.blockers[0].code, 'review-stale')
  const observed = {
    baseTip: 'base',
    branchTip: 'tip',
    reviewedTip: 'r1',
    found: { commit: 'merge', parents: ['base', 'tip'] },
    mergedCommit: 'merge',
    latest: review,
  }
  assert.deepEqual(landedMergeEvidence({
    missionId: 'M1',
    base: 'main',
    baseTip: 'base',
    branchTip: 'tip',
    reviewedTip: 'r1',
    branchLanded: true,
    reviewedLanded: true,
    found: observed.found,
    latest: review,
  }).measured, observed)
  assert.equal(landedMergeResult(observed).mergedCommit, 'merge')
  assert.equal(landedMergeResult(observed).review.reviewedCommit, 'r1')
  assert.match(landedMergeNote({ found: observed.found, mergedCommit: 'mergecommit', base: 'main' }), /parents \[base, tip\]/)
  assert.match(landedMergeNote({ found: null, mergedCommit: 'mergecommit', base: 'main' }), /no merge commit found/)
  assert.equal(mergeIntentEvidence({ head: 'base', baseTip: 'base', mergeInProgress: false, landed: null }).landed, null)
  assert.equal(mergeIntentEvidence({ head: 'x', baseTip: 'base', mergeInProgress: true, landed: null }), null)
  assert.equal(
    mergeIntentEvidence({ head: 'x', baseTip: 'base', mergeInProgress: false, landed: null }),
    null,
  )
})

test('rebase intent classification covers clear, ambiguous, and record', () => {
  const intent = buildRebaseIntent({
    token: 't',
    missionId: 'M1',
    base: 'main',
    oldTip: 'old',
    baseTip: 'base',
    commits: 2,
    startedAt: 5,
  })
  const mission = { id: 'M1', worktree: { path: 'x' } }
  assert.equal(shortTip('abcdef0123'), 'abcdef0')
  assert.equal(classifyRebaseIntent({ intent, mission: undefined, tipReadable: false, baseIsAncestor: false }).action, 'clear')
  assert.deepEqual(classifyRebaseIntent({ intent, mission, tipReadable: false, baseIsAncestor: false }), {
    action: 'clear',
    reason: 'the worktree is not readable',
  })
  assert.deepEqual(classifyRebaseIntent({ intent, mission, tip: 'old', tipReadable: true, baseIsAncestor: false }), {
    action: 'clear',
    reason: 'the branch tip is unchanged (the rebase never ran)',
  })
  assert.deepEqual(classifyRebaseIntent({ intent, mission, tip: 'moved', tipReadable: true, baseIsAncestor: false }), {
    action: 'ambiguous',
    tip: 'moved',
  })
  assert.equal(
    classifyRebaseIntent({ intent, mission, tip: 'moved', tipReadable: true, baseIsAncestor: true, actualCommits: 3 }).action,
    'ambiguous',
  )
  assert.deepEqual(
    classifyRebaseIntent({ intent, mission, tip: 'moved', tipReadable: true, baseIsAncestor: true, actualCommits: 2 }),
    { action: 'record', tip: 'moved' },
  )
  assert.equal(malformedRebaseIntent(null), true)
  assert.equal(malformedRebaseIntent({ missionId: 'M1' }), true)
  assert.equal(malformedRebaseIntent(intent), false)
  assert.match(ambiguousRebaseIntentMessage(intent, 'abcdef0123'), /tip abcdef0 does not match/)
  assert.match(ambiguousRebaseIntentMessage(intent, 'abcdef0123'), /1970-01-01T00:00:00.005Z/)
})

test('rebase outcomes and notes stay stable', () => {
  assert.deepEqual(alreadyUpToDateResult({ oldTip: 'o', baseTip: 'b' }), {
    ok: true,
    alreadyUpToDate: true,
    oldTip: 'o',
    newTip: 'o',
    baseTip: 'b',
  })
  assert.equal(alreadyMergedRebaseResult({ oldTip: 'oldtip12', baseTip: 'basetip1', base: 'main' }).newTip, 'oldtip12')
  assert.match(alreadyMergedRebaseResult({ oldTip: 'oldtip12', baseTip: 'basetip1', base: 'main' }).note, /call tower_merge/)
  assert.equal(rebaseTipsMoved({ oldTip: 'o', baseTip: 'b', currentTip: 'o', currentBase: 'b' }), false)
  assert.equal(rebaseTipsMoved({ oldTip: 'o', baseTip: 'b', currentTip: 'x', currentBase: 'b' }), true)
  assert.match(
    rebaseTipsMovedDetail({ oldTip: 'oldtip12', baseTip: 'basetip1', currentTip: 'newtip12', currentBase: 'newbase1' }),
    /\(oldtip1\/basetip -> newtip1\/newbase\)/,
  )
  assert.equal(rebaseConflictResult('boom').blockers[0].code, 'rebase-conflict')
  assert.equal(rebaseConflictNote('main', 'abcdef0123'), 'rebase conflict onto main @ abcdef0123')
  assert.deepEqual(rebaseSuccessResult({ oldTip: 'o', newTip: 'n', baseTip: 'b' }), {
    ok: true,
    oldTip: 'o',
    newTip: 'n',
    baseTip: 'b',
    reviewWaived: true,
  })
  assert.equal(rebaseSuccessNote({ oldTip: 'oldtip12', newTip: 'newtip12', baseTip: 'basetip1' }), 'rebased oldtip1 -> newtip1 onto basetip; conflict-free rebase waives re-review')
  assert.equal(clearedRebaseIntentActivityText('the branch tip is unchanged'), 'cleared a stale rebase intent (the branch tip is unchanged)')
})

test('teardown eligibility and candidate revalidation are pure decisions', () => {
  const merged = { id: 'M1', status: 'merged', worktree: { path: 'wt', branch: 'b' } }
  assert.deepEqual(teardownPrecheck(merged), { proceed: true })
  assert.deepEqual(teardownPrecheck({ id: 'M1', status: 'merged' }), { skip: true })
  assert.deepEqual(teardownPrecheck(merged, { excluded: true }), {
    decision: { missionId: 'M1', action: 'keep', reason: 'excluded' },
  })
  assert.deepEqual(teardownPrecheck(merged, { hasLiveAgent: true }), {
    decision: { missionId: 'M1', action: 'keep', reason: 'live agent' },
  })
  assert.deepEqual(teardownPrecheck({ ...merged, status: 'active' }), {
    decision: { missionId: 'M1', action: 'keep', reason: 'mission is active' },
  })
  assert.equal(revalidateTeardownCandidate({ missions: [] }, { missionId: 'M1', worktree: { path: 'wt' } }).reason, 'worktree is already gone')
  assert.equal(
    revalidateTeardownCandidate(
      { missions: [{ ...merged, worktree: { path: 'other', branch: 'b' } }] },
      { missionId: 'M1', worktree: { path: 'wt' } },
    ).reason,
    'worktree path changed during teardown',
  )
  assert.equal(revalidateTeardownCandidate({ missions: [{ ...merged, status: 'active' }] }, { missionId: 'M1', worktree: { path: 'wt' } }).reason, 'mission is active')
  assert.equal(
    revalidateTeardownCandidate(
      { missions: [merged], roster: [{ name: 'w', missionId: 'M1', state: 'running', agentId: 'a' }] },
      { missionId: 'M1', worktree: { path: 'wt' } },
      { a: 'running' },
    ).reason,
    'live agent',
  )
  assert.equal(revalidateTeardownCandidate({ missions: [merged] }, { missionId: 'M1', worktree: { path: 'wt' } }).ok, true)
  assert.deepEqual(teardownDirtyDecision(true, false), { action: 'keep', reason: 'uncommitted changes' })
  assert.equal(teardownDirtyDecision(true, true), null)
  assert.deepEqual(teardownDirtyDecision(false, false), null)
  assert.deepEqual(teardownRemoveDecision(true), { action: 'remove', reason: 'eligible', forced: true })
  assert.deepEqual(teardownRemovedDecision({ branch: 'b', branchDeleteError: 'nope' }), {
    action: 'removed',
    branch: 'b',
    branchRetained: true,
    branchDeleteError: 'nope',
  })
  assert.equal(teardownActivityText('b', 'nope'), 'b (branch retained)')
  assert.equal(teardownActivityText('b'), 'b')
  assert.match(ownershipUnverifiedDecision('M1', new Error('x'.repeat(300))).reason, /^worktree ownership\/registration unverified: x/)
  const decision = { missionId: 'M1', action: 'remove', reason: 'eligible', forced: false }
  replaceDecision(decision, { action: 'keep', reason: 'live agent' })
  assert.deepEqual(decision, { missionId: 'M1', action: 'keep', reason: 'live agent' })
})

test('init base, ownership, snapshot and result decisions are pure', () => {
  assert.equal(explicitBase('  main  '), 'main')
  assert.equal(explicitBase('   '), null)
  assert.equal(explicitBase(3), null)
  assert.equal(invalidBaseMessage('main'), null)
  assert.match(invalidBaseMessage('refs/heads/main'), /must be a local branch name/)
  assert.match(invalidBaseMessage('origin/main'), /must be a local branch name/)
  assert.deepEqual(fallbackBase({ branch: 'work', committed: true }), { base: 'work' })
  assert.deepEqual(fallbackBase({ branch: null, committed: false }), { base: 'main' })
  assert.match(fallbackBase({ branch: null, committed: true }).error, /detached HEAD/)
  assert.equal(ownedByOther('a', 'b'), true)
  assert.equal(ownedByOther(null, 'b'), false)
  assert.equal(claimCaller(null, 'b'), 'b')
  assert.equal(claimCaller('a', 'b'), null)
  assert.match(reanchorBlockedMessage([{ status: 'active' }, { status: 'merged' }]), /1 mission\(s\)/)
  assert.equal(reanchorBlockedMessage([{ status: 'merged' }, { status: 'abandoned' }]), null)
  assert.equal(shouldReanchor({ reanchor: true, reanchorBase: 'release', currentBase: 'main' }), true)
  assert.equal(shouldReanchor({ reanchor: true, reanchorBase: 'main', currentBase: 'main' }), false)
  assert.equal(shouldSnapshot({ snapshotDirty: true, dirty: true }), true)
  assert.equal(shouldSnapshot({ snapshotDirty: true, dirty: false }), false)
  assert.equal(snapshotRefFor('abc'), 'refs/tower/snapshot/abc')
  const state = initialState({ repoRoot: '/repo', commonDir: '/repo/.git', base: 'main', dirty: true, towerAgentId: 'a', snapshotCommit: 's', snapshotRef: 'r', now: 5 })
  assert.deepEqual(state, {
    schemaVersion: SCHEMA_VERSION,
    repoRoot: '/repo',
    commonDir: '/repo/.git',
    base: 'main',
    revision: 0,
    createdAt: 5,
    updatedAt: 5,
    dirtyBase: true,
    caseInsensitive: null,
    towerAgentId: 'a',
    snapshotCommit: 's',
    snapshotRef: 'r',
    missions: [],
  })
  assert.equal(initialState({ repoRoot: '/r', commonDir: '/r/.git', base: 'main', dirty: false, now: 1 }).towerAgentId, undefined)
  assert.equal(
    initialState({ repoRoot: '/r', commonDir: '/r/.git', base: 'main', dirty: false, now: 1, caseInsensitive: true })
      .caseInsensitive,
    true,
  )
  const existing = existingInitResult({ state, statePath: '/state', dirty: true })
  assert.equal(existing.created, false)
  assert.equal(existing.snapshotCommit, 's')
  const write = existingInitWriteResult({ state: { ...state, revision: 3 }, statePath: '/state', dirty: false, reanchored: true })
  assert.equal(write.revision, 3)
  assert.equal(write.reanchored, true)
  const created = createdInitResult({ repoRoot: '/repo', commonDir: '/repo/.git', statePath: '/state', base: 'main', dirty: false, snapshotCommit: null, snapshotRef: null })
  assert.equal(created.created, true)
  assert.equal(created.revision, 0)
  assert.equal(initActivityText({ base: 'main', snapshotCommit: 'abcdef012345', dirty: true }), 'base main snapshot abcdef012345 (dirty base)')
  assert.equal(initActivityText({ base: 'main' }), 'base main')
  assert.equal(ownerClaimActivityText('a'), 'tower owner claimed by a')
  assert.equal(reanchorActivityText('release'), 'base reanchored to release')
})

test('provision base commit, branch, and path decisions are pure', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world')
  assert.equal(slugify('***'), 'mission')
  assert.equal(worktreeBranch({ id: 'M1', title: 'Two Phase' }), 'tower/m1-two-phase')
  assert.deepEqual(baseCommitChoice({ baseCommit: 'explicit' }), { source: 'explicit', commit: 'explicit' })
  assert.deepEqual(baseCommitChoice({ includeDirtyBase: false, snapshotCommit: 'snap', snapshotCommitValid: true }), { source: 'base' })
  assert.deepEqual(baseCommitChoice({ snapshotCommit: 'snap', snapshotCommitValid: true }), { source: 'snapshot', commit: 'snap' })
  assert.deepEqual(baseCommitChoice({ snapshotCommit: 'snap', snapshotCommitValid: false }), { source: 'base' })
  assert.equal(hasMissionId('M1'), true)
  assert.equal(hasMissionId('  '), false)
  assert.equal(worktreeRoot({ worktreeRoot: 'custom', repoRoot: '/repo/x', commonDirHash: 'h' }), path.resolve('custom'))
  assert.equal(worktreeRoot({ configuredRoot: 'configured', repoRoot: '/repo/x', commonDirHash: 'h' }), path.resolve('configured'))
  assert.equal(
    worktreeRoot({ repoRoot: '/repo/x', commonDirHash: 'h' }),
    path.join(path.dirname('/repo/x'), '.dsh-tower-worktrees', 'h'),
  )
  assert.equal(worktreePath('/root', 'M1'), path.join('/root', 'M1'))
  const record = worktreeRecord({ path: '/wt', branch: 'b', baseCommit: 'c', createdAt: 7 })
  assert.equal(record.path, '/wt')
  assert.equal(record.createdAt, 7)
  assert.equal(worktreeRecord({ path: '/wt', branch: 'b', baseCommit: 'c', createdAt: 7, realPath: '/real' }).realPath, '/real')
  assert.deepEqual(existingWorktreeResult({ id: 'M1' }, record).created, false)
  assert.deepEqual(createdWorktreeResult({ id: 'M1' }, record).created, true)
  assert.equal(provisionActivityText('b', '/wt'), 'b at /wt')
})

test('preflight blockers are computed from snapshots without repository I/O', () => {
  assert.deepEqual(missingMissionGateResult('M1'), {
    ok: false,
    blockers: [{ code: 'mission-missing', detail: 'unknown mission "M1"' }],
    missionId: 'M1',
    branchTip: null,
    baseTip: null,
    changedFiles: [],
    review: null,
  })
  assert.deepEqual(mergeIntentPendingBlocker({ missionId: 'M1', startedAt: 0 }), {
    code: 'merge-intent-pending',
    detail: 'a merge intent for M1 was recorded at 1970-01-01T00:00:00.000Z; run tower_merge to reconcile it',
  })
  assert.equal(noWorktreeBlocker('M1').code, 'branch-missing')
  assert.equal(staleBaseBlocker({ branch: 'b', base: 'main', baseTip: 'abcdef0123' }).detail, 'b does not contain base "main" tip abcdef0123; run tower_rebase first')
  assert.equal(surveyChangedFilesBlocker({ missionId: 'M1', changedFiles: [] }), null)
  assert.equal(surveyChangedFilesBlocker({ missionId: 'M1', changedFiles: ['a'] }).code, 'read-only-survey')
  assert.equal(outOfScopeBlocker({ mission: { scope: ['src/**'] }, changedFiles: ['src/a', 'docs/b'] }).code, 'out-of-scope')
  assert.equal(outOfScopeBlocker({ mission: { scope: ['**'] }, changedFiles: ['src/a'] }), null)
  assert.deepEqual(overwrittenPaths(['a', 'b', 'c'], ['x', 'b']), ['b'])
  assert.equal(baseDirtyBlocker([]), null)
  assert.equal(baseDirtyBlocker(['a']).code, 'base-dirty')
  assert.deepEqual(
    dependencyBlockers({
      deps: ['M1', 'M2'],
      state: { missions: [{ id: 'M1', status: 'merged' }, { id: 'M2', status: 'active' }] },
    }),
    [{ code: 'deps-unmerged', detail: 'M2 is active' }],
  )
  assert.equal(baseWrongBranchBlocker({ checkoutBranch: 'main', base: 'main' }), null)
  assert.equal(baseWrongBranchBlocker({ checkoutBranch: null, base: 'main' }).detail, 'main checkout is on detached HEAD, expected "main"')
  assert.deepEqual(
    gateResult({ mission: { id: 'M1' }, worktree: null, branchTip: null, baseTip: null, changedFiles: [], review: null, blockers: [] }),
    { ok: true, blockers: [], mission: { id: 'M1' }, worktree: null, branchTip: null, baseTip: null, changedFiles: [], review: null },
  )
})
