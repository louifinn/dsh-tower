// Tower domain: repo-scoped mission state machine, validation, and gates.
import path from 'node:path'
import { fsp } from '../adapters/store-fs.js'
import { defaultDeps } from '../adapters/default.js'
import { validateCreate as validateBatchCreate, validateClose as validateBatchClose, summarize as summarizeBatch } from '../domain/batch.js'
import { assertOwnership } from '../lib/worktreeOwnership.js'

import { runtimeConfig, resolveRepoConfig } from '../lib/config.js'
import { rebaseWaived } from '../domain/gate.js'
export { ROSTER_INACTIVE_STATES } from '../domain/roster.js'

export { fileInScope, scopesOverlap, validateTitle, normalizeScope } from '../domain/scope.js'
export { missionSummary } from '../domain/summary.js'

export { MISSION_STATUSES, SCHEMA_VERSION, MERGE_VERDICTS, FINDING_TYPES, FINDING_SEVERITIES, FINDING_STATUSES, FINDING_TRANSITIONS } from '../domain/mission.js'
import { TowerToolError } from '../domain/errors.js'
import { plan } from './plan.js'
import { updateMission } from './mission.js'
import { checkCompletion, complete } from './checkCompletion.js'
import { missionContext } from './missionContext.js'
import { enrichedMissions } from './enrichedMissions.js'
import { writeBoard, boardFile } from './board.js'
import { recordSpawnOutcome, recordInterrupt, reserveRoster, recordSpawn, rosterView } from './spawn.js'
import { recordTestRun, recordLegacySnapshot, recordLegacyMap } from './recording.js'

export const ROLES = ['worker', 'reviewer']
const MAX_REVIEW_ROUNDS = 5
const DEFAULT_MERGE_TIMEOUT_MS = 15 * 60 * 1000
const MERGE_MAX_BUFFER = 64 * 1024 * 1024

function mergeTimeoutMs(value, config) {
  if (value === undefined || value === null) {
    const configured = (config ?? runtimeConfig()).merge.timeoutMs
    return Number.isInteger(configured) && configured >= 1000 ? configured : DEFAULT_MERGE_TIMEOUT_MS
  }
  const ms = Number(value)
  if (!Number.isInteger(ms) || ms < 1000) fail('timeoutMs must be an integer of at least 1000 milliseconds')
  return ms
}

async function commitParents(cwd, sha) {
  const line = await defaultDeps.vcs.tryGit(cwd, ['rev-list', '--parents', '-n', '1', sha])
  return line ? line.trim().split(/\s+/).slice(1) : []
}

/**
 * Find a reachable merge commit whose second parent is one of the known tips.
 * `--no-ff` merges put the integrated branch on the second parent, so this is
 * the concrete evidence that a mission's work already landed in the base.
 */
async function findLandedMerge(cwd, baseTip, tips) {
  const revs = (await defaultDeps.vcs.tryGit(cwd, ['rev-list', '--merges', baseTip])) ?? ''
  for (const sha of revs.split('\n').filter(Boolean)) {
    const parents = await commitParents(cwd, sha)
    if (parents.length >= 2 && tips.has(parents[1])) return { commit: sha, parents }
  }
  return null
}

function describeGitFailure(error) {
  const prefix = error?.timedOut ? 'timed out: ' : error?.bufferOverflow ? 'output buffer overflow: ' : ''
  return `${prefix}${String(error?.message ?? error)}`
}

/** Remove only lock files that are provably old. A fresh lock may belong to a
 * concurrent Git process; deleting it would let two writers into the index. */
async function removeStaleGitLocks(commonDir, maxAgeMs = 60000) {
  const removed = []
  for (const name of ['index.lock', 'HEAD.lock', 'MERGE_HEAD.lock', 'ORIG_HEAD.lock']) {
    const file = path.join(commonDir, name)
    try {
      const stat = await fsp.stat(file)
      if (Date.now() - stat.mtimeMs < maxAgeMs) continue
      await fsp.unlink(file)
      removed.push(name)
    } catch {
      // absent or in use; never force it
    }
  }
  return removed
}

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

import { validateState } from '../domain/state.js'
import { boardMarkdown } from '../domain/report.js'
import { diff, missionDetail, status } from './read.js'
import { evaluateGate } from './gate.js'
import { submitReview } from './review.js'
import { teardown } from './teardown.js'
import { rebase } from './rebase.js'
import { merge } from './merge.js'
import { init } from './init.js'
import { provision } from './provision.js'
import { addFinding, readFindings, findings } from './findings.js'
import { recordMessage, recordDelivery, inbox } from './messages.js'
import { createBatch, closeBatch, abandonBatch, batchStatus } from './batch.js'
import { recordRosterObservations, reconcileObservedInactive, markRetired, markMissing, sweepRoster, unreadFor } from './roster.js'
export { validateState } from '../domain/state.js'

export class Tower {
  /**
   * @param {{ root: string, commonDir: string, branch?: string | null }} repo
   * @param {import('../types/index.js').TowerConfig} [config]
   */
  constructor(repo, config, deps = defaultDeps) {
    this.root = repo.root
    this.commonDir = repo.commonDir
    this.branch = repo.branch
    this.deps = deps
    this.paths = this.deps.store.pathsFor(repo.commonDir)
    // Effective config for this repository: code defaults < profile config <
    // repo config file. Per-call tool arguments are applied by the caller.
    this.config = /** @type {import('../types/index.js').TowerConfig} */ (config ?? { ...runtimeConfig(), configPath: null, repoConfigPresent: false })
  }

  static async open(repoRoot) {
    const repo = await defaultDeps.vcs.resolveRepo(repoRoot)
    const config = await resolveRepoConfig(repo)
    return new Tower(repo, config)
  }

  git(cwd, args, options = {}) {
    return this.deps.vcs.git(cwd, args, { timeoutMs: this.config.git?.timeoutMs, ...options })
  }

  tryGit(cwd, args, options = {}) {
    return this.deps.vcs.tryGit(cwd, args, { timeoutMs: this.config.git?.timeoutMs, ...options })
  }

  async revParse(cwd, ref) {
    return (await this.git(cwd, ['rev-parse', ref])).trim()
  }

  async isClean(cwd) {
    return (await this.git(cwd, ['status', '--porcelain'])).trim().length === 0
  }

  async isAncestor(cwd, ancestor, descendant) {
    return (await this.tryGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant].filter(Boolean))) !== null
  }

  async load() {
    if (!(await this.deps.store.exists(this.paths.state))) {
      fail(`tower is not initialized for ${this.root} — run tower_init first`, 'not-initialized')
    }
    const state = await this.deps.store.readJson(this.paths.state)
    return validateState(state, this.paths.state)
  }

  /** #51 two-phase init: see the prepare/act/commit helpers in `./tower/init.js`. */
  async init(input = {}) {
    return init(this, input)
  }

  async plan(input = {}) {
    return plan(this, input)
  }

  async mission(input = {}) {
    return updateMission(this, input)
  }

  assertOutside(target) {
    const resolved = path.resolve(target)
    const inside = (parent) => {
      const rel = path.relative(path.resolve(parent), resolved)
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
    }
    if (resolved === path.resolve(this.root) || inside(this.root)) {
      fail(`worktree path must be outside the main checkout: ${resolved}`)
    }
    if (resolved === path.resolve(this.commonDir) || inside(this.commonDir)) {
      fail(`worktree path must be outside Git metadata: ${resolved}`)
    }
    return resolved
  }

  async assertWorktree(worktree) {
    if (!worktree || typeof worktree.path !== 'string') fail('mission has no worktree')
    const owned = await assertOwnership({
      storedPath: worktree.path,
      storedRealPath: worktree.realPath,
      branch: worktree.branch,
      commonDir: this.commonDir,
      missionId: worktree.missionId,
    })
    worktree.realPath = owned.realPath
    const registered = await this.deps.vcs.listWorktrees(this.root)
    if (!registered.some((entry) => path.resolve(entry.path) === path.resolve(owned.path))) {
      fail(`worktree ${owned.path} is not registered with git`)
    }
    return worktree
  }

  /** Record that a spawned agent failed or went idle, so roster state is truthful. */
  async recordSpawnOutcome(input) {
    return recordSpawnOutcome(this, input)
  }

  /** Record that a live agent was interrupted by the tower. */
  async recordInterrupt(input) {
    return recordInterrupt(this, input)
  }

  /** #51 two-phase provision: see the prepare/act/commit helpers in `./tower/provision.js`. */
  async provision(input = {}) {
    return provision(this, input)
  }

  async missionContext(missionId) {
    return missionContext(this, missionId)
  }

  /** Reserve a roster name before activation so a failed spawn is recoverable. */
  async reserveRoster(input) {
    return reserveRoster(this, input)
  }

  async recordSpawn(input) {
    return recordSpawn(this, input)
  }

  async rosterView() {
    return rosterView(this)
  }

  async recordTestRun(input = {}) {
    return recordTestRun(this, input)
  }

  async recordLegacySnapshot(snapshot) {
    return recordLegacySnapshot(this, snapshot)
  }

  async recordLegacyMap(map) {
    return recordLegacyMap(this, map)
  }

  async createBatch(input = {}, actor = 'tower') {
    return createBatch(this, input, actor)
  }

  async closeBatch(batchId, options = {}, actor = 'tower') {
    return closeBatch(this, batchId, options, actor)
  }

  async abandonBatch(batchId, actor = 'tower', reason = null) {
    return abandonBatch(this, batchId, actor, reason)
  }

  async batchStatus(batchId) {
    return batchStatus(this, batchId)
  }

  async recordRosterObservations(input = {}) {
    return recordRosterObservations(this, input)
  }

  async reconcileObservedInactive(activity = {}) {
    return reconcileObservedInactive(this, activity)
  }

  async markRetired(agentIds) {
    return markRetired(this, agentIds)
  }

  async markMissing(agentIds) {
    return markMissing(this, agentIds)
  }

  async sweepRoster(input = {}) {
    return sweepRoster(this, input)
  }

  async recordMessage(input) {
    return recordMessage(this, input)
  }

  async recordDelivery(messageId, results) {
    return recordDelivery(this, messageId, results)
  }

  async inbox(input) {
    return inbox(this, input)
  }

  async checkCompletion(input) {
    return checkCompletion(this, input)
  }

  async complete(input) {
    return complete(this, input)
  }

  async addFinding(input) {
    return addFinding(this, input)
  }

  async readFindings(input = {}) {
    return readFindings(this, input)
  }

  async findings(input = {}) {
    return findings(this, input)
  }

  async submitReview(input) {
    return submitReview(this, input)
  }

  /** Full detail for one mission, including reviews, findings and recent activity. */
  async missionDetail(missionId) {
    return missionDetail(this, missionId)
  }

  /** Human-readable mission board (markdown) for the current state. */
  boardMarkdown(state) {
    return boardMarkdown(state)
  }

  async ensureExcluded(target) {
    if (this.config.init?.autoExclude === false) return { inside: false, excluded: false }
    const absolute = path.resolve(String(target))
    const relative = path.relative(this.root, absolute)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { inside: false, excluded: false }
    }
    const pattern = relative.split(path.sep).join('/')
    const file = path.join(this.commonDir, 'info', 'exclude')
    await this.deps.store.ensureDir(path.dirname(file))
    let text = ''
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch {
      text = ''
    }
    const lines = text.split(/\r?\n/)
    if (lines.includes(pattern) || lines.includes(`${pattern}/`)) return { inside: true, excluded: true, pattern }
    const suffix = text === '' || text.endsWith('\n') ? '' : '\n'
    await fsp.appendFile(file, `${suffix}${pattern}\n`, 'utf8')
    return { inside: true, excluded: true, pattern }
  }

  async writeBoard() {
    return writeBoard(this)
  }

  unreadFor(state, name) {
    return unreadFor(this, state, name)
  }

  boardFile() {
    return boardFile(this)
  }

  async enrichedMissions(state, onlyIds) {
    return enrichedMissions(this, state, onlyIds)
  }

  rebaseWaived(mission, review) {
    return rebaseWaived(mission, review)
  }

  async evaluateGate(input) {
    return evaluateGate(this, input)
  }

  async diff(input = {}) {
    return diff(this, input)
  }

  /**
   * Record a merge that already landed in Git without being recorded here:
   * a crashed/timed-out merge, a manual merge, or a rebase that fast-forwarded
   * the branch to the base tip. The evidence is concrete: a clean merge review
   * exists and either the branch tip or the reviewed commit is already an
   * ancestor of the base.
   */
  /** Clear a stale merge intent only when the crash left no merge in progress
   * or no merge commit. Returns true when the intent was consumed. */
  async reconcileMergeIntent(state, mission) {
    const intent = state.mergeIntent
    if (!intent || intent.missionId !== mission.id || !mission.worktree) return false
    let head = null
    try {
      head = await this.revParse(this.root, 'HEAD')
    } catch {
      return false
    }
    const mergeHeadPath = path.join(this.commonDir, 'MERGE_HEAD')
    const inProgress = await this.deps.store.exists(mergeHeadPath)
    if (inProgress) return false
    let landed = null
    if (head === intent.baseTip) {
      landed = null // no merge commit was created; the intent is safe to drop
    } else {
      landed = await findLandedMerge(
        this.root,
        head,
        new Set([intent.branchTip, intent.baseTip].filter(Boolean)),
      ).catch(() => null)
      if (!landed) return false
    }
    const now = Date.now()
    delete state.mergeIntent
    state.revision += 1
    state.updatedAt = now
    await this.deps.store.writeJsonAtomic(this.paths.state, state)
    await this.deps.store.appendJsonl(this.paths.activity, {
      at: now,
      type: 'merge',
      missionId: mission.id,
      text: landed
        ? `reconciled merge intent; found landed commit ${String(landed.commit).slice(0, 7)}`
        : 'cleared a merge intent that created no commit',
    })
    return true
  }

  async reconcileLandedMerge(state, mission) {
    if (!['completed', 'blocked'].includes(mission.status)) return null
    if (!mission.worktree) return null
    const branch = mission.worktree.branch
    const reviews = (state.reviews ?? []).filter((review) => review.branch === branch)
    const exempt =
      this.config.review?.requireReview === false ||
      (mission.reviewPolicy === 'none' &&
        this.config.gates?.allowReviewExemption === true &&
        String(mission.reviewExemptionReason ?? '').trim().length > 0)
    if (reviews.length === 0 && !exempt) return null
    const latest = reviews.length > 0 ? reviews.reduce((a, b) => (a.round >= b.round ? a : b)) : null
    if (latest && !exempt && (latest.status !== 'clean' || latest.mergeVerdict !== 'merge')) return null
    if (!latest && !exempt) return null
    let baseTip
    let branchTip
    try {
      baseTip = await this.revParse(this.root, state.base)
      branchTip = await this.revParse(mission.worktree.path, 'HEAD')
    } catch {
      return null
    }
    const reviewedTip = latest?.reviewedCommit ?? null
    const branchLanded = await this.isAncestor(this.root, branchTip, baseTip)
    const reviewedLanded = reviewedTip ? await this.isAncestor(this.root, reviewedTip, baseTip) : false
    if (!branchLanded) {
      if (reviewedLanded) {
        return {
          ok: false,
          missionId: mission.id,
          blockers: [
            {
              code: 'review-stale',
              detail: `reviewed commit ${reviewedTip.slice(0, 7)} is contained in ${state.base}, but branch tip ${branchTip.slice(0, 7)} is not; the branch was partially landed or moved — re-review or repair manually`,
            },
          ],
        }
      }
      return null
    }
    const tips = new Set([branchTip, reviewedTip].filter(Boolean))
    const found = await findLandedMerge(this.root, baseTip, tips)
    const mergedCommit = found ? found.commit : branchTip
    const now = Date.now()
    if (state.mergeIntent?.missionId === mission.id) delete state.mergeIntent
    mission.status = 'merged'
    mission.mergedAt = now
    mission.mergedCommit = mergedCommit
    mission.blockers = []
    mission.notes.push(
      found
        ? `reconciled already-landed merge ${mergedCommit.slice(0, 7)} with parents [${found.parents.map((parent) => parent.slice(0, 7)).join(', ')}]`
        : `reconciled already-landed merge: ${mergedCommit.slice(0, 7)} is contained in ${state.base} (no merge commit found)`,
    )
    mission.updatedAt = now
    state.revision += 1
    state.updatedAt = now
    validateState(state, this.paths.state)
    await this.deps.store.writeJsonAtomic(this.paths.state, state)
    await this.deps.store.appendJsonl(this.paths.activity, {
      at: now,
      type: 'merge',
      missionId: mission.id,
      text: `reconciled already-landed ${mergedCommit.slice(0, 7)} on ${state.base}`,
    })
    return {
      ok: true,
      reconciled: true,
      alreadyLanded: true,
      mergedCommit,
      baseTip,
      branchTip,
      parents: found ? found.parents : null,
      review: latest
        ? {
            round: latest.round,
            status: latest.status,
            mergeVerdict: latest.mergeVerdict,
            reviewer: latest.reviewer,
            reviewedCommit: reviewedTip,
          }
        : null,
    }
  }

  async merge(input) {
    return merge(this, input, { describeGitFailure, mergeTimeoutMs, commitParents, removeStaleGitLocks, MERGE_MAX_BUFFER })
  }

  async rebase(input) {
    return rebase(this, input)
  }

  async teardown(input) {
    return teardown(this, input)
  }

  async status(input = {}) {
    return status(this, input)
  }

}
