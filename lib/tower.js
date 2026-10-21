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

export { MISSION_STATUSES, SCHEMA_VERSION, MERGE_VERDICTS } from './domain/mission.js'
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

export const FINDING_TYPES = ['bug', 'improve', 'vuln', 'idea']
export const FINDING_SEVERITIES = ['low', 'medium', 'high', 'critical']
export const FINDING_STATUSES = ['open', 'triaged', 'fixed', 'wontfix']
export const ROLES = ['worker', 'reviewer']
export const FINDING_TRANSITIONS = {
  open: ['triaged', 'fixed', 'wontfix'],
  triaged: ['open', 'fixed', 'wontfix'],
  fixed: ['open'],
  wontfix: ['open'],
}
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
    return withLock(this.paths, async () => {
      const state = await this.load()
      const normalized = validateBatchCreate(state, input)
      if (!Array.isArray(state.batches)) state.batches = []
      const max = state.batches.reduce((value, batch) => {
        const match = /^B(\d+)$/.exec(String(batch.id ?? ''))
        return match ? Math.max(value, Number(match[1])) : value
      }, 0)
      const batch = {
        id: `B${max + 1}`,
        status: 'open',
        ...normalized,
        createdBy: actor,
        createdAt: Date.now(),
      }
      state.batches.push(batch)
      state.revision += 1
      state.updatedAt = batch.createdAt
      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, {
        at: batch.createdAt,
        type: 'batch',
        text: `created ${batch.id}: ${batch.missionIds.join(', ')}`,
      })
      return batch
    })
  }

  async closeBatch(batchId, options = {}, actor = 'tower') {
    return withLock(this.paths, async () => {
      const state = await this.load()
      const batch = (state.batches ?? []).find((entry) => entry.id === batchId)
      if (!batch) fail(`unknown batch "${batchId}"`)
      const result = validateBatchClose(state, batch, { ...options, state })
      const blockers = Array.isArray(result.blockers) ? result.blockers : []
      if (blockers.length > 0) return { ok: false, batch, blockers, checks: result.checks ?? [] }
      batch.status = 'closed'
      batch.closedAt = Date.now()
      batch.closedBy = actor
      batch.close = {
        checks: options.checks ?? [],
        treeTip: options.treeTip ?? null,
        receiptHashes: options.receiptHashes ?? {},
        at: batch.closedAt,
      }
      state.revision += 1
      state.updatedAt = batch.closedAt
      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, { at: batch.closedAt, type: 'batch', text: `closed ${batch.id}` })
      return { ok: true, batch, blockers: [], checks: result.checks ?? [] }
    })
  }

  async abandonBatch(batchId, actor = 'tower', reason = null) {
    return withLock(this.paths, async () => {
      const state = await this.load()
      const batch = (state.batches ?? []).find((entry) => entry.id === batchId)
      if (!batch) fail(`unknown batch "${batchId}"`)
      if (batch.status === 'closed') fail(`batch ${batchId} is already closed`)
      if (batch.status === 'abandoned') return { ok: true, batch, alreadyAbandoned: true }
      batch.status = 'abandoned'
      batch.abandonedAt = Date.now()
      batch.abandonedBy = actor
      batch.abandonReason = typeof reason === 'string' && reason.trim() ? reason.trim() : null
      state.revision += 1
      state.updatedAt = batch.abandonedAt
      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, { at: batch.abandonedAt, type: 'batch', text: `abandoned ${batch.id}` })
      return { ok: true, batch, alreadyAbandoned: false }
    })
  }

  async batchStatus(batchId) {
    const state = await this.load()
    const batch = batchId
      ? (state.batches ?? []).find((entry) => entry.id === batchId)
      : null
    if (batchId && !batch) fail(`unknown batch "${batchId}"`)
    return {
      batches: (state.batches ?? []).map((entry) => summarizeBatch(state, entry)),
      ...(batch ? { batch: summarizeBatch(state, batch) } : {}),
    }
  }

  /** Track repeated absence observations before declaring a roster row gone. */
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
    return withLock(this.paths, async () => {
      const state = await this.load()
      if (!Array.isArray(state.findings)) state.findings = []
      if (!FINDING_TYPES.includes(input.type)) {
        fail(`finding type must be one of ${FINDING_TYPES.join('|')}`)
      }
      const title = String(input.title ?? '').trim()
      if (!title) fail('finding title is required')
      const summary = String(input.summary ?? '').trim()
      if (!summary) fail('finding summary is required')
      const details = String(input.details ?? '').trim()
      if (!details) fail('finding details are required')
      const suggestedFix = String(input.suggested_fix ?? '').trim()
      if (!suggestedFix) fail('finding suggested_fix is required')
      const severity = input.severity ?? null
      if (severity !== null && !FINDING_SEVERITIES.includes(severity)) {
        fail(`finding severity must be one of ${FINDING_SEVERITIES.join('|')}`)
      }
      let mission = null
      if (input.missionId !== undefined && input.missionId !== null && input.missionId !== '') {
        mission = state.missions.find((entry) => entry.id === input.missionId)
        if (!mission) fail(`unknown mission "${input.missionId}"`)
      }
      const now = Date.now()
      const seq = (state.findingSeq ?? 0) + 1
      state.findingSeq = seq
      const finding = {
        id: `F${seq}`,
        seq,
        type: input.type,
        title,
        severity,
        summary,
        location: typeof input.location === 'string' && input.location.trim() ? input.location.trim() : null,
        details,
        suggested_fix: suggestedFix,
        missionId: mission ? mission.id : null,
        branch: mission && mission.worktree ? mission.worktree.branch : null,
        reportedBy: input.reportedBy,
        at: now,
        status: 'open',
      }
      state.findings.push(finding)
      state.revision += 1
      state.updatedAt = now

      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, {
        at: now,
        type: 'finding',
        missionId: finding.missionId,
        text: `${finding.id} ${finding.type}: ${finding.title}`,
      })
      return finding
    })
  }

  /** List or read findings. Read-only paths never take the writer lock. */
  async readFindings(input = {}) {
    const state = await this.load()
    const all = state.findings ?? []
    const counts = countFindings(all)
    if (input.id !== undefined && input.id !== null && input.id !== '') {
      const finding = all.find((entry) => entry.id === input.id)
      if (!finding) fail(`unknown finding "${input.id}"`)
      return { finding: { ...finding }, counts, total: all.length, filtered: 1, action: 'read' }
    }
    if (input.status !== undefined && input.status !== 'all') {
      if (!FINDING_STATUSES.includes(input.status)) {
        fail(`finding status must be one of ${FINDING_STATUSES.join('|')}`)
      }
    }
    let visible = all
    if (input.status !== undefined && input.status !== 'all') {
      visible = visible.filter((finding) => (finding.status ?? 'open') === input.status)
    }
    if (input.type !== undefined) {
      if (!FINDING_TYPES.includes(input.type)) fail(`finding type must be one of ${FINDING_TYPES.join('|')}`)
      visible = visible.filter((finding) => finding.type === input.type)
    }
    if (input.severity !== undefined) {
      if (!FINDING_SEVERITIES.includes(input.severity)) {
        fail(`finding severity must be one of ${FINDING_SEVERITIES.join('|')}`)
      }
      visible = visible.filter((finding) => finding.severity === input.severity)
    }
    if (input.missionId !== undefined && input.missionId !== null && input.missionId !== '') {
      visible = visible.filter((finding) => finding.missionId === input.missionId)
    }
    if (input.open === true) {
      visible = visible.filter((finding) => !['fixed', 'wontfix'].includes(finding.status ?? 'open'))
    }
    const limit = Math.max(1, Math.min(200, Number.isInteger(input.limit) ? input.limit : 50))
    const page = visible.slice(-limit).reverse()
    return {
      findings: page.map((finding) => findingSummary(finding)),
      counts,
      total: all.length,
      filtered: visible.length,
      action: 'list',
    }
  }

  /**
   * List, read, or transition findings. Listing and reading are lock-free;
   * only a transition takes the writer lock. Reviewers may only read.
   */
  async findings(input = {}) {
    const actor = input.actor ?? { name: 'tower', role: 'tower' }
    if (typeof actor.role !== 'string') fail('finding actor role must be a string')
    const hasId = input.id !== undefined && input.id !== null && input.id !== ''
    const wantsUpdate = hasId && (input.status !== undefined || input.note !== undefined)
    if (!wantsUpdate) return this.readFindings(input)

    return withLock(this.paths, async () => {
      const state = await this.load()
      const all = state.findings ?? []
      const finding = all.find((entry) => entry.id === input.id)
      if (!finding) fail(`unknown finding "${input.id}"`)
      if (actor.role === 'reviewer') {
        fail('reviewers may list and read findings, but only the tower or a worker may change finding status')
      }
      const now = Date.now()
      if (input.status !== undefined) {
        if (input.status === 'all') {
          fail('finding status "all" is only a list filter; pass a concrete status when updating')
        }
        if (!FINDING_STATUSES.includes(input.status)) {
          fail(`finding status must be one of ${FINDING_STATUSES.join('|')}`)
        }
        const current = finding.status ?? 'open'
        const allowed = FINDING_TRANSITIONS[current] ?? []
        if (!allowed.includes(input.status)) {
          fail(`finding ${finding.id} cannot move from ${current} to ${input.status}`)
        }
        finding.status = input.status
        if (input.status === 'fixed' || input.status === 'wontfix') finding.closedAt = now
        else delete finding.closedAt
      }
      if (input.note !== undefined) {
        if (typeof input.note !== 'string' || input.note.trim().length === 0) {
          fail('finding note must be a non-empty string')
        }
        if (!Array.isArray(finding.notes)) finding.notes = []
        finding.notes.push({ by: actor.name, at: now, text: input.note.trim() })
      }
      finding.updatedAt = now
      state.revision += 1
      state.updatedAt = now
      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, {
        at: now,
        type: 'finding',
        missionId: finding.missionId,
        text: `${finding.id} ${finding.status}${input.note !== undefined ? ' +note' : ''} (${actor.name})`,
      })
      // Counts must reflect the transition just recorded.
      return { finding: { ...finding }, counts: countFindings(all), total: all.length, filtered: 1, action: 'updated' }
    })
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
    return withLock(this.paths, async () => {
      const state = await this.load()
      const mission = state.missions.find((entry) => entry.id === input.missionId)
      if (!mission) {
        return { ok: false, blockers: [{ code: 'mission-missing', detail: `unknown mission "${input.missionId}"` }] }
      }
      await this.reconcileMergeIntent(state, mission)
      const baseTip = await revParse(this.root, state.base)
      if (mission.status === 'merged') {
        return { ok: true, alreadyMerged: true, mergedCommit: mission.mergedCommit ?? null, baseTip }
      }
      const reconciled = await this.reconcileLandedMerge(state, mission)
      if (reconciled) return reconciled
      const gate = await this.evaluateGate(input)
      if (!gate.ok) return { ok: false, blockers: gate.blockers, missionId: input.missionId }

      const worktree = mission.worktree
      const baseTipBefore = await revParse(this.root, 'HEAD')
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
      await writeJsonAtomic(this.paths.state, state)
      const timeoutMs = mergeTimeoutMs(input.timeoutMs, this.config)
      let failure = null
      try {
        // Merge the exact reviewed commit, never a mutable branch name. A
        // branch move after the gate must not smuggle extra commits into base.
        await this.git(
          this.root,
          ['merge', '--no-ff', branchTip, '-m', `tower: merge ${mission.id} — ${mission.title}`],
          { timeoutMs, maxBuffer: this.config.merge.maxBufferBytes || MERGE_MAX_BUFFER },
        )
      } catch (error) {
        failure = error
      }

      const newTip = await revParse(this.root, 'HEAD')
      const parents = await commitParents(this.root, newTip)
      const expectedShape = parents.length === 2 && parents[0] === baseTipBefore && parents[1] === branchTip
      const warnings = []

      if (failure && expectedShape) {
        warnings.push(
          `merge command reported a failure (${describeGitFailure(failure)}) but merge commit ${newTip.slice(0, 7)} exists; treated as merged`,
        )
        const dirty = (await this.git(this.root, ['status', '--porcelain']))
          .split('\n')
          .filter(Boolean)
          .map((line) => line.slice(3).trim())
        if (dirty.length > 0) {
          const changed = new Set(gate.changedFiles ?? [])
          if (dirty.every((file) => changed.has(file))) {
            await this.git(this.root, ['reset', '--hard', 'HEAD'])
            warnings.push('restored index/worktree to the merge commit (only merge-related paths were dirty)')
          } else {
            warnings.push('working tree still has unrelated changes; left untouched — inspect it before the next Git operation')
          }
        }
      } else if (failure) {
        const unmerged = (await this.tryGit(this.root, ['ls-files', '-u'])) ?? ''
        const conflict = unmerged.trim().length > 0
        let cleanup = 'none'
        const mergeHeadPath = path.join(this.commonDir, 'MERGE_HEAD')
        if (await exists(mergeHeadPath)) {
          try {
            await this.git(this.root, ['merge', '--abort'])
            cleanup = 'aborted'
          } catch {
            await removeStaleGitLocks(this.commonDir)
            try {
              await this.git(this.root, ['merge', '--abort'])
              cleanup = 'aborted-after-lock-cleanup'
            } catch {
              await this.git(this.root, ['reset', '--hard', baseTipBefore]).catch(() => {})
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
        const dirtyAfter = (await this.git(this.root, ['status', '--porcelain']))
          .split('\n')
          .filter(Boolean)
          .map((line) => line.slice(3).trim())
        if (dirtyAfter.length > 0) {
          const changed = new Set(gate.changedFiles ?? [])
          if (newTip === baseTipBefore && dirtyAfter.every((file) => changed.has(file))) {
            await removeStaleGitLocks(this.commonDir)
            await this.git(this.root, ['reset', '--hard', baseTipBefore]).catch(() => {})
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
        await writeJsonAtomic(this.paths.state, state)
        await appendJsonl(this.paths.activity, { at: now, type: 'merge', missionId: mission.id, text: `${conflict ? 'conflict' : 'failed-before-commit'} (${cleanup})` })
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
        await writeJsonAtomic(this.paths.state, state)
        await appendJsonl(this.paths.activity, {
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
      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, {
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

  async rebase(input) {
    return withLock(this.paths, async () => {
      const state = await this.load()
      const mission = state.missions.find((entry) => entry.id === input.missionId)
      if (!mission) fail(`unknown mission "${input.missionId}"`)
      if (!mission.worktree) fail(`mission ${mission.id} has no worktree to rebase`)
      const activity = input.activity ?? {}
      for (const entry of (state.roster ?? []).filter((row) => row.missionId === mission.id && !ROSTER_INACTIVE.has(row.state))) {
        if (activity[entry.agentId] === 'running') {
          return { ok: false, blockers: [{ code: 'worker-busy', detail: `agent ${entry.name} is running; rebase refused` }] }
        }
      }
      await this.assertWorktree(mission.worktree)
      if (!(await isClean(mission.worktree.path))) {
        return { ok: false, blockers: [{ code: 'worktree-dirty', detail: `${mission.worktree.path} has uncommitted changes` }] }
      }
      const oldTip = await revParse(mission.worktree.path, 'HEAD')
      const baseTip = await revParse(this.root, state.base)
      if (await isAncestor(this.root, oldTip, baseTip)) {
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
      if (await isAncestor(this.root, baseTip, oldTip)) {
        return { ok: true, alreadyUpToDate: true, oldTip, newTip: oldTip, baseTip }
      }
      const now = Date.now()
      try {
        await this.git(mission.worktree.path, ['rebase', baseTip])
      } catch (error) {
        await this.git(mission.worktree.path, ['rebase', '--abort']).catch(() => {})
        mission.status = 'blocked'
        mission.blockers.push(`rebase conflict onto ${state.base} @ ${baseTip.slice(0, 12)}`)
        mission.updatedAt = now
        state.revision += 1
        state.updatedAt = now
        await writeJsonAtomic(this.paths.state, state)
        await appendJsonl(this.paths.activity, { at: now, type: 'rebase', missionId: mission.id, text: 'conflict' })
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
      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, {
        at: now,
        type: 'rebase',
        missionId: mission.id,
        text: `${oldTip.slice(0, 7)} -> ${newTip.slice(0, 7)} onto ${baseTip.slice(0, 7)}`,
      })
      return { ok: true, oldTip, newTip, baseTip, reviewWaived: true }
    })
  }

  async teardown(input) {
    return withLock(this.paths, async () => {
      const state = await this.load()
      const activity = input.activity ?? {}
      const exclude = new Set(input.exclude ?? [])
      const decisions = []
      const removed = []
      const now = Date.now()

      for (const mission of state.missions) {
        if (!mission.worktree || mission.worktreeRemovedAt) continue
        if (exclude.has(mission.id)) {
          decisions.push({ missionId: mission.id, action: 'keep', reason: 'excluded' })
          continue
        }
        const live = (state.roster ?? []).some(
          (entry) => entry.missionId === mission.id && !ROSTER_INACTIVE.has(entry.state) && activity[entry.agentId] === 'running',
        )
        if (live) {
          decisions.push({ missionId: mission.id, action: 'keep', reason: 'live agent' })
          continue
        }
        if (!['merged', 'abandoned'].includes(mission.status)) {
          decisions.push({ missionId: mission.id, action: 'keep', reason: `mission is ${mission.status}` })
          continue
        }
        try {
          await this.assertWorktree(mission.worktree)
        } catch (error) {
          decisions.push({
            missionId: mission.id,
            action: 'keep',
            reason: `worktree ownership/registration unverified: ${String(error?.message ?? error).slice(0, 240)}`,
          })
          continue
        }
        let dirty = true
        try {
          dirty = !(await isClean(mission.worktree.path))
        } catch {
          dirty = true
        }
        if (dirty && input.force !== true) {
          decisions.push({ missionId: mission.id, action: 'keep', reason: 'uncommitted changes' })
          continue
        }
        if (input.dryRun === true) {
          decisions.push({ missionId: mission.id, action: 'remove', reason: 'eligible', forced: dirty })
          continue
        }
        try {
          await this.git(this.root, ['worktree', 'remove', ...(dirty ? ['--force'] : []), mission.worktree.path])
        } catch (error) {
          decisions.push({ missionId: mission.id, action: 'keep', reason: `remove failed: ${String(error?.message ?? error)}` })
          continue
        }
        let branchDeleteError = null
        try {
          await this.git(this.root, ['branch', '-d', mission.worktree.branch])
        } catch (error) {
          branchDeleteError = String(error?.message ?? error).slice(0, 240)
        }
        mission.worktreeRemovedAt = now
        mission.updatedAt = now
        if (branchDeleteError) mission.branchDeleteError = branchDeleteError
        else delete mission.branchDeleteError
        removed.push(mission.id)
        decisions.push({
          missionId: mission.id,
          action: 'removed',
          branch: mission.worktree.branch,
          ...(branchDeleteError ? { branchRetained: true, branchDeleteError } : {}),
        })
        await appendJsonl(this.paths.activity, {
          at: now,
          type: 'teardown',
          missionId: mission.id,
          text: `${mission.worktree.branch}${branchDeleteError ? ' (branch retained)' : ''}`,
        })
      }

      if (!input.dryRun && removed.length > 0) {
        state.revision += 1
        state.updatedAt = now
        validateState(state, this.paths.state)
        await writeJsonAtomic(this.paths.state, state)
      }
      return { ok: true, dryRun: input.dryRun === true, removed, decisions }
    })
  }

  async status(input = {}) {
    return status(this, input)
  }

}
