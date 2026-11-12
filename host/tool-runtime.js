// Tower tool runtime and registration primitive (#56 P5, W5-A).
//
// This module owns the composition state, the default-deps Tower factory, the
// authorization kernel adapters, spawn throttling, the repository watcher and
// the `define()` registration primitive. The registration aggregators live in
// `tool-capabilities.js`, the cross-cutting observers in `tool-observers.js`,
// and `tool-registry.js` re-exports the stable public names.
import { Tower } from '../app/tower.js'
import { TowerToolError, classifyError } from '../domain/errors.js'
import { exposureWhen, resetExposureMemo } from './exposure.js'
import {
  allowsAnonymous,
  openForAuthorization,
  anonymousActor,
  authorize,
  isRepositoryOptional,
  resolveActor,
} from './authorization.js'
import { git, resolveRepo, hasAnyCommit } from '../adapters/git.js'
import { createDefaultDeps } from '../adapters/default.js'
import path from 'node:path'
import { fsp } from '../adapters/store-fs.js'

// Mutable composition state is grouped in one const object: the registration
// aggregator is the composition root, not an ambient module-level binding.
/**
 * The workspace-lock hook the Host entry injects (`index.js`). Optional
 * members are only present when the entry supplies them, so the registry and
 * the tools that receive it declare the same shape.
 * @typedef {object} WorkspaceHook
 * @property {(repoRoot: string, exec: any, toolName: string) => Promise<void>} ensure
 * @property {(exec: any) => string | null} [basePreference]
 * @property {(exec: any) => Record<string, any> | null} [modeInfo]
 * @property {(entry: any, key: string) => Promise<Record<string, any>>} [status]
 */
/** @type {{ workspaceHook: WorkspaceHook | null, hmrBridge: ReturnType<typeof import('./hmr.js').createHmrBridge> | null, deps: Record<string, any> | null, definedTools: Set<string> }} */
export const runtimeState = {
  workspaceHook: null,
  hmrBridge: null,
  // #69: the host entry builds the adapter set once and passes it in. The lazy
  // fallback is for tests/embedders that call registerTowerTools() directly;
  // it is still built once per process.
  deps: null,
  // #84/#118/#121: registered tool names are recorded before any component row
  // decides whether its capability mounts, so the concept budget measures the
  // full build surface (29 tools) rather than one profile's mounted subset (28
  // with the shipped `tower-hmr` row off). `recordToolRegistration` is the one
  // recorder: define() calls it for every definition, the Host entry calls it
  // for the directly registered tower_mode/tower_control pair, and the host
  // records the declared capability tools (COMPONENT_TOOLS) because those entry
  // points only run when their row is on. The number is reported by
  // tower_doctor and compared with the committed scripts/surface-baseline.json.
  definedTools: new Set(),
}

/**
 * Record one tool name in the concept-budget surface (#84, #118, #121).
 *
 * This is the single recorder for the *build* tool surface. `define()` calls it
 * for every definition when a capability is mounted; the Host entry (`index.js`)
 * calls it for the two tools it registers directly, `tower_mode` and
 * `tower_control`; and `registerCoreTowerTools` records the declared capability
 * tools up front so a row that ships off does not shrink the budget. One
 * recorder means the count cannot silently miss a registration path again: #118
 * found 27 of the 29 names because only the `define()` path was recorded.
 */
export function recordToolRegistration(name) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new TypeError('recordToolRegistration requires a non-empty tool name')
  }
  runtimeState.definedTools.add(name.trim())
}

/**
 * The full shipped tool surface (names, sorted). It covers every tool this build
 * can register, including capabilities whose component row is currently off.
 */
export function definedToolNames() {
  return [...runtimeState.definedTools].sort()
}

/** The number of tools this build ships, used by the concept budget (#84). */
export function definedToolCount() {
  return runtimeState.definedTools.size
}

/** Test hook: the recorded set is process state and must be reset per fixture. */
export function __testResetToolSurface() {
  runtimeState.definedTools.clear()
}

/** The injected port set for the app layer (built once per process). */
export function towerDeps() {
  if (!runtimeState.deps) runtimeState.deps = createDefaultDeps()
  return runtimeState.deps
}

/** Compose the app Tower with the injected ports (never a bare adapter import). */
export function openTower(repoRoot) {
  return Tower.open(repoRoot, towerDeps())
}

/** Build a Tower with an explicit config for the read-only doctor path. */
export function createTower(repo, config) {
  return new Tower(repo, config, towerDeps())
}

export function normalizeToolArgs(args, aliases = {}) {
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

// The authorization kernel (host/authorization.js) is the single source of
// truth for who may call which tool. `actorFor` stays as the internal name the
// tool registrars already receive; it resolves through the kernel.
export const actorFor = resolveActor

/** Authorize one call: tower_init bootstraps; a repoRoot-less optional row takes
 * the absent path; public rows continue anonymously; the config-diagnostic doctor
 * row degrades an unresolvable config instead of failing, and `degraded` says so. */
export async function authorizeCall(name, args, exec) {
  if (name === 'tower_init') {
    let tower = null
    try { tower = await openTower(args.repoRoot) } catch { tower = null }
    const actor = tower ? await resolveActor(tower, exec) : anonymousActor(exec)
    await authorize(name, actor, { args, tower })
    return { actor, degraded: false }
  }
  if (isRepositoryOptional(name) && typeof args.repoRoot !== 'string') {
    const actor = anonymousActor(exec)
    await authorize(name, actor, { args, tower: null, repositoryAbsent: true })
    return { actor, degraded: false }
  }
  const tower = await openForAuthorization(name, args.repoRoot, openTower)
  let actor
  try {
    actor = tower ? await resolveActor(tower, exec) : anonymousActor(exec)
  } catch (error) {
    if (!allowsAnonymous(name)) throw error
    actor = anonymousActor(exec)
  }
  await authorize(name, actor, { args, tower })
  return { actor, degraded: tower === null }
}

/**
 * Authorize a directly registered session tool through the matrix. Repository
 * resolution is best-effort (a broken repo falls back to the anonymous actor and
 * the public session rows decide); `authorize` is outside the fallback so a
 * denial is never retried.
 *
 * @param {string} name @param {any} exec @param {string | null | undefined} repoRoot
 */
export async function authorizeSessionCall(name, exec, repoRoot) {
  /** @type {any} */ let tower = null
  let actor
  try {
    if (typeof repoRoot === 'string' && repoRoot.trim()) tower = await openTower(repoRoot)
    actor = tower ? await resolveActor(tower, exec) : anonymousActor(exec)
  } catch {
    tower = null; actor = anonymousActor(exec)
  }
  await authorize(name, actor, { args: {}, tower })
  return actor
}

const SEND_RATE = new Map()
const SPAWN_QUEUES = new Map()
const SPAWN_BACKOFF = new Map()

export function spawnBackoffState(repoRoot, maxLiveWorkers) {
  const key = String(repoRoot)
  let state = SPAWN_BACKOFF.get(key)
  if (!state) {
    state = { failures: 0, blockedUntil: 0, budget: Math.max(1, Number(maxLiveWorkers) || 4) }
    SPAWN_BACKOFF.set(key, state)
  }
  if (state.failures === 0) state.budget = Math.max(1, Number(maxLiveWorkers) || 4)
  return state
}

export function recordSpawnThrottle(repoRoot, maxLiveWorkers) {
  const state = spawnBackoffState(repoRoot, maxLiveWorkers)
  state.failures += 1
  state.budget = Math.max(1, (Number(maxLiveWorkers) || 4) - 1)
  if (state.failures >= 3) {
    const delay = Math.min(60000, 5000 * 2 ** Math.min(4, state.failures - 3))
    state.blockedUntil = Date.now() + delay
  }
  return state
}

export function recordSpawnSuccess(repoRoot, maxLiveWorkers) {
  const state = spawnBackoffState(repoRoot, maxLiveWorkers)
  state.failures = 0
  state.blockedUntil = 0
  state.budget = Math.max(1, Number(maxLiveWorkers) || 4)
  return state
}

export function spawnBackoffView(repoRoot, maxLiveWorkers, inflight) {
  const state = spawnBackoffState(repoRoot, maxLiveWorkers)
  return {
    inflight,
    budget: Math.min(state.budget, Math.max(1, Number(maxLiveWorkers) || 4)),
    blockedUntil: state.blockedUntil > Date.now() ? state.blockedUntil : 0,
  }
}
const WATCHED_REPOS = new Set()
export function watchRepo(repoRoot) {
  WATCHED_REPOS.add(repoRoot)
  if (WATCHED_REPOS.size > 100) {
    const oldest = WATCHED_REPOS.values().next().value
    WATCHED_REPOS.delete(oldest)
  }
}

/** The repositories the roster watchdog re-checks (read by the capability layer). */
export function watchedRepos() {
  return WATCHED_REPOS
}

/** Serialize spawn decisions per repository so precheck + activation + record are atomic. */
export function enqueueSpawn(key, operation) {
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
export function checkSendRate(config, repoRoot) {
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

// #138: exported so `scripts/check-components.mjs` can import the route table
// instead of scraping this file. The table is empty since #122; an empty Map is
// the determined state, while a missing export or a failed import is a gate
// failure.
export const OPERATIONAL_TOOLS = new Map()

export function plainSchema(value) {
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
 *   execute: (args: import('@sinclair/typebox').Static<S>, exec: any, actor?: any) => Promise<unknown>,
 *   aliases?: any,
 *   requiresMissionId?: any,
 *   board?: any,
 *   output?: any,
 * }} definition
 */
export function define(ctx, definition) {
  const { aliases, requiresMissionId, board, execute, ...rest } = definition
  // Record the definition for the concept budget. The capability that owns the
  // tool decides whether it is registered at all (#121): the component row is
  // the switch, so `define()` no longer consults a `tools.expose*` boolean.
  recordToolRegistration(rest.name)
  // #164: when the host entry installed the exposure gate, every registration
  // carries the step-time condition. The set that built request N is the set
  // that validates calls in N (the host resolves `when` once per model step);
  // a hidden tool resolves as UNKNOWN_TOOL. No gate installed (tests,
  // embedders) keeps the unconditional registration.
  const when = exposureWhen(rest.name)
  ctx.effect(() =>
    ctx.tools.register(
      {
        ...rest,
        parameters: plainSchema(rest.parameters),
        async execute(args, exec) {
          try {
            return await executeTowerCall(rest, { aliases, requiresMissionId, board }, execute, args, exec, ctx)
          } finally {
            // The phase facts are memoized per agent until the next tower
            // tool call: tower_init/tower_teardown are the state-existence
            // transitions, and both run through here.
            resetExposureMemo()
          }
        },
      },
      when ? { when } : {},
    ),
  )
}

/** The shared `define()` execution wrapper: aliases, authorization, effects.
 * `aliases`, `requiresMissionId` and `board` are destructured *out* of the
 * definition by `define()`, so they arrive as the second argument — `rest`
 * never carries them. */
async function executeTowerCall(rest, { aliases, requiresMissionId, board }, execute, args, exec, ctx) {
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
    // Default-deny authorization runs before any side effect: a denied
    // call must not take the workspace lock, write state, or spawn.
    const { actor, degraded } = await authorizeCall(rest.name, normalized, exec)
    if (!degraded && runtimeState.workspaceHook && typeof normalized.repoRoot === 'string' && rest.name !== 'tower_init') { // F48: only a degraded config-diagnostic open skips the lock
      await runtimeState.workspaceHook.ensure(normalized.repoRoot, exec, rest.name)
    }
    value = await execute(normalized, exec, actor)
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
}

export function textOf(blocks) {
  if (!Array.isArray(blocks)) return null
  return blocks
    .map((block) => (block && block.type === 'text' ? block.text : `[${block && block.type}]`))
    .join('\n')
}

/** autoGitInit support: Tower.open needs a repository, so prepare it first.
 * Only absolute, existing directories are eligible; a typo must not git-init the
 * DSH process cwd or create a repository at an unintended path. */
export async function ensureRepository(repoRootInput, autoGitInit) {
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

export const __testSpawnBackoff = {
  spawnBackoffState,
  recordSpawnThrottle,
  recordSpawnSuccess,
  spawnBackoffView,
}
