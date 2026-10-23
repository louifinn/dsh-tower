// Tower tool registration and shared machinery (#56 P5).
//
// Per-tool handlers live in tools/*.js; this module owns the registration
// aggregator, actor guards, spawn throttling, repository preparation, and the
// best-effort roster watchdog. tools/index.js stays a thin public wiring module.
import { Tower } from '../app/tower.js'
import { TowerToolError, classifyError } from '../domain/errors.js'
import {
  PARENT_STATUS_OK,
  ROLE,
  ROSTER_ACTIVITY,
  ROSTER_INACTIVE_STATES,
  isRunningActivity,
  isTowerRole,
  isUnknownRole,
} from '../domain/vocabulary.js'
import { git, resolveRepo, hasAnyCommit } from '../adapters/git.js'
import { runtimeConfig } from './config.js'
import { runDoctor } from './doctor.js'
import { createHmrBridge } from './hmr.js'
import { assertPresetsAvailable } from './presets.js'
import { readStateLock } from '../adapters/store.js'
import { lockTiming } from '../adapters/persistence.js'
import { acquireLease, releaseLease, inspectLeases } from '../adapters/leases.js'
import { importLegacySnapshot, validateLegacyMap } from '../adapters/legacy.js'
import { registerDoctorTool } from '../tools/doctor.js'
import { registerRecoverTool } from '../tools/recover.js'
import { registerTestTool } from '../tools/test.js'
import { registerBatchTool } from '../tools/batch.js'
import { registerResourceTool } from '../tools/resource.js'
import { registerImportLegacyTool } from '../tools/import-legacy.js'
import { registerLegacyMapTool } from '../tools/legacy-map.js'
import { registerReloadTool } from '../tools/reload.js'
import { registerInitTool } from '../tools/init.js'
import { registerPlanTool } from '../tools/plan.js'
import { registerMissionTool } from '../tools/mission.js'
import { registerStatusTool } from '../tools/status.js'
import { registerRosterTool } from '../tools/roster.js'
import { registerInterruptTool } from '../tools/interrupt.js'
import { registerDiffTool } from '../tools/diff.js'
import { registerAdoptTool } from '../tools/adopt.js'
import { registerSendTool } from '../tools/send.js'
import { registerInboxTool } from '../tools/inbox.js'
import { registerReviewTool } from '../tools/review.js'
import { registerPreflightTool } from '../tools/preflight.js'
import { registerMergeTool } from '../tools/merge.js'
import { registerRebaseTool } from '../tools/rebase.js'
import { registerTeardownTool } from '../tools/teardown.js'
import { registerSpawnTool } from '../tools/spawn.js'
import { registerCompleteTool } from '../tools/complete.js'
import { registerFindingTool } from '../tools/finding.js'
import { registerFindingsTool } from '../tools/findings.js'
import { readDiscoveryConfig, normalizeDiscovery, runDiscovery } from '../adapters/tests.js'
import { summarize as summarizeBatch } from '../domain/batch.js'
import { assertPorts } from '../ports/index.js'
import path from 'node:path'
import { fsp } from '../adapters/store-fs.js'
import { createDefaultDeps } from '../adapters/default.js'
import crypto from 'node:crypto'

// Mutable composition state is grouped in one const object: the registration
// aggregator is the composition root, not an ambient module-level binding.
const runtimeState = {
  workspaceHook: null,
  hmrBridge: null,
  // #69: the host entry builds the adapter set once and passes it in. The lazy
  // fallback is for tests/embedders that call registerTowerTools() directly;
  // it is still built once per process.
  deps: null,
}

/** The injected port set for the app layer (built once per process). */
function towerDeps() {
  if (!runtimeState.deps) runtimeState.deps = createDefaultDeps()
  return runtimeState.deps
}

/** Compose the app Tower with the injected ports (never a bare adapter import). */
function openTower(repoRoot) {
  return Tower.open(repoRoot, towerDeps())
}

/** Build a Tower with an explicit config for the read-only doctor path. */
function createTower(repo, config) {
  return new Tower(repo, config, towerDeps())
}

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
  const unknown = { name: ROLE.unknown, role: ROLE.unknown, agentId, ownerMissing: false }
  if (!agentId) return unknown
  let state
  try {
    state = await tower.load()
  } catch (error) {
    if (error?.code !== 'not-initialized') throw error
    // No readable state: only tower_init may claim ownership (handled in that tool).
    return unknown
  }
  if (!state.towerAgentId) unknown.ownerMissing = true
  if (state.towerAgentId && String(state.towerAgentId) === agentId) {
    return { name: ROLE.tower, role: ROLE.tower, agentId }
  }
  let view
  try {
    view = await tower.rosterView()
  } catch {
    return unknown
  }
  const self = view.roster.find((entry) => entry.agentId === agentId)
  if (!self) return unknown
  if (isTowerRole(self.role)) return { name: self.name, role: ROLE.tower, agentId }
  return { name: self.name, role: self.role, agentId }
}

function requireKnownActor(actor, action) {
  if (!actor || isUnknownRole(actor.role)) {
    throw new TowerToolError('not-authorized', `${action} requires a registered roster agent or the tower${actor?.ownerMissing ? '; repository state has no towerAgentId — run tower_init to re-claim' : ''}`)
  }
}

function requireTowerActor(actor, action) {
  if (!isTowerRole(actor.role)) {
    throw new TowerToolError('not-authorized', `only the tower can ${action}; ${actor.name} is a ${actor.role}${actor.ownerMissing ? '; repository state has no towerAgentId — run tower_init to re-claim' : ''}`)
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
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new TowerToolError('invalid-argument', 'path escapes the repository')
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
  const previousActivity = activity[entry.agentId] ?? ROSTER_ACTIVITY.unknown
  if (!isRunningActivity(previousActivity)) {
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

const OPERATIONAL_TOOLS = new Map([
  ['tower_batch', 'exposeBatch'],
  ['tower_resource', 'exposeLeases'],
  ['tower_import_legacy', 'exposeImport'],
  ['tower_legacy_map', 'exposeImport'],
  ['tower_recover', 'exposeRecovery'],
  ['tower_test', 'exposeTests'],
  ['tower_doctor', 'exposeDoctor'],
])

function plainSchema(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * Register one tool. The TypeBox schema is the single source of truth for the
 * runtime JSON Schema and the handler's argument type.
 *
 * @template {import('@sinclair/typebox').TSchema} S
 * @param {any} ctx
 * @param {{
 *   name: string,
 *   description: string,
 *   parameters: S,
 *   execute: (args: import('@sinclair/typebox').Static<S>, exec: any) => Promise<unknown>,
 *   aliases?: any,
 *   requiresMissionId?: any,
 *   board?: any,
 *   output?: any,
 * }} definition
 */
function define(ctx, definition) {
  const { aliases, requiresMissionId, board, execute, ...rest } = definition
  const toolsConfig = runtimeConfig().tools ?? {}
  const flag = OPERATIONAL_TOOLS.get(rest.name)
  if (flag && (toolsConfig.exposeOperational === false || toolsConfig[flag] === false)) return
  ctx.effect(() =>
    ctx.tools.register({
      ...rest,
      parameters: plainSchema(rest.parameters),
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
          if (runtimeState.workspaceHook && typeof normalized.repoRoot === 'string' && rest.name !== 'tower_init') {
            await runtimeState.workspaceHook.ensure(normalized.repoRoot, exec, rest.name)
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
            const opened = await openTower(normalized.repoRoot)
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
      for (const row of rows) activity[String(row.id)] = row.activity ?? ROSTER_ACTIVITY.unknown
      parentStatus[parent] = PARENT_STATUS_OK
    } catch (error) {
      parentStatus[parent] = `unavailable: ${String(error?.message ?? error)}`
    }
  }
  return { activity, parentStatus }
}

export function registerTowerTools(ctx, options = {}) {
  runtimeState.workspaceHook = options.workspace ?? null
  runtimeState.hmrBridge = options.hmrBridge ?? null
  // #69: the host entry (index.js) is the composition root. When it supplies the
  // port set, adopt it — validated once — instead of constructing a second set
  // here. Tests/embedders that omit deps fall back to one lazily built set.
  if (options.deps) runtimeState.deps = assertPorts(options.deps)
  // A lightweight roster watchdog: the authoritative activity comes from the
  // subagents catalog; a missing observation after spawn.staleMs is marked
  // stale (never silently treated as stopped) and blocks merge via the gate.
  const watchMs = Math.max(1000, Number(runtimeConfig().mode?.heartbeatMs) || 10000)
  const timer = setInterval(() => {
    void (async () => {
      try {
        if (!ctx.get('subagents')) return
        for (const repoRoot of [...WATCHED_REPOS]) {
          const tower = await openTower(repoRoot)
          const view = await tower.rosterView()
          const live = view.roster.filter((entry) => !ROSTER_INACTIVE_STATES.includes(entry.state))
          if (live.length === 0) { WATCHED_REPOS.delete(repoRoot); continue }
          const parents = [...new Set(live.map((entry) => entry.parentSessionId).filter(Boolean))]
          if (parents.length === 0) continue
          const { activity, parentStatus } = await observeActivity(ctx, tower)
          const authoritative = parents.every((parent) => parentStatus[parent] === PARENT_STATUS_OK)
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
  registerInitTool(ctx, { openTower, define, actorFor, requireTowerActor, workspaceHook: runtimeState.workspaceHook, ensureRepository, resolveRepo, runtimeConfig })

  registerPlanTool(ctx, { openTower, define, actorFor, requireTowerActor, assertPresetsAvailable })

  registerMissionTool(ctx, { openTower, define, actorFor, requireKnownActor })

  registerStatusTool(ctx, { openTower, define, workspaceHook: runtimeState.workspaceHook, spawnBackoffView, observeActivity })

  registerSpawnTool(ctx, { openTower, define, actorFor, requireTowerActor, enqueueSpawn, observeActivity, spawnBackoffState, spawnBackoffView, recordSpawnThrottle, recordSpawnSuccess, runMissionDiscovery, textOf, inspectLeases })

  registerRosterTool(ctx, { openTower, define, workspaceHook: runtimeState.workspaceHook, observeActivity, actorFor, requireTowerActor, interruptRosterAgent })

  registerInterruptTool(ctx, { openTower, define, actorFor, requireTowerActor, interruptRosterAgent })

  registerDiffTool(ctx, { openTower, define, actorFor, requireTowerActor })

  registerAdoptTool(ctx, { openTower, define, actorFor, requireTowerActor })

  registerSendTool(ctx, { openTower, define, actorFor, checkSendRate })

  registerInboxTool(ctx, { openTower, define })

  registerCompleteTool(ctx, { openTower, define, runMissionDiscovery })

  registerFindingTool(ctx, { openTower, define, actorFor, requireKnownActor })

  registerFindingsTool(ctx, { openTower, define, actorFor, requireKnownActor })

  registerReviewTool(ctx, { openTower, define, actorFor })

  registerPreflightTool(ctx, { openTower, define, observeActivity })

  registerMergeTool(ctx, { openTower, define, actorFor, requireTowerActor, observeActivity })

  registerRebaseTool(ctx, { openTower, define, actorFor, requireTowerActor, observeActivity })

  registerTeardownTool(ctx, { openTower, define, actorFor, requireTowerActor, observeActivity })

  registerDoctorTool(ctx, { openTower, define, createTower, resolveRepo, runtimeConfig, runDoctor })

  registerRecoverTool(ctx, { openTower, define, actorFor, requireTowerActor, readStateLock, lockTiming })

  registerTestTool(ctx, { openTower, define, actorFor, requireKnownActor, runMissionDiscovery })

  registerBatchTool(ctx, { openTower, define, actorFor, requireTowerActor, summarizeBatch, verifyBatchReceiptFiles })

  registerResourceTool(ctx, { openTower, define, actorFor, requireTowerActor, acquireLease, releaseLease, inspectLeases })

  registerImportLegacyTool(ctx, { openTower, define, actorFor, requireTowerActor, importLegacySnapshot })

  registerLegacyMapTool(ctx, { openTower, define, actorFor, requireTowerActor, validateLegacyMap })

  registerReloadTool(ctx, { openTower, define, actorFor, requireTowerActor, sharedHmrBridge: runtimeState.hmrBridge, runtimeConfig, createHmrBridge })
}

export const __testSpawnBackoff = {
  spawnBackoffState,
  recordSpawnThrottle,
  recordSpawnSuccess,
  spawnBackoffView,
}
