// Tower tool runtime and registration primitive (#56 P5, W5-A).
//
// This module owns the composition state, the default-deps Tower factory, the
// authorization kernel adapters, spawn throttling, the repository watcher and
// the `define()` registration primitive. The registration aggregators live in
// `tool-capabilities.js`, the cross-cutting observers in `tool-observers.js`,
// and `tool-registry.js` re-exports the stable public names.
import { Tower } from '../app/tower.js'
import { TowerToolError, classifyError } from '../domain/errors.js'
import { DEFAULT_SPAWN_PREFLIGHT_TIMEOUT_MS } from '../domain/config/schema.js'
import { exposureWhen, resetExposureMemo } from './exposure.js'
import {
  allowsAnonymous,
  openForAuthorization,
  anonymousActor,
  authorize,
  resolveActor,
} from './authorization.js'
import { isTowerRole } from '../domain/vocabulary.js'
import { resolveToolRepoRoot } from './tool-repo.js'
import { isRepositoryOptionalTool, roleAllowsTool, roleDenialHint } from './tool-profiles.js'
import { git, resolveRepo, hasAnyCommit } from '../adapters/git.js'
import { createDefaultDeps } from '../adapters/default.js'
import path from 'node:path'
import { fs, fsp } from '../adapters/store-fs.js'

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
  // for the directly registered tower_mode tool, and the host
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
 * `tower_mode`; and `registerCoreTowerTools` records the declared capability
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

// #230: an undeclared top-level input key is refused, never silently dropped.
// 2.9.7 sent `task_add` to tower_plan, lost every task and still returned
// `ok: true`; this is the seam where that becomes an `invalid-argument` call.
//
// The tool's own TypeBox schema is the source of truth, so a key a newer plugin
// declares passes on that build while a key this build does not declare fails.
// Only top-level keys are considered: nested values remain the handler's
// contract, and declared values are not re-validated here (refusing an
// undeclared key must not change any declared-key call).
//
// A key is legitimate in exactly three cases:
// - the schema declares it (`parameters.properties`);
// - it is an alias name from the definition's `aliases` map, which
//   normalizeToolArgs has already mirrored onto the canonical key;
// - it is `repoRoot`, which host/tool-repo.js keeps accepting from headless
//   callers on purpose (#163 Phase 1).
const RESOLVED_REPO_ROOT = 'repoRoot'

/**
 * The top-level argument names one tool accepts: its declared properties, its
 * alias names (canonical and legacy), and `repoRoot`.
 *
 * @param {any} parameters the tool's own JSON-Schema input contract
 * @param {Record<string, readonly string[]>} [aliases]
 * @returns {Set<string>}
 */
export function declaredToolArgKeys(parameters, aliases = {}) {
  const keys = new Set([RESOLVED_REPO_ROOT])
  const properties = parameters && typeof parameters === 'object' ? parameters.properties : null
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const key of Object.keys(properties)) keys.add(key)
  }
  for (const [canonical, names] of Object.entries(aliases ?? {})) {
    keys.add(canonical)
    if (Array.isArray(names)) for (const name of names) keys.add(name)
  }
  return keys
}

/**
 * The caller-supplied top-level keys this tool's closed schema does not declare.
 * An open schema (`additionalProperties` absent or true) keeps accepting extra
 * keys by contract, so nothing is refused there.
 *
 * @param {any} parameters
 * @param {any} args
 * @param {Record<string, readonly string[]>} [aliases]
 * @returns {string[]}
 */
export function undeclaredToolArgKeys(parameters, args, aliases = {}) {
  if (!parameters || typeof parameters !== 'object' || parameters.additionalProperties !== false) return []
  if (!args || typeof args !== 'object' || Array.isArray(args)) return []
  const declared = declaredToolArgKeys(parameters, aliases)
  return Object.keys(args).filter((key) => !declared.has(key)).sort()
}

let cachedPluginVersion
/** The shipped plugin version, cached after the first read. Read through the
 * store adapter because host/ modules may not import `node:fs` (fs-surface). */
function shippedPluginVersion() {
  if (cachedPluginVersion === undefined) {
    try {
      const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      cachedPluginVersion = typeof manifest.version === 'string' && manifest.version.trim() ? manifest.version.trim() : null
    } catch {
      cachedPluginVersion = null
    }
  }
  return cachedPluginVersion
}

/** Refuse one call whose top-level arguments name keys the tool does not
 * declare, so it can never reach the handler and return `ok: true` (#230). */
function refuseUndeclaredToolArgs(name, parameters, args, aliases) {
  const undeclared = undeclaredToolArgKeys(parameters, args, aliases)
  if (undeclared.length === 0) return
  const version = shippedPluginVersion() ?? 'unknown'
  const keys = undeclared.map((key) => `"${key}"`).join(', ')
  const noun = undeclared.length === 1 ? 'key' : 'keys'
  const pronoun = undeclared.length === 1 ? 'it' : 'them'
  const declared = Object.keys(parameters?.properties ?? {}).sort().join(', ') || '(none)'
  const aliasNames = [...new Set(Object.values(aliases ?? {}).flatMap((names) => (Array.isArray(names) ? names : [])))].sort().join(', ') || '(none)'
  throw new TowerToolError(
    'invalid-argument',
    `${name} does not declare the top-level input ${noun} ${keys} (dsh-tower ${version}); the call is refused instead of dropping ${pronoun}. Declared keys: ${declared}. Alias keys: ${aliasNames}. repoRoot is also accepted.`,
    { nextAction: `pass only the keys ${name} declares in dsh-tower ${version}; a key a newer build declares needs that build` },
  )
}

// The authorization kernel (host/authorization.js) is the single source of
// truth for who may call which tool. `actorFor` stays as the internal name the
// tool registrars already receive; it resolves through the kernel.
export const actorFor = resolveActor

/** Authorize one call: tower_init bootstraps; a repository-optional tool without
 * a repository takes the absent path (the tool identity, not whether the caller
 * happened to pass one, is the contract); public rows continue anonymously; the
 * config-diagnostic doctor row degrades an unresolvable config instead of
 * failing, and `degraded` says so. */
export async function authorizeCall(name, args, exec) {
  if (name === 'tower_init') {
    let tower = null
    try { tower = await openTower(args.repoRoot) } catch { tower = null }
    const actor = tower ? await resolveActor(tower, exec) : anonymousActor(exec)
    await authorize(name, actor, { args, tower })
    return { actor, degraded: false }
  }
  if (isRepositoryOptionalTool(name) && typeof args.repoRoot !== 'string') {
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

// #230: `tower_mode` is the one tool registered directly by the Host entry
// (index.js), so its definition never flows through `define()`. The same closed
// schema is restated here, in one place, so the dispatch seam can refuse an
// undeclared key for it without changing index.js (out of this mission's scope)
// and without a process-global capture of the tools service.
//
// This list is pinned against the real registration by
// tests/tool-schemas.test.mjs ('the session-tool seam restates the live
// registration'): a key added to index.js and not here, or the reverse, fails
// that test instead of drifting silently.
export const SESSION_TOOL_ARG_KEYS = Object.freeze(['active', 'authorization', 'reason'])

/**
 * The input contract one directly registered session tool is dispatched under.
 * Only `tower_mode` exists today; any other name yields null, so the seam keeps
 * the pre-#230 behavior for a definition this build cannot see.
 *
 * @param {string} name
 * @returns {any}
 */
function sessionToolParameters(name) {
  if (name !== 'tower_mode') return null
  return Object.freeze({
    type: 'object',
    properties: Object.freeze(Object.fromEntries(SESSION_TOOL_ARG_KEYS.map((key) => [key, Object.freeze({})]))),
    additionalProperties: false,
  })
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
  // #230: the session tool is registered directly by the Host entry, so it never
  // passes through define()'s seam. Its call does reach this step, and the
  // pipeline hands the body the frozen execution object that carries the caller
  // arguments, so the same schema-derived refusal runs here before authorization.
  refuseUndeclaredToolArgs(name, sessionToolParameters(name), exec?.arguments)
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

/**
 * Serialize spawn decisions per repository so precheck + activation + record are atomic.
 *
 * #237: the serialization used to be unbounded. A pre-flight that never settled
 * (a host that never answers `listDescendants`, a preset list that never
 * returns) kept the queue tail pending forever, so every later spawn waited
 * forever with no depth counter and no wait bound — the tool call simply never
 * returned and nothing recorded why. The queue is now metered: each entry knows
 * how long it has waited and the depth it found, and a spawn that waited longer
 * than `spawn.preflightTimeoutMs` is refused with `spawn-unavailable`
 * `details {phase: 'queue', waitedMs, depth}` instead of running late.
 *
 * The bound is armed only for a spawn that actually has to wait: a spawn that
 * gets the slot immediately is bounded by its own pre-flight deadline, not by a
 * queue timer that would blame the queue for its own duration.
 *
 * @param {string} key
 * @param {() => Promise<any>} operation
 * @param {{
 *   timeoutMs?: number | undefined,
 *   onQueue?: ((wait: { waitedMs: number, depth: number }) => void) | undefined,
 *   onWait?: ((wait: { depth: number, queuedAt: number }) => void) | undefined,
 * }} [options]
 */
export function enqueueSpawn(key, operation, options = {}) {
  const id = String(key)
  const entry = spawnQueueEntry(id)
  const limit = Number(options.timeoutMs)
  const budgetMs = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_SPAWN_PREFLIGHT_TIMEOUT_MS
  const queuedAt = Date.now()
  // Read and bump synchronously: every caller in this tick sees the ones before
  // it, which is what makes `depth` and the serialization honest.
  const ahead = entry.active
  entry.active += 1
  const depth = ahead + 1
  const wait = { queuedAt, abandoned: false }
  if (ahead > 0) entry.waiters.push(wait)
  // #237: the caller learns it is queued the moment the decision is made, not
  // when the wait ends. A spawn that later loses its own deadline must be able
  // to report `phase: 'queue'` with the wait it burned, and a caller watching
  // the repository learns a second spawn is behind the first.
  if (ahead > 0) options.onWait?.({ depth, queuedAt })
  /** @type {Promise<never>} */
  let deadline = /** @type {any} */ (new Promise(() => {}))
  let timer
  if (ahead > 0) {
    deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        // The caller's bound expires while it is still waiting: refuse it now.
        // Waiting for the slot to free would be the very unbounded behavior this
        // guards, and the pre-flight it would then run describes a state the
        // caller has already given up on.
        if (wait.abandoned) return
        wait.abandoned = true
        // The caller is gone: it neither waits nor holds a chain slot any more,
        // so the snapshot must stop counting it (the blocker stays visible).
        const index = entry.waiters.indexOf(wait)
        if (index >= 0) entry.waiters.splice(index, 1)
        entry.active -= 1
        const waitedMs = Math.max(0, Date.now() - wait.queuedAt)
        options.onQueue?.({ waitedMs, depth })
        reject(
          new TowerToolError(
            'spawn-unavailable',
            `tower_spawn stayed queued for ${waitedMs}ms behind ${depth - 1} other spawn(s) (spawn.preflightTimeoutMs ${budgetMs}ms); its pre-flight never ran, so nothing was written and a retry needs no cleanup`,
            { details: { phase: 'queue', waitedMs, depth } },
          ),
        )
      }, budgetMs)
    })
    // The chain still has to move for the spawns behind a refused caller, so
    // the abandoned turn resolves immediately when it is reached.
    deadline.catch(() => {})
  }
  const previous = entry.tail
  const turn = previous.catch(() => {}).then(async () => {
    // A caller that already failed must not run its pre-flight late; the chain
    // still has to move for the spawns behind it.
    if (wait.abandoned) return undefined
    const index = entry.waiters.indexOf(wait)
    if (index >= 0) entry.waiters.splice(index, 1)
    // #237: the queue reports the wait it actually cost, once, so the caller can
    // write one activity line instead of polling the queue for progress.
    if (index >= 0) options.onQueue?.({ waitedMs: Math.max(0, Date.now() - wait.queuedAt), depth })
    return await operation()
  })
  const settled = turn.catch(() => {})
  entry.tail = settled
  settled.finally(() => {
    clearTimeout(timer)
    // A refused waiter already left the count when its deadline fired.
    if (!wait.abandoned) entry.active -= 1
    const leftover = entry.waiters.indexOf(wait)
    if (leftover >= 0) entry.waiters.splice(leftover, 1)
    if (entry.tail === settled && entry.waiters.length === 0 && entry.active <= 0) SPAWN_QUEUES.delete(id)
  })
  return ahead > 0 ? Promise.race([turn, deadline]) : turn
}

/** @param {string} key */
function spawnQueueEntry(key) {
  let entry = SPAWN_QUEUES.get(key)
  if (!entry) {
    entry = { tail: Promise.resolve(), active: 0, waiters: [] }
    SPAWN_QUEUES.set(key, entry)
  }
  return entry
}

/**
 * Read-only snapshot of the spawn queue for one repository (#237): how many
 * spawns hold or wait for the slot and how long the oldest waiter has waited.
 * `oldestWaitMs` is 0 when nothing is waiting — a running spawn is not a wait.
 * @param {string} key
 * @returns {{ depth: number, oldestWaitMs: number }}
 */
export function spawnQueueView(key) {
  const entry = SPAWN_QUEUES.get(String(key))
  if (!entry) return { depth: 0, oldestWaitMs: 0 }
  const oldest = entry.waiters.length > 0 ? entry.waiters[0].queuedAt : 0
  return {
    depth: entry.active,
    oldestWaitMs: oldest > 0 ? Math.max(0, Date.now() - oldest) : 0,
  }
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
 * Step admission for a role-owned tool (#163 Phase 5). The tool stays in the
 * build surface so the all-on profile and the baseline can count it, but a
 * normal tower session does not advertise it: DSH resolves the registration's
 * `when` against the calling agent, whose preset id names the role.
 *
 * @param {string} name
 * @param {readonly string[] | undefined} roles
 * @returns {{ when: (context: { agent?: any }) => boolean } | undefined}
 */
function roleToolRegistration(name, roles) {
  if (!Array.isArray(roles) || roles.length === 0) return undefined
  return { when: (context) => roleAllowsTool(context?.agent, name) }
}

/**
 * Combine the two step-time conditions one registration can carry (#164):
 * the exposure ladder (an async predicate once the host entry installs the
 * gate) and the role contract (#163, synchronous). An absent exposure gate
 * leaves the role-only condition untouched — that keeps the compatibility
 * floor for tests/embedders and keeps `role-contracts.test.mjs` synchronous.
 *
 * @param {string} name
 * @param {readonly string[] | undefined} roles
 * @returns {{ when: (context: { agent?: any }) => boolean | Promise<boolean> } | undefined}
 */
function admissionFor(name, roles) {
  const roleGate = roleToolRegistration(name, roles)
  const exposure = exposureWhen(name)
  if (!exposure) return roleGate
  if (!roleGate) return { when: exposure }
  return {
    when: async (context) => {
      // Both gates must admit: exposure only subtracts, the role contract
      // stays the authority. Short-circuit the synchronous rejection first.
      if (!roleGate.when(context)) return false
      return exposure(context)
    },
  }
}

/**
 * Register one tool. The TypeBox schema is the single source of truth for the
 * runtime JSON Schema and the handler's argument type. The runtime injects the
 * resolved `repoRoot` after normalization (#163), so the handler type carries it
 * even though no schema advertises it.
 *
 * @template {import('@sinclair/typebox').TSchema} S
 * @param {any} ctx
 * @param {{
 *   name: string,
 *   description: string,
 *   parameters: S,
 *   execute: (args: import('@sinclair/typebox').Static<S> & { repoRoot?: string }, exec: any, actor?: any) => Promise<unknown>,
 *   aliases?: any,
 *   requiresMissionId?: any,
 *   validateArgs?: (args: any) => void,
 *   roles?: readonly string[],
 *   allowTowerExecution?: boolean,
 *   board?: any,
 *   output?: any,
 * }} definition
 */
export function define(ctx, definition) {
  const { aliases, requiresMissionId, validateArgs, board, roles, allowTowerExecution, execute, ...rest } = definition
  // Record the definition for the concept budget. The capability that owns the
  // tool decides whether it is registered at all (#121): the component row is
  // the switch, so `define()` no longer consults a `tools.expose*` boolean.
  recordToolRegistration(rest.name)
  // #164: when the host entry installed the exposure gate, every registration
  // carries the step-time condition, composed with the #163 role contract. The
  // set that built request N is the set that validates calls in N (the host
  // resolves `when` once per model step); a hidden tool resolves as
  // UNKNOWN_TOOL. No gate installed (tests, embedders) keeps the
  // unconditional registration.
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
        // #163 Phase 3: a dispatcher can require arguments that depend on the
        // selected operation; validating them before authorization keeps a
        // malformed call `invalid-argument` rather than a role denial.
        if (typeof validateArgs === 'function') validateArgs(normalized)
        // #230: refuse an undeclared top-level key before the repository is
        // resolved or anything is authorized, so the handler can never receive a
        // call whose arguments were silently trimmed. validateArgs runs first: a
        // tool's own migration message (e.g. tower_spawn's retired keys) is more
        // specific than the generic refusal.
        refuseUndeclaredToolArgs(rest.name, rest.parameters, normalized, aliases)
        try {
          let value
          try {
            // #163: resolve the repository here, once, before authorization, so the
            // kernel, the workspace lock, the handler and the board all share one
            // value and no tool schema has to advertise `repoRoot` again.
            const repoRoot = await resolveToolRepoRoot(rest.name, normalized, exec)
            if (typeof repoRoot === 'string') normalized.repoRoot = repoRoot
            else delete normalized.repoRoot
            // Default-deny authorization runs before any side effect: a denied
            // call must not take the workspace lock, write state, or spawn.
            const { actor, degraded } = await authorizeCall(rest.name, normalized, exec)
            // #163 Phase 5: a role-owned tool reached from the wrong profile gets
            // the replacement path, not a bare unknown-tool or access denial.
            if (Array.isArray(roles) && !roles.includes(actor?.role) && !(allowTowerExecution === true && isTowerRole(actor?.role))) {
              throw new TowerToolError('not-authorized', roleDenialHint(rest.name, actor?.role))
            }
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
        } finally {
          // #164: the phase facts are memoized per agent until the next tower
          // tool call; tower_init/tower_teardown are the state-existence
          // transitions and both run through here.
          resetExposureMemo()
        }
      },
    }, admissionFor(rest.name, roles) ?? {}),
  )
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
  spawnQueueView,
}
