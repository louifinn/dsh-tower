// The `record` path for a merge whose landable work already shipped (#248).
//
// Split out of `app/merge.js` when the two observation/write halves pushed that
// file past the 800-line architecture ceiling. The phase split documented at the
// top of `app/merge.js` still governs this module: every Git read here happens
// outside the state lock, and the single write happens under a short lock that
// revalidates the revision it was prepared from.
// @ts-check
import { validateState } from '../domain/state.js'
import {
  applyLandedMerge,
  landedMergeCandidate,
  landedRecordDecision,
  landedUnrecordedResult,
  missionMissingResult,
  recordedMergeNote,
  recordedMergeResult,
} from '../domain/integration/merge.js'
import { latestReview, reviewsForBranch } from '../domain/integration/review.js'
import { appendActivityAfterGit } from './merge-write.js'

/**
 * `rev-list --parents -n 1` through the Tower git port (never under the state lock).
 * @param {any} tower
 * @param {string} sha
 * @returns {Promise<string[]>}
 */
async function readCommitParents(tower, sha) {
  const line = await tower.tryGit(tower.root, ['rev-list', '--parents', '-n', '1', sha])
  return line ? line.trim().split(/\s+/).slice(1) : []
}

/**
 * Last merge commit reachable from `baseTip` that integrated one of `tips`.
 * @param {any} tower
 * @param {string} baseTip
 * @param {Set<string>} tips
 * @returns {Promise<{ commit: string, parents: string[] } | null>}
 */
export async function findLandedMerge(tower, baseTip, tips) {
  const listed = (await tower.tryGit(tower.root, ['rev-list', '--merges', baseTip])) ?? ''
  for (const commit of listed.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const parents = await readCommitParents(tower, commit)
    if (!parents || parents.length < 2) continue
    if (parents.slice(1).some((parent) => tips.has(parent))) return { commit, parents }
  }
  return null
}

/**
 * Did this one commit reach the base — either as an ancestor, or as a patch
 * that is already there under another SHA (a cherry-pick landing)?
 *
 * The second half is what makes `content-equivalent` usable: in that shape the
 * branch is *by definition* not an ancestor of the base, so an ancestry-only
 * test would refuse the very commits the caller has to name. `git cherry`
 * answers exactly this question: a `-` line means "an equivalent patch is
 * already upstream".
 *
 * @param {any} tower
 * @param {string} baseTip
 * @param {string} commit
 * @returns {Promise<{ landed: boolean, equivalent: boolean }>}
 */
async function commitLanding(tower, baseTip, commit) {
  if (await tower.isAncestor(tower.root, commit, baseTip)) return { landed: true, equivalent: false }
  const cherry = await tower.tryGit(tower.root, ['cherry', baseTip, commit])
  if (cherry === null) return { landed: false, equivalent: false }
  const equivalent = cherry
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => line.startsWith('-'))
  return { landed: equivalent, equivalent }
}

/**
 * ##248 unlocked observation half of the `record` path: everything the decision
 * needs, read from Git. Returns null when the branch or the base cannot be
 * resolved, so the caller reports the ordinary `branch-missing` / `stale-base`
 * instead of pretending the work landed.
 * @param {any} tower
 * @param {any} state
 * @param {any} mission
 * @param {{ reason: string, commits?: string[] }} record
 * @returns {Promise<any | null>}
 */
export async function observeRecordFacts(tower, state, mission, record) {
  const candidate = landedMergeCandidate(mission, state.reviews, tower.config)
  let baseTip
  let branchTip
  try {
    baseTip = await tower.revParse(tower.root, state.base)
    branchTip = await tower.branchTip(mission)
  } catch {
    return null
  }
  const branchReviews = reviewsForBranch(state.reviews, mission.worktree?.branch)
  const latest = latestReview(branchReviews)
  const reviewedTip = latest?.reviewedCommit ?? null
  const branchLanded = await tower.isAncestor(tower.root, branchTip, baseTip)
  const reviewedLanded = reviewedTip ? await tower.isAncestor(tower.root, reviewedTip, baseTip) : false
  const commits = []
  for (const commit of record?.commits ?? []) {
    const landing = await commitLanding(tower, baseTip, commit)
    commits.push({ commit, landed: landing.landed, equivalent: landing.equivalent })
  }
  const tips = new Set([branchTip, reviewedTip].filter(Boolean))
  const found = branchLanded ? await findLandedMerge(tower, baseTip, tips) : null
  if (!branchLanded && commits.length === 0) return null
  return { candidate, base: state.base, baseTip, branchTip, reviewedTip, branchLanded, reviewedLanded, commits, found }
}

/**
 * Locked write half of the `record` path. The same revision CAS the automatic
 * reconcile uses; the note carries the caller's statement so the activity log
 * answers "who says this shipped".
 * @param {any} tower
 * @param {number} stateRevision
 * @param {string} missionId
 * @param {any} observed
 * @returns {Promise<{ retry: true } | { result: object }>}
 */
export async function applyLandedRecordWrite(tower, stateRevision, missionId, observed) {
  return tower.withStateLock(async (/** @type {any} */ _paths, /** @type {any} */ held) => {
    const state = await tower.load()
    if (state.revision !== stateRevision) return { retry: true }
    const mission = state.missions.find((/** @type {any} */ entry) => entry.id === missionId)
    if (!mission) return { result: missionMissingResult(missionId) }
    const now = Date.now()
    if (state.mergeIntent?.missionId === mission.id) delete state.mergeIntent
    const applied = applyLandedMerge({
      mission,
      mergedCommit: observed.mergedCommit,
      note: recordedMergeNote({
        base: state.base,
        mergedCommit: observed.mergedCommit,
        record: observed.record,
        basis: observed.basis,
        reviewedTip: observed.reviewedTip,
        latest: observed.latest,
        commits: observed.commits,
      }),
      now,
    })
    state.revision += 1
    state.updatedAt = now
    validateState(state, tower.paths.state)
    await tower.writeState(state, held)
    await appendActivityAfterGit(
      tower,
      {
        at: now,
        type: 'merge',
        missionId: mission.id,
        text: `recorded already-landed ${observed.mergedCommit.slice(0, 7)} on ${state.base} (${observed.basis}): ${observed.record.reason}`,
      },
      `the merge commit ${observed.mergedCommit.slice(0, 12)} was already in Git and the mission record is committed; only the record activity line could not be appended`,
    )
    tower.emitEvents(applied.events, { revision: state.revision, at: now })
    return { result: recordedMergeResult(observed) }
  })
}

/**
 * Unlocked read for the "the work shipped, the record did not" diagnosis
 * (#248). Returns the `landed-unrecorded` result when the branch is contained
 * in the base without a clean review at its tip, or when every commit of the
 * branch is already in the base by patch equivalence (a cherry-pick landing, so
 * the tip is not an ancestor). Returns null in every other case, leaving the
 * ordinary gate to report a branch that still needs re-review.
 *
 * This runs no state write and no merge: it only turns a dead end into the one
 * call that resolves it.
 * @param {any} tower
 * @param {any} state
 * @param {any} mission
 * @returns {Promise<object | null>}
 */
export async function observeUnrecordedLanding(tower, state, mission) {
  if (!['completed', 'blocked'].includes(mission.status)) return null
  if (!mission.worktree) return null
  let baseTip
  let branchTip
  try {
    baseTip = await tower.revParse(tower.root, state.base)
    branchTip = await tower.branchTip(mission)
  } catch {
    return null
  }
  const branchReviews = reviewsForBranch(state.reviews, mission.worktree.branch)
  const latest = latestReview(branchReviews)
  const reviewedTip = latest?.reviewedCommit ?? null
  const cleanAtTip =
    latest !== null && latest.status === 'clean' && latest.mergeVerdict === 'merge' && reviewedTip === branchTip
  if (cleanAtTip) return null
  const branchLanded = await tower.isAncestor(tower.root, branchTip, baseTip)
  if (branchLanded) {
    return landedUnrecordedResult({
      missionId: mission.id,
      base: state.base,
      branchTip,
      reviewedTip,
      latest,
      basis: 'review-superseded',
    })
  }
  // Not an ancestor. A cherry-pick landing shows up as patch equivalence for
  // every commit of the branch; `git cherry` answers exactly that question.
  const commits = (await tower.tryGit(tower.root, ['rev-list', `${baseTip}..${branchTip}`])) ?? ''
  const shas = commits.split('\n').map((line) => line.trim()).filter(Boolean)
  if (shas.length === 0) return null
  const cherry = await tower.tryGit(tower.root, ['cherry', baseTip, branchTip])
  if (cherry === null) return null
  const equivalent = cherry
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.startsWith('-'))
    .map((line) => line.slice(1).trim())
  if (equivalent.length !== shas.length) return null
  return landedUnrecordedResult({
    missionId: mission.id,
    base: state.base,
    branchTip,
    reviewedTip,
    latest,
    basis: 'content-equivalent',
    commits: equivalent,
  })
}

/**
 * The structural decision for a `record` call, kept next to its two halves so a
 * reader sees observation → decision → write in one place.
 * @param {any} tower
 * @param {any} state
 * @param {any} mission
 * @param {{ reason: string, commits?: string[] }} record
 * @returns {Promise<{ facts: any, decision: any } | null>}
 */
export async function decideLandedRecord(tower, state, mission, record) {
  const facts = await observeRecordFacts(tower, state, mission, record)
  if (!facts) return null
  const decision = landedRecordDecision({
    mission,
    reviews: state.reviews,
    config: tower.config,
    record,
    facts,
  })
  return { facts, decision }
}
