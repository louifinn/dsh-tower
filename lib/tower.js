// Tower domain: repo-scoped mission state machine, validation, and gates.
import path from 'node:path'
import fsp from 'node:fs/promises'
import {
  git,
  resolveRepo,
  hasAnyCommit,
  localBranchExists,
  revParse,
  branchExists,
  currentBranch,
  currentCommonDir,
  addWorktree,
  listWorktrees,
  countCommits,
  isClean,
  isAncestor,
  tryGit,
} from './git.js'
import { validateCreate as validateBatchCreate, validateClose as validateBatchClose, summarize as summarizeBatch } from './batch.js'
import { assertOwnership, canonicalPath } from './worktreeOwnership.js'
import {
  pathsFor,
  exists,
  ensureDir,
  readJson,
  writeJsonAtomic,
  renameWithRetry,
  appendJsonl,
  readActivityTail,
  withLock,
  shortHash,
} from './store.js'
import { runtimeConfig, resolveRepoConfig } from './config.js'
import {
  MISSION_STATUSES,
  TERMINAL_STATUSES,
  SCHEMA_VERSION,
  MERGE_VERDICTS,
  REVIEW_STATUS_RE,
  FINDING_TYPES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FINDING_TRANSITIONS,
  canTransition,
  pauseCauseError,
} from './domain/mission.js'
import { completionBlockers, mergeGateBlockers, rebaseWaived } from './domain/gate.js'
import { fileInScope, scopesOverlap, validateTitle, normalizeScope } from './domain/scope.js'
import { ROSTER_INACTIVE_STATES, ROSTER_INACTIVE, liveWorkerEntry, workerEntries, countLiveWorkers } from './domain/roster.js'
export { ROSTER_INACTIVE_STATES } from './domain/roster.js'

export { fileInScope, scopesOverlap, validateTitle, normalizeScope } from './domain/scope.js'
import { taskCounts, missionSummary, fullMission, findingSummary, countFindings } from './domain/summary.js'
export { missionSummary } from './domain/summary.js'

export { MISSION_STATUSES, SCHEMA_VERSION, MERGE_VERDICTS, FINDING_TYPES, FINDING_SEVERITIES, FINDING_STATUSES, FINDING_TRANSITIONS } from './domain/mission.js'
import { TowerToolError } from './errors.js'

const TERMINAL = TERMINAL_STATUSES
/** Roster states that no longer represent a live writer. `inactive` is an idle
 * child whose turn finished: it must not block a new owner or consume a worker
 * slot. `unknown` is deliberately NOT included because it cannot be proven
 * stopped. */
const SNAPSHOT_REF_PREFIX = 'refs/tower/snapshot/'

function slugify(title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return slug || 'mission'
}

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
  const line = await tryGit(cwd, ['rev-list', '--parents', '-n', '1', sha])
  return line ? line.trim().split(/\s+/).slice(1) : []
}

/**
 * Find a reachable merge commit whose second parent is one of the known tips.
 * `--no-ff` merges put the integrated branch on the second parent, so this is
 * the concrete evidence that a mission's work already landed in the base.
 */
async function findLandedMerge(cwd, baseTip, tips) {
  const revs = (await tryGit(cwd, ['rev-list', '--merges', baseTip])) ?? ''
  for (const sha of revs.split('\n').filter(Boolean)) {
    const parents = await commitParents(cwd, sha)
    if (parents.length >= 2 && tips.has(parents[1])) return { commit: sha, parents }
  }
  return null
}

function clearStale(entry) {
  delete entry.stale
  delete entry.staleAt
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

function fail(message) {
  throw new Error(message)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

import { nextMissionNumber, addDependency, hasDependencyPath, assertAcyclic, addAutoDeps } from './domain/planning.js'

function normalizeMissionInput(input, index) {
  if (!isPlainObject(input)) fail(`missions[${index}] must be an object`)
  const title = validateTitle(input.title)
  const kind = input.kind === 'survey' ? 'survey' : 'build'
  const scope = normalizeScope(input.scope ?? [], { allowEmpty: kind === 'survey' })
  const tasks = []
  if (input.tasks !== undefined) {
    if (!Array.isArray(input.tasks)) fail(`missions[${index}].tasks must be an array of strings`)
    for (const task of input.tasks) {
      if (typeof task !== 'string' || task.trim().length === 0) {
        fail(`missions[${index}].tasks entries must be non-empty strings`)
      }
      tasks.push({ text: task.trim(), status: 'open' })
    }
  }
  const deps = []
  if (input.deps !== undefined) {
    if (!Array.isArray(input.deps)) fail(`missions[${index}].deps must be an array of mission ids`)
    for (const dep of input.deps) {
      if (typeof dep !== 'string' || dep.trim().length === 0) {
        fail(`missions[${index}].deps entries must be non-empty mission ids`)
      }
      if (!deps.includes(dep.trim())) deps.push(dep.trim())
    }
  }
  const context = typeof input.context === 'string' ? input.context.slice(0, 4096) : ''
  const references = []
  if (input.references !== undefined) {
    if (!Array.isArray(input.references)) fail(`missions[${index}].references must be an array of pointers`)
    if (input.references.length > 20) fail(`missions[${index}].references supports at most 20 pointers`)
    for (const reference of input.references) {
      if (typeof reference !== 'string' || reference.trim().length === 0) {
        fail(`missions[${index}].references entries must be non-empty strings`)
      }
      if (!references.includes(reference.trim())) references.push(reference.trim())
    }
  }
  const reviewPolicy = input.reviewPolicy === undefined ? 'required-clean' : input.reviewPolicy
  if (!['required-clean', 'none'].includes(reviewPolicy)) {
    fail(`missions[${index}].reviewPolicy must be "required-clean" or "none"`)
  }
  const reviewExemptionReason = typeof input.reviewExemptionReason === 'string' ? input.reviewExemptionReason.trim() : ''
  if (reviewPolicy === 'none' && reviewExemptionReason.length === 0) {
    fail(`missions[${index}].reviewPolicy "none" requires a non-empty reviewExemptionReason`)
  }
  return { title, kind, scope, tasks, deps, context, references, reviewPolicy, reviewExemptionReason }
}

function newMission(id, input, now) {
  return {
    id,
    title: input.title,
    kind: input.kind,
    scope: input.scope,
    tasks: input.tasks,
    deps: input.deps,
    context: input.context,
    references: input.references ?? [],
    reviewPolicy: input.reviewPolicy ?? 'required-clean',
    reviewExemptionReason: input.reviewExemptionReason ?? '',
    status: 'planned',
    owner: null,
    blockers: [],
    notes: [],
    reviews: [],
    scopeGeneration: 1,
    createdAt: now,
    updatedAt: now,
  }
}

import { validateState } from './domain/state.js'
import { boardMarkdown } from './domain/report.js'
import { diff, missionDetail, status } from './tower/read.js'
import { evaluateGate } from './tower/gate.js'
import { submitReview } from './tower/review.js'
import { teardown } from './tower/teardown.js'
import { rebase } from './tower/rebase.js'
import { merge } from './tower/merge.js'
import { addFinding, readFindings, findings } from './tower/findings.js'
import { createBatch, closeBatch, abandonBatch, batchStatus } from './tower/batch.js'
export { validateState } from './domain/state.js'

function normalizePauseCause(value) {
  const error = pauseCauseError(value)
  if (error) fail(error)
  return value === undefined || value === null || value === '' ? 'user' : value
}

function normalizeChecks(checks) {
  if (checks === undefined) return []
  if (!Array.isArray(checks)) fail('checks must be an array')
  if (checks.length > 20) fail('checks may contain at most 20 entries')
  return checks.map((check, index) => {
    if (!isPlainObject(check)) fail(`checks[${index}] must be an object`)
    const name = typeof check.name === 'string' ? check.name.trim() : ''
    if (!name) fail(`checks[${index}].name must be a non-empty string`)
    const entry = { name }
    if (typeof check.command === 'string' && check.command.trim()) entry.command = check.command.trim()
    if (check.exitCode !== undefined && check.exitCode !== null) {
      if (!Number.isInteger(check.exitCode)) fail(`checks[${index}].exitCode must be an integer`)
      entry.exitCode = check.exitCode
    }
    if (typeof check.evidence === 'string' && check.evidence.trim()) entry.evidence = check.evidence.trim().slice(0, 4000)
    return entry
  })
}

export class Tower {
  constructor(repo, config) {
    this.root = repo.root
    this.commonDir = repo.commonDir
    this.branch = repo.branch
    this.paths = pathsFor(repo.commonDir)
    // Effective config for this repository: code defaults < profile config <
    // repo config file. Per-call tool arguments are applied by the caller.
    this.config = config ?? { ...runtimeConfig(), configPath: null, repoConfigPresent: false }
  }

  static async open(repoRoot) {
    const repo = await resolveRepo(repoRoot)
    const config = await resolveRepoConfig(repo)
    return new Tower(repo, config)
  }

  git(cwd, args, options = {}) {
    return git(cwd, args, { timeoutMs: this.config.git?.timeoutMs, ...options })
  }

  tryGit(cwd, args, options = {}) {
    return tryGit(cwd, args, { timeoutMs: this.config.git?.timeoutMs, ...options })
  }

  async load() {
    if (!(await exists(this.paths.state))) {
      fail(`tower is not initialized for ${this.root} — run tower_init first`)
    }
    const state = await readJson(this.paths.state)
    return validateState(state, this.paths.state)
  }

  async init(input = {}) {
    await ensureDir(this.paths.dir)
    return withLock(this.paths, async () => {
      const now = Date.now()
      const dirty = !(await isClean(this.root))
      const committed = await hasAnyCommit(this.root)
      const resolveBase = async () => {
        let base = typeof input.base === 'string' && input.base.trim() ? input.base.trim() : null
        if (base) {
          if (/^refs\//.test(base) || base.startsWith('origin/')) {
            fail(`base must be a local branch name, not ${base}`)
          }
          if (committed && !(await localBranchExists(this.root, base))) {
            fail(`base branch "${base}" does not exist locally`)
          }
          return base
        }
        base = this.branch
        if (!base && !committed) base = 'main'
        if (!base) fail('repository is in detached HEAD; pass an explicit local base branch')
        return base
      }

      if (await exists(this.paths.state)) {
        const state = await this.load()
        const owner = state.towerAgentId ? String(state.towerAgentId) : null
        const caller = input.towerAgentId ? String(input.towerAgentId) : null
        if (owner && caller && owner !== caller) {
          fail(`tower state is owned by another agent; ${caller} is not the tower`)
        }
        if (!owner && caller) {
          state.towerAgentId = caller
          state.revision += 1
          state.updatedAt = now
          validateState(state, this.paths.state)
          await writeJsonAtomic(this.paths.state, state)
          await appendJsonl(this.paths.activity, { at: now, type: 'init', text: `tower owner claimed by ${caller}` })
        }
        let reanchored = false
        if (input.reanchor === true) {
          const active = state.missions.filter((mission) => !TERMINAL.has(mission.status))
          if (active.length > 0) {
            fail(`cannot reanchor base while ${active.length} mission(s) are not merged or abandoned`)
          }
          const base = await resolveBase()
          if (base !== state.base) {
            const refs = (await this.tryGit(this.root, ['for-each-ref', '--format=%(refname)', SNAPSHOT_REF_PREFIX])) ?? ''
            for (const ref of refs.split('\n').map((line) => line.trim()).filter(Boolean)) {
              await this.git(this.root, ['update-ref', '-d', ref]).catch(() => {})
            }
            state.base = base
            state.baseChangedAt = now
            delete state.snapshotCommit
            delete state.snapshotRef
            reanchored = true
            state.revision += 1
            state.updatedAt = now
            validateState(state, this.paths.state)
            await writeJsonAtomic(this.paths.state, state)
            await appendJsonl(this.paths.activity, { at: now, type: 'init', text: `base reanchored to ${base}` })
          }
        }
        return {
          created: false,
          repoRoot: state.repoRoot,
          commonDir: state.commonDir,
          statePath: this.paths.state,
          base: state.base,
          revision: state.revision,
          missions: state.missions.length,
          reanchored,
          dirty,
          snapshotCommit: state.snapshotCommit ?? null,
        }
      }

      const base = await resolveBase()
      let snapshotCommit = null
      let snapshotRef = null
      if (input.snapshotDirty === true && dirty) {
        snapshotCommit = ((await this.tryGit(this.root, ['stash', 'create'])) ?? '').trim() || null
        if (!snapshotCommit) {
          fail('snapshotDirty was requested but no snapshot commit could be created; commit or stash the working tree first')
        }
        // A dangling commit can be pruned by git gc; keep a ref so the mission
        // baseline stays reachable for the life of the state.
        snapshotRef = `${SNAPSHOT_REF_PREFIX}${snapshotCommit}`
        await this.git(this.root, ['update-ref', snapshotRef, snapshotCommit])
      }

      const state = {
        schemaVersion: SCHEMA_VERSION,
        repoRoot: this.root,
        commonDir: this.commonDir,
        base,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        dirtyBase: dirty,
        ...(input.towerAgentId ? { towerAgentId: String(input.towerAgentId) } : {}),
        ...(snapshotCommit ? { snapshotCommit, snapshotRef } : {}),
        missions: [],
      }
      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, {
        at: now,
        type: 'init',
        text: `base ${base}${snapshotCommit ? ` snapshot ${snapshotCommit.slice(0, 12)}` : ''}${dirty ? ' (dirty base)' : ''}`,
      })
      return {
        created: true,
        repoRoot: this.root,
        commonDir: this.commonDir,
        statePath: this.paths.state,
        base,
        revision: 0,
        missions: 0,
        reanchored: false,
        dirty,
        snapshotCommit,
        snapshotRef,
      }
    })
  }

  async plan(input = {}) {
    if (!Array.isArray(input.missions) || input.missions.length === 0) {
      fail('tower_plan needs at least one mission')
    }
    const prepared = input.missions.map((mission, index) => normalizeMissionInput(mission, index))
    return withLock(this.paths, async () => {
      const state = await this.load()
      const now = Date.now()
      const start = nextMissionNumber(state.missions)
      const assigned = prepared.map((mission, index) => ({ ...mission, id: `M${start + index}` }))

      const known = new Set([...state.missions.map((mission) => mission.id), ...assigned.map((mission) => mission.id)])
      for (const mission of assigned) {
        for (const dep of mission.deps) {
          if (!known.has(dep)) fail(`mission ${mission.id} depends on unknown mission "${dep}"`)
        }
      }

      addAutoDeps(assigned, state.missions)
      assertAcyclic([...state.missions, ...assigned])

      const created = assigned.map((mission) => newMission(mission.id, mission, now))
      state.missions.push(...created)
      state.revision += 1
      state.updatedAt = now

      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, {
        at: now,
        type: 'plan',
        text: `created ${created.map((mission) => mission.id).join(', ')}`,
      })
      return {
        revision: state.revision,
        missions: created.map((mission) => fullMission(mission)),
      }
    })
  }

  async mission(input = {}) {
    const missionId = typeof input.id === 'string' ? input.id.trim() : input.id
    if (typeof missionId !== 'string' || missionId.length === 0) fail('tower_mission requires id')
    return withLock(this.paths, async () => {
      const state = await this.load()
      const mission = state.missions.find((entry) => entry.id === missionId)
      if (!mission) fail(`unknown mission "${missionId}"`)
      const actor = input.actor ?? { name: 'tower', role: 'tower' }
      const workerRequest = actor.role === 'worker'
      if (actor.role === 'reviewer') {
        fail('only the tower or a worker may update a mission; reviewers submit tower_review')
      }
      if (workerRequest && mission.owner && mission.owner !== actor.name) {
        fail(`worker ${actor.name} does not own mission ${mission.id} (owner: ${mission.owner})`)
      }
      if (workerRequest) {
        if (input.status !== undefined) {
          fail('only the tower can change mission status directly; workers report completion with tower_complete')
        }
        if (input.scope !== undefined) fail('only the tower can change mission scope')
        if (input.clear_blockers === true) fail('only the tower can clear blockers')
        if (input.pause_cause !== undefined || input.authorization !== undefined) {
          fail('only the tower can record pause/authorization metadata')
        }
      }
      if (input.pause_cause !== undefined && input.status !== 'paused') {
        fail('pause_cause is only valid together with status "paused"')
      }
      if (input.status === 'abandoned' && (typeof input.note !== 'string' || input.note.trim().length === 0)) {
        fail('abandoning a mission requires a non-empty note (reason)')
      }
      const now = Date.now()
      const changes = []

      if (input.status !== undefined) {
        if (typeof input.status !== 'string' || !MISSION_STATUSES.includes(input.status)) {
          fail(`unknown mission status "${input.status}"`)
        }
        if (input.status === 'merged') fail('merged is recorded only by tower_merge, not by a generic mission patch')
        if (!canTransition(mission.status, input.status)) {
          fail(`mission ${mission.id} cannot move from ${mission.status} to ${input.status}`)
        }
        if (input.status === 'paused') {
          mission.pauseCause = normalizePauseCause(input.pause_cause)
        }
        if (mission.status === 'paused' && input.status === 'active') {
          const requireAuthorization = this.config.mode.requireResumeAuthorization === true
          if (requireAuthorization && (mission.pauseCause ?? 'user') === 'user') {
            if (typeof input.authorization !== 'string' || input.authorization.trim().length === 0) {
              fail('resuming a user-paused mission requires a non-empty authorization reference')
            }
          }
          if (typeof input.authorization === 'string' && input.authorization.trim()) {
            mission.authorizationRef = input.authorization.trim()
          }
        }
        mission.status = input.status
        changes.push(`status=${input.status}`)
      }

      if (input.task_done !== undefined) {
        const needle = String(input.task_done)
        const task = mission.tasks.find(
          (entry) => entry.status === 'open' && entry.text.toLowerCase().includes(needle.toLowerCase()),
        )
        if (!task) fail(`no open task matching "${needle}" in mission ${mission.id}`)
        task.status = 'done'
        changes.push(`task_done="${task.text}"`)
      }

      if (input.task_drop !== undefined) {
        if (typeof input.task_drop_reason !== 'string' || input.task_drop_reason.trim().length === 0) {
          fail('task_drop requires task_drop_reason')
        }
        const needle = String(input.task_drop)
        const task = mission.tasks.find(
          (entry) => entry.status === 'open' && entry.text.toLowerCase().includes(needle.toLowerCase()),
        )
        if (!task) fail(`no open task matching "${needle}" in mission ${mission.id}`)
        task.status = 'dropped'
        task.note = input.task_drop_reason.trim()
        mission.notes.push(`task dropped: ${task.text} — ${task.note}`)
        changes.push(`task_drop="${task.text}"`)
      }

      if (input.blocker !== undefined) {
        if (typeof input.blocker !== 'string' || input.blocker.trim().length === 0) {
          fail('blocker must be a non-empty string')
        }
        if (TERMINAL.has(mission.status)) {
          fail(`mission ${mission.id} is ${mission.status}; a blocker cannot reopen a terminal mission`)
        }
        mission.blockers.push(input.blocker.trim())
        mission.status = 'blocked'
        changes.push('blocker added')
      }

      if (input.clear_blockers === true) {
        mission.blockers = []
        changes.push('blockers cleared')
      }

      if (input.note !== undefined) {
        if (typeof input.note !== 'string' || input.note.trim().length === 0) {
          fail('note must be a non-empty string')
        }
        mission.notes.push(input.note.trim())
        changes.push('note added')
      }

      if (input.scope !== undefined) {
        if (!['active', 'completed'].includes(mission.status)) {
          fail(`scope can only be widened for active or completed missions, not ${mission.status}`)
        }
        const scope = normalizeScope(input.scope, { allowEmpty: mission.kind === 'survey' })
        const others = state.missions.filter(
          (entry) => entry.id !== mission.id && !TERMINAL.has(entry.status) && entry.kind !== 'survey',
        )
        for (const other of others) {
          if (mission.kind !== 'survey' && scopesOverlap(scope, other.scope)) {
            fail(`widened scope overlaps mission ${other.id}; retire it or add an explicit ordering`)
          }
        }
        mission.scope = scope
        mission.scopeGeneration = (mission.scopeGeneration ?? 1) + 1
        mission.status = 'active'
        changes.push('scope widened')
      }

      if (changes.length === 0) fail('tower_mission requires at least one change')
      mission.updatedAt = now
      state.revision += 1
      state.updatedAt = now

      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, {
        at: now,
        type: 'mission',
        missionId: mission.id,
        text: changes.join('; '),
      })
      return { revision: state.revision, mission: fullMission(mission) }
    })
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
    const registered = await listWorktrees(this.root)
    if (!registered.some((entry) => path.resolve(entry.path) === path.resolve(owned.path))) {
      fail(`worktree ${owned.path} is not registered with git`)
    }
    return worktree
  }

  /** Record that a spawned agent failed or went idle, so roster state is truthful. */
  async recordSpawnOutcome(input) {
    return withLock(this.paths, async () => {
      const state = await this.load()
      const entry = (state.roster ?? []).find((row) => row.name === input.name && row.missionId === input.missionId)
      if (!entry) return null
      const now = Date.now()
      entry.state = input.state ?? 'failed'
      entry.outcome = input.detail ? String(input.detail).slice(0, 1000) : null
      entry.outcomeAt = now
      clearStale(entry)
      state.revision += 1
      state.updatedAt = now
      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, {
        at: now,
        type: 'spawn',
        missionId: input.missionId,
        text: `${entry.name} ${entry.state}${entry.outcome ? `: ${entry.outcome.slice(0, 160)}` : ''}`,
      })
      return entry
    })
  }

  /** Record that a live agent was interrupted by the tower. */
  async recordInterrupt(input) {
    return withLock(this.paths, async () => {
      const state = await this.load()
      const entry = (state.roster ?? []).find(
        (row) =>
          (input.agentId !== undefined && row.agentId === input.agentId) ||
          (input.name !== undefined && row.name === input.name),
      )
      if (!entry) fail(`unknown roster agent "${input.name ?? input.agentId}"`)
      const now = Date.now()
      entry.state = 'interrupted'
      entry.outcome = String(input.reason ?? 'interrupted by tower').slice(0, 1000)
      entry.outcomeAt = now
      clearStale(entry)
      state.revision += 1
      state.updatedAt = now
      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, {
        at: now,
        type: 'spawn',
        missionId: entry.missionId,
        text: `${entry.name} interrupted: ${entry.outcome}`,
      })
      return entry
    })
  }

  async provision(input = {}) {
    const missionId = input.missionId
    if (typeof missionId !== 'string' || missionId.trim().length === 0) {
      fail('tower_spawn requires missionId in this version')
    }
    return withLock(this.paths, async () => {
      const state = await this.load()
      const mission = state.missions.find((entry) => entry.id === missionId)
      if (!mission) fail(`unknown mission "${missionId}"`)
      if (mission.worktree) {
        await this.assertWorktree(mission.worktree)
        return { mission, worktree: mission.worktree, created: false }
      }

      const baseCommit = input.baseCommit
        ? String(input.baseCommit)
        : input.includeDirtyBase === false
          ? await revParse(this.root, state.base)
          : state.snapshotCommit && (await this.tryGit(this.root, ['cat-file', '-e', `${state.snapshotCommit}^{commit}`])) !== null
            ? state.snapshotCommit
            : await revParse(this.root, state.base)
      const branch = `tower/${mission.id.toLowerCase()}-${slugify(mission.title)}`
      const configuredRoot = this.config.worktrees.root
      const root = input.worktreeRoot
        ? path.resolve(input.worktreeRoot)
        : configuredRoot
          ? path.resolve(configuredRoot)
          : path.join(path.dirname(this.root), '.dsh-tower-worktrees', shortHash(this.commonDir))
      if (!path.isAbsolute(root)) fail('worktreeRoot must be an absolute path')
      this.assertOutside(root)
      await ensureDir(root)

      const wtPath = path.join(root, mission.id)
      if (await exists(wtPath)) fail(`worktree path already exists: ${wtPath}`)
      if (await branchExists(this.root, branch)) fail(`branch already exists: ${branch}`)

      await addWorktree(this.root, { path: wtPath, branch, commit: baseCommit })
      await this.ensureExcluded(wtPath)
      const now = Date.now()
      const worktree = { path: wtPath, branch, baseCommit, createdAt: now, realPath: await canonicalPath(wtPath) }
      mission.worktree = worktree
      mission.baseCommit = baseCommit
      mission.updatedAt = now
      state.revision += 1
      state.updatedAt = now

      try {
        validateState(state, this.paths.state)
        await writeJsonAtomic(this.paths.state, state)
      } catch (error) {
        // Roll back Git resources if state persistence failed, otherwise the
        // mission is wedged forever with an untracked worktree/branch.
        await this.git(this.root, ['worktree', 'remove', '--force', wtPath]).catch(() => {})
        await this.git(this.root, ['branch', '-D', branch]).catch(() => {})
        throw error
      }
      await appendJsonl(this.paths.activity, {
        at: now,
        type: 'worktree',
        missionId,
        text: `${branch} at ${wtPath}`,
      }).catch(() => {})
      return { mission, worktree, created: true }
    })
  }

  async missionContext(missionId) {
    const state = await this.load()
    const mission = state.missions.find((entry) => entry.id === missionId)
    if (!mission) fail(`unknown mission "${missionId}"`)
    const byId = new Map(state.missions.map((entry) => [entry.id, entry]))
    const branch = mission.worktree ? mission.worktree.branch : null
    const reviews = branch
      ? (state.reviews ?? [])
          .filter((review) => review.branch === branch)
          .slice()
          .sort((a, b) => b.round - a.round)
          .slice(0, 3)
      : []
    const findings = (state.findings ?? [])
      .filter((finding) => finding.missionId === mission.id)
      .slice()
      .sort((a, b) => b.seq - a.seq)
      .slice(0, 10)
    return {
      base: state.base,
      mission: fullMission(mission),
      snapshotCommit: state.snapshotCommit ?? null,
      completionReport: mission.completionReport ?? null,
      reviews: reviews.map((review) => ({
        id: review.id,
        round: review.round,
        status: review.status,
        mergeVerdict: review.mergeVerdict,
        reviewer: review.reviewer,
        findings: review.findings,
        checks: review.checks ?? [],
        decision: review.decision,
        reviewedCommit: review.reviewedCommit,
        at: review.at,
      })),
      findings: findings.map((finding) => findingSummary(finding)),
      deps: (mission.deps ?? []).map((id) => {
        const dep = byId.get(id)
        return dep ? { id, title: dep.title, status: dep.status } : { id, title: null, status: 'unknown' }
      }),
    }
  }

  /** Reserve a roster name before activation so a failed spawn is recoverable. */
  async reserveRoster(input) {
    return withLock(this.paths, async () => {
      const state = await this.load()
      const mission = state.missions.find((entry) => entry.id === input.missionId)
      if (!mission) fail(`unknown mission "${input.missionId}"`)
      if (!Array.isArray(state.roster)) state.roster = []
      if (state.roster.some((entry) => entry.name === input.name)) fail(`roster name already used: ${input.name}`)
      const now = Date.now()
      const entry = {
        name: input.name,
        role: input.role,
        agentId: null,
        sessionId: null,
        parentSessionId: input.parentSessionId,
        missionId: input.missionId,
        cwd: input.cwd ?? null,
        branch: input.branch ?? null,
        spawnTip: null,
        state: 'reserved',
        reservedAt: now,
        spawnedAt: now,
      }
      state.roster.push(entry)
      state.revision += 1
      state.updatedAt = now
      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, {
        at: now,
        type: 'spawn',
        missionId: input.missionId,
        text: `reserved ${input.role} ${input.name}`,
      })
      return entry
    })
  }

  async recordSpawn(input) {
    return withLock(this.paths, async () => {
      const state = await this.load()
      const mission = state.missions.find((entry) => entry.id === input.missionId)
      if (!mission) fail(`unknown mission "${input.missionId}"`)
      if (!Array.isArray(state.roster)) state.roster = []
      const reserved = state.roster.find((entry) => entry.name === input.name && entry.state === 'reserved' && !entry.agentId)
      if (!reserved && state.roster.some((entry) => entry.name === input.name)) {
        fail(`roster name already used: ${input.name}`)
      }
      if (state.roster.some((entry) => entry.agentId && entry.agentId === input.agentId)) {
        fail(`agent ${input.agentId} is already in the roster`)
      }
      const now = Date.now()
      const spawnTip = input.cwd ? ((await this.tryGit(input.cwd, ['rev-parse', 'HEAD'])) ?? '').trim() || null : null
      const entry = {
        name: input.name,
        role: input.role,
        agentId: input.agentId,
        sessionId: input.sessionId ?? input.agentId,
        parentSessionId: input.parentSessionId,
        missionId: input.missionId,
        cwd: input.cwd ?? null,
        branch: input.branch ?? null,
        spawnTip,
        state: 'active',
        spawnedAt: now,
      }
      if (input.role === 'worker') {
        const previous = workerEntries(state, mission.id)
        const live = previous.find((entry) => !ROSTER_INACTIVE.has(entry.state) && entry.state !== 'reserved')
        if (live && !input.takeover) {
          fail(
            `mission ${mission.id} already has a live worker "${live.name}"; stop it with tower_interrupt, or pass takeover:true after it is no longer running`,
          )
        }
        // A new owner always retires the mission's older worker entries, including
        // idle `inactive` ones; otherwise the next spawn would see several entries
        // for the same mission and the old idle worker would block forever.
        for (const old of previous) {
          if (old.state === 'retired' || old.state === 'reserved') continue
          old.state = 'retired'
          old.outcome = `replaced by ${input.name}${input.takeover ? ' (takeover)' : ''}`
          old.outcomeAt = now
          clearStale(old)
        }
        const liveCount = countLiveWorkers(state)
        const max = Number(this.config.spawn.maxLiveWorkers) || 4
        if (liveCount >= max) {
          fail(`live worker limit reached (${max}); stop a worker or raise spawn.maxLiveWorkers`)
        }
        const generation = (mission.ownerGeneration ?? 0) + 1
        entry.generation = generation
        mission.ownerGeneration = generation
        mission.owner = input.name
        if (mission.status === 'planned') mission.status = 'active'
      }
      if (reserved) Object.assign(reserved, entry)
      else state.roster.push(entry)
      mission.updatedAt = now
      state.revision += 1
      state.updatedAt = now

      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, {
        at: now,
        type: 'spawn',
        missionId: input.missionId,
        text: `${input.role} ${input.name} (${input.agentId})`,
      })
      return reserved ?? entry
    })
  }

  async rosterView() {
    const state = await this.load()
    return {
      revision: state.revision,
      roster: (state.roster ?? []).map((entry) => ({ ...entry })),
      missions: state.missions.map((mission) => ({
        id: mission.id,
        status: mission.status,
        owner: mission.owner ?? null,
        worktree: mission.worktree
          ? {
              path: mission.worktree.path,
              branch: mission.worktree.branch,
              baseCommit: mission.worktree.baseCommit,
            }
          : null,
      })),
    }
  }

  async recordTestRun(input = {}) {
    return withLock(this.paths, async () => {
      const state = await this.load()
      const mission = state.missions.find((entry) => entry.id === input.missionId)
      if (!mission) fail(`unknown mission "${input.missionId}"`)
      if (!mission.testRuns) mission.testRuns = []
      const rawReceipt = { ...input.receipt, recordedAt: Date.now() }
      // Keep state bounded even when a repository reports a huge suite.
      const tests = Array.isArray(rawReceipt.tests) ? rawReceipt.tests : []
      const receipt = tests.length > 100
        ? { ...rawReceipt, tests: tests.slice(0, 100), testsTotal: rawReceipt.count ?? tests.length, testsTruncated: true }
        : rawReceipt
      mission.testRuns.push(receipt)
      if (mission.testRuns.length > 50) mission.testRuns = mission.testRuns.slice(-50)
      const MAX_RUNS_BYTES = 512 * 1024
      while (mission.testRuns.length > 1 && Buffer.byteLength(JSON.stringify(mission.testRuns), 'utf8') > MAX_RUNS_BYTES) {
        mission.testRuns.shift()
      }
      state.revision += 1
      state.updatedAt = Date.now()
      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, {
        at: Date.now(),
        type: 'test',
        missionId: mission.id,
        text: receipt.ok === true ? `passed ${receipt.tests?.length ?? 0} test(s)` : `failed: ${String(receipt.error ?? 'unknown').slice(0, 200)}`,
      })
      return receipt
    })
  }

  async recordLegacySnapshot(snapshot) {
    return withLock(this.paths, async () => {
      const state = await this.load()
      if (!Array.isArray(state.legacySnapshots)) state.legacySnapshots = []
      const existing = state.legacySnapshots.find((entry) => entry.sourceHash === snapshot.sourceHash)
      if (existing) return { snapshot: existing, duplicate: true }
      state.legacySnapshots.push(snapshot)
      state.revision += 1
      state.updatedAt = Date.now()
      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      return { snapshot, duplicate: false }
    })
  }

  async recordLegacyMap(map) {
    return withLock(this.paths, async () => {
      const state = await this.load()
      if (!Array.isArray(state.legacyMaps)) state.legacyMaps = []
      const existing = state.legacyMaps.find(
        (entry) => entry.sourceHash === map.sourceHash && entry.oldId === map.oldId,
      )
      if (existing) return { map: existing, duplicate: true }
      state.legacyMaps.push(map)
      state.revision += 1
      state.updatedAt = Date.now()
      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      return { map, duplicate: false }
    })
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

  async recordRosterObservations({ present = [], absent = [], confirmations = 2 }) {
    const presentIds = new Set(present)
    const absentIds = new Set(absent)
    return withLock(this.paths, async () => {
      const state = await this.load()
      const candidates = []
      const now = Date.now()
      let changed = false
      for (const entry of state.roster ?? []) {
        if (presentIds.has(entry.agentId)) {
          if (entry.absentObservations !== undefined) {
            delete entry.absentObservations
            delete entry.absentSince
            changed = true
          }
          continue
        }
        if (!absentIds.has(entry.agentId)) continue
        entry.absentObservations = (entry.absentObservations ?? 0) + 1
        entry.absentSince ??= now
        changed = true
        if (entry.absentObservations >= Math.max(2, Number(confirmations) || 2)) candidates.push(entry.agentId)
      }
      if (changed) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, this.paths.state)
        await writeJsonAtomic(this.paths.state, state)
      }
      return { candidates }
    })
  }

  /** Release live roster slots whose catalog activity is explicitly inactive. */
  async reconcileObservedInactive(activity = {}) {
    return withLock(this.paths, async () => {
      const state = await this.load()
      const released = []
      const now = Date.now()
      for (const entry of state.roster ?? []) {
        if (entry.state === 'reserved' || ROSTER_INACTIVE.has(entry.state)) continue
        if (activity[entry.agentId] !== 'inactive') continue
        entry.state = 'inactive'
        entry.outcome = 'catalog reported inactive'
        entry.outcomeAt = now
        clearStale(entry)
        released.push(entry.name)
      }
      if (released.length > 0) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, this.paths.state)
        await writeJsonAtomic(this.paths.state, state)
        await appendJsonl(this.paths.activity, {
          at: now,
          type: 'roster',
          text: `released inactive slots: ${released.join(', ')}`,
        })
      }
      return { released }
    })
  }

  async markRetired(agentIds) {
    if (!Array.isArray(agentIds) || agentIds.length === 0) return { retired: [] }
    return withLock(this.paths, async () => {
      const state = await this.load()
      const retired = []
      const now = Date.now()
      for (const entry of state.roster ?? []) {
        if (entry.state !== 'retired' && agentIds.includes(entry.agentId)) {
          entry.state = 'retired'
          entry.retiredAt = now
          clearStale(entry)
          retired.push(entry.agentId)
        }
      }
      if (retired.length > 0) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, this.paths.state)
        await writeJsonAtomic(this.paths.state, state)
        await appendJsonl(this.paths.activity, {
          at: now,
          type: 'adopt',
          text: `retired ${retired.join(', ')}`,
        })
      }
      return { retired }
    })
  }

  async markMissing(agentIds) {
    if (!Array.isArray(agentIds) || agentIds.length === 0) return { missing: [] }
    return withLock(this.paths, async () => {
      const state = await this.load()
      const missing = []
      const now = Date.now()
      for (const entry of state.roster ?? []) {
        if (!ROSTER_INACTIVE.has(entry.state) && agentIds.includes(entry.agentId)) {
          entry.state = 'missing'
          entry.missingSince = now
          clearStale(entry)
          missing.push(entry.agentId)
        }
      }
      if (missing.length > 0) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, this.paths.state)
        await writeJsonAtomic(this.paths.state, state)
        await appendJsonl(this.paths.activity, { at: now, type: 'adopt', text: `missing ${missing.join(', ')}` })
      }
      return { missing }
    })
  }

  /** Mark live roster entries whose catalog activity disappeared after staleMs.
   * `authoritative` must be true only when the parent catalog was readable;
   * unknown state is never treated as stopped. */
  async sweepRoster(input = {}) {
    const staleMs = Number(input.staleMs) || 0
    if (staleMs <= 0 || input.authoritative !== true) return { marked: [], idled: [] }
    const activity = input.activity ?? {}
    return withLock(this.paths, async () => {
      const state = await this.load()
      const now = Date.now()
      const marked = []
      const idled = []
      for (const entry of state.roster ?? []) {
        if (ROSTER_INACTIVE.has(entry.state)) continue
        const observed = activity[entry.agentId]
        if (observed === 'inactive') {
          entry.state = 'inactive'
          entry.outcome = entry.outcome ?? 'idle (catalog)'
          entry.outcomeAt = now
          idled.push(entry.name)
          continue
        }
        if (observed === 'running') continue
        if (observed !== undefined) continue
        const age = now - Number(entry.spawnedAt ?? now)
        if (age > staleMs) {
          entry.state = 'stale'
          entry.stale = true
          entry.staleAt = now
          marked.push(entry.name)
        }
      }
      if (marked.length > 0 || idled.length > 0) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, this.paths.state)
        await writeJsonAtomic(this.paths.state, state)
        await appendJsonl(this.paths.activity, {
          at: now,
          type: 'watchdog',
          text: `stale ${marked.join(', ') || '-'}; idle ${idled.join(', ') || '-'}`,
        })
      }
      return { marked, idled }
    })
  }

  unreadFor(state, name) {
    return (state.messages ?? []).filter((message) => {
      if (message.from === name) return false
      if (message.to !== name && message.to !== 'all') return false
      return !(message.readBy ?? []).includes(name)
    })
  }

  async recordMessage(input) {
    return withLock(this.paths, async () => {
      const state = await this.load()
      if (!Array.isArray(state.messages)) state.messages = []
      const names = new Set((state.roster ?? []).map((entry) => entry.name))
      names.add('tower')
      if (input.to !== 'all' && !names.has(input.to)) {
        fail(`unknown message recipient "${input.to}" (known: ${[...names].join(', ')}, all)`)
      }
      if (input.to === input.from) fail('refusing to send a message to yourself')
      const now = Date.now()
      const seq = (state.messageSeq ?? 0) + 1
      state.messageSeq = seq
      const message = {
        id: `msg-${seq}`,
        seq,
        from: input.from,
        to: input.to,
        subject: input.subject,
        body: input.body,
        scope: input.scope ?? null,
        consentRef: input.consentRef ?? null,
        at: now,
        readBy: [],
        delivery: [],
      }
      state.messages.push(message)
      state.revision += 1
      state.updatedAt = now

      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, {
        at: now,
        type: 'message',
        text: `${input.from} -> ${input.to}: ${input.subject}`,
      })
      return { ...message, readBy: [], delivery: [] }
    })
  }

  async recordDelivery(messageId, results) {
    return withLock(this.paths, async () => {
      const state = await this.load()
      const message = (state.messages ?? []).find((entry) => entry.id === messageId)
      if (!message) fail(`unknown message "${messageId}"`)
      message.delivery = [...(message.delivery ?? []), ...results]
      state.revision += 1
      state.updatedAt = Date.now()
      await writeJsonAtomic(this.paths.state, state)
      return message.delivery
    })
  }

  async inbox(input) {
    const reader = input.reader
    return withLock(this.paths, async () => {
      const state = await this.load()
      const limit = Math.max(1, Math.min(100, input.limit ?? 20))
      const includeRead = input.includeRead === true
      const visible = [...(state.messages ?? [])]
        .reverse()
        .filter((message) => (message.to === reader || message.to === 'all') && message.from !== reader)
      const unread = visible.filter((message) => !(message.readBy ?? []).includes(reader))
      const page = (includeRead ? visible : unread).slice(0, limit)

      let changed = false
      for (const message of page) {
        if (!(message.readBy ?? []).includes(reader)) {
          message.readBy = [...(message.readBy ?? []), reader]
          message.readAt = { ...(message.readAt ?? {}), [reader]: Date.now() }
          changed = true
        }
      }
      const unreadRemaining = visible.filter((message) => !(message.readBy ?? []).includes(reader)).length
      if (changed) {
        state.revision += 1
        state.updatedAt = Date.now()
        validateState(state, this.paths.state)
        await writeJsonAtomic(this.paths.state, state)
      }
      return {
        reader,
        messages: page.map((message) => ({
          id: message.id,
          from: message.from,
          to: message.to,
          subject: message.subject,
          body: message.body,
          scope: message.scope ?? null,
          at: message.at,
          delivery: message.delivery ?? [],
          ackAt: message.readAt?.[reader] ?? null,
        })),
        pageSize: page.length,
        unreadRemaining,
      }
    })
  }

  /** Read-only completion preconditions shared by tower_complete and the tool
   * layer's test-discovery preflight. Throws on the first failed condition. */
  async checkCompletion(input) {
    const state = await this.load()
    const mission = state.missions.find((entry) => entry.id === input.missionId)
    if (!mission) fail(`unknown mission "${input.missionId}"`)
    const worker = (state.roster ?? []).find((entry) => entry.agentId === input.agentId)
    if (!worker || worker.missionId !== mission.id) {
      fail(`agent ${input.agentId} is not assigned to mission ${mission.id}`)
    }
    if (worker.role !== 'worker') fail(`agent ${worker.name} is a ${worker.role}, not a worker`)
    if (['retired', 'failed', 'interrupted', 'missing', 'stale'].includes(worker.state)) {
      fail(`agent ${worker.name} is ${worker.state}; a stopped worker cannot report completion`)
    }
    if (mission.owner && mission.owner !== worker.name) {
      fail(`agent ${worker.name} is not the current owner of mission ${mission.id} (owner: ${mission.owner})`)
    }
    if (mission.status === 'completed') fail(`mission ${mission.id} is already completed`)
    if (!['active', 'planned'].includes(mission.status)) {
      fail(`mission ${mission.id} is ${mission.status}; it cannot be completed from that state`)
    }
    if (typeof input.report !== 'string' || input.report.trim().length === 0) {
      fail('tower_complete requires a non-empty report')
    }
    const openTasks = mission.tasks.filter((task) => task.status === 'open')
    if (openTasks.length > 0) {
      fail(
        `mission ${mission.id} still has ${openTasks.length} open task(s): ${openTasks
          .map((task) => task.text)
          .join('; ')}`,
      )
    }
    if ((mission.blockers ?? []).length > 0) {
      fail(`mission ${mission.id} has unresolved blockers: ${mission.blockers.join('; ')}`)
    }
    if (!mission.worktree) fail(`mission ${mission.id} has no worktree`)
    await this.assertWorktree(mission.worktree)
    const commits = await countCommits(mission.worktree.path, mission.worktree.baseCommit)
    if (commits < 1) {
      fail(`mission branch has no commits since ${String(mission.worktree.baseCommit).slice(0, 12)}`)
    }
    if (!(await isClean(mission.worktree.path))) {
      const dirty = (await this.git(mission.worktree.path, ['status', '--porcelain']))
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
      throw new TowerToolError(
        'worktree-dirty',
        `mission ${mission.id} worktree has uncommitted changes (${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? ', …' : ''}); commit, remove, or record them before tower_complete`,
      )
    }
    const unread = this.unreadFor(state, worker.name)
    if (unread.length > 0) {
      fail(
        `mission ${mission.id} cannot complete with ${unread.length} unread inbox message(s) for ${worker.name}; call tower_inbox until unread is 0, incorporate them, then retry`,
      )
    }
    return { state, mission, worker, commits }
  }

  async complete(input) {
    // Two-phase pilot (#51): expensive git/state checks run before the lock;
    // the lock only revalidates the state revision and commits the transition.
    const prepared = await this.checkCompletion(input)
    return withLock(this.paths, async () => {
      const state = await this.load()
      if (state.revision !== prepared.state.revision) {
        throw new TowerToolError('stale-base', 'tower state changed while completion was being prepared; retry')
      }
      const mission = state.missions.find((entry) => entry.id === input.missionId)
      if (!mission) throw new TowerToolError('mission-not-found', `unknown mission "${input.missionId}"`)
      const { worker, commits } = prepared
      const checks = normalizeChecks(input.checks)
      const now = Date.now()
      mission.status = 'completed'
      mission.completionReport = { report: input.report.trim(), by: worker.name, at: now, checks }
      mission.updatedAt = now
      state.revision += 1
      state.updatedAt = now

      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, {
        at: now,
        type: 'complete',
        missionId: mission.id,
        text: `${worker.name} reported completion (${commits} commit(s))`,
      })
      return { mission: fullMission(mission), commits, unread: 0 }
    })
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
    await ensureDir(path.dirname(file))
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
    if (this.config.docs?.board === false) return null
    try {
      const state = await this.load()
      const file = this.config.docs?.boardLocation === 'repo'
        ? path.join(this.root, 'MISSIONS.md')
        : path.join(this.paths.dir, 'MISSIONS.md')
      await this.ensureExcluded(file)
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
      await fsp.writeFile(tmp, this.boardMarkdown(state), 'utf8')
      await renameWithRetry(tmp, file)
      return file
    } catch {
      return null
    }
  }

  boardFile() {
    return this.config.docs?.boardLocation === 'repo'
      ? path.join(this.root, 'MISSIONS.md')
      : path.join(this.paths.dir, 'MISSIONS.md')
  }

  async enrichedMissions(state, onlyIds) {
    const wanted = onlyIds ? new Set(onlyIds) : null
    const out = []
    for (const mission of state.missions) {
      if (wanted && !wanted.has(mission.id)) continue
      const summary = missionSummary(mission)
      const branch = mission.worktree ? mission.worktree.branch : null
      const reviews = branch ? (state.reviews ?? []).filter((review) => review.branch === branch) : []
      const latest = reviews.length > 0 ? reviews.reduce((a, b) => (a.round >= b.round ? a : b)) : null
      let tipMoved = false
      if (latest && mission.worktree && (await exists(mission.worktree.path))) {
        try {
          const tip = await revParse(mission.worktree.path, 'HEAD')
          tipMoved = tip !== latest.reviewedCommit
        } catch {
          tipMoved = false
        }
      }
      out.push({
        ...summary,
        review: latest
          ? {
              id: latest.id,
              round: latest.round,
              status: latest.status,
              mergeVerdict: latest.mergeVerdict,
              reviewer: latest.reviewer,
              reviewerRole: latest.reviewerRole,
              reviewedCommit: latest.reviewedCommit,
              at: latest.at,
            }
          : null,
        tipMoved,
      })
    }
    return out
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
      head = await revParse(this.root, 'HEAD')
    } catch {
      return false
    }
    const mergeHeadPath = path.join(this.commonDir, 'MERGE_HEAD')
    const inProgress = await exists(mergeHeadPath)
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
    await writeJsonAtomic(this.paths.state, state)
    await appendJsonl(this.paths.activity, {
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
        this.config.gates.allowReviewExemption === true &&
        String(mission.reviewExemptionReason ?? '').trim().length > 0)
    if (reviews.length === 0 && !exempt) return null
    const latest = reviews.length > 0 ? reviews.reduce((a, b) => (a.round >= b.round ? a : b)) : null
    if (latest && !exempt && (latest.status !== 'clean' || latest.mergeVerdict !== 'merge')) return null
    if (!latest && !exempt) return null
    let baseTip
    let branchTip
    try {
      baseTip = await revParse(this.root, state.base)
      branchTip = await revParse(mission.worktree.path, 'HEAD')
    } catch {
      return null
    }
    const reviewedTip = latest?.reviewedCommit ?? null
    const branchLanded = await isAncestor(this.root, branchTip, baseTip)
    const reviewedLanded = reviewedTip ? await isAncestor(this.root, reviewedTip, baseTip) : false
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
    await writeJsonAtomic(this.paths.state, state)
    await appendJsonl(this.paths.activity, {
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
