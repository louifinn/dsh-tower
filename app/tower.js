// Tower domain: repo-scoped mission state machine, validation, and gates.
//
// #69: the app layer depends on the ports in ports/ and receives their
// implementations through the deps object assembled by the composition root.
// It imports no adapter and no infrastructure module.
import path from 'node:path'
import { assertPorts } from '../ports/index.js'
import { validateCreate as validateBatchCreate, validateClose as validateBatchClose, summarize as summarizeBatch } from '../domain/batch.js'

import { rebaseWaived } from '../domain/gate.js'
import { DEFAULT_MERGE_TIMEOUT_MS, gitLockTimeoutMs } from '../domain/lockBudget.js'
export { ROSTER_INACTIVE_STATES } from '../domain/roster.js'

export { fileInScope, scopesOverlap, validateTitle, normalizeScope } from '../domain/scope.js'
export { missionSummary } from '../domain/summary.js'

export { MISSION_STATUSES, SCHEMA_VERSION, MERGE_VERDICTS, FINDING_TYPES, FINDING_SEVERITIES, FINDING_STATUSES, FINDING_TRANSITIONS } from '../domain/mission.js'
import { TowerToolError } from '../domain/errors.js'
import { buildMissionEvent } from '../domain/events.js'
import { plan } from './plan.js'
import { updateMission } from './mission.js'
import { checkCompletion, complete } from './checkCompletion.js'
import { missionContext } from './missionContext.js'
import { enrichedMissions } from './enrichedMissions.js'
import { writeBoard, boardFile } from './board.js'
import { archiveIndex, archivedMission } from './archive.js'
import { recordSpawnOutcome, recordInterrupt, reserveRoster, recordSpawn, rosterView } from './spawn.js'
import { recordTestRun, recordLegacySnapshot, recordLegacyMap } from './recording.js'
import { resolveLegacySurveyRead } from './sharedCheckout.js'

export const ROLES = ['worker', 'reviewer']
const MAX_REVIEW_ROUNDS = 5
const MERGE_MAX_BUFFER = 64 * 1024 * 1024

function mergeTimeoutMs(value, config) {
  if (value === undefined || value === null) {
    const configured = (config ?? {}).merge?.timeoutMs
    return Number.isInteger(configured) && configured >= 1000 ? configured : DEFAULT_MERGE_TIMEOUT_MS
  }
  const ms = Number(value)
  if (!Number.isInteger(ms) || ms < 1000) fail('timeoutMs must be an integer of at least 1000 milliseconds')
  return ms
}

async function commitParents(tower, cwd, sha) {
  const line = await tower.deps.vcs.tryGit(cwd, ['rev-list', '--parents', '-n', '1', sha])
  return line ? line.trim().split(/\s+/).slice(1) : []
}

function describeGitFailure(error) {
  const prefix = error?.timedOut ? 'timed out: ' : error?.bufferOverflow ? 'output buffer overflow: ' : ''
  return `${prefix}${String(error?.message ?? error)}`
}

const GIT_LOCK_FILES = Object.freeze(['index.lock', 'HEAD.lock', 'MERGE_HEAD.lock', 'ORIG_HEAD.lock'])

/**
 * Identity of one lock file at observation time. Byte content alone cannot
 * distinguish a foreign empty lock from the empty lock we observed, so the
 * stat fingerprint (mtime, and size when the store exposes it) is part of the
 * compare-and-swap.
 * @typedef {{ raw: string, mtimeMs: number, size: number | null }} GitLockSnapshot
 */

/** @param {any} stat @returns {number | null} */
function statSize(stat) {
  return typeof stat?.size === 'number' && Number.isFinite(stat.size) ? stat.size : null
}

/**
 * Read one lock file and re-stat it, so a lock that changed while it was being
 * read is treated as in use and never claimed.
 * @param {any} store
 * @param {string} file
 * @returns {Promise<GitLockSnapshot | null>}
 */
async function snapshotGitLock(store, file) {
  let before
  try {
    before = await store.stat(file)
  } catch {
    return null
  }
  let raw
  try {
    raw = await store.readText(file)
  } catch {
    return null
  }
  let after
  try {
    after = await store.stat(file)
  } catch {
    return null
  }
  if (after.mtimeMs !== before.mtimeMs) return null
  return { raw, mtimeMs: before.mtimeMs, size: statSize(before) }
}

/**
 * Whether the quarantined file is still the one the snapshot described. A
 * rename preserves mtime on every supported platform; size is compared when
 * both the store and the snapshot expose it.
 * @param {any} store
 * @param {string} file
 * @param {GitLockSnapshot} snapshot
 * @returns {Promise<boolean>}
 */
async function sameLockSnapshot(store, file, snapshot) {
  let stat
  try {
    stat = await store.stat(file)
  } catch {
    return false
  }
  if (stat.mtimeMs !== snapshot.mtimeMs) return false
  const size = statSize(stat)
  return snapshot.size === null || size === null || size === snapshot.size
}

/**
 * Restore a mismatched quarantine with an exclusive create: EEXIST means a
 * newer writer owns the path (`exists()` + `rename()` would replace it), and
 * failures keep the quarantined bytes for audit.
 * @param {any} store
 * @param {string} quarantine
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function restoreQuarantinedGitLock(store, quarantine, file) {
  if (typeof store?.copyFileExclusive !== 'function') return false
  let restored = false
  try {
    await store.copyFileExclusive(quarantine, file)
    restored = true
    await store.unlink(quarantine)
  } catch {}
  return restored
}

/** Per-call unique quarantine name; pid and clocks separate processes and calls. */
async function gitLockQuarantinePath(store, file) {
  const base = `${file}.tower-stale-${process.pid}-${Date.now().toString(36)}-${process.hrtime.bigint().toString(36)}`
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`
    if (!(await store.exists(candidate))) return candidate
  }
  return null
}

/**
 * Remove only Git lock files that are both old and unchanged since the
 * observation. The lock is claimed by an atomic rename to a quarantine name,
 * then its bytes and stat fingerprint are compared with the snapshot; only the
 * quarantined copy that matches is unlinked. A foreign or newer lock is
 * restored (or kept in quarantine when its path was already reclaimed), never
 * deleted.
 * @param {any} tower
 * @param {string} commonDir
 * @param {number} [maxAgeMs]
 * @param {{ now?: number }} [options]
 * @returns {Promise<{ removed: string[], retained: Array<{ name: string, reason: string }> }>}
 */
export async function removeStaleGitLocks(tower, commonDir, maxAgeMs = 60000, options = {}) {
  const store = tower.deps.store
  const now = typeof options.now === 'number' ? options.now : Date.now()
  /** @type {string[]} */
  const removed = []
  /** @type {Array<{ name: string, reason: string }>} */
  const retained = []
  for (const name of GIT_LOCK_FILES) {
    const file = path.join(commonDir, name)
    const snapshot = await snapshotGitLock(store, file)
    if (!snapshot) continue
    // A fresh lock may belong to a concurrent Git process; deleting it would
    // let two writers into the index.
    if (now - snapshot.mtimeMs < maxAgeMs) {
      retained.push({ name, reason: 'fresh' })
      continue
    }
    const quarantine = await gitLockQuarantinePath(store, file)
    if (quarantine === null) continue
    try {
      // The rename is the claim; only the claimed bytes can now be deleted.
      await store.rename(file, quarantine)
    } catch {
      // Absent, or another process claimed it first. Never force.
      continue
    }
    let claimed = null
    try {
      claimed = await store.readText(quarantine)
    } catch {
      claimed = null
    }
    if (claimed === null || claimed !== snapshot.raw || !(await sameLockSnapshot(store, quarantine, snapshot))) {
      const restored = await restoreQuarantinedGitLock(store, quarantine, file)
      retained.push({ name, reason: restored ? 'replaced' : 'replaced-quarantined' })
      continue
    }
    try {
      await store.unlink(quarantine)
      removed.push(name)
    } catch {
      retained.push({ name, reason: 'unlink-failed' })
    }
  }
  return { removed, retained }
}

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

import { boardMarkdown } from '../domain/report.js'
import { diff, missionDetail, status } from './read.js'
import { evaluateGate } from './gate.js'
import { submitReview } from './review.js'
import { teardown } from './teardown.js'
import { rebase } from './rebase.js'
import { merge } from './merge.js'
import { init } from './init.js'
import { provision } from './provision.js'
import { provisionReviewCheckout } from './reviewCheckout.js'
import { addFinding, readFindings, findings } from './findings.js'
import { recordMessage, recordDelivery, inbox } from './messages.js'
import { createBatch, closeBatch, abandonBatch, batchStatus } from './batch.js'
import { recordRosterObservations, reconcileObservedInactive, markRetired, markMissing, sweepRoster, unreadFor } from './roster.js'
export { validateState } from '../domain/state.js'

export class Tower {
  /**
   * @param {{ root: string, commonDir: string, branch?: string | null }} repo
   * @param {import('../types/index.js').TowerConfig} [config]
   * @param {Record<string, any>} [deps] ports assembled by the composition root
   *   (the host entry); required.
   */
  constructor(repo, config, deps) {
    assertPorts(deps)
    this.root = repo.root
    this.commonDir = repo.commonDir
    this.branch = repo.branch
    this.deps = /** @type {Record<string, any>} */ (deps)
    this.paths = this.deps.store.pathsFor(repo.commonDir)
    // Effective config for this repository: code defaults < profile config <
    // repo config file. Per-call tool arguments are applied by the caller.
    this.config = /** @type {import('../types/index.js').TowerConfig} */ (
      config ?? { ...this.deps.config.runtimeConfig(), configPath: null, repoConfigPresent: false }
    )
  }

  /**
   * Persist the repository state file only through the token-checked write.
   * The real store rejects a missing or stale token, so a caller must be the
   * one holding the state lock (the `held` context passed to `withLock`). The
   * in-memory test double predates that protocol and passes no lock context,
   * so the unguarded fallback is limited to `held === undefined` (#167).
   * @param {Record<string, any>} state
   * @param {{ token?: string } | undefined} [held]
   */
  async writeState(state, held) {
    const store = this.deps.store
    if (typeof store.writeStateLocked === 'function') {
      await store.writeStateLocked(this.paths, state, held?.token)
      return
    }
    if (held === undefined) {
      await store.writeJsonAtomic(this.paths.state, state)
      return
    }
    throw new TowerToolError(
      'state-locked',
      `store does not support token-checked state writes (${this.paths.state})`,
      { retryable: false, nextAction: 'pass the lock context from withLock, or use a store that implements writeStateLocked' },
    )
  }

  /**
   * Resolve the repository and config through the injected ports.
   * @param {string} repoRoot
   * @param {Record<string, any>} deps
   */
  static async open(repoRoot, deps) {
    assertPorts(deps)
    const repo = await deps.vcs.resolveRepo(repoRoot)
    const config = await deps.config.resolveRepoConfig(repo)
    return new Tower(repo, config, deps)
  }

  git(cwd, args, options = {}) {
    return this.deps.vcs.git(cwd, args, { timeoutMs: this.config.git?.timeoutMs, ...options })
  }

  /**
   * Options for one git-mutex section: the phase, the wait budget derived from
   * the merge timeout, and the injected clock so waiting is testable in virtual
   * time. The budget itself is the pure domain policy in ../domain/lockBudget.js
   * (#93); this method only adds the Tower config and the injected clock.
   * @param {{ phase?: string, mergeTimeoutMs?: number, timeoutMs?: number, now?: Function }} [options]
   * @returns {Record<string, any>}
   */
  gitMutexOptions(options = {}) {
    const { phase, mergeTimeoutMs, timeoutMs, ...rest } = options
    const clock = this.deps.clock
    const clockNow = clock && typeof clock.now === 'function' ? clock.now.bind(clock) : null
    return {
      ...rest,
      ...(phase ? { phase } : {}),
      timeoutMs: timeoutMs ?? gitLockTimeoutMs(this.config, mergeTimeoutMs),
      ...(clockNow ? { now: clockNow } : {}),
    }
  }

  tryGit(cwd, args, options = {}) {
    return this.deps.vcs.tryGit(cwd, args, { timeoutMs: this.config.git?.timeoutMs, ...options })
  }

  async revParse(cwd, ref) {
    return (await this.git(cwd, ['rev-parse', ref])).trim()
  }

  /**
   * The commit a mission branch points at, resolved from the branch ref. Never
   * reads a live worktree checkout: a checkout is a view, the ref is the fact
   * (#149 W3 review evidence and every tip comparison use this).
   * @param {{ id?: string, worktree?: { branch?: string } | null }} mission
   */
  async branchTip(mission) {
    const branch = mission?.worktree?.branch
    if (typeof branch !== 'string' || branch.length === 0) {
      fail(`mission ${mission?.id ?? ''} has no branch to resolve`.replace('  ', ' '), 'invalid-argument')
    }
    return this.revParse(this.root, `refs/heads/${branch}`)
  }

  async isClean(cwd) {
    return (await this.git(cwd, ['status', '--porcelain'])).trim().length === 0
  }

  async isAncestor(cwd, ancestor, descendant) {
    return (await this.tryGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant].filter(Boolean))) !== null
  }

  /**
   * Read the state document, migrating an older schema in memory and (while the
   * caller holds the state lock) persisting that migration with one revision
   * bump and a `state.migrated` activity entry (#72).
   * @param {{ persist?: boolean }} [options]
   */
  async load(options = {}) {
    if (!(await this.deps.store.exists(this.paths.state))) {
      fail(`tower is not initialized for ${this.root} — run tower_init first`, 'not-initialized')
    }
    const loaded = await this.deps.state.loadStateFile({
      store: this.deps.store,
      paths: this.paths,
      now: this.deps.clock?.now ? this.deps.clock.now() : Date.now(),
      persist: options.persist,
      // A legacy survey planned but never provisioned recorded no base; the
      // loader resolves it once, from this checkout, before the pure migration.
      resolveLegacySurvey: (rawState) => resolveLegacySurveyRead(this, rawState),
    })
    this.stateLoad = { ...loaded.version, migration: loaded.migration }
    return loaded.state
  }

  /** #51 two-phase init: see the prepare/act/commit helpers in `./tower/init.js`. */
  async init(input = {}) {
    return init(this, input)
  }

  /**
   * Persist-then-emit (#75): the caller has already written `state.json` and the
   * activity log, so each domain transition descriptor is finalised with the
   * persisted revision and emitted through the event port. The event channel is
   * best effort — a listener (or an embedder without one) never fails the tool.
   * @param {Array<{ type: string, missionId: string, commit?: string }>} descriptors
   * @param {{ revision: number, at: number }} context
   */
  emitEvents(descriptors, context) {
    const events = this.deps.events
    if (!events || typeof events.emit !== 'function') return
    for (const descriptor of descriptors ?? []) {
      try {
        const event = buildMissionEvent(/** @type {any} */ (descriptor), context)
        events.emit(event.name, event.payload)
      } catch {
        // events describe a fact that is already durable; never fail the tool
      }
    }
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
    const owned = await this.deps.ownership.assertOwnership({
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

  /**
   * Provision the disposable detached review checkout for a reviewer (#149 W3).
   * The commit it returns is the reviewer's evidence for every later read and
   * the verdict stamp.
   */
  async provisionReviewCheckout(input = {}) {
    return provisionReviewCheckout(this, input)
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

  /**
   * Human-readable mission board (markdown) for the current state.
   * @param {import('../types/index.js').TowerState} state
   * @param {{ count?: number, unreadable?: boolean, message?: string } | null} [archive]
   */
  boardMarkdown(state, archive = null) {
    return boardMarkdown(state, archive)
  }

  /** Read `archive/index.json`; `ok:false` carries a diagnostic instead of throwing. */
  archiveIndex() {
    return archiveIndex(this)
  }

  /** Load one archived mission (full record) with its linked reviews and findings. */
  archivedMission(missionId) {
    return archivedMission(this, missionId)
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
      text = await this.deps.store.readText(file)
    } catch {
      text = ''
    }
    const lines = text.split(/\r?\n/)
    if (lines.includes(pattern) || lines.includes(`${pattern}/`)) return { inside: true, excluded: true, pattern }
    const suffix = text === '' || text.endsWith('\n') ? '' : '\n'
    await this.deps.store.appendText(file, `${suffix}${pattern}\n`)
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
