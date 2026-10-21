// Tower tools: init, plan, mission, status, spawn, roster, adopt, findings.
import {
  Tower,
  ROSTER_INACTIVE_STATES,
  MISSION_STATUSES,
  FINDING_TYPES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  ROLES,
} from './tower.js'
import { TowerToolError, classifyError } from './errors.js'
import { git, resolveRepo, hasAnyCommit } from './git.js'
import { runtimeConfig } from './config.js'
import { createHmrBridge } from './hmr.js'
import { registerDoctorTool } from './tools/doctor.js'
import { registerRecoverTool } from './tools/recover.js'
import { registerTestTool } from './tools/test.js'
import { S, SCHEMAS, output } from './schemas.js'
import { workerBriefing, reviewerBriefing } from './briefing.js'
export { workerBriefing, reviewerBriefing } from './briefing.js'
import { readStateLock } from './store.js'
import { readDiscoveryConfig, normalizeDiscovery, runDiscovery } from './tests.js'
import { validateCreate as validateBatchCreate, validateClose as validateBatchClose, summarize as summarizeBatch, BatchError } from './batch.js'
import { acquireLease, releaseLease, inspectLeases } from './leases.js'
import { importLegacySnapshot, validateLegacySnapshot, validateLegacyMap } from './legacy.js'
import { runDoctor } from './doctor.js'
import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const ROLE_ENUM = ROLES

function normalizeToolArgs(args, aliases = {}) {
  const out = { ...(args ?? {}) }
  for (const [canonical, names] of Object.entries(aliases)) {
    const current = out[canonical]
    if (current !== undefined && current !== null) continue
    for (const name of names) {
      if (out[name] !== undefined && out[name] !== null) {
        out[canonical] = out[name]
        break
      }
    }
  }
  return out
}

/** Resolve the calling agent to a roster role; unknown callers are rejected. */
async function actorFor(tower, exec) {
  const agentId = exec?.agent?.id !== undefined ? String(exec.agent.id) : null
  const unknown = { name: 'unknown', role: 'unknown', agentId }
  if (!agentId) return unknown
  let state
  try {
    state = await tower.load()
  } catch (error) {
    if (!/not initialized/i.test(String(error?.message ?? error))) throw error
    // No readable state: only tower_init may claim ownership (handled in that tool).
    return unknown
  }
  if (state.towerAgentId && String(state.towerAgentId) === agentId) {
    return { name: 'tower', role: 'tower', agentId }
  }
  let view
  try {
    view = await tower.rosterView()
  } catch {
    return unknown
  }
  const self = view.roster.find((entry) => entry.agentId === agentId)
  if (!self) return unknown
  if (self.role === 'tower') return { name: self.name, role: 'tower', agentId }
  return { name: self.name, role: self.role, agentId }
}

function requireKnownActor(actor, action) {
  if (!actor || actor.role === 'unknown') {
    throw new TowerToolError('not-authorized', `${action} requires a registered roster agent or the tower`)
  }
}

function requireTowerActor(actor, action) {
  if (actor.role !== 'tower') {
    throw new TowerToolError('not-authorized', `only the tower can ${action}; ${actor.name} is a ${actor.role}`)
  }
}

const SEND_RATE = new Map()
const SPAWN_QUEUES = new Map()
const SPAWN_BACKOFF = new Map()

function spawnBackoffState(repoRoot, maxLiveWorkers) {
  const key = String(repoRoot)
  let state = SPAWN_BACKOFF.get(key)
  if (!state) {
    state = { failures: 0, blockedUntil: 0, budget: Math.max(1, Number(maxLiveWorkers) || 4) }
    SPAWN_BACKOFF.set(key, state)
  }
  if (state.failures === 0) state.budget = Math.max(1, Number(maxLiveWorkers) || 4)
  return state
}

function recordSpawnThrottle(repoRoot, maxLiveWorkers) {
  const state = spawnBackoffState(repoRoot, maxLiveWorkers)
  state.failures += 1
  state.budget = Math.max(1, (Number(maxLiveWorkers) || 4) - 1)
  if (state.failures >= 3) {
    const delay = Math.min(60000, 5000 * 2 ** Math.min(4, state.failures - 3))
    state.blockedUntil = Date.now() + delay
  }
  return state
}

function recordSpawnSuccess(repoRoot, maxLiveWorkers) {
  const state = spawnBackoffState(repoRoot, maxLiveWorkers)
  state.failures = 0
  state.blockedUntil = 0
  state.budget = Math.max(1, Number(maxLiveWorkers) || 4)
  return state
}

function spawnBackoffView(repoRoot, maxLiveWorkers, inflight) {
  const state = spawnBackoffState(repoRoot, maxLiveWorkers)
  return {
    inflight,
    budget: Math.min(state.budget, Math.max(1, Number(maxLiveWorkers) || 4)),
    blockedUntil: state.blockedUntil > Date.now() ? state.blockedUntil : 0,
  }
}
const WATCHED_REPOS = new Set()
function watchRepo(repoRoot) {
  WATCHED_REPOS.add(repoRoot)
  if (WATCHED_REPOS.size > 100) {
    const oldest = WATCHED_REPOS.values().next().value
    WATCHED_REPOS.delete(oldest)
  }
}
let workspaceHook = null
let sharedHmrBridge = null

/** Serialize spawn decisions per repository so precheck + activation + record are atomic. */
function enqueueSpawn(key, operation) {
  const previous = SPAWN_QUEUES.get(key) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(operation)
  const settled = run.catch(() => {})
  SPAWN_QUEUES.set(key, settled)
  settled.finally(() => {
    if (SPAWN_QUEUES.get(key) === settled) SPAWN_QUEUES.delete(key)
  })
  return run
}

/** In-memory per-repository tower_send rate limit (process-local, advisory). */
function checkSendRate(config, repoRoot) {
  const max = Number(config.send?.maxPerMinute)
  if (!max || max <= 0) return
  const key = String(repoRoot)
  const now = Date.now()
  const bucket = SEND_RATE.get(key)
  if (!bucket || now - bucket.start >= 60000) {
    SEND_RATE.set(key, { start: now, count: 1 })
    return
  }
  if (bucket.count >= max) {
    throw new TowerToolError('rate-limited', `tower_send rate limit reached (${max}/min for ${key}); retry later or raise send.maxPerMinute`)
  }
  bucket.count += 1
}

async function verifyBatchReceiptFiles(root, batch, args) {
  const problems = []
  const frozen = new Set(batch.receiptPaths ?? [])
  const declared = new Map()
  for (const [rawPath, rawHash] of Object.entries(args.receiptHashes ?? {})) {
    declared.set(String(rawPath), String(rawHash).trim().toLowerCase())
  }
  for (const entry of args.receipts ?? []) {
    if (entry && typeof entry.path === 'string' && typeof entry.hash === 'string') {
      declared.set(entry.path, entry.hash.trim().toLowerCase())
    }
  }
  for (const [rel, reported] of declared) {
    if (frozen.size > 0 && !frozen.has(rel)) continue
    let actual
    try {
      const abs = path.resolve(root, rel)
      const relative = path.relative(root, abs)
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('path escapes the repository')
      actual = crypto.createHash('sha256').update(await fsp.readFile(abs)).digest('hex')
    } catch (error) {
      problems.push({ code: 'batch-invalid', detail: `receipt "${rel}" cannot be read: ${String(error?.message ?? error)}` })
      continue
    }
    if (reported && reported !== actual) {
      problems.push({ code: 'batch-invalid', detail: `receipt "${rel}" hash ${reported.slice(0, 12)} does not match the file (${actual.slice(0, 12)})` })
    }
  }
  return problems
}

async function interruptRosterAgent(ctx, tower, exec, input) {
  const subagents = ctx.get('subagents')
  if (!subagents || typeof subagents.interrupt !== 'function') {
    throw new TowerToolError('spawn-unavailable', 'subagents service is unavailable; cannot interrupt')
  }
  const view = await tower.rosterView()
  const entry = view.roster.find(
    (row) =>
      (input.agentId !== undefined && row.agentId === String(input.agentId)) ||
      (input.to !== undefined && row.name === input.to),
  )
  if (!entry) throw new TowerToolError('invalid-argument', `unknown roster agent "${input.to ?? input.agentId}"`)
  const { activity } = await observeActivity(ctx, tower)
  const previousActivity = activity[entry.agentId] ?? 'unknown'
  if (previousActivity !== 'running') {
    return { interrupted: false, reason: `agent is ${previousActivity}, not running`, entry }
  }
  subagents.interrupt(entry.agentId, { kind: 'ancestor', agent: exec.agent })
  const updated = await tower.recordInterrupt({
    agentId: entry.agentId,
    name: entry.name,
    reason: input.reason ?? 'interrupted by tower',
  })
  return { interrupted: true, previousActivity, entry: updated }
}

/** autoGitInit support: Tower.open needs a repository, so prepare it first.
 * Only absolute, existing directories are eligible; a typo must not git-init the
 * DSH process cwd or create a repository at an unintended path. */
async function ensureRepository(repoRootInput, autoGitInit) {
  try {
    return await resolveRepo(repoRootInput)
  } catch (error) {
    if (autoGitInit !== true) throw error
    if (typeof repoRootInput !== 'string' || !path.isAbsolute(repoRootInput)) {
      throw new TowerToolError('repo-invalid', `autoGitInit requires an absolute directory path: ${repoRootInput}`)
    }
    const resolved = path.resolve(repoRootInput)
    let stat = null
    try {
      stat = await fsp.stat(resolved)
    } catch {
      stat = null
    }
    if (!stat || !stat.isDirectory()) {
      throw new TowerToolError('repo-invalid', `autoGitInit requires an existing directory: ${resolved}`)
    }
    if (resolved === path.parse(resolved).root) {
      throw new TowerToolError('repo-invalid', 'autoGitInit refuses to initialize a filesystem root')
    }
    await git(resolved, ['init'])
    const repo = await resolveRepo(resolved)
    if (!(await hasAnyCommit(repo.root))) {
      await git(repo.root, [
        '-c',
        'user.name=dsh-tower',
        '-c',
        'user.email=dsh-tower@localhost',
        'commit',
        '--allow-empty',
        '-m',
        'tower: initial empty commit',
      ])
    }
    return repo
  }
}

const OPERATIONAL_TOOLS = new Set([
  'tower_batch',
  'tower_resource',
  'tower_import_legacy',
  'tower_legacy_map',
  'tower_recover',
  'tower_test',
  'tower_doctor',
])

function define(ctx, definition) {
  const { aliases, requiresMissionId, board, execute, ...rest } = definition
  if (OPERATIONAL_TOOLS.has(rest.name) && runtimeConfig().tools?.exposeOperational === false) return
  ctx.effect(() =>
    ctx.tools.register({
      ...rest,
      async execute(args, exec) {
        const normalized = normalizeToolArgs(args, aliases)
        if (requiresMissionId) {
          const id = normalized.missionId
          if (typeof id !== 'string' || id.trim().length === 0) {
            throw new TowerToolError('invalid-argument', `${rest.name} requires missionId (alias: id)`)
          }
          normalized.missionId = id.trim()
        }
        let value
        try {
          if (workspaceHook && typeof normalized.repoRoot === 'string' && rest.name !== 'tower_init') {
            await workspaceHook.ensure(normalized.repoRoot, exec, rest.name)
          }
          value = await execute(normalized, exec)
        } catch (error) {
          throw classifyError(error)
        }
        if (typeof normalized.repoRoot === 'string') watchRepo(normalized.repoRoot)
        const event = rest.name.startsWith('tower_') ? rest.name.slice('tower_'.length) : null
        if (event) {
          try {
            ctx.emit?.(`tower/${event}`, {
              tool: rest.name,
              repoRoot: typeof normalized.repoRoot === 'string' ? normalized.repoRoot : null,
              value: value ?? null,
            })
          } catch {
            // events are an optional side channel; never fail a tool for them
          }
        }
        if (board === true && typeof normalized.repoRoot === 'string') {
          try {
            const opened = await Tower.open(normalized.repoRoot)
            await opened.writeBoard()
          } catch {
            // board output is best effort
          }
        }
        return value
      },
    }),
  )
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return null
  return blocks
    .map((block) => (block && block.type === 'text' ? block.text : `[${block && block.type}]`))
    .join('\n')
}

/** Read `package.json tower.testDiscovery` and run it for one mission worktree.
 * Returns `{configured:false}` when the repository has no discovery block. */
async function runMissionDiscovery(tower, mission) {
  const testsConfig = tower.config.tests ?? {}
  if (testsConfig.enabled === false || testsConfig.allowPackageDiscovery === false) {
    return { configured: false }
  }
  const worktreePath = mission?.worktree?.path
  if (!worktreePath) return { configured: false, error: 'mission has no worktree' }
  let packageText
  try {
    packageText = await fsp.readFile(path.join(worktreePath, 'package.json'), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { configured: false }
    throw error
  }
  const read = readDiscoveryConfig(packageText)
  if (!read.configured) {
    if (read.error) throw new TowerToolError('invalid-argument', `package.json test discovery is invalid: ${read.error}`)
    return { configured: false, error: null }
  }
  const normalized = normalizeDiscovery(read.config)
  if (!normalized.ok) {
    throw new TowerToolError('invalid-argument', `invalid tower.testDiscovery: ${normalized.error}`)
  }
  const receipt = await runDiscovery({
    worktreePath,
    config: read.config,
    timeoutMs: Number(testsConfig.timeoutMs) || 60000,
    maxBytes: Number(testsConfig.maxBytes) || 16 * 1024 * 1024,
    missionId: mission.id,
    diagnosticsDir: path.join(tower.paths.dir, 'test-runs', `${mission.id}-${Date.now()}`),
  })
  const stored = await tower.recordTestRun({ missionId: mission.id, receipt })
  const commands = Array.isArray(stored.commands) ? stored.commands : []
  const check = {
    name: 'tests',
    command: commands.map((command) => `${command.id}: ${command.command}`).join('; ') || 'tower.testDiscovery',
    exitCode: commands.every((command) => command.exitCode === 0) ? 0 : (commands.find((command) => command.exitCode !== 0)?.exitCode ?? 1),
    evidence: stored.ok
      ? `${stored.tests?.length ?? 0} test(s) passed at ${String(stored.treeTip ?? '').slice(0, 12)}; receipt ${stored.receiptPath ?? stored.diagnosticsPath}`
      : `test discovery failed: ${String(stored.error ?? 'unknown').slice(0, 300)}`,
  }
  return { configured: true, receipt: stored, check }
}

async function observeActivity(ctx, tower) {
  const view = await tower.rosterView()
  const subagents = ctx.get('subagents')
  const activity = {}
  const parentStatus = {}
  if (!subagents) return { activity, parentStatus }
  const parents = [...new Set(view.roster.map((entry) => entry.parentSessionId).filter(Boolean))]
  for (const parent of parents) {
    try {
      const rows = await subagents.listDescendants(parent)
      for (const row of rows) activity[String(row.id)] = row.activity ?? 'unknown'
      parentStatus[parent] = 'ok'
    } catch (error) {
      parentStatus[parent] = `unavailable: ${String(error?.message ?? error)}`
    }
  }
  return { activity, parentStatus }
}

export function registerTowerTools(ctx, options = {}) {
  workspaceHook = options.workspace ?? null
  sharedHmrBridge = options.hmrBridge ?? null
  // A lightweight roster watchdog: the authoritative activity comes from the
  // subagents catalog; a missing observation after spawn.staleMs is marked
  // stale (never silently treated as stopped) and blocks merge via the gate.
  const watchMs = Math.max(1000, Number(runtimeConfig().mode?.heartbeatMs) || 10000)
  const timer = setInterval(() => {
    void (async () => {
      try {
        if (!ctx.get('subagents')) return
        for (const repoRoot of [...WATCHED_REPOS]) {
          const tower = await Tower.open(repoRoot)
          const view = await tower.rosterView()
          const live = view.roster.filter((entry) => !ROSTER_INACTIVE_STATES.includes(entry.state))
          if (live.length === 0) { WATCHED_REPOS.delete(repoRoot); continue }
          const parents = [...new Set(live.map((entry) => entry.parentSessionId).filter(Boolean))]
          if (parents.length === 0) continue
          const { activity, parentStatus } = await observeActivity(ctx, tower)
          const authoritative = parents.every((parent) => parentStatus[parent] === 'ok')
          await tower.sweepRoster({
            staleMs: Number(tower.config.spawn?.staleMs) || 0,
            activity,
            authoritative,
          })
        }
      } catch {
        // watchdog failures are best effort; tools still re-check on demand
      }
    })()
  }, watchMs)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer))
  define(ctx, {
    name: 'tower_init',
    description:
      'Initialize Tower mission state for a repository (absolute repoRoot). Creates <git-common-dir>/dsh-tower/state.json and an activity log; idempotent on an existing workspace. Options: autoGitInit (git init + empty initial commit when the directory is not a repository), snapshotDirty (snapshot uncommitted work into a dangling commit used as the mission baseline), reanchor (change base when every mission is merged/abandoned). Only the tower may initialize.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        base: { type: 'string', description: 'Optional local base branch (defaults to the checked-out branch).' },
        autoGitInit: { type: 'boolean', description: 'Run git init (and an empty initial commit) when repoRoot is not a repository yet.' },
        snapshotDirty: { type: 'boolean', description: 'Snapshot uncommitted tracked changes into a dangling commit used as the mission baseline (untracked files are not included).' },
        reanchor: { type: 'boolean', description: 'Update the recorded base when no mission is active.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: { auto_git_init: ['autoGitInit'], snapshot_dirty: ['snapshotDirty'] },
    board: true,
    output: output(SCHEMAS.init),
    async execute(args, exec) {
      const profileInit = runtimeConfig().init ?? {}
      let repo = null
      try {
        repo = await resolveRepo(args.repoRoot)
      } catch (error) {
        const autoGitInit =
          args.autoGitInit === true || (args.autoGitInit === undefined && profileInit.autoGitInit === true)
        repo = await ensureRepository(args.repoRoot, autoGitInit)
      }
      const tower = await Tower.open(repo.root)
      const initConfig = tower.config.init ?? {}
      const snapshotDirty =
        args.snapshotDirty === true || (args.snapshotDirty === undefined && initConfig.snapshotDirty === true)
      const agentId = exec?.agent?.id !== undefined ? String(exec.agent.id) : null
      if (!agentId) {
        throw new TowerToolError('not-authorized', 'tower_init requires a caller agent id; refusing to treat an unidentified caller as the tower')
      }
      let state = null
      try {
        state = await tower.load()
      } catch {
        state = null
      }
      if (state?.towerAgentId) {
        const actor = await actorFor(tower, exec)
        requireTowerActor(actor, 'initialize Tower state')
      } else if (state) {
        // Legacy state predating owner binding: an explicit tower_init may
        // claim ownership once. Other tools remain fail-closed until then.
        const actor = await actorFor(tower, exec)
        if (actor.role !== 'tower' && actor.role !== 'unknown') {
          requireTowerActor(actor, 'claim Tower ownership')
        }
      }
      const base = args.base ?? workspaceHook?.basePreference?.(exec) ?? undefined
      return tower.init({ base, snapshotDirty, reanchor: args.reanchor, towerAgentId: agentId })
    },
  })

  define(ctx, {
    name: 'tower_plan',
    description:
      'Plan one or more missions in an initialized repository. Each mission has a printable-ASCII title, relative scope globs, optional task checklist, optional mission-id dependencies, and kind build|survey. Assigns M1.. ids and auto-adds a dependency when build scopes overlap (serializes merges); rejects dependency cycles.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missions: {
          type: 'array',
          description: 'Missions to create, in intended order.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Printable ASCII title; used as the mission label.' },
              scope: { type: 'array', items: { type: 'string' }, description: 'Relative file globs this mission may touch; empty only for survey.' },
              tasks: { type: 'array', items: { type: 'string' }, description: 'Verifiable task items the worker ticks off.' },
              deps: { type: 'array', items: { type: 'string' }, description: 'Mission ids that must merge before this one.' },
              kind: { type: 'string', enum: ['build', 'survey'], description: 'survey = read-only investigation that reserves no scope.' },
              context: { type: 'string', description: "The user's own key sentences, verbatim (max 4096 chars)." },
              references: {
                type: 'array',
                maxItems: 20,
                items: { type: 'string' },
                description: 'Read-only pointers/files the worker should read (max 20); copied into the briefing.',
              },
              reviewPolicy: {
                type: 'string',
                enum: ['required-clean', 'none'],
                description: 'required-clean (mission default) means a clean review is required when review.requireReview is on; none needs reviewExemptionReason, and with the review gate on it also needs gates.allowReviewExemption.',
              },
              reviewExemptionReason: {
                type: 'string',
                description: 'Non-empty justification when reviewPolicy is "none".',
              },
            },
            required: ['title'],
            additionalProperties: false,
          },
        },
      },
      required: ['repoRoot', 'missions'],
      additionalProperties: false,
    },
    board: true,
    output: output(SCHEMAS.plan),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'plan missions')
      return tower.plan({ missions: args.missions })
    },
  })

  define(ctx, {
    name: 'tower_mission',
    description:
      'Update one mission: lifecycle status, decision note, blocker, clear blockers, mark a task done, drop a task with a reason, or widen the scope (tower only). "merged" is never set here; only a future tower_merge records it. Merged and abandoned are terminal.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        id: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: missionId).' },
        missionId: { type: 'string', description: 'Alias for id; both are accepted.' },
        status: {
          type: 'string',
          enum: [...MISSION_STATUSES],
          description: 'New lifecycle status.',
        },
        note: { type: 'string', description: 'Append a decision-log note.' },
        blocker: { type: 'string', description: 'Report a blocker (also sets status to blocked).' },
        clear_blockers: { type: 'boolean', description: 'Clear all recorded blockers.' },
        clearBlockers: { type: 'boolean', description: 'Alias for clear_blockers.' },
        task_done: { type: 'string', description: 'Mark the first open task containing this text as done.' },
        taskDone: { type: 'string', description: 'Alias for task_done.' },
        task_drop: { type: 'string', description: 'Mark the first open task containing this text as dropped.' },
        taskDrop: { type: 'string', description: 'Alias for task_drop.' },
        task_drop_reason: { type: 'string', description: 'Required with task_drop: why the task is legitimately descoped.' },
        taskDropReason: { type: 'string', description: 'Alias for task_drop_reason.' },
        scope: { type: 'array', items: { type: 'string' }, description: 'Tower only: replacement scope globs; bumps scopeGeneration.' },
        pause_cause: {
          type: 'string',
          enum: ['user', 'failure', 'resource', 'dependency'],
          description: 'With status=paused: why the mission was paused (default user).',
        },
        authorization: { type: 'string', description: 'Authorization reference recorded when resuming a user-paused mission.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"id":["missionId"],"task_done":["taskDone"],"task_drop":["taskDrop"],"task_drop_reason":["taskDropReason"],"clear_blockers":["clearBlockers"]},
    board: true,
    output: output(SCHEMAS.mission),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireKnownActor(actor, 'tower_mission')
      return tower.mission({
        actor,
        id: args.id,
        status: args.status,
        note: args.note,
        blocker: args.blocker,
        clear_blockers: args.clear_blockers,
        task_done: args.task_done,
        task_drop: args.task_drop,
        task_drop_reason: args.task_drop_reason,
        scope: args.scope,
        pause_cause: args.pause_cause,
        authorization: args.authorization,
      })
    },
  })

  define(ctx, {
    name: 'tower_status',
    description:
      'Read the Tower dashboard for a repository: state path, base branch, revision, mission status counts, paged mission summaries (scope/deps/tasks/worktree/owner), roster size, findings, config path and the activity tail. Pass missionId for one full mission (tasks, notes, reviews, findings, completion report); offset/limit page the mission list (default 20, max 100); includeGate adds preflight gate digests for the page; format:"markdown" returns the human-readable mission board. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missionId: { type: 'string', description: 'Return full detail for one mission instead of the dashboard list.' },
        offset: { type: 'integer', minimum: 0, description: 'Mission list offset (default 0).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Mission list page size (default 20).' },
        includeGate: { type: 'boolean', description: 'Compute tower_preflight-style gate digests for missions on this page.' },
        format: { type: 'string', enum: ['json', 'markdown'], description: 'markdown returns the MISSIONS.md board text.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: { mission_id: ['missionId'], include_gate: ['includeGate'] },
    output: output(SCHEMAS.status),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const boardPath = tower.boardFile()
      const mode = workspaceHook?.modeInfo?.(exec) ?? null
      const statusState = await tower.load()
      const inflight = (statusState.roster ?? []).filter(
        (entry) => entry.role === 'worker' && !ROSTER_INACTIVE_STATES.includes(entry.state) && entry.state !== 'reserved',
      ).length
      const spawn = spawnBackoffView(tower.root, tower.config.spawn?.maxLiveWorkers, inflight)
      if (args.missionId) {
        const [status, detail] = await Promise.all([
          tower.status({ missionIds: [args.missionId] }),
          tower.missionDetail(args.missionId),
        ])
        return {
          ...status,
          missions: status.missions.filter((mission) => mission.id === args.missionId),
          missionId: args.missionId,
          detail,
          boardPath,
          mode,
          spawn,
        }
      }
      const state = await tower.load()
      const total = state.missions.length
      const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0
      const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(100, args.limit)) : 20
      const pageIds = state.missions.slice(offset, offset + limit).map((mission) => mission.id)
      const status = await tower.status({ missionIds: pageIds })
      let page = status.missions
      if (args.includeGate === true) {
        const { activity, parentStatus } = await observeActivity(ctx, tower)
        page = await Promise.all(
          page.map(async (mission) => {
            try {
              const gate = await tower.evaluateGate({ missionId: mission.id, activity, parentStatus })
              return {
                ...mission,
                gate: {
                  ok: gate.ok,
                  blockers: (gate.blockers ?? []).map((blocker) => ({ code: blocker.code, detail: blocker.detail })),
                },
              }
            } catch (error) {
              return { ...mission, gate: { ok: false, error: classifyError(error).message } }
            }
          }),
        )
      }
      const result = {
        ...status,
        missions: page,
        total,
        offset,
        nextOffset: offset + page.length < total ? offset + page.length : null,
        boardPath,
        mode,
        spawn,
      }
      if (args.format === 'markdown') {
        const state = await tower.load()
        result.markdown = tower.boardMarkdown(state)
      }
      return result
    },
  })

  define(ctx, {
    name: 'tower_spawn',
    description:
      'Spawn a worker or reviewer for a mission. Workers use the tower-worker preset; reviewers require a completed mission and use the read-only tower-reviewer preset. Provisions (or reuses) the mission git worktree and branch, generates a self-contained briefing, and starts a background subagent in that worktree. The child final report is delivered back to this session; tower_roster shows authoritative activity. Records the agent in the roster; reviewer spawns record the branch tip so a reviewer that modifies the branch cannot submit a review. Returns immediately unless wait=true.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missionId: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: id).' },
        id: { type: 'string', description: 'Alias for missionId; both are accepted.' },
        role: { type: 'string', enum: ROLE_ENUM, description: 'worker executes; reviewer audits the mission branch.' },
        name: { type: 'string', description: 'Unique roster name; defaults to <role>-<missionId>.' },
        instructions: { type: 'string', description: 'Extra tower instructions appended to the briefing.' },
        worktreeRoot: { type: 'string', description: 'Optional absolute parent directory for the worktree.' },
        wait: { type: 'boolean', description: 'Wait for the child result instead of returning immediately (testing/debug).' },
        waitMs: { type: 'number', description: 'Max wait with wait=true, default 180000; clamped to spawn.maxWaitMs (default 90000).' },
        wait_ms: { type: 'number', description: 'Alias for waitMs.' },
        takeover: { type: 'boolean', description: 'Replace a live worker entry that is no longer running (increments ownerGeneration).' },
        includeDirtyBase: { type: 'boolean', description: 'Use the recorded snapshotCommit baseline when true (default true).' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"missionId":["id"],"waitMs":["wait_ms"]},
    requiresMissionId: true,
    board: true,
    output: output(SCHEMAS.spawn),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'spawn tower agents')
      const role = args.role ?? 'worker'
      if (!ROLE_ENUM.includes(role)) throw new TowerToolError('invalid-argument', `role must be one of ${ROLE_ENUM.join('|')}`)
      // Repository config (if any) already overrides the profile config here.
      const config = tower.config
      const preset = role === 'reviewer' ? config.spawn.reviewerPreset : config.spawn.workerPreset
      const model = role === 'reviewer' ? config.spawn.reviewerModel : config.spawn.workerModel
      const context = await tower.missionContext(args.missionId)
      if (role === 'reviewer') {
        if (!context.mission.worktree) {
          throw new TowerToolError('reviewer-prerequisite', 'reviewer needs an existing mission worktree; spawn a worker first')
        }
        if (context.mission.status !== 'completed') {
          throw new TowerToolError('reviewer-prerequisite', `reviewer requires a completed mission; ${context.mission.id} is ${context.mission.status}`)
        }
      }
      if (role === 'worker' && ['merged', 'abandoned'].includes(context.mission.status)) {
        throw new TowerToolError(
          'invalid-transition',
          `mission ${context.mission.id} is ${context.mission.status}; a worker can only be spawned for a planned or active mission`,
        )
      }
      const spawned = await enqueueSpawn(tower.root, async () => {
        const observed = await observeActivity(ctx, tower)
        await tower.reconcileObservedInactive(observed.activity)
        const backoff = spawnBackoffState(tower.root, config.spawn.maxLiveWorkers)
        if (backoff.blockedUntil > Date.now()) {
          const seconds = Math.ceil((backoff.blockedUntil - Date.now()) / 1000)
          throw new TowerToolError('provider-cooldown', `provider cooldown active; retry in ${seconds}s (${backoff.failures} recent failures)`)
        }
        const view = await tower.rosterView()
        const inactiveStates = ROSTER_INACTIVE_STATES
        // Resolve a unique roster name BEFORE any activation. The default name
        // is derived per role/mission and gets a numeric suffix on rework rounds.
        let name
        if (typeof args.name === 'string' && args.name.trim()) {
          name = args.name.trim()
          if (view.roster.some((entry) => entry.name === name)) {
            throw new TowerToolError('invalid-argument', 'roster name already used: ' + name)
          }
        } else {
          const base = role + '-' + args.missionId.toLowerCase()
          let candidate = base
          let suffix = 2
          while (view.roster.some((entry) => entry.name === candidate)) {
            candidate = base + '-' + suffix
            suffix += 1
          }
          name = candidate
        }
        let takeover = args.takeover === true
        if (role === 'worker') {
          // Pre-check the single-owner and live-worker rules BEFORE provisioning
          // or starting a child: a rejection must not leak an activation/worktree.
          const liveWorkers = view.roster.filter(
            (entry) => entry.role === 'worker' && !inactiveStates.includes(entry.state),
          )
          const sameMission = liveWorkers.filter((entry) => entry.missionId === args.missionId)
          if (sameMission.length > 1) {
            throw new TowerToolError(
              'invalid-transition',
              'mission ' + args.missionId + ' has ' + sameMission.length + ' live worker entries; inspect tower_roster before spawning',
            )
          }
          if (sameMission.length === 1 && !takeover) {
            throw new TowerToolError(
              'invalid-transition',
              'mission ' + args.missionId + ' already has a live worker "' + sameMission[0].name + '"; stop it with tower_interrupt, or pass takeover:true after it is no longer running',
            )
          }
          if (takeover) {
            if (sameMission.length === 1) {
              const worker = sameMission[0]
              const observed = await observeActivity(ctx, tower)
              if (observed.parentStatus[worker.parentSessionId] !== 'ok') {
                throw new TowerToolError(
                  'takeover-refused',
                  'cannot verify that worker ' + worker.name + ' stopped: its parent catalog is unavailable',
                )
              }
              const activity = observed.activity[worker.agentId]
              if (activity === 'running') {
                throw new TowerToolError(
                  'takeover-refused',
                  'worker ' + worker.name + ' is still running; call tower_interrupt (or wait) before takeover',
                )
              }
              if (activity === undefined) {
                throw new TowerToolError(
                  'takeover-refused',
                  'worker ' + worker.name + ' is not in the live catalog; run tower_adopt before takeover',
                )
              }
            } else {
              takeover = false
            }
          }
          const replacing = takeover ? sameMission : []
          const remaining = liveWorkers.filter((entry) => !replacing.includes(entry))
          const max = Math.min(Number(config.spawn.maxLiveWorkers) || 4, backoff.budget)
          if (remaining.length >= max) {
            throw new TowerToolError(
              'worker-limit',
              'live worker limit reached (' + max + '); stop a worker with tower_interrupt or raise spawn.maxLiveWorkers',
            )
          }
        }

        // Service/provider/preset checks happen before provisioning, so a failed
        // precheck cannot leave a worktree or roster revision behind.
        const subagents = ctx.get('subagents')
        if (!subagents) throw new TowerToolError('spawn-unavailable', 'subagents service is unavailable; cannot spawn')
        const providers = subagents.list()
        const provider = config.spawn.provider || (providers.includes('spawn') ? 'spawn' : providers[0])
        if (!provider) throw new TowerToolError('provider-missing', 'no subagent provider is registered')
        const presets = ctx.get('agentPresets')
        if (presets && typeof presets.list === 'function') {
          const available = await presets.list()
          if (!available.some((entry) => String(entry.id) === preset)) {
            throw new TowerToolError('preset-missing', 'agent preset "' + preset + '" is not registered; check the Tower bundle preset rows and restart DSH')
          }
        }
        if (typeof config.spawn.requireLease === 'string' && config.spawn.requireLease.trim()) {
          const requiredLease = config.spawn.requireLease.trim()
          const info = await inspectLeases(tower.commonDir)
          const lease = info.leases.find((entry) => entry.name === requiredLease && entry.expired !== true)
          if (!lease) {
            throw new TowerToolError(
              'lease-busy',
              `spawn.requireLease="${requiredLease}" is not held; acquire it with tower_resource before spawning`,
            )
          }
          if (lease.holder !== actor.name && lease.holder !== String(exec.agent.id)) {
            throw new TowerToolError(
              'lease-busy',
              `spawn.requireLease="${requiredLease}" is held by "${lease.holder}", not by this tower`,
            )
          }
        }

        const provisioned = await tower.provision({
          missionId: args.missionId,
          worktreeRoot: args.worktreeRoot,
          includeDirtyBase: args.includeDirtyBase !== false,
        })
        const { mission, worktree } = provisioned
        const contextWithWorktree = {
          ...context,
          mission: {
            ...context.mission,
            worktree: { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit },
          },
        }
        const briefing =
          role === 'worker'
            ? workerBriefing({
                repoRoot: tower.root,
                base: context.base,
                mission: contextWithWorktree.mission,
                deps: context.deps,
                worktree,
                instructions: args.instructions,
                reviews: context.reviews,
                findings: context.findings,
                completionReport: context.completionReport,
              })
            : reviewerBriefing({
                repoRoot: tower.root,
                base: context.base,
                mission: contextWithWorktree.mission,
                deps: context.deps,
                worktree,
                instructions: args.instructions,
                reviews: context.reviews,
                findings: context.findings,
                completionReport: context.completionReport,
              })

        const agentOptions = {}
        for (const key of ['provider', 'model', 'reasoningEffort', 'maxTokens']) {
          if (model && model[key] !== undefined && model[key] !== null && model[key] !== '') agentOptions[key] = model[key]
        }

        if (role === 'worker' && tower.config.tests?.admission === 'spawn') {
          const discovery = await runMissionDiscovery(tower, mission)
          if (discovery.configured && discovery.receipt.ok !== true) {
            throw new TowerToolError(
              'tests-failed',
              `test admission failed for ${mission.id}: ${discovery.receipt.error}; no child was started`,
            )
          }
        }

        let activation = null
        let agentId = null
        let entry = null
        await tower.reserveRoster({
          missionId: mission.id,
          name,
          role,
          parentSessionId: String(exec.agent.id),
          cwd: worktree.path,
          branch: worktree.branch,
        })
        try {
          activation = await subagents.startActivation({
            provider,
            label: name,
            request: {
              cwd: worktree.path,
              agentPreset: preset,
              prompt: [{ type: 'text', text: briefing }],
              parent: exec.agent,
              maxDepth: config.spawn.maxDepth ?? 1,
              ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
            },
            signal: exec.signal,
            delivery: 'parent',
          })
          agentId = String(activation.childId)
          entry = await tower.recordSpawn({
            missionId: mission.id,
            name,
            role,
            agentId,
            parentSessionId: String(exec.agent.id),
            cwd: worktree.path,
            branch: worktree.branch,
            takeover,
          })
          recordSpawnSuccess(tower.root, config.spawn.maxLiveWorkers)
        } catch (error) {
          if (classifyError(error).retryable === true) {
            recordSpawnThrottle(tower.root, config.spawn.maxLiveWorkers)
          }
          // The child may already be running even when recordSpawn failed: stop
          // it and mark the reserved entry failed so it cannot keep writing
          // unobserved.
          if (agentId) {
            try {
              await Promise.resolve(subagents.interrupt(agentId, { kind: 'ancestor', agent: exec.agent }))
            } catch {
              // best effort; the error below is the actionable one
            }
          }
          await tower
            .recordSpawnOutcome({
              missionId: mission.id,
              name,
              state: 'failed',
              detail: `spawn failed${agentId ? ` after activation ${agentId}` : ' before activation'}: ${String(error?.message ?? error).slice(0, 300)}`,
            })
            .catch(() => {})
          throw error
        }

        const recordOutcome = (state, detail) =>
          tower.recordSpawnOutcome({ missionId: mission.id, name, state, detail }).catch(() => {})

        const report = {
          name,
          agentId,
          role,
          missionId: mission.id,
          preset,
          provider,
          maxDepth: config.spawn.maxDepth ?? 1,
          ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
          worktree: { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit },
          created: provisioned.created,
          briefingChars: briefing.length,
          takeover,
          rosterEntry: entry,
        }

        return { report, activation, recordOutcome }
      })
      const { report, activation, recordOutcome } = spawned
      if (args.wait !== true) {
        activation.result
          .then((result) => {
            const state = result?.stopReason === 'completed' ? 'inactive' : 'failed'
            return recordOutcome(state, result?.diagnostic ?? result?.stopReason ?? null)
          })
          .catch((error) => recordOutcome('failed', String(error?.message ?? error)))
        return report
      }
      const waitMs = Math.max(1000, Math.min(config.spawn.maxWaitMs ?? 90000, args.waitMs ?? 180000))
      let timer
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ __timeout: true }), waitMs)
      })
      let result
      try {
        result = await Promise.race([activation.result, timeout])
      } catch (error) {
        report.stopReason = 'failed'
        report.diagnostic = String(error?.message ?? error)
        await recordOutcome('failed', report.diagnostic)
        throw error
      } finally {
        clearTimeout(timer)
      }
      if (result && result.__timeout) {
        report.timedOut = true
        recordOutcome('unknown', 'spawn wait timed out; check tower_roster')
      } else {
        report.stopReason = result?.stopReason ?? null
        report.output = textOf(result?.output)
        report.diagnostic = result?.diagnostic ?? null
        const state = report.stopReason === 'completed' ? 'inactive' : 'failed'
        if (state === 'failed') report.diagnostic = report.diagnostic ?? report.stopReason
        await recordOutcome(state, report.diagnostic ?? null)
      }
      return report

    },
  })

  define(ctx, {
    name: 'tower_roster',
    description:
      'List tower roster agents with authoritative live activity from the subagent catalog (running/inactive/missing/unknown). Read-only; never resumes children. Use before completion or merge decisions.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    output: output(SCHEMAS.roster),
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      const view = await tower.rosterView()
      const subagents = ctx.get('subagents')
      if (!subagents) throw new TowerToolError('spawn-unavailable', 'subagents service is unavailable; cannot observe roster')

      const parents = [...new Set(view.roster.map((entry) => entry.parentSessionId).filter(Boolean))]
      const activity = new Map()
      const parentStatus = {}
      for (const parent of parents) {
        try {
          const rows = await subagents.listDescendants(parent)
          for (const row of rows) activity.set(String(row.id), row.activity ?? 'unknown')
          parentStatus[parent] = 'ok'
        } catch (error) {
          parentStatus[parent] = `unavailable: ${String(error?.message ?? error)}`
        }
      }

      const staleMs = Number(tower.config.spawn?.staleMs) || 0
      const now = Date.now()
      const roster = view.roster.map((entry) => {
        const observed = activity.get(entry.agentId)
        const known = parentStatus[entry.parentSessionId] === 'ok'
        const stale =
          staleMs > 0 &&
          observed === undefined &&
          known &&
          !['retired', 'failed', 'interrupted', 'missing', 'stale'].includes(entry.state) &&
          now - Number(entry.spawnedAt ?? 0) > staleMs
        return {
          ...entry,
          activity: observed ?? (known ? 'missing' : 'unknown'),
          observed: observed !== undefined,
          stale,
        }
      })
      return { revision: view.revision, roster, parentStatus, missions: view.missions }
    },
  })

  define(ctx, {
    name: 'tower_interrupt',
    description:
      'Interrupt one running tower roster agent (worker or reviewer) and record it as interrupted in the roster. Only the tower may interrupt. Idempotent: an agent that is not running returns interrupted:false. Use it before takeover after a runaway worker, or to stop work that is no longer wanted.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        to: { type: 'string', description: 'Roster name to interrupt.' },
        agentId: { type: 'string', description: 'Agent/session id to interrupt (alternative to to).' },
        agent_id: { type: 'string', description: 'Alias for agentId.' },
        reason: { type: 'string', description: 'Why the agent is being interrupted (recorded in the roster).' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: { agentId: ['agent_id'] },
    output: output(SCHEMAS.interrupt),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'interrupt tower agents')
      if (!args.to && !args.agentId) throw new TowerToolError('invalid-argument', 'tower_interrupt requires to (roster name) or agentId')
      const result = await interruptRosterAgent(ctx, tower, exec, {
        to: args.to,
        agentId: args.agentId,
        reason: args.reason,
      })
      return { ok: true, ...result }
    },
  })

  define(ctx, {
    name: 'tower_diff',
    description:
      'Read-only view of a mission branch for review: merge base, changed files, commits, and a capped patch against the recorded base. Safe for reviewers; it never modifies the repository.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path to the main checkout root.' },
        missionId: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: id).' },
        id: { type: 'string', description: 'Alias for missionId; both are accepted.' },
        maxBytes: { type: 'integer', minimum: 1024, description: 'Patch cap in bytes (default 65536).' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    output: output(SCHEMAS.diff),
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      return tower.diff({ missionId: args.missionId, maxBytes: args.maxBytes })
    },
  })

  define(ctx, {
    name: 'tower_adopt',
    description:
      'Reconcile the roster with the durable subagent catalog after a restart or new session. Agents that are provably gone are marked retired (records are kept) or missing (retireMissing:false, so the tower can inspect/take over); agents whose parent catalog cannot be read stay unknown and are never changed. Only the tower may adopt.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        retireMissing: { type: 'boolean', description: 'Retire provably gone agents (default true); false marks them missing instead.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: { retire_missing: ['retireMissing'] },
    output: output(SCHEMAS.adopt),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'adopt the roster')
      const view = await tower.rosterView()
      const subagents = ctx.get('subagents')
      if (!subagents) throw new TowerToolError('spawn-unavailable', 'subagents service is unavailable; cannot adopt')

      const parents = [...new Set(view.roster.map((entry) => entry.parentSessionId).filter(Boolean))]
      const activity = new Map()
      const parentStatus = {}
      for (const parent of parents) {
        try {
          const rows = await subagents.listDescendants(parent)
          for (const row of rows) activity.set(String(row.id), row.activity ?? 'unknown')
          parentStatus[parent] = 'ok'
        } catch (error) {
          parentStatus[parent] = `unavailable: ${String(error?.message ?? error)}`
        }
      }

      const retiredCandidates = []
      const presentIds = []
      const absentIds = []
      for (const entry of view.roster) {
        if (entry.state === 'retired') continue
        if (parentStatus[entry.parentSessionId] !== 'ok') continue
        if (activity.has(entry.agentId)) {
          presentIds.push(entry.agentId)
        } else {
          absentIds.push(entry.agentId)
        }
      }
      const observations = await tower.recordRosterObservations({ present: presentIds, absent: absentIds, confirmations: 2 })
      retiredCandidates.push(...observations.candidates)
      const retireMissing = args.retireMissing !== false
      const { retired } = retireMissing ? await tower.markRetired(retiredCandidates) : { retired: [] }
      const { missing } = retireMissing ? { missing: [] } : await tower.markMissing(retiredCandidates)
      const after = await tower.rosterView()
      return {
        retired,
        missing,
        unconfirmed: absentIds.filter((agentId) => !retiredCandidates.includes(agentId)),
        skippedUnknownParents: Object.entries(parentStatus)
          .filter(([, status]) => status !== 'ok')
          .map(([parent]) => parent),
        roster: after.roster,
        parentStatus,
      }
    },
  })

  define(ctx, {
    name: 'tower_send',
    description:
      'Send a durable inbox message to a tower participant: a roster agent name, "tower", or "all" (broadcast). The message is persisted first; when the recipient is a currently running roster agent the tower also steers it into that child\'s current turn. Returns delivery results.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        to: { type: 'string', description: 'Recipient: a roster agent name, "tower", or "all".' },
        subject: { type: 'string', description: 'One-line subject.' },
        body: { type: 'string', description: 'Full message body (markdown).' },
        scope: { type: 'string', description: 'Optional scope tag, e.g. the mission id.' },
        interrupt: {
          type: 'boolean',
          description: 'Interrupt the recipient\'s current turn before delivering (Kimi-style "message interrupts the running turn"); default false = queue at the next step boundary.',
        },
        consentRef: { type: 'string', description: 'Optional audit reference recording who consented to this instruction.' },
        consent_ref: { type: 'string', description: 'Alias for consentRef.' },
      },
      required: ['repoRoot', 'to', 'subject', 'body'],
      additionalProperties: false,
    },
    aliases: { consentRef: ['consent_ref'] },
    output: output(SCHEMAS.send),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      checkSendRate(tower.config, args.repoRoot)
      const actor = await actorFor(tower, exec)
      const view = await tower.rosterView()
      const from = actor.role === 'tower' ? 'tower' : actor.name
      if (actor.role === 'unknown') {
        throw new TowerToolError('not-authorized', 'tower_send requires a registered roster agent or the tower')
      }
      if (args.to === 'all' && actor.role !== 'tower') {
        throw new TowerToolError('not-authorized', 'only the tower may broadcast to "all"')
      }
      const sendConfig = tower.config.send ?? {}
      const interrupt =
        args.interrupt === undefined ? sendConfig.interruptDefault === true : args.interrupt === true
      if (interrupt && actor.role !== 'tower') {
        throw new TowerToolError('not-authorized', 'only the tower may interrupt a recipient with tower_send')
      }
      if (actor.role !== 'tower') {
        const self = view.roster.find((entry) => entry.agentId === actor.agentId)
        const target = view.roster.find((entry) => entry.name === args.to)
        const allowed =
          args.to === 'tower' ||
          (self && target && target.agentId !== self.agentId && target.missionId === self.missionId)
        if (!allowed) {
          throw new TowerToolError('not-authorized', `${actor.name} may only message the tower or agents on the same mission`)
        }
      }
      if (typeof args.subject !== 'string' || args.subject.trim().length === 0) {
        throw new TowerToolError('invalid-argument', 'tower_send requires a subject')
      }
      if (typeof args.body !== 'string' || args.body.trim().length === 0) {
        throw new TowerToolError('invalid-argument', 'tower_send requires a body')
      }
      const message = await tower.recordMessage({
        from,
        to: args.to,
        subject: args.subject.trim(),
        body: args.body,
        scope: args.scope,
        consentRef: args.consentRef,
      })

      const subagents = ctx.get('subagents')
      const results = []
      if (!subagents) {
        results.push({ target: '*', pushed: false, reason: 'subagents service unavailable; persisted only' })
      } else {
        const roster = view.roster
        const parents = [...new Set(roster.map((entry) => entry.parentSessionId).filter(Boolean))]
        const activity = new Map()
        for (const parent of parents) {
          try {
            const rows = await subagents.listDescendants(parent)
            for (const row of rows) activity.set(String(row.id), row.activity ?? 'unknown')
          } catch {
            // an unreadable parent catalog only means "do not wake it"
          }
        }
        const targets =
          args.to === 'all' ? roster.map((entry) => entry.name) : [args.to]
        for (const targetName of targets) {
          if (targetName === 'tower') {
            results.push({ target: 'tower', pushed: false, reason: 'tower reads its inbox' })
            continue
          }
          const entry = roster.find((candidate) => candidate.name === targetName)
          if (!entry) {
            results.push({ target: targetName, pushed: false, reason: 'not in roster' })
            continue
          }
          if (activity.get(entry.agentId) !== 'running') {
            results.push({ target: targetName, pushed: false, reason: 'not running; queued in inbox' })
            continue
          }
          let interrupted = false
          if (interrupt) {
            try {
              subagents.interrupt(entry.agentId, { kind: 'ancestor', agent: exec.agent })
              interrupted = true
              await tower.recordInterrupt({
                agentId: entry.agentId,
                reason: `tower_send${message?.id ? ` ${message.id}` : ''}: ${args.subject.trim().slice(0, 120)}`,
              })
            } catch (error) {
              results.push({ target: targetName, pushed: false, reason: `interrupt failed: ${String(error?.message ?? error)}` })
              continue
            }
          }
          try {
            await subagents.sendMessage(
              exec.agent,
              entry.agentId,
              [
                {
                  type: 'text',
                  text: `[tower inbox ${message.id}] ${message.subject}\n\n${message.body}`,
                },
              ],
              { signal: exec.signal },
            )
            results.push({ target: targetName, pushed: true, interrupted })
          } catch (error) {
            results.push({ target: targetName, pushed: false, reason: String(error?.message ?? error) })
          }
        }
      }
      if (results.length > 0) await tower.recordDelivery(message.id, results)
      return {
        message: { id: message.id, from, to: message.to, subject: message.subject },
        deliveries: results,
      }
    },
  })

  define(ctx, {
    name: 'tower_inbox',
    description:
      'Read your tower inbox: messages addressed to you plus broadcasts, newest first. Only returned messages are acknowledged; the result reports unreadRemaining, so keep reading until it reaches 0. Set include_read for history. Unread messages block tower_complete.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        limit: { type: 'number', description: 'Max messages to return (default 20), newest first.' },
        include_read: { type: 'boolean', description: 'Include previously acknowledged messages for history lookup.' },
        includeRead: { type: 'boolean', description: 'Alias for include_read.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"include_read":["includeRead"]},
    output: output(SCHEMAS.inbox),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const view = await tower.rosterView()
      const self = view.roster.find((entry) => entry.agentId === String(exec.agent.id))
      const reader = self ? self.name : 'tower'
      return tower.inbox({ reader, limit: args.limit, includeRead: args.include_read === true })
    },
  })

  define(ctx, {
    name: 'tower_complete',
    description:
      'Worker-only: report mission completion. Enforced by the store: every task done or dropped, no blockers, the current owner, the mission branch has at least one commit since its spawn base, and no unread inbox messages. checks records verifiable evidence (name/command/exitCode/evidence); gates.requireChecks can require at least one before merge. Stores the full report; completion means ready for preflight and optional review, not merged.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missionId: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: id).' },
        id: { type: 'string', description: 'Alias for missionId; both are accepted.' },
        report: { type: 'string', description: 'Full completion report for the tower and the next review round.' },
        checks: {
          type: 'array',
          description: 'Optional evidence ledger entries: {name, command?, exitCode?, evidence?}.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'What was checked.' },
              command: { type: 'string', description: 'Command or method used.' },
              exitCode: { type: 'integer', description: 'Observed exit code.' },
              evidence: { type: 'string', description: 'Short evidence line/log reference.' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
      required: ['repoRoot', 'report'],
      additionalProperties: false,
    },
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    board: true,
    output: output(SCHEMAS.complete),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      // Validate authorization/state before executing repository-controlled
      // test code or writing a test receipt.
      await tower.checkCompletion({
        missionId: args.missionId,
        agentId: String(exec.agent.id),
        report: args.report,
      })
      const context = await tower.missionContext(args.missionId)
      const checks = [...(Array.isArray(args.checks) ? args.checks : [])]
      const testsConfig = tower.config.tests ?? {}
      if (testsConfig.enabled !== false && testsConfig.admission === 'complete') {
        const discovery = await runMissionDiscovery(tower, { id: args.missionId, worktree: context.mission.worktree })
        if (discovery.configured && discovery.receipt.ok !== true) {
          throw new TowerToolError('tests-failed', `test discovery failed for ${args.missionId}: ${discovery.receipt.error}`)
        }
        if (discovery.configured && testsConfig.autoChecks !== false && discovery.check) {
          if (checks.length >= 20) checks[19] = discovery.check
          else checks.push(discovery.check)
        }
      }
      return tower.complete({
        missionId: args.missionId,
        agentId: String(exec.agent.id),
        report: args.report,
        checks,
      })
    },
  })

  define(ctx, {
    name: 'tower_finding',
    description:
      'File a structured finding (bug / improve / vuln / idea) for the tower to route. Use this for anything notable OUTSIDE your mission scope instead of editing out-of-scope files. Severity is one of low|medium|high|critical. Use tower_findings to list, read, or close findings later.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        type: { type: 'string', enum: [...FINDING_TYPES], description: 'Finding category.' },
        title: { type: 'string', description: 'Short finding title.' },
        severity: { type: 'string', enum: [...FINDING_SEVERITIES], description: 'Optional severity.' },
        summary: { type: 'string', description: 'What was found, in a sentence or two.' },
        location: { type: 'string', description: 'File/symbol the finding concerns.' },
        details: { type: 'string', description: 'Full details: evidence, reproduction, impact.' },
        suggested_fix: { type: 'string', description: 'What you would do about it.' },
        missionId: { type: 'string', description: 'Optional mission this finding relates to (alias: mission_id).' },
        mission_id: { type: 'string', description: 'Alias for missionId.' },
      },
      required: ['repoRoot', 'type', 'title', 'summary', 'details', 'suggested_fix'],
      additionalProperties: false,
    },
    aliases: {"missionId":["mission_id"]},
    board: true,
    output: output(SCHEMAS.finding),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireKnownActor(actor, 'tower_finding')
      const view = await tower.rosterView()
      const self = view.roster.find((entry) => entry.agentId === String(exec.agent.id))
      return tower.addFinding({
        type: args.type,
        title: args.title,
        severity: args.severity,
        summary: args.summary,
        location: args.location,
        details: args.details,
        suggested_fix: args.suggested_fix,
        missionId: args.missionId,
        reportedBy: self ? self.name : 'tower',
      })
    },
  })

  define(ctx, {
    name: 'tower_findings',
    description:
      'List, read, or update findings for a repository. Without id it lists findings newest-first with counts by status (filters: status, type, severity, missionId, open, limit). With id it returns that finding; with id plus status and/or note it records a lifecycle transition. Statuses are open -> triaged -> fixed|wontfix, and fixed/wontfix can be reopened to open. Only the tower or a worker may change a finding; reviewers may only list and read. Read-only when no id is given.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        id: { type: 'string', description: 'Finding id, e.g. F1. When present the call reads or updates that finding.' },
        status: {
          type: 'string',
          enum: [...FINDING_STATUSES, 'all'],
          description: 'With id: target status. Without id: filter (default all).',
        },
        note: { type: 'string', description: 'Optional note recorded together with an update.' },
        type: { type: 'string', enum: [...FINDING_TYPES], description: 'Filter by finding type.' },
        severity: { type: 'string', enum: [...FINDING_SEVERITIES], description: 'Filter by severity.' },
        missionId: { type: 'string', description: 'Filter by mission id (alias: mission_id).' },
        mission_id: { type: 'string', description: 'Alias for missionId.' },
        open: { type: 'boolean', description: 'Only findings that are not fixed or wontfix.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max findings to list (default 50).' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"missionId":["mission_id"]},
    output: output(SCHEMAS.findings),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireKnownActor(actor, 'tower_findings')
      const view = await tower.rosterView()
      const self = view.roster.find((entry) => entry.agentId === String(exec.agent.id))
      return tower.findings({
        id: args.id,
        status: args.status,
        note: args.note,
        type: args.type,
        severity: args.severity,
        missionId: args.missionId,
        open: args.open,
        limit: args.limit,
        actor: { name: self ? self.name : 'tower', role: self ? self.role : 'tower' },
      })
    },
  })

  define(ctx, {
    name: 'tower_review',
    description:
      'Submit an independent review verdict for a completed mission, bound to the current branch tip. status is "clean", "p1-Nitems", or "p2-Nitems"; merge is "merge", "fix-then-merge", or "hold" (only clean + merge is later approval). Non-clean returns the mission to active. Reviewers are capped at 5 rounds per branch; a tower-submitted review is break-glass and requires breakGlassReason.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missionId: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: id).' },
        id: { type: 'string', description: 'Alias for missionId; both are accepted.' },
        status: { type: 'string', description: 'Verdict: "clean", or "p1-Nitems" / "p2-Nitems" with the number of findings at that priority.' },
        merge: { type: 'string', enum: ['merge', 'fix-then-merge', 'hold'], description: 'Merge recommendation for the tower.' },
        findings: { type: 'string', description: 'Full findings text (markdown); write "none" when clean.' },
        checks: { type: 'array', items: { type: 'string' }, description: 'Checklist items you verified.' },
        decision: { type: 'string', description: 'The reasoning behind your verdict.' },
        breakGlassReason: { type: 'string', description: 'Tower-only exceptional self-review: why no independent reviewer was used.' },
      },
      required: ['repoRoot', 'status', 'merge', 'findings', 'decision'],
      additionalProperties: false,
    },
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    board: true,
    output: output(SCHEMAS.review),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      if (!['reviewer', 'tower'].includes(actor.role)) {
        throw new TowerToolError('not-authorized', `only an assigned reviewer or the tower may review; ${actor.name} is ${actor.role}`)
      }
      if (actor.role === 'tower' && (typeof args.breakGlassReason !== 'string' || args.breakGlassReason.trim().length === 0)) {
        throw new TowerToolError('not-authorized', 'a tower-submitted review is break-glass and requires a non-empty breakGlassReason')
      }
      return tower.submitReview({
        missionId: args.missionId,
        agentId: String(exec.agent.id),
        actor,
        status: args.status,
        merge: args.merge,
        findings: args.findings,
        checks: args.checks,
        decision: args.decision,
        breakGlassReason: args.breakGlassReason,
      })
    },
  })

  define(ctx, {
    name: 'tower_preflight',
    description:
      'Read-only merge gate for one mission: returns ok plus stable blocker codes (branch-missing, deps-unmerged, read-only-survey, stale-base, out-of-scope, base-dirty, branch-owned-by-closed-missions, and mission/worker guards). Review blockers (no-review, review-hold, not-clean, review-not-approved, tip-moved, review-mission-mismatch) apply only when review.requireReview is on. Never changes anything.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missionId: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: id).' },
        id: { type: 'string', description: 'Alias for missionId; both are accepted.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    output: output(SCHEMAS.preflight),
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      const { activity, parentStatus } = await observeActivity(ctx, tower)
      const gate = await tower.evaluateGate({ missionId: args.missionId, activity, parentStatus })
      return {
        ok: gate.ok,
        blockers: gate.blockers,
        missionId: args.missionId,
        branchTip: gate.branchTip ?? null,
        baseTip: gate.baseTip ?? null,
        changedFiles: gate.changedFiles ?? [],
        review: gate.review
          ? {
              round: gate.review.round,
              status: gate.review.status,
              mergeVerdict: gate.review.mergeVerdict,
              reviewer: gate.review.reviewer,
              reviewedCommit: gate.review.reviewedCommit,
            }
          : null,
      }
    },
  })

  define(ctx, {
    name: 'tower_merge',
    description:
      'Merge a mission branch into the recorded base branch with --no-ff, after the hard gate passes. Verifies the two merge parents and records the mission as merged. If the merge commit already landed (manual merge, crashed or slow pre-merge hook), it detects the merge commit and records it as reconciled instead of merging again. A failed gate returns stable blocker codes without merging; a hook failure aborts cleanly and returns "merge-hook-failed" while a real content conflict returns "merge-conflict".',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missionId: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: id).' },
        id: { type: 'string', description: 'Alias for missionId; both are accepted.' },
        timeoutMs: {
          type: 'integer',
          minimum: 1000,
          description: 'Optional timeout for the merge command in milliseconds, including pre-merge hooks (default 15 minutes).',
        },
        timeout_ms: {
          type: 'integer',
          minimum: 1000,
          description: 'Alias for timeoutMs.',
        },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"missionId":["id"],"timeoutMs":["timeout_ms"]},
    requiresMissionId: true,
    board: true,
    output: output(SCHEMAS.merge),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'merge missions')
      const { activity, parentStatus } = await observeActivity(ctx, tower)
      return tower.merge({ missionId: args.missionId, activity, parentStatus, timeoutMs: args.timeoutMs })
    },
  })

  define(ctx, {
    name: 'tower_rebase',
    description:
      'Rebase a mission branch onto the current base tip inside its own worktree. Refuses while its worker is running or the worktree is dirty. A clean conflict-free rebase waives re-review for the old review; a conflict is aborted and the mission is marked blocked. If the branch is already contained in the base, it returns alreadyMerged and leaves the branch untouched so tower_merge can record the landed merge.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missionId: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: id).' },
        id: { type: 'string', description: 'Alias for missionId; both are accepted.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    board: true,
    output: output(SCHEMAS.rebase),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'rebase missions')
      const { activity } = await observeActivity(ctx, tower)
      return tower.rebase({ missionId: args.missionId, activity })
    },
  })

  define(ctx, {
    name: 'tower_teardown',
    description:
      'Tear down eligible mission worktrees after their missions are merged or abandoned. A worktree whose roster agent is running is always kept (force cannot override); dirty worktrees need force; exclude keeps named missions. dry_run previews the remove/keep decisions without changing anything.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        force: { type: 'boolean', description: 'Remove worktrees that contain uncommitted changes (never a live agent).' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Mission ids to keep.' },
        dry_run: { type: 'boolean', description: 'Preview remove/keep decisions without changing disk or state.' },
        dryRun: { type: 'boolean', description: 'Alias for dry_run.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"dry_run":["dryRun"]},
    board: true,
    output: output(SCHEMAS.teardown),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'tear down worktrees')
      const { activity } = await observeActivity(ctx, tower)
      return tower.teardown({
        force: args.force === true,
        exclude: args.exclude,
        dryRun: args.dry_run === true,
        activity,
      })
    },
  })

  registerDoctorTool(ctx, define)

  registerRecoverTool(ctx, { define, actorFor, requireTowerActor })

  registerTestTool(ctx, { define, actorFor, requireKnownActor, runMissionDiscovery })

  define(ctx, {
    name: 'tower_batch',
    description:
      'Manage finite evidence batches: create freezes missionIds/requiredChecks/receiptPaths, status summarizes members, close verifies every required check and receipt hash, abandon retires a stale open batch. Membership and exclusions are immutable after create; close/abandon never remove missions.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        action: { type: 'string', enum: ['create', 'status', 'close', 'abandon'], description: 'Batch operation.' },
        missionIds: { type: 'array', items: { type: 'string' }, description: 'Exact mission ids in this batch (create).' },
        exclusions: { type: 'array', items: { type: 'string' }, description: 'Paused legacy mission ids excluded from the batch.' },
        requiredChecks: { type: 'array', items: { type: 'string' }, description: 'Check names every build member must record (default ["check"]).' },
        receiptPaths: { type: 'array', items: { type: 'string' }, description: 'Exact relative receipt files checked at close.' },
        batchId: { type: 'string', description: 'Batch id (status/close/abandon).' },
        reason: { type: 'string', description: 'Reason recorded when abandoning a batch.' },
        checks: { type: 'array', items: { type: 'object' }, description: 'Close-time extra check evidence.' },
        treeTip: { type: 'string', description: 'Expected reviewed/tested commit for close evidence.' },
        receiptHashes: { type: 'object', description: 'Relative receipt path -> sha256 observed by the caller.' },
      },
      required: ['repoRoot', 'action'],
      additionalProperties: false,
    },
    board: true,
    output: output(SCHEMAS.batch),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      if (args.action === 'status') {
        const state = await tower.load()
        const batch = args.batchId
          ? (state.batches ?? []).find((entry) => entry.id === args.batchId)
          : null
        if (args.batchId && !batch) throw new TowerToolError('invalid-argument', `unknown batch "${args.batchId}"`)
        return {
          ok: true,
          action: 'status',
          batches: (state.batches ?? []).map((entry) => summarizeBatch(state, entry)),
          ...(batch ? { batch: summarizeBatch(state, batch) } : {}),
          ...(args.batchId ? { summary: summarizeBatch(state, batch) } : {}),
        }
      }
      requireTowerActor(actor, args.action === 'create' ? 'create a batch' : args.action === 'abandon' ? 'abandon a batch' : 'close a batch')
      if (args.action === 'create') {
        const batch = await tower.createBatch(args, actor.name)
        return { ok: true, action: 'create', batch, batches: (await tower.batchStatus()).batches }
      }
      if (typeof args.batchId !== 'string' || args.batchId.trim().length === 0) {
        throw new TowerToolError('invalid-argument', `tower_batch ${args.action} requires batchId`)
      }
      if (args.action === 'abandon') {
        const result = await tower.abandonBatch(args.batchId.trim(), actor.name, args.reason)
        return { ok: true, action: 'abandon', batch: result.batch, blockers: [] }
      }
      const closeState = await tower.load()
      const closeBatch = (closeState.batches ?? []).find((entry) => entry.id === args.batchId.trim())
      if (closeBatch) {
        const receiptProblems = await verifyBatchReceiptFiles(tower.root, closeBatch, args)
        if (receiptProblems.length > 0) {
          return { ok: false, action: 'close', batch: closeBatch, blockers: receiptProblems, checks: [] }
        }
      }
      const result = await tower.closeBatch(args.batchId.trim(), {
        checks: args.checks,
        treeTip: args.treeTip,
        receiptHashes: args.receiptHashes,
      }, actor.name)
      return {
        ok: result.ok,
        action: 'close',
        batch: result.batch,
        blockers: (result.blockers ?? []).map((blocker) => ({
          code: blocker.code ?? 'batch-invalid',
          detail: blocker.detail ?? blocker.message ?? String(blocker),
          ...(blocker.cleanup ? { cleanup: blocker.cleanup } : {}),
          ...(blocker.timeout ? { timeout: true } : {}),
        })),
        checks: result.checks ?? [],
      }
    },
  })

  define(ctx, {
    name: 'tower_resource',
    description:
      'Advisory resource leases per repository (coordination only; no OS CPU/memory hard cap). acquire/release require a token and are tower-only; status is read-only. Expired leases are never taken over silently.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        action: { type: 'string', enum: ['acquire', 'release', 'status'], description: 'Lease operation.' },
        name: { type: 'string', description: 'Lease name, e.g. plugin-load or heavy-ci.' },
        holder: { type: 'string', description: 'Holder label (defaults to the caller).' },
        token: { type: 'string', description: 'Release token; generated on acquire when omitted.' },
        ttlMs: { type: 'integer', minimum: 1000, description: 'Lease lifetime (default leases.ttlMs).' },
        force: { type: 'boolean', description: 'Explicitly release an expired lease (token still required).' },
      },
      required: ['repoRoot', 'action'],
      additionalProperties: false,
    },
    output: output(SCHEMAS.resource),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      const redact = (leases) => leases.map(({ token, ...lease }) => lease)
      if (args.action === 'status') {
        const info = await inspectLeases(tower.commonDir)
        const leases = redact(info.leases ?? [])
        return { ok: true, action: 'status', ...info, leases }
      }
      requireTowerActor(actor, args.action === 'acquire' ? 'acquire a lease' : 'release a lease')
      if (typeof args.name !== 'string' || args.name.trim().length === 0) {
        throw new TowerToolError('invalid-argument', 'tower_resource requires name')
      }
      const name = args.name.trim()
      const ttlMs = Number(args.ttlMs ?? tower.config.leases?.ttlMs ?? 900000)
      if (args.action === 'acquire') {
        const lease = await acquireLease(tower.commonDir, {
          name,
          holder: args.holder ?? actor.name,
          token: args.token ?? crypto.randomUUID(),
          pid: process.pid,
          ttlMs,
        })
        return { ok: true, action: 'acquire', lease }
      }
      const token = args.token
      if (typeof token !== 'string' || token.length === 0) {
        throw new TowerToolError('invalid-argument', 'tower_resource release requires token')
      }
      const released = await releaseLease(tower.commonDir, { name, token, force: args.force === true })
      return { ok: true, action: 'release', released, leases: redact((await inspectLeases(tower.commonDir)).leases) }
    },
  })

  define(ctx, {
    name: 'tower_import_legacy',
    description:
      'Read-only import of a Tower Codex (schemaVersion 1) or DSH legacy state file. Stores the full payload under <common>/dsh-tower/legacy/<sha256>.json and records only a summary in state.legacySnapshots; never activates, adopts, or resumes paused missions.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        sourcePath: { type: 'string', description: 'Absolute path to the legacy JSON state file.' },
      },
      required: ['repoRoot', 'sourcePath'],
      additionalProperties: false,
    },
    board: true,
    output: output(SCHEMAS.importLegacy),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'import a legacy snapshot')
      const imported = await importLegacySnapshot({
        repoRoot: tower.root,
        commonDir: tower.commonDir,
        sourcePath: args.sourcePath,
      })
      const recorded = await tower.recordLegacySnapshot(imported.snapshot)
      return { ok: true, summary: imported.summary, snapshot: recorded.snapshot }
    },
  })

  define(ctx, {
    name: 'tower_legacy_map',
    description:
      'Audit-only mapping between a legacy snapshot id and a current mission. map records sourceHash/oldId/newMissionId; status lists mappings. Mapping never adopts or resumes a legacy mission.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        action: { type: 'string', enum: ['map', 'status'], description: 'Mapping operation.' },
        sourceHash: { type: 'string', description: 'Legacy snapshot sha256 (map).' },
        oldId: { type: 'string', description: 'Legacy mission id (map).' },
        newMissionId: { type: 'string', description: 'Current mission id; optional audit pointer.' },
      },
      required: ['repoRoot', 'action'],
      additionalProperties: false,
    },
    output: output(SCHEMAS.legacyMap),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      const state = await tower.load()
      if (args.action === 'status') {
        return { ok: true, maps: state.legacyMaps ?? [] }
      }
      requireTowerActor(actor, 'map a legacy mission')
      const validation = validateLegacyMap(state, args)
      if (validation.ok !== true) {
        throw new TowerToolError('invalid-argument', validation.error ?? 'invalid legacy mapping')
      }
      const map = { ...validation.map, by: actor.name, at: Date.now() }
      const recorded = await tower.recordLegacyMap(map)
      return { ok: true, map: recorded.map, maps: [...(state.legacyMaps ?? []), recorded.map] }
    },
  })

  // Dev-only hot reload. The tool is registered whenever dev.hotReload is on;
  // it reports reload-unavailable when the profile has no HMR service. When the
  // Host passed a shared bridge, its status() reflects the command's reloads too.
  const dev = runtimeConfig().dev ?? {}
  if (dev.hotReload !== false) {
    const bridge =
      sharedHmrBridge ??
      createHmrBridge(ctx, {
        requiredIds: dev.reloadRequiredIds,
        delayMs: dev.reloadDelayMs,
        logger: ctx.logger ?? console,
      })
    define(ctx, {
      name: 'tower_reload',
      description:
        'Dev-only: ask DSH HMR to reconcile this profile and reload the Tower Host plugin from disk. The reload is scheduled a few milliseconds after this call returns (so the result reaches the model first). Use after editing the plugin source in a linked profile; plugin_manager install/update already triggers reconciliation by itself. Registered while dev.hotReload is on; fails with reload-unavailable when the HMR service is absent.',
      parameters: {
        type: 'object',
        properties: {
          repoRoot: { type: 'string', description: 'Optional repository root; when present the caller must be the tower.' },
        },
        required: [],
        additionalProperties: false,
      },
      output: output(SCHEMAS.reload),
      async execute(args, exec) {
        if (typeof args.repoRoot === 'string') {
          const tower = await Tower.open(args.repoRoot)
          const actor = await actorFor(tower, exec)
          requireTowerActor(actor, 'reload the Tower plugin')
        }
        if (!bridge.available) {
          throw new TowerToolError('reload-unavailable', 'this DSH profile has no HMR service; restart DSH instead')
        }
        const outcome = bridge.schedule()
        return {
          ok: true,
          ...outcome,
          ...(outcome.lastError ? { error: outcome.lastError } : {}),
          restartHint: 'If the new code does not appear, restart DSH or check the profile hmr entry.',
        }
      },
    })
  }
}

export const __testSpawnBackoff = {
  spawnBackoffState,
  recordSpawnThrottle,
  recordSpawnSuccess,
  spawnBackoffView,
}
