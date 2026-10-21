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
  setGitTimeout,
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
import { TowerToolError } from './errors.js'

export const SCHEMA_VERSION = 1
export const MISSION_STATUSES = [
  'planned',
  'active',
  'completed',
  'blocked',
  'paused',
  'merged',
  'abandoned',
]
const TERMINAL = new Set(['merged', 'abandoned'])
/** Roster states that no longer represent a live writer. `inactive` is an idle
 * child whose turn finished: it must not block a new owner or consume a worker
 * slot. `unknown` is deliberately NOT included because it cannot be proven
 * stopped. */
export const ROSTER_INACTIVE_STATES = ['retired', 'failed', 'interrupted', 'missing', 'stale', 'inactive']
const ROSTER_INACTIVE = new Set(ROSTER_INACTIVE_STATES)
const SNAPSHOT_REF_PREFIX = 'refs/tower/snapshot/'
const PAUSE_CAUSES = ['user', 'failure', 'resource', 'dependency']
const TRANSITIONS = {
  planned: ['active', 'abandoned'],
  active: ['completed', 'blocked', 'paused', 'abandoned'],
  blocked: ['active', 'paused', 'completed', 'abandoned'],
  paused: ['active', 'abandoned'],
  completed: ['active', 'abandoned'],
  merged: [],
  abandoned: [],
}
const GLOB_META = /[*?[{]/

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
export const FINDING_TRANSITIONS = {
  open: ['triaged', 'fixed', 'wontfix'],
  triaged: ['open', 'fixed', 'wontfix'],
  fixed: ['open'],
  wontfix: ['open'],
}
export const MERGE_VERDICTS = ['merge', 'fix-then-merge', 'hold']
const MAX_REVIEW_ROUNDS = 5
const REVIEW_STATUS_RE = /^(clean|p1-\d+items|p2-\d+items)$/
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

function globToRegExp(pattern) {
  let out = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        out += '.*'
        index += 1
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`${out}$`)
}

export function fileInScope(scope, file) {
  return (scope ?? []).some((pattern) => globToRegExp(pattern).test(file))
}

function fail(message) {
  throw new Error(message)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validateTitle(title) {
  if (typeof title !== 'string' || title.trim().length === 0) fail('mission title is required')
  if (!/^[\x20-\x7E]+$/.test(title)) {
    fail(`mission title must be printable ASCII: ${JSON.stringify(title)}`)
  }
  return title.trim()
}

export function normalizeScope(scope, { allowEmpty = false } = {}) {
  if (!Array.isArray(scope)) fail('mission scope must be an array of relative globs')
  if (scope.length === 0 && !allowEmpty) fail('mission scope must not be empty for a build mission')
  const out = []
  for (const raw of scope) {
    if (typeof raw !== 'string' || raw.trim().length === 0) fail('scope entries must be non-empty strings')
    const value = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim()
    if (value.length === 0) fail('scope entries must be non-empty strings')
    if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) fail(`scope must be relative: ${raw}`)
    if (value.split('/').some((part) => part === '..')) fail(`scope must not contain "..": ${raw}`)
    if (!out.includes(value)) out.push(value)
  }
  return out
}

function scopePrefix(pattern) {
  const index = pattern.search(GLOB_META)
  const literal = index < 0 ? pattern : pattern.slice(0, index)
  return literal.replace(/\/+$/, '')
}

export function scopesOverlap(a, b) {
  for (const pa of a) {
    for (const pb of b) {
      if (pa === pb) return true
      const x = scopePrefix(pa)
      const y = scopePrefix(pb)
      if (!x || !y) return true
      if (x === y) return true
      if (x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true
    }
  }
  return false
}

function nextMissionNumber(missions) {
  let max = 0
  for (const mission of missions) {
    const match = /^M(\d+)$/.exec(mission.id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

function addDependency(mission, dep) {
  if (mission.id === dep) return
  if (!mission.deps.includes(dep)) mission.deps.push(dep)
}

function hasDependencyPath(missionsById, fromId, toId) {
  const seen = new Set()
  const stack = [fromId]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === toId) return true
    if (seen.has(current)) continue
    seen.add(current)
    const mission = missionsById.get(current)
    if (!mission) continue
    for (const dep of mission.deps) stack.push(dep)
  }
  return false
}

function assertAcyclic(missions) {
  const byId = new Map(missions.map((mission) => [mission.id, mission]))
  const state = new Map()
  const visit = (id, trail) => {
    const mark = state.get(id)
    if (mark === 'done') return
    if (mark === 'visiting') fail(`mission dependencies have a cycle: ${[...trail, id].join(' -> ')}`)
    state.set(id, 'visiting')
    const mission = byId.get(id)
    if (mission) for (const dep of mission.deps) visit(dep, [...trail, id])
    state.set(id, 'done')
  }
  for (const mission of missions) visit(mission.id, [])
}

/**
 * Kimi-style heuristic: overlapping build scopes are serialized by an
 * auto-added dependency. It is conservative, not a proof of disjointness.
 */
function addAutoDeps(newMissions, existingMissions) {
  const openExisting = existingMissions.filter((mission) => !TERMINAL.has(mission.status))
  const all = [...existingMissions, ...newMissions]
  const byId = new Map(all.map((mission) => [mission.id, mission]))

  for (let i = 0; i < newMissions.length; i += 1) {
    for (let j = i + 1; j < newMissions.length; j += 1) {
      const earlier = newMissions[i]
      const later = newMissions[j]
      if (earlier.kind === 'survey' || later.kind === 'survey') continue
      if (!scopesOverlap(earlier.scope, later.scope)) continue
      if (hasDependencyPath(byId, later.id, earlier.id)) continue
      addDependency(later, earlier.id)
    }
    const mission = newMissions[i]
    if (mission.kind === 'survey') continue
    for (const other of openExisting) {
      if (other.kind === 'survey') continue
      if (!scopesOverlap(mission.scope, other.scope)) continue
      if (hasDependencyPath(byId, mission.id, other.id)) continue
      addDependency(mission, other.id)
    }
  }
}

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

export function validateState(state, statePath) {
  const where = statePath ? ` at ${statePath}` : ''
  if (!isPlainObject(state)) fail(`tower state is not an object${where}`)
  if (state.schemaVersion !== SCHEMA_VERSION) {
    fail(`unsupported tower state schemaVersion ${state.schemaVersion}${where}`)
  }
  if (!Array.isArray(state.missions)) fail(`tower state has no missions array${where}`)
  const ids = new Set()
  for (const mission of state.missions) {
    if (!isPlainObject(mission) || typeof mission.id !== 'string') fail(`mission entry without id${where}`)
    if (ids.has(mission.id)) fail(`duplicate mission id ${mission.id}${where}`)
    ids.add(mission.id)
    if (!MISSION_STATUSES.includes(mission.status)) {
      fail(`mission ${mission.id} has unknown status ${mission.status}${where}`)
    }
    if (!Array.isArray(mission.tasks)) fail(`mission ${mission.id} has no tasks array${where}`)
    if (!Array.isArray(mission.deps)) fail(`mission ${mission.id} has no deps array${where}`)
    if (mission.references !== undefined && !Array.isArray(mission.references)) {
      fail(`mission ${mission.id} has no references array${where}`)
    }
    if (mission.reviewPolicy !== undefined && !['required-clean', 'none'].includes(mission.reviewPolicy)) {
      fail(`mission ${mission.id} has unknown reviewPolicy ${mission.reviewPolicy}${where}`)
    }
    if (mission.reviewPolicy === 'none' && !String(mission.reviewExemptionReason ?? '').trim()) {
      fail(`mission ${mission.id} has reviewPolicy none without a reason${where}`)
    }
    if (mission.testRuns !== undefined && !Array.isArray(mission.testRuns)) {
      fail(`mission ${mission.id} has no testRuns array${where}`)
    }
  }
  for (const key of ['batches', 'legacySnapshots', 'legacyMaps', 'deliveries']) {
    if (state[key] !== undefined && !Array.isArray(state[key])) fail(`tower state ${key} is not an array${where}`)
  }
  if (state.mergeIntent !== undefined && state.mergeIntent !== null && !isPlainObject(state.mergeIntent)) {
    fail(`tower state mergeIntent is not an object${where}`)
  }
  if (state.roster !== undefined) {
    if (!Array.isArray(state.roster)) fail(`tower state roster is not an array${where}`)
    const names = new Set()
    const agents = new Set()
    for (const entry of state.roster) {
      const reserved = entry?.state === 'reserved'
      if (!entry || typeof entry.name !== 'string' || (!reserved && typeof entry.agentId !== 'string')) {
        fail(`invalid roster entry${where}`)
      }
      if (names.has(entry.name)) fail(`duplicate roster name ${entry.name}${where}`)
      if (typeof entry.agentId === 'string') {
        if (agents.has(entry.agentId)) fail(`duplicate roster agent ${entry.agentId}${where}`)
        agents.add(entry.agentId)
      }
      names.add(entry.name)
    }
  }
  if (state.messages !== undefined) {
    if (!Array.isArray(state.messages)) fail(`tower state messages is not an array${where}`)
    const ids = new Set()
    for (const message of state.messages) {
      if (!message || typeof message.id !== 'string' || typeof message.to !== 'string') {
        fail(`invalid message entry${where}`)
      }
      if (ids.has(message.id)) fail(`duplicate message id ${message.id}${where}`)
      ids.add(message.id)
      if (!Array.isArray(message.readBy)) fail(`message ${message.id} has no readBy array${where}`)
    }
  }
  if (state.findings !== undefined) {
    if (!Array.isArray(state.findings)) fail(`tower state findings is not an array${where}`)
    const ids = new Set()
    for (const finding of state.findings) {
      if (!finding || typeof finding.id !== 'string') fail(`invalid finding entry${where}`)
      if (ids.has(finding.id)) fail(`duplicate finding id ${finding.id}${where}`)
      ids.add(finding.id)
      if (finding.status !== undefined && !FINDING_STATUSES.includes(finding.status)) {
        fail(`finding ${finding.id} has unknown status ${finding.status}${where}`)
      }
    }
  }
  if (state.reviews !== undefined) {
    if (!Array.isArray(state.reviews)) fail(`tower state reviews is not an array${where}`)
    const ids = new Set()
    for (const review of state.reviews) {
      if (!review || typeof review.id !== 'string') fail(`invalid review entry${where}`)
      if (ids.has(review.id)) fail(`duplicate review id ${review.id}${where}`)
      ids.add(review.id)
      if (!REVIEW_STATUS_RE.test(String(review.status))) {
        fail(`review ${review.id} has unknown status ${review.status}${where}`)
      }
      if (!MERGE_VERDICTS.includes(review.mergeVerdict)) {
        fail(`review ${review.id} has unknown merge verdict ${review.mergeVerdict}${where}`)
      }
    }
  }
  return state
}

function taskCounts(tasks) {
  const counts = { total: tasks.length, done: 0, open: 0, dropped: 0 }
  for (const task of tasks) {
    if (task.status === 'done') counts.done += 1
    else if (task.status === 'dropped') counts.dropped += 1
    else counts.open += 1
  }
  return counts
}

export function missionSummary(mission) {
  return {
    id: mission.id,
    title: mission.title,
    kind: mission.kind,
    status: mission.status,
    scope: mission.scope,
    deps: mission.deps,
    owner: mission.owner ?? null,
    worktree: mission.worktree
      ? {
          path: mission.worktree.path,
          branch: mission.worktree.branch,
          baseCommit: mission.worktree.baseCommit,
        }
      : null,
    blockers: mission.blockers ?? [],
    tasks: taskCounts(mission.tasks ?? []),
    scopeGeneration: mission.scopeGeneration ?? 1,
    ownerGeneration: mission.ownerGeneration ?? 0,
    pauseCause: mission.pauseCause ?? null,
    reviewPolicy: mission.reviewPolicy ?? 'required-clean',
    mergedCommit: mission.mergedCommit ?? null,
    mergedAt: mission.mergedAt ?? null,
    updatedAt: mission.updatedAt,
  }
}

function fullMission(mission) {
  return {
    ...missionSummary(mission),
    tasks: (mission.tasks ?? []).map((task) => ({ ...task })),
    notes: mission.notes ?? [],
    completionReport: mission.completionReport ?? null,
    authorizationRef: mission.authorizationRef ?? null,
    references: mission.references ?? [],
    reviewPolicy: mission.reviewPolicy ?? 'required-clean',
    reviewExemptionReason: mission.reviewExemptionReason ?? '',
    testRuns: mission.testRuns ?? [],
  }
}

function findingSummary(finding) {
  return {
    id: finding.id,
    seq: finding.seq ?? null,
    type: finding.type,
    title: finding.title,
    severity: finding.severity ?? null,
    status: finding.status ?? 'open',
    missionId: finding.missionId ?? null,
    branch: finding.branch ?? null,
    reportedBy: finding.reportedBy ?? null,
    at: finding.at ?? null,
    updatedAt: finding.updatedAt ?? null,
    closedAt: finding.closedAt ?? null,
  }
}

function countFindings(findings) {
  const counts = {}
  for (const status of FINDING_STATUSES) counts[status] = 0
  for (const finding of findings) {
    const status = finding.status ?? 'open'
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
}

function liveWorkerEntry(state, missionId) {
  return (state.roster ?? []).find(
    (entry) => entry.missionId === missionId && entry.role === 'worker' && !ROSTER_INACTIVE.has(entry.state),
  )
}

function workerEntries(state, missionId) {
  return (state.roster ?? []).filter((entry) => entry.missionId === missionId && entry.role === 'worker')
}

function countLiveWorkers(state) {
  return (state.roster ?? []).filter(
    (entry) => entry.role === 'worker' && !ROSTER_INACTIVE.has(entry.state) && entry.state !== 'reserved',
  ).length
}

function normalizePauseCause(value) {
  if (value === undefined || value === null || value === '') return 'user'
  if (!PAUSE_CAUSES.includes(value)) fail(`pause_cause must be one of ${PAUSE_CAUSES.join('|')}`)
  return value
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
    setGitTimeout(this.config.git?.timeoutMs)
  }

  static async open(repoRoot) {
    const repo = await resolveRepo(repoRoot)
    const config = await resolveRepoConfig(repo)
    return new Tower(repo, config)
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
            const refs = (await tryGit(this.root, ['for-each-ref', '--format=%(refname)', SNAPSHOT_REF_PREFIX])) ?? ''
            for (const ref of refs.split('\n').map((line) => line.trim()).filter(Boolean)) {
              await git(this.root, ['update-ref', '-d', ref]).catch(() => {})
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
        snapshotCommit = ((await tryGit(this.root, ['stash', 'create'])) ?? '').trim() || null
        if (!snapshotCommit) {
          fail('snapshotDirty was requested but no snapshot commit could be created; commit or stash the working tree first')
        }
        // A dangling commit can be pruned by git gc; keep a ref so the mission
        // baseline stays reachable for the life of the state.
        snapshotRef = `${SNAPSHOT_REF_PREFIX}${snapshotCommit}`
        await git(this.root, ['update-ref', snapshotRef, snapshotCommit])
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
        const allowed = TRANSITIONS[mission.status] ?? []
        if (!allowed.includes(input.status)) {
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
          : state.snapshotCommit && (await tryGit(this.root, ['cat-file', '-e', `${state.snapshotCommit}^{commit}`])) !== null
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
        await git(this.root, ['worktree', 'remove', '--force', wtPath]).catch(() => {})
        await git(this.root, ['branch', '-D', branch]).catch(() => {})
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
      const spawnTip = input.cwd ? ((await tryGit(input.cwd, ['rev-parse', 'HEAD'])) ?? '').trim() || null : null
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
      const dirty = (await git(mission.worktree.path, ['status', '--porcelain']))
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
    return withLock(this.paths, async () => {
      const { state, mission, worker, commits } = await this.checkCompletion(input)

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
    return withLock(this.paths, async () => {
      const state = await this.load()
      const mission = state.missions.find((entry) => entry.id === input.missionId)
      if (!mission) fail(`unknown mission "${input.missionId}"`)
      if (!mission.worktree) fail(`mission ${mission.id} has no worktree to review`)

      const caller = (state.roster ?? []).find((entry) => entry.agentId === input.agentId)
      const actorRole = input.actor?.role
      let reviewerName
      let reviewerRole
      if (actorRole === 'tower') {
        if (typeof input.breakGlassReason !== 'string' || input.breakGlassReason.trim().length === 0) {
          fail('a tower-submitted review is break-glass and requires a non-empty breakGlassReason')
        }
        reviewerName = 'tower'
        reviewerRole = 'tower'
      } else if (caller) {
        if (caller.role !== 'reviewer') {
          fail(`agent ${caller.name} is a ${caller.role}; only an assigned reviewer or the tower (break-glass) may review`)
        }
        if (caller.missionId !== mission.id) {
          fail(`reviewer ${caller.name} was not assigned to mission ${mission.id}`)
        }
        if (mission.owner && caller.name === mission.owner) fail('the reviewer must differ from the worker')
        reviewerName = caller.name
        reviewerRole = 'reviewer'
      } else {
        // Fail closed: an unknown caller is not the tower, and a missing
        // roster row is not evidence of tower identity.
        fail(`agent ${input.agentId ?? '(unknown)'} is not a registered reviewer or the tower`)
      }

      if (mission.status !== 'completed') {
        fail(`mission ${mission.id} is ${mission.status}; only a completed mission can be reviewed`)
      }
      if (!REVIEW_STATUS_RE.test(String(input.status ?? ''))) {
        fail('status must be "clean", "p1-Nitems", or "p2-Nitems"')
      }
      if (!MERGE_VERDICTS.includes(input.merge)) {
        fail(`merge verdict must be one of ${MERGE_VERDICTS.join('|')}`)
      }
      const findingsText = String(input.findings ?? '').trim()
      if (!findingsText) fail('findings text is required; write "none" for a clean verdict')
      if (input.status === 'clean' && findingsText.toLowerCase() !== 'none') {
        fail('a clean verdict requires findings text "none"')
      }
      if (input.status !== 'clean' && findingsText.toLowerCase() === 'none') {
        fail('a non-clean verdict must describe its findings')
      }
      const decision = String(input.decision ?? '').trim()
      if (!decision) fail('decision (the reasoning behind the verdict) is required')
      let checks = []
      if (input.checks !== undefined) {
        if (!Array.isArray(input.checks)) fail('checks must be an array of strings')
        checks = input.checks.map((entry) => String(entry))
      }

      await this.assertWorktree(mission.worktree)
      const tip = await revParse(mission.worktree.path, 'HEAD')
      const branch = mission.worktree.branch
      if (caller && caller.role === 'reviewer' && !String(caller.spawnTip ?? '').trim()) {
        fail(`reviewer ${caller.name} has no recorded spawn tip; re-spawn the reviewer before reviewing`)
      }
      if (caller && caller.role === 'reviewer' && caller.spawnTip !== tip) {
        fail(
          `reviewer ${caller.name} modified the mission branch after it was spawned (${String(caller.spawnTip).slice(0, 7)} -> ${tip.slice(0, 7)}); reviewers must be read-only — spawn a fresh reviewer`,
        )
      }
      const prior = (state.reviews ?? []).filter((review) => review.branch === branch)
      const reviewerRounds = prior.filter((review) => review.reviewer === reviewerName).length
      const maxReviewRounds = Number(this.config.review.maxRoundsPerReviewer) || MAX_REVIEW_ROUNDS
      if (reviewerRounds >= maxReviewRounds) {
        fail(
          `reviewer ${reviewerName} reached the ${maxReviewRounds}-round cap for ${branch}; continue with a different reviewer`,
        )
      }
      const round = prior.length === 0 ? 1 : Math.max(...prior.map((review) => review.round)) + 1

      const now = Date.now()
      const seq = (state.reviewSeq ?? 0) + 1
      state.reviewSeq = seq
      const review = {
        id: `R${seq}`,
        seq,
        missionId: mission.id,
        branch,
        reviewedCommit: tip,
        status: input.status,
        mergeVerdict: input.merge,
        findings: findingsText,
        checks,
        decision,
        reviewer: reviewerName,
        reviewerRole,
        round,
        at: now,
        ...(reviewerRole === 'tower' ? { breakGlassReason: input.breakGlassReason.trim() } : {}),
      }
      if (!Array.isArray(state.reviews)) state.reviews = []
      state.reviews.push(review)

      if (input.status !== 'clean') {
        mission.status = 'active'
        mission.notes.push(
          `review round ${round} by ${reviewerName}: ${input.status} (${input.merge}) — returned to active`,
        )
      } else {
        mission.notes.push(`review round ${round} by ${reviewerName}: clean (${input.merge})`)
      }
      mission.updatedAt = now
      state.revision += 1
      state.updatedAt = now

      validateState(state, this.paths.state)
      await writeJsonAtomic(this.paths.state, state)
      await appendJsonl(this.paths.activity, {
        at: now,
        type: 'review',
        missionId: mission.id,
        text: `round ${round} ${reviewerName}: ${input.status} / ${input.merge} @ ${tip.slice(0, 12)}`,
      })
      return {
        review,
        branchTip: tip,
        missionStatus: mission.status,
        round,
        reviewerRounds: reviewerRounds + 1,
      }
    })
  }

  /** Full detail for one mission, including reviews, findings and recent activity. */
  async missionDetail(missionId) {
    const state = await this.load()
    const mission = state.missions.find((entry) => entry.id === missionId)
    if (!mission) fail(`unknown mission "${missionId}"`)
    const branch = mission.worktree ? mission.worktree.branch : null
    const reviews = (state.reviews ?? [])
      .filter((review) => review.missionId === mission.id || (branch && review.branch === branch))
      .slice()
      .sort((a, b) => b.round - a.round)
    const findings = (state.findings ?? []).filter((finding) => finding.missionId === mission.id)
    const activity = (await readActivityTail(this.paths.activity, 200)).filter(
      (entry) => entry.missionId === mission.id,
    )
    return {
      mission: fullMission(mission),
      reviews: reviews.slice(0, 10),
      findings: findings.slice(-10).map((finding) => findingSummary(finding)),
      activity: activity.slice(-20),
    }
  }

  /** Human-readable mission board (markdown) for the current state. */
  boardMarkdown(state) {
    const lines = []
    lines.push(`# Tower missions — ${state.repoRoot}`)
    lines.push('')
    lines.push(`Base: \`${state.base}\` · revision ${state.revision} · updated ${new Date(state.updatedAt ?? Date.now()).toISOString()}`)
    const counts = {}
    for (const status of MISSION_STATUSES) counts[status] = 0
    for (const mission of state.missions) counts[mission.status] += 1
    lines.push('')
    lines.push(
      `Missions: ${state.missions.length} · ` +
        MISSION_STATUSES.map((status) => `${status} ${counts[status]}`).join(' · '),
    )
    const openFindings = (state.findings ?? []).filter((finding) => !['fixed', 'wontfix'].includes(finding.status ?? 'open'))
    lines.push(`Findings: ${openFindings.length} open of ${(state.findings ?? []).length}`)
    lines.push('')
    lines.push('| Mission | Status | Kind | Title | Owner | Tasks (done/open/dropped) | Latest review | Merged |')
    lines.push('|---|---|---|---|---|---|---|---|')
    for (const mission of state.missions) {
      const tasks = taskCounts(mission.tasks ?? [])
      const branch = mission.worktree ? mission.worktree.branch : null
      const reviews = branch ? (state.reviews ?? []).filter((review) => review.branch === branch) : []
      const latest = reviews.length > 0 ? reviews.reduce((a, b) => (a.round >= b.round ? a : b)) : null
      const reviewText = latest ? `R${latest.round} ${latest.status}/${latest.mergeVerdict}` : '—'
      lines.push(
        `| ${mission.id} | ${mission.status} | ${mission.kind} | ${String(mission.title).replaceAll('|', '\\|')} | ${
          mission.owner ?? '—'
        } | ${tasks.done}/${tasks.open}/${tasks.dropped} | ${reviewText} | ${
          mission.mergedCommit ? mission.mergedCommit.slice(0, 8) : '—'
        } |`,
      )
    }
    if ((state.roster ?? []).length > 0) {
      lines.push('')
      lines.push('## Roster')
      lines.push('')
      lines.push('| Name | Role | Mission | State | Agent |')
      lines.push('|---|---|---|---|---|')
      for (const entry of state.roster) {
        lines.push(
          `| ${entry.name} | ${entry.role} | ${entry.missionId} | ${entry.state} | \`${entry.agentId}\` |`,
        )
      }
    }
    lines.push('')
    return lines.join('\n')
  }

  /** Write the board when docs.board is enabled; failures never break a mutation. */
  /** Append a repo-relative pattern to .git/info/exclude, never .gitignore. */
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
    const rebase = mission.rebase
    if (!rebase) return false
    return review.at <= rebase.at && review.reviewedCommit === rebase.oldTip
  }

  async evaluateGate(input) {
    const state = await this.load()
    const mission = state.missions.find((entry) => entry.id === input.missionId)
    if (!mission) {
      return {
        ok: false,
        blockers: [{ code: 'mission-missing', detail: `unknown mission "${input.missionId}"` }],
        missionId: input.missionId,
        branchTip: null,
        baseTip: null,
        changedFiles: [],
        review: null,
      }
    }
    const activity = input.activity ?? {}
    const blockers = []
    const push = (code, detail) => blockers.push({ code, detail })

    if (TERMINAL.has(mission.status)) {
      push(
        'branch-owned-by-closed-missions',
        `mission ${mission.id} is ${mission.status}; a merge never flips a closed mission — re-plan the work under a new title`,
      )
    }
    if (mission.status !== 'completed') {
      push('mission-not-completed', `mission ${mission.id} is ${mission.status}; completion is required`)
    }
    const openTasks = mission.tasks.filter((task) => task.status === 'open')
    if (openTasks.length > 0) push('tasks-open', `${openTasks.length} open task(s): ${openTasks.map((task) => task.text).join('; ')}`)
    if ((mission.blockers ?? []).length > 0) push('blockers-present', mission.blockers.join('; '))
    if (this.config.gates.requireChecks === true) {
      const checks = mission.completionReport?.checks ?? []
      if (checks.length === 0) {
        push('no-check-evidence', `mission ${mission.id} has no completion checks; gates.requireChecks is enabled`)
      }
    }
    if (state.mergeIntent && state.mergeIntent.missionId === mission.id) {
      push(
        'merge-intent-pending',
        `a merge intent for ${state.mergeIntent.missionId} was recorded at ${new Date(Number(state.mergeIntent.startedAt) || 0).toISOString()}; run tower_merge to reconcile it`,
      )
    }

    const worktree = mission.worktree ?? null
    let branchTip = null
    let baseTip = null
    let changedFiles = []
    if (!worktree) {
      push('branch-missing', `mission ${mission.id} has no worktree or branch`)
    } else {
      try {
        await this.assertWorktree(worktree)
        branchTip = await revParse(worktree.path, 'HEAD')
        baseTip = await revParse(this.root, state.base)
        const mergeBase = (await git(worktree.path, ['merge-base', baseTip, branchTip])).trim()
        changedFiles = (await git(worktree.path, ['diff', '--name-only', `${mergeBase}..${branchTip}`]))
          .split('\n')
          .filter(Boolean)
        if (!(await isAncestor(this.root, baseTip, branchTip))) {
          push(
            'stale-base',
            `${worktree.branch} does not contain base "${state.base}" tip ${baseTip.slice(0, 12)}; run tower_rebase first`,
          )
        }
        if (mission.kind === 'survey' && changedFiles.length > 0) {
          push('read-only-survey', `survey ${mission.id} is read-only but ${changedFiles.length} file(s) changed: ${changedFiles.slice(0, 5).join(', ')}`)
        }
        if (mission.kind !== 'survey') {
          const outOfScope = changedFiles.filter((file) => !fileInScope(mission.scope, file))
          if (outOfScope.length > 0) {
            push('out-of-scope', `changed files outside scope (${mission.scope.join(', ')}): ${outOfScope.slice(0, 8).join(', ')}`)
          }
        }
        const dirty = (await git(this.root, ['status', '--porcelain']))
          .split('\n')
          .filter(Boolean)
          .map((line) => line.slice(3).trim())
        const wouldOverwrite = changedFiles.filter((file) => dirty.includes(file))
        if (wouldOverwrite.length > 0) {
          push('base-dirty', `main checkout has uncommitted changes this merge would overwrite: ${wouldOverwrite.slice(0, 8).join(', ')}`)
        }
      } catch (error) {
        push('branch-missing', String(error?.message ?? error))
      }
    }

    for (const depId of mission.deps ?? []) {
      const dep = state.missions.find((entry) => entry.id === depId)
      if (!dep || !['merged', 'abandoned'].includes(dep.status)) {
        push('deps-unmerged', `${depId} is ${dep ? dep.status : 'missing'}`)
      }
    }

    const branch = worktree ? worktree.branch : null
    const reviews = branch ? (state.reviews ?? []).filter((review) => review.branch === branch) : []
    const latest = reviews.length > 0 ? reviews.reduce((a, b) => (a.round >= b.round ? a : b)) : null
    const requireReview = this.config.review?.requireReview !== false
    const exempt =
      !requireReview ||
      (mission.reviewPolicy === 'none' &&
        this.config.gates.allowReviewExemption === true &&
        String(mission.reviewExemptionReason ?? '').trim().length > 0)
    if (requireReview && mission.reviewPolicy === 'none' && this.config.gates.allowReviewExemption !== true) {
      push('review-exemption-invalid', `mission ${mission.id} requests no review but gates.allowReviewExemption is disabled`)
    }
    if (requireReview && !exempt && !latest) {
      push('no-review', `branch ${branch ?? '(none)'} has no review; assign a reviewer first (or set review.requireReview:false)`)
    } else if (requireReview && !exempt) {
      const waived = this.rebaseWaived(mission, latest)
      if (latest.missionId !== mission.id) {
        push('review-mission-mismatch', `latest review belongs to mission ${latest.missionId}`)
      }
      if (latest.status !== 'clean') push('not-clean', `latest review round ${latest.round} is "${latest.status}"`)
      if (latest.mergeVerdict === 'hold') {
        push('review-hold', `latest review recommends hold — a later clean review must supersede it`)
      } else if (latest.status === 'clean' && latest.mergeVerdict !== 'merge') {
        push('review-not-approved', `latest clean review recommends "${latest.mergeVerdict}" — only "merge" approves`)
      }
      if (branchTip && latest.reviewedCommit !== branchTip && !waived) {
        push('tip-moved', `reviewed ${latest.reviewedCommit.slice(0, 7)} but tip is ${branchTip.slice(0, 7)}; re-review required`)
      }
    }

    for (const entry of (state.roster ?? []).filter((row) => row.missionId === mission.id && !ROSTER_INACTIVE.has(row.state))) {
      if (activity[entry.agentId] === 'running') push('worker-busy', `agent ${entry.name} is still running`)
      else if (input.parentStatus && entry.parentSessionId && input.parentStatus[entry.parentSessionId] !== 'ok') {
        push(
          'worker-status-unknown',
          `cannot prove agent ${entry.name} is stopped: its parent catalog is unavailable`,
        )
      }
    }
    const staleWorkers = (state.roster ?? []).filter(
      (row) =>
        row.missionId === mission.id &&
        (row.state === 'stale' || (row.stale === true && !ROSTER_INACTIVE.has(row.state))),
    )
    if (staleWorkers.length > 0) {
      push('worker-stale', `stale worker(s) for ${mission.id}: ${staleWorkers.map((row) => row.name).join(', ')}; adopt or interrupt before merge`)
    }
    if (this.config.gates.requireTests === true) {
      const runs = (mission.testRuns ?? []).filter((run) => run.ok === true && run.treeTip && branchTip && run.treeTip === branchTip)
      if (runs.length === 0) {
        push('tests-missing', `mission ${mission.id} has no passing test discovery for tip ${branchTip ? branchTip.slice(0, 7) : '(none)'}`)
      }
    }

    const checkoutBranch = await currentBranch(this.root)
    if (checkoutBranch !== state.base) {
      push('base-wrong-branch', `main checkout is on ${checkoutBranch ?? 'detached HEAD'}, expected "${state.base}"`)
    }

    return {
      ok: blockers.length === 0,
      blockers,
      mission: fullMission(mission),
      worktree,
      branchTip,
      baseTip,
      changedFiles,
      review: latest,
    }
  }

  /** Read-only mission diff for reviewers: branch changes against the merge base. */
  async diff(input = {}) {
    const state = await this.load()
    const mission = state.missions.find((entry) => entry.id === input.missionId)
    if (!mission) fail(`unknown mission "${input.missionId}"`)
    if (!mission.worktree) fail(`mission ${mission.id} has no worktree to diff`)
    await this.assertWorktree(mission.worktree)
    const baseTip = await revParse(this.root, state.base)
    const branchTip = await revParse(mission.worktree.path, 'HEAD')
    const mergeBase = (await git(mission.worktree.path, ['merge-base', baseTip, branchTip])).trim()
    const files = (await git(mission.worktree.path, ['diff', '--name-status', `${mergeBase}..${branchTip}`]))
      .split('\n')
      .filter(Boolean)
    const commits = (await git(mission.worktree.path, ['log', '--oneline', `${mergeBase}..${branchTip}`]))
      .split('\n')
      .filter(Boolean)
    const fullPatch = await git(mission.worktree.path, ['diff', `${mergeBase}..${branchTip}`])
    const limit = Number.isInteger(input.maxBytes) && input.maxBytes > 0 ? input.maxBytes : 64 * 1024
    return {
      missionId: mission.id,
      branch: mission.worktree.branch,
      baseTip,
      branchTip,
      mergeBase,
      files,
      commits,
      truncated: fullPatch.length > limit,
      patch: fullPatch.slice(0, limit),
    }
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
        await git(
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
        const dirty = (await git(this.root, ['status', '--porcelain']))
          .split('\n')
          .filter(Boolean)
          .map((line) => line.slice(3).trim())
        if (dirty.length > 0) {
          const changed = new Set(gate.changedFiles ?? [])
          if (dirty.every((file) => changed.has(file))) {
            await git(this.root, ['reset', '--hard', 'HEAD'])
            warnings.push('restored index/worktree to the merge commit (only merge-related paths were dirty)')
          } else {
            warnings.push('working tree still has unrelated changes; left untouched — inspect it before the next Git operation')
          }
        }
      } else if (failure) {
        const unmerged = (await tryGit(this.root, ['ls-files', '-u'])) ?? ''
        const conflict = unmerged.trim().length > 0
        let cleanup = 'none'
        const mergeHeadPath = path.join(this.commonDir, 'MERGE_HEAD')
        if (await exists(mergeHeadPath)) {
          try {
            await git(this.root, ['merge', '--abort'])
            cleanup = 'aborted'
          } catch {
            await removeStaleGitLocks(this.commonDir)
            try {
              await git(this.root, ['merge', '--abort'])
              cleanup = 'aborted-after-lock-cleanup'
            } catch {
              await git(this.root, ['reset', '--hard', baseTipBefore]).catch(() => {})
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
        const dirtyAfter = (await git(this.root, ['status', '--porcelain']))
          .split('\n')
          .filter(Boolean)
          .map((line) => line.slice(3).trim())
        if (dirtyAfter.length > 0) {
          const changed = new Set(gate.changedFiles ?? [])
          if (newTip === baseTipBefore && dirtyAfter.every((file) => changed.has(file))) {
            await removeStaleGitLocks(this.commonDir)
            await git(this.root, ['reset', '--hard', baseTipBefore]).catch(() => {})
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
        await git(mission.worktree.path, ['rebase', baseTip])
      } catch (error) {
        await git(mission.worktree.path, ['rebase', '--abort']).catch(() => {})
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
          await git(this.root, ['worktree', 'remove', ...(dirty ? ['--force'] : []), mission.worktree.path])
        } catch (error) {
          decisions.push({ missionId: mission.id, action: 'keep', reason: `remove failed: ${String(error?.message ?? error)}` })
          continue
        }
        let branchDeleteError = null
        try {
          await git(this.root, ['branch', '-d', mission.worktree.branch])
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
    const state = await this.load()
    const activity = await readActivityTail(this.paths.activity, 12)
    const counts = {}
    for (const status of MISSION_STATUSES) counts[status] = 0
    for (const mission of state.missions) counts[mission.status] = (counts[mission.status] ?? 0) + 1
    const openTasks = state.missions.reduce((sum, mission) => sum + taskCounts(mission.tasks).open, 0)
    const findingsByStatus = {}
    for (const status of FINDING_STATUSES) findingsByStatus[status] = 0
    for (const finding of state.findings ?? []) {
      const status = finding.status ?? 'open'
      findingsByStatus[status] = (findingsByStatus[status] ?? 0) + 1
    }
    return {
      repoRoot: state.repoRoot,
      commonDir: state.commonDir,
      statePath: this.paths.state,
      base: state.base,
      revision: state.revision,
      counts,
      openTasks,
      roster: (state.roster ?? []).length,
      messages: (state.messages ?? []).length,
      unreadTower: this.unreadFor(state, 'tower').length,
      findings: (state.findings ?? []).length,
      findingsByStatus,
      reviews: (state.reviews ?? []).length,
      config: {
        path: this.config.configPath ?? null,
        repoConfigPresent: this.config.repoConfigPresent === true,
        spawn: {
          workerPreset: this.config.spawn?.workerPreset ?? null,
          reviewerPreset: this.config.spawn?.reviewerPreset ?? null,
        },
      },
      recentFindings: (state.findings ?? []).slice(-5).map((finding) => ({
        id: finding.id,
        type: finding.type,
        severity: finding.severity,
        status: finding.status ?? 'open',
        title: finding.title,
        missionId: finding.missionId,
        reportedBy: finding.reportedBy,
        at: finding.at,
      })),
      missions: await this.enrichedMissions(state, input.missionIds),
      activity,
    }
  }
}
