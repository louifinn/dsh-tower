// Tower domain: repo-scoped mission state machine, validation, and gates.
//
// #69: the app layer depends on the ports in ports/ and receives their
// implementations through the deps object assembled by the composition root.
// It imports no adapter and no infrastructure module.
//
// W5-A: this file is the Tower facade. Repository path guards live in
// `app/tower-paths.js`, the merge delegation helpers in `app/merge-support.js`,
// and the stale Git-lock quarantine in `app/git-locks.js`; the public class and
// its re-exports are unchanged.
import path from 'node:path'
import { assertPorts } from '../ports/index.js'
import { directoryScopeCandidate, expandScopeDirectories, scopePrefixDirectory, validateScopeEntries } from '../domain/scope.js'
import { validateCreate as validateBatchCreate, validateClose as validateBatchClose, summarize as summarizeBatch } from '../domain/batch.js'

import { rebaseWaived } from '../domain/gate.js'
import { DEFAULT_MERGE_TIMEOUT_MS, gitLockTimeoutMs } from '../domain/lockBudget.js'
export { ROSTER_INACTIVE_STATES } from '../domain/roster.js'

export { fileInScope, scopesOverlap, validateTitle, normalizeScope, directoryScopeCandidate, expandScopeDirectories, scopePrefixDirectory, validateScopeEntries } from '../domain/scope.js'
export { missionSummary } from '../domain/summary.js'

export { MISSION_STATUSES, SCHEMA_VERSION, MERGE_VERDICTS, FINDING_TYPES, FINDING_SEVERITIES, FINDING_STATUSES, FINDING_TRANSITIONS } from '../domain/mission.js'
import { TowerToolError } from '../domain/errors.js'
import { buildMissionEvent } from '../domain/events.js'
import { normalizeMissionBatch } from '../domain/missions/lifecycle.js'
import { plan } from './plan.js'
import { assertBaseCheckout, readHeadView, updateMission, updateMissionBatch } from './mission.js'
import { checkCompletion, complete } from './checkCompletion.js'
import { missionContext } from './missionContext.js'
import { enrichedMissions } from './enrichedMissions.js'
import { writeBoard, boardFile } from './board.js'
import { archiveIndex, archivedMission } from './archive.js'
import { recordSpawnOutcome, recordInterrupt, reserveRoster, recordSpawn, rosterView } from './spawn.js'
import { recordTestRun, recordLegacySnapshot, recordLegacyMap } from './recording.js'
import { resolveLegacySurveyRead } from './sharedCheckout.js'
import { removeStaleGitLocks } from './git-locks.js'
import { MERGE_MAX_BUFFER, commitParents, describeGitFailure, mergeTimeoutMs } from './merge-support.js'
import { assertOutside as assertOutsidePath, ensureExcluded as ensureExcludedPath } from './tower-paths.js'

export { removeStaleGitLocks } from './git-locks.js'

export const ROLES = ['worker', 'reviewer']
const MAX_REVIEW_ROUNDS = 5

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

/**
 * F18: the bare scope entries of one plan or widening input that name a
 * directory in the planning checkout. `plan`/`mission` expand those entries
 * into `dir/**` before planning; a bare path that is not a directory stays
 * literal (an existing file, or a file a mission will create). The probe is
 * best effort: a missing path or any store failure leaves the entry literal
 * instead of failing the plan. `stat` is declared on StorePort to return
 * `{ mtimeMs, isDirectory() }` (#F70), so this reads a capability the port
 * promises; a store that still returns a foreign shape fails open here.
 * @param {Tower} tower
 * @param {unknown} scope
 * @returns {Promise<Set<string>>}
 */
async function plannedDirectorySet(tower, scope) {
  const directories = new Set()
  if (!Array.isArray(scope)) return directories
  const probed = new Set()
  for (const raw of scope) {
    const candidate = directoryScopeCandidate(raw)
    if (candidate === null || candidate.trailing || candidate.value === '.') continue
    if (probed.has(candidate.value)) continue
    probed.add(candidate.value)
    try {
      const info = await tower.deps.store.stat(path.join(tower.root, candidate.value))
      if (info.isDirectory()) directories.add(candidate.value)
    } catch {
      // Missing or unreadable paths are not directories: keep the entry literal.
    }
  }
  return directories
}

/**
 * #200: the tracked files of this checkout, in `git ls-files -z` order, or
 * `null` when the listing cannot be trusted (not a repository, a git failure,
 * or an empty index). Presence validation runs only on a trustworthy list: an
 * unreadable checkout keeps planning, exactly as an unprobeable directory keeps
 * an entry literal (F70).
 * @param {Tower} tower
 * @returns {Promise<string[] | null>}
 */
async function trackedPathList(tower) {
  let output
  try {
    output = await tower.deps.vcs.git(tower.root, ['ls-files', '-z'])
  } catch {
    return null
  }
  if (typeof output !== 'string') return null
  const paths = output.split('\0').filter((entry) => entry.length > 0)
  return paths.length > 0 ? paths : null
}

/**
 * #200: the directories that prove an entry is in known territory: the F18
 * planned directories, plus each entry's anchor directory when it exists on
 * disk. The second set is what catches a glob that matches only ignored or
 * untracked files (`dist/*.js` with a checked-out but ignored `dist/`), without
 * treating a tree the mission is about to create as known (`src/**` in a
 * README-only checkout).
 * @param {Tower} tower
 * @param {unknown} scope
 * @returns {Promise<Set<string>>}
 */
async function scopeDirectories(tower, scope) {
  const directories = await plannedDirectorySet(tower, scope)
  if (!Array.isArray(scope)) return directories
  for (const raw of scope) {
    const directory = scopePrefixDirectory(raw)
    if (directory.length === 0 || directories.has(directory)) continue
    try {
      const info = await tower.deps.store.stat(path.join(tower.root, directory))
      if (info.isDirectory()) directories.add(directory)
    } catch {
      // A missing anchor directory is a tree the mission will create; no probe.
    }
  }
  return directories
}

/**
 * #205: whether this update edits a planned mission's fence. The scope check
 * runs before the locked update, so a missing state or mission is not this
 * helper's failure to report: it just falls back to the widening label.
 * @param {Tower} tower
 * @param {unknown} id
 * @returns {Promise<boolean>}
 */
async function plannedScopeEdit(tower, id) {
  if (typeof id !== 'string') return false
  try {
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === id)
    return mission?.status === 'planned'
  } catch {
    return false
  }
}

/**
 * #200: the one `invalid-argument` for the first unverifiable entry. The
 * message names the entry, the nearest existing prefix, and up to five tracked
 * files in the same directory; the next action depends on the operation that
 * asked: planning and a planned edit may accept a future path through
 * `allowMissingScope: true`, and since #205 a widening may too.
 * @param {import('../domain/scope.js').ScopeEntryProblem[]} problems
 * @param {'plan' | 'widen'} operation
 * @returns {never}
 */
function failScopeEntries(problems, operation) {
  const first = problems[0]
  const parts = [`no tracked file matches "${first.entry}"`]
  if (first.closestPrefix.length > 0) parts.push(`nearest existing prefix "${first.closestPrefix}"`)
  if (first.candidates.length > 0) parts.push(`tracked files there: ${first.candidates.join(', ')}`)
  if (problems.length > 1) {
    const more = problems.length - 1
    parts.push(`${more} more scope ${more === 1 ? 'entry matches' : 'entries match'} no tracked file`)
  }
  throw new TowerToolError('invalid-argument', parts.join('; '), {
    nextAction: scopeNextAction(first, operation),
    details: { operation, problems },
  })
}

/**
 * #200: the recommendation a caller can actually carry out. Both planning and
 * a widening accept a future path through `allowMissingScope: true` (#205); the
 * tracking rule is the same for a planned edit, which also reports operation
 * `plan`.
 * @param {import('../domain/scope.js').ScopeEntryProblem} first
 * @param {'plan' | 'widen'} operation
 * @returns {string}
 */
function scopeNextAction(first, operation) {
  const tracked =
    first.candidates.length > 0
      ? `a tracked path such as "${first.candidates[0]}"`
      : `a tracked path${first.closestPrefix.length > 0 ? ` under "${first.closestPrefix}"` : ''}`
  if (operation === 'widen') {
    return `use ${tracked} or an existing directory; to widen to a path that does not exist yet, pass allowMissingScope: true, or declare the future path in the original plan`
  }
  return `use ${tracked}, or pass allowMissingScope: true to accept a path a mission will create`
}

/**
 * @param {string[]} scope
 * @param {string[]} trackedPaths
 * @param {ReadonlySet<string>} directories
 * @param {'plan' | 'widen'} operation
 */
function assertScopeEntries(scope, trackedPaths, directories, operation) {
  const problems = validateScopeEntries(scope, { trackedPaths, directories })
  if (problems.length > 0) failScopeEntries(problems, operation)
}

/**
 * F18: a fresh plan input with directory-shaped scope entries expanded to
 * explicit subtree globs. Invalid shapes are passed through untouched so the
 * domain reports the same error as before.
 *
 * #200: before expansion, each mission's scope is checked against the tracked
 * files (see `validateScopeEntries`), so an entry that names no file fails
 * before a mission is created. A mission may skip the check with
 * `allowMissingScope: true` (and `Tower.plan` accepts it top-level for direct
 * callers, though the tool forwards only the per-mission field); the accepted
 * entries are recorded afterwards by `recordUnverifiedPlanScope`.
 * @param {Tower} tower
 * @param {any} input
 * @returns {Promise<{ input: any, problems: Array<Record<string, any>> }>}
 */
async function inspectPlanInput(tower, input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.missions)) return { input, problems: [] }
  const allowMissing = input.allowMissingScope === true
  /** @type {string[] | null | undefined} */
  let trackedPaths
  let listed = false
  /** @type {Array<Record<string, any>>} */
  const problems = []
  const missions = []
  for (let index = 0; index < input.missions.length; index += 1) {
    const mission = input.missions[index]
    if (mission === null || typeof mission !== 'object' || Array.isArray(mission) || !Array.isArray(mission.scope)) {
      missions.push(mission)
      continue
    }
    const directories = await scopeDirectories(tower, mission.scope)
    if (!allowMissing && mission.allowMissingScope !== true) {
      if (!listed) {
        trackedPaths = await trackedPathList(tower)
        listed = true
      }
      if (trackedPaths !== null && trackedPaths !== undefined) {
        for (const problem of validateScopeEntries(mission.scope, { trackedPaths, directories })) {
          problems.push({ ...problem, index })
        }
      }
    }
    missions.push({ ...mission, scope: expandScopeDirectories(mission.scope, { directories }) })
  }
  return { input: { ...input, missions }, problems }
}

/**
 * #200: the escape hatch is auditable. Each mission that asked to skip the
 * presence check leaves one `scope.unverified` activity record naming the
 * entries accepted without proof, so a later reader can tell an intended
 * future path from a typo.
 * @param {Tower} tower
 * @param {any} input the caller's original plan input
 * @param {{ missions?: Array<{ id?: string }> }} result
 */
async function recordUnverifiedPlanScope(tower, input, result) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.missions)) return
  const allowMissing = input.allowMissingScope === true
  for (let index = 0; index < input.missions.length; index += 1) {
    const requested = input.missions[index]
    if (requested === null || typeof requested !== 'object' || !Array.isArray(requested.scope) || requested.scope.length === 0) continue
    if (!allowMissing && requested.allowMissingScope !== true) continue
    const created = Array.isArray(result?.missions) ? result.missions[index] : undefined
    await tower.appendActivity({
      at: Date.now(),
      type: 'scope.unverified',
      ...(created?.id ? { missionId: created.id } : {}),
      text: `accepted unverified scope: ${requested.scope.join(', ')}`,
    })
  }
}

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

  /**
   * Append one entry to the repo-scoped activity log. The store adapter owns
   * the append and the rotation; the app only supplies this repository's
   * bounded-log policy from the resolved config. Callers inside a state-lock
   * critical section are already serialised; the adapter also serialises
   * rotation within the process.
   * @param {Record<string, any>} entry
   */
  async appendActivity(entry) {
    return this.deps.store.appendJsonl(this.paths.activity, entry, this.config.activity ?? {})
  }

  /**
   * Run one mutation inside the repo-wide state lock. The wait budget defaults
   * to `mode.lockTimeoutMs`, the same cross-process lock tuning used by the
   * mode store, so a repository can raise it once for both locks; a caller that
   * passes `timeoutMs` explicitly wins. Before #M76 the app called
   * `deps.store.withLock` directly, so that key only governed `modes.lock`.
   * @template T
   * @param {(paths: Record<string, any>, held: { token: string }) => Promise<T>} fn
   * @param {{ timeoutMs?: number, [key: string]: any }} [options]
   * @returns {Promise<T>}
   */
  async withStateLock(fn, options = {}) {
    return this.deps.store.withLock(this.paths, fn, {
      ...options,
      timeoutMs: options.timeoutMs ?? this.config?.mode?.lockTimeoutMs ?? 5000,
    })
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
      // The adapter owns rotation, but this repository's policy comes from the
      // resolved config. Passed as data: the app layer imports no adapter.
      activity: this.config.activity,
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

  /** #215: live HEAD; see readHeadView in app/mission.js. */
  async currentHeadView() {
    return readHeadView(this)
  }

  /** #215: refuse a checkout that is not `state.base`; see app/mission.js. */
  async assertBaseCheckout(action = 'this operation') {
    return assertBaseCheckout(this, action)
  }

  async plan(input = {}) {
    await this.assertBaseCheckout('tower_plan')
    const dryRun = input?.dry_run === true
    const inspected = await inspectPlanInput(this, input)
    const planned = await plan(this, inspected.input, { dryRun, scopeProblems: inspected.problems })
    // A preview creates nothing, so it has no unverified scope to record.
    if (!dryRun) await recordUnverifiedPlanScope(this, input, planned)
    return planned
  }

  async mission(input = {}) {
    // #216: the bulk form is normalized and validated before any write. Scope
    // entries on a bulk item get the same directory expansion and tracked-file
    // check as the single form, item by item.
    const batch = normalizeMissionBatch(input)
    if (batch) {
      for (const item of batch.items) {
        if (!Array.isArray(item.fields.scope)) continue
        const directories = await scopeDirectories(this, item.fields.scope)
        const plannedEdit = await plannedScopeEdit(this, item.id)
        if (item.fields.allowMissingScope !== true) {
          const trackedPaths = await trackedPathList(this)
          if (trackedPaths !== null) {
            assertScopeEntries(item.fields.scope, trackedPaths, directories, plannedEdit ? 'plan' : 'widen')
          }
        }
        item.unverified = item.fields.allowMissingScope === true && item.fields.scope.length > 0
          ? { plannedEdit, scope: [...item.fields.scope] }
          : null
        item.fields = { ...item.fields, scope: expandScopeDirectories(item.fields.scope, { directories }) }
      }
      const result = await updateMissionBatch(this, {
        atomic: batch.atomic,
        items: batch.items,
        actor: input.actor,
      })
      const succeeded = new Set(result.results.filter((entry) => entry.ok).map((entry) => entry.id))
      for (const item of batch.items) {
        if (!item.unverified || !succeeded.has(item.id)) continue
        await this.appendActivity({
          at: Date.now(),
          type: 'scope.unverified',
          missionId: item.id,
          text: `${item.unverified.plannedEdit ? 'edited' : 'widened'} to unverified scope: ${item.unverified.scope.join(', ')}`,
        })
      }
      return result
    }
    // F18: widening input gets the same directory expansion as planning, so a
    // directory-shaped entry cannot silently widen a fence to nothing.
    // #200: a widened entry must also match a tracked file, so a typo cannot
    // fence a mission to a path that does not exist. A direct caller may skip
    // that check with `allowMissingScope: true`; the recorded entries then
    // carry one `scope.unverified` activity record.
    // #205: a planned mission edits its fence rather than widening it, so a
    // rejection names the planning operation the same entries would face in
    // `tower_plan`; both operations accept `allowMissingScope`.
    const update = /** @type {any} */ (input)
    if (update && typeof update === 'object' && Array.isArray(update.scope)) {
      const directories = await scopeDirectories(this, update.scope)
      const plannedEdit = await plannedScopeEdit(this, update.id)
      if (update.allowMissingScope !== true) {
        const trackedPaths = await trackedPathList(this)
        if (trackedPaths !== null) {
          assertScopeEntries(update.scope, trackedPaths, directories, plannedEdit ? 'plan' : 'widen')
        }
      }
      const result = await updateMission(this, { ...update, scope: expandScopeDirectories(update.scope, { directories }) })
      if (update.allowMissingScope === true && update.scope.length > 0) {
        await this.appendActivity({
          at: Date.now(),
          type: 'scope.unverified',
          missionId: result.mission.id,
          text: `${plannedEdit ? 'edited' : 'widened'} to unverified scope: ${update.scope.join(', ')}`,
        })
      }
      return result
    }
    return updateMission(this, update)
  }

  assertOutside(target) {
    return assertOutsidePath(this, target)
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

  async checkCompletion(input, options = {}) {
    return checkCompletion(this, input, options)
  }

  async complete(input, options = {}) {
    return complete(this, input, options)
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
    return ensureExcludedPath(this, target)
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
