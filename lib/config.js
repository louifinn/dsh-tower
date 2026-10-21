// Tower configuration: one declared schema, resolved defaults, and the
// process-local effective snapshot consumed by the domain modules.
//
// Layers, lowest precedence first:
//   1. code defaults (the schemastery `.default(...)` values)
//   2. profile config (the Cordis patch passes it to `apply()`)
//   3. repository config: <git-common-dir>/dsh-tower/config.json
//   4. per-tool arguments (e.g. worktreeRoot, timeoutMs)
//
// Defaults are exactly the 1.2.0 behavior; the shipped cordis patch keeps
// `allowAgentControl: true` via the legacy top-level key.
import fsp from 'node:fs/promises'
import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { TowerToolError } from './errors.js'

export const DEFAULT_DENY_TOOLS = [
  'create_goal',
  'todo_write',
  'team_task_create',
  'team_task_update',
  'team_task_reopen',
  'team_task_list',
  'spawn_teammate',
  'wait_agent',
  'workflow',
  'ralph',
  'subagent',
  'subagent_fork',
]

const LEGACY_KEYS = ['section', 'allowAgentControl']
const GROUP_KEYS = ['init', 'mode', 'review', 'merge', 'git', 'worktrees', 'spawn', 'send', 'tests', 'gates', 'docs', 'leases', 'dev', 'tools']

const SECTION_KEYS = {
  init: ['autoGitInit', 'snapshotDirty', 'autoExclude'],
  mode: [
    'promptSection',
    'sectionAppend',
    'allowAgentControl',
    'autoPauseGoal',
    'requireResumeAuthorization',
    'requireHumanAckOnFirstEntry',
    'workspaceLock',
    'workspaceLockScope',
    'planModePolicy',
    'workspaceStaleMs',
    'heartbeatMs',
    'denyTools',
    'storePath',
    'maxEntries',
    'lockTimeoutMs',
  ],
  review: ['requireReview', 'maxRoundsPerReviewer'],
  merge: ['timeoutMs', 'maxBufferBytes'],
  git: ['timeoutMs'],
  worktrees: ['root'],
  spawn: [
    'workerPreset',
    'reviewerPreset',
    'maxDepth',
    'provider',
    'workerModel',
    'reviewerModel',
    'maxLiveWorkers',
    'staleMs',
    'maxWaitMs',
    'requireLease',
  ],
  send: ['maxPerMinute', 'interruptDefault'],
  tests: ['enabled', 'admission', 'timeoutMs', 'maxBytes', 'autoChecks', 'allowPackageDiscovery'],
  gates: ['requireChecks', 'requireTests', 'allowReviewExemption'],
  docs: ['board', 'boardLocation'],
  tools: ['exposeOperational', 'exposeBatch', 'exposeImport', 'exposeLeases', 'exposeTests', 'exposeRecovery', 'exposeDoctor'],
  leases: ['ttlMs'],
  dev: ['hotReload', 'reloadDelayMs', 'reloadRequiredIds'],
}

const MODEL_KEYS = ['provider', 'model', 'reasoningEffort', 'maxTokens']

const ModelSchema = () =>
  Schema.object({
    provider: Schema.string().description('Provider route override for this role.'),
    model: Schema.string().description('Model id override for this role.'),
    reasoningEffort: Schema.string().description('Optional reasoning effort override.'),
    maxTokens: Schema.natural().description('Optional output token cap.'),
  })

export const Config = Schema.object({
  section: Schema.string().description(
    'Legacy alias for mode.promptSection: replaces the whole Tower-mode system prompt text.',
  ),
  allowAgentControl: Schema.boolean().description(
    'Legacy alias for mode.allowAgentControl: register tower_control so the model may toggle the mode.',
  ),
  init: Schema.object({
    autoGitInit: Schema.boolean()
      .default(false)
      .description('tower_init may run git init and create an empty initial commit when the directory is not a repository.'),
    snapshotDirty: Schema.boolean()
      .default(false)
      .description('tower_init may snapshot uncommitted tracked changes into a dangling commit used as the mission baseline.'),
    autoExclude: Schema.boolean()
      .default(true)
      .description('Add in-repo Tower artifacts (MISSIONS.md, in-repo worktree roots) to .git/info/exclude so they do not look like user dirt.'),
  })
    .default({})
    .description('Repository initialization policy.'),
  mode: Schema.object({
    promptSection: Schema.string().description('Replacement Tower-mode system prompt text. Empty keeps the built-in reminder.'),
    sectionAppend: Schema.string().description('Extra text appended to the Tower-mode system prompt section (team conventions).'),
    allowAgentControl: Schema.boolean().description('Register tower_control so the model may enter/leave the mode with a reason.'),
    autoPauseGoal: Schema.boolean().default(true).description('Pause an active goal when entering Tower mode.'),
    requireResumeAuthorization: Schema.boolean()
      .default(false)
      .description('Require an authorization reference when resuming a mission paused with pauseCause=user.'),
    requireHumanAckOnFirstEntry: Schema.boolean()
      .default(false)
      .description('Require a human /tower ack before the model may enter Tower mode for the first time in a session.'),
    workspaceLock: Schema.boolean()
      .default(false)
      .description('Allow only one Tower session per repository (advisory <git-common-dir>/dsh-tower/tower.lock).'),
    workspaceLockScope: Schema.union(['all', 'mutations'])
      .default('all')
      .description('all = every repo-scoped tool acquires the workspace lock; mutations = only tools that write state/worktrees do.'),
    planModePolicy: Schema.union(['clear', 'refuse'])
      .default('clear')
      .description('On Tower entry: clear an active plan mode, or refuse to enter until the plan is exited.'),
    workspaceStaleMs: Schema.natural()
      .min(1000)
      .default(300000)
      .description('A workspace lock older than this is stale and can be taken over.'),
    heartbeatMs: Schema.natural().min(1000).default(10000).description('Workspace-lock heartbeat interval while Tower mode is on.'),
    denyTools: Schema.array(Schema.string())
      .default(DEFAULT_DENY_TOOLS)
      .description('Tools refused while Tower mode is active.'),
    storePath: Schema.string().description('Directory for modes.json; defaults to $DSH_HOME/tower-mode.'),
    maxEntries: Schema.natural().min(1).max(2000).default(200).description('Maximum persisted mode entries.'),
    lockTimeoutMs: Schema.natural().min(10).max(60000).default(5000).description('How long saveModes waits for the cross-process modes.lock before giving up.'),
  })
    .default({})
    .description('Tower-mode behavior and persistence.'),
  review: Schema.object({
    requireReview: Schema.boolean()
      .default(false)
      .description('Require an independent clean review before merge. Default false: review is optional; set true to enforce the review gate globally.'),
    maxRoundsPerReviewer: Schema.natural().min(1).default(5).description('Review-round cap per reviewer per mission branch.'),
  })
    .default({})
    .description('Review policy.'),
  merge: Schema.object({
    timeoutMs: Schema.natural().min(1000).default(900000).description('Default tower_merge timeout, including pre-merge hooks.'),
    maxBufferBytes: Schema.natural().min(65536).default(67108864).description('Captured merge output buffer.'),
  })
    .default({})
    .description('Merge execution policy.'),
  git: Schema.object({
    timeoutMs: Schema.natural().min(1000).default(15000).description('Default timeout for Git commands other than merge; merge uses merge.timeoutMs.'),
  })
    .default({})
    .description('Git subprocess policy.'),
  worktrees: Schema.object({
    root: Schema.string().description('Default parent directory for mission worktrees; empty derives <main-checkout-parent>/.dsh-tower-worktrees/<hash>.'),
  })
    .default({})
    .description('Worktree placement.'),
  spawn: Schema.object({
    workerPreset: Schema.string().default('tower-worker').description('Agent preset for worker missions.'),
    reviewerPreset: Schema.string().default('tower-reviewer').description('Agent preset for reviewers.'),
    maxDepth: Schema.natural().min(1).default(1).description('Subagent depth requested when spawning tower agents.'),
    provider: Schema.string().description('Subagent provider id; empty picks spawn, then the first registered provider.'),
    workerModel: ModelSchema().description('Model route for workers; omitted inherits the parent session.'),
    reviewerModel: ModelSchema().description('Model route for reviewers; omitted inherits the parent session (recommended).'),
    maxLiveWorkers: Schema.natural()
      .min(1)
      .max(64)
      .default(4)
      .description('Maximum live worker entries allowed per repository at once.'),
    staleMs: Schema.natural()
      .min(0)
      .default(15000)
      .description('Roster entries with no catalog activity after this age are marked stale and block merge (0 disables).'),
    maxWaitMs: Schema.natural()
      .min(1000)
      .max(600000)
      .default(90000)
      .description('Upper bound for tower_spawn waitMs (default 90s, Kimi-compatible).'),
    requireLease: Schema.string().description('Optional lease name tower_spawn must hold before starting a worker.'),
  })
    .default({})
    .description('Worker and reviewer presets plus model routing.'),
  send: Schema.object({
    maxPerMinute: Schema.natural()
      .min(0)
      .default(120)
      .description('Per-repository tower_send rate limit per minute (0 disables).'),
    interruptDefault: Schema.boolean()
      .default(false)
      .description('Default value of tower_send.interrupt when the caller omits it.'),
  })
    .default({})
    .description('Message delivery policy.'),
  tests: Schema.object({
    enabled: Schema.boolean().default(true).description('Run declared test discovery when a mission configures it.'),
    admission: Schema.union(['spawn', 'complete', 'off'])
      .default('off')
      .description('Run discovery before spawning a worker, when completing, or only on explicit tower_test (default off: repository code runs only on an explicit tower_test).'),
    timeoutMs: Schema.natural().min(1000).max(1800000).default(60000).description('Per discovery command timeout.'),
    maxBytes: Schema.natural().min(1024).max(16 * 1024 * 1024).default(16 * 1024 * 1024).description('Maximum captured stdout bytes per command.'),
    autoChecks: Schema.boolean().default(true).description('Attach a tests check to the completion report when discovery runs.'),
    allowPackageDiscovery: Schema.boolean()
      .default(true)
      .description('Allow package.json tower.testDiscovery commands from the mission worktree (executes repository code; see security docs).'),
  })
    .default({})
    .description('Declared test discovery and admission.'),
  gates: Schema.object({
    requireChecks: Schema.boolean()
      .default(false)
      .description('Require at least one completion check (tower_complete.checks) before a mission can merge.'),
    requireTests: Schema.boolean()
      .default(false)
      .description('Require a passing test-discovery receipt for the reviewed worktree tip before merge.'),
    allowReviewExemption: Schema.boolean()
      .default(false)
      .description('Allow reviewPolicy:none missions with a non-empty reviewExemptionReason to skip review blockers.'),
  })
    .default({})
    .description('Merge-gate strictness.'),
  docs: Schema.object({
    board: Schema.boolean()
      .default(true)
      .description('Write a human-readable MISSIONS.md after mission changes.'),
    boardLocation: Schema.union(['common', 'repo'])
      .default('common')
      .description('common = <git-common-dir>/dsh-tower/MISSIONS.md; repo = <repoRoot>/MISSIONS.md.'),
  })
    .default({})
    .description('Human-readable artifacts.'),
  tools: Schema.object({
    exposeOperational: Schema.boolean()
      .default(true)
      .description('Master switch for batch/resource/import/legacy/recover/test/doctor tools.'),
    exposeBatch: Schema.boolean().default(true).description('Register tower_batch.'),
    exposeImport: Schema.boolean().default(true).description('Register tower_import_legacy/tower_legacy_map.'),
    exposeLeases: Schema.boolean().default(true).description('Register tower_resource advisory leases.'),
    exposeTests: Schema.boolean().default(true).description('Register tower_test; gates.requireTests requires it.'),
    exposeRecovery: Schema.boolean().default(true).description('Register tower_recover (stale state-lock escape).'),
    exposeDoctor: Schema.boolean().default(true).description('Register tower_doctor (read-only health contract).'),
  })
    .default({})
    .description('Tool-surface policy.'),
  leases: Schema.object({
    ttlMs: Schema.natural().min(1000).max(86400000).default(900000).description('Default advisory lease lifetime; expiry never auto-releases.'),
  })
    .default({})
    .description('Advisory resource leases.'),
  dev: Schema.object({
    hotReload: Schema.boolean().default(true).description('Register tower_reload and /tower reload when the DSH HMR service is available.'),
    reloadDelayMs: Schema.natural().min(1).max(5000).default(50).description('Delay before a scheduled reload, so the tool result is delivered first.'),
    reloadRequiredIds: Schema.array(Schema.string())
      .default(['tower-bundle', 'tower', 'tower-skills', 'preset-tower-worker', 'preset-tower-reviewer'])
      .description('Loader entry ids passed to reconcileProfile as required.'),
  })
    .default({})
    .description('Development and hot-reload behavior.'),
}).description('DSH Tower configuration')


// The last raw profile config `apply()` received; repository config is merged
// over it so a repo can tune spawn/merge/review without editing the profile.
let profileRaw = {}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge(base, override) {
  if (override === undefined) return clone(base) ?? {}
  if (!isPlainObject(base) || !isPlainObject(override)) return clone(override)
  const out = clone(base)
  for (const [key, value] of Object.entries(override)) {
    out[key] = value === undefined ? out[key] : deepMerge(base[key], value)
  }
  return out
}

/** Move the legacy top-level aliases into their canonical group keys. */
function normalizeLegacy(raw = {}) {
  const out = clone(raw) ?? {}
  if (out.section !== undefined) {
    const mode = { ...(out.mode ?? {}) }
    if (mode.promptSection === undefined) mode.promptSection = out.section
    out.mode = mode
    delete out.section
  }
  if (out.allowAgentControl !== undefined) {
    const mode = { ...(out.mode ?? {}) }
    if (mode.allowAgentControl === undefined) mode.allowAgentControl = out.allowAgentControl
    out.mode = mode
    delete out.allowAgentControl
  }
  return out
}

function assertModelKeys(value, label) {
  const bad = Object.keys(value).filter((key) => !MODEL_KEYS.includes(key))
  if (bad.length > 0) {
    throw new TowerToolError('config-unknown-key', `${label} has unknown key(s) ${bad.join(', ')}`)
  }
}

function assertKnownKeys(raw, label) {
  const unknown = Object.keys(raw).filter((key) => !LEGACY_KEYS.includes(key) && !GROUP_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new TowerToolError(
      'config-unknown-key',
      `${label} has unknown key(s) ${unknown.join(', ')} — config is { section?, allowAgentControl?, init?, mode?, review?, merge?, git?, worktrees?, spawn?, send?, tests?, gates?, docs?, leases?, dev? }`,
    )
  }
  for (const [group, allowed] of Object.entries(SECTION_KEYS)) {
    const value = raw[group]
    if (value === undefined) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const bad = Object.keys(value).filter((key) => !allowed.includes(key))
    if (bad.length > 0) {
      throw new TowerToolError(
        'config-unknown-key',
        `${label} has unknown key(s) ${bad.map((key) => `${group}.${key}`).join(', ')}`,
      )
    }
    if ((group === 'spawn') && value.workerModel && typeof value.workerModel === 'object') {
      assertModelKeys(value.workerModel, `${label} spawn.workerModel`)
    }
    if ((group === 'spawn') && value.reviewerModel && typeof value.reviewerModel === 'object') {
      assertModelKeys(value.reviewerModel, `${label} spawn.reviewerModel`)
    }
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const REPO_CONFIG_MAX_BYTES = 1024 * 1024

/** Reject prototype-pollution style keys anywhere in a repository config. */
function assertSafeKeys(value, label) {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeKeys(item, label)
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new TowerToolError('config-invalid', `${label} contains the forbidden key "${key}"`)
    }
    assertSafeKeys(child, label)
  }
}

export function resolveTowerConfig(rawConfig) {
  const raw = rawConfig ?? {}
  if (raw !== null && typeof raw !== 'object') throw new Error('Tower config must be an object')
  assertKnownKeys(raw, 'Tower config')
  let parsed
  try {
    parsed = Config(raw)
  } catch (error) {
    throw new Error(`Tower config is invalid: ${String(error?.message ?? error)}`)
  }
  const mode = clone(parsed.mode ?? {})
  if (parsed.gates?.requireTests === true) {
    const testsAvailable = parsed.tests?.enabled !== false && parsed.tools?.exposeOperational !== false && parsed.tools?.exposeTests !== false
    if (!testsAvailable) {
      throw new Error('Tower config is invalid: gates.requireTests is true but test discovery is disabled (tests.enabled/tools.exposeTests)')
    }
  }
  // Canonical keys win; the legacy top-level aliases only fill gaps.
  const rawMode = raw.mode ?? {}
  if (rawMode.promptSection === undefined && raw.section !== undefined) mode.promptSection = raw.section
  if (rawMode.allowAgentControl === undefined && raw.allowAgentControl !== undefined) {
    mode.allowAgentControl = raw.allowAgentControl
  }
  // Apply the canonical default only after alias resolution: a validated
  // Cordis config may omit this key, and an explicit legacy top-level
  // `allowAgentControl:true` must not be shadowed by a schema default.
  if (mode.allowAgentControl === undefined) mode.allowAgentControl = true
  if (!Array.isArray(mode.denyTools) || mode.denyTools.length === 0) mode.denyTools = [...DEFAULT_DENY_TOOLS]
  return {
    section: mode.promptSection ?? '',
    init: clone(parsed.init ?? {}),
    mode,
    review: clone(parsed.review ?? {}),
    merge: clone(parsed.merge ?? {}),
    git: clone(parsed.git ?? {}),
    worktrees: clone(parsed.worktrees ?? {}),
    spawn: clone(parsed.spawn ?? {}),
    send: clone(parsed.send ?? {}),
    tests: clone(parsed.tests ?? {}),
    gates: clone(parsed.gates ?? {}),
    docs: clone(parsed.docs ?? {}),
    tools: clone(parsed.tools ?? {}),
    leases: clone(parsed.leases ?? {}),
    dev: clone(parsed.dev ?? {}),
  }
}

export function configureRuntime(config) {
  profileRaw = clone(config ?? {}) ?? {}
  return resolveTowerConfig(config)
}

export function runtimeConfig() {
  return resolveTowerConfig(profileRaw)
}

/** Raw profile config before defaults are materialized (for doctor warnings). */
export function profileConfig() {
  return clone(profileRaw) ?? {}
}

export function repoConfigPath(commonDir) {
  return path.join(commonDir, 'dsh-tower', 'config.json')
}

/**
 * Read and validate <git-common-dir>/dsh-tower/config.json.
 * Returns the raw (legacy-normalized) object plus its path; missing is not an error.
 */
export async function readRepoConfig(commonDir) {
  const file = repoConfigPath(commonDir)
  let stat
  try {
    stat = await fsp.stat(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return { config: {}, path: file, present: false }
    throw new TowerToolError('config-invalid', `repo config at ${file} could not be read: ${String(error?.message ?? error)}`)
  }
  if (stat.size > REPO_CONFIG_MAX_BYTES) {
    throw new TowerToolError(
      'config-invalid',
      `repo config at ${file} is too large (${stat.size} bytes; limit ${REPO_CONFIG_MAX_BYTES})`,
    )
  }
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { config: {}, path: file, present: false }
    throw new TowerToolError('config-invalid', `repo config at ${file} could not be read: ${String(error?.message ?? error)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new TowerToolError('config-invalid', `repo config at ${file} is not valid JSON: ${String(error?.message ?? error)}`)
  }
  if (!isPlainObject(parsed)) {
    throw new TowerToolError('config-invalid', `repo config at ${file} must be a JSON object`)
  }
  assertSafeKeys(parsed, `repo config at ${file}`)
  assertKnownKeys(parsed, `repo config at ${file}`)
  try {
    // Validate value types without letting the schema's defaults win over the
    // profile layer: merge into an empty raw object and discard the result.
    Config(parsed)
  } catch (error) {
    throw new TowerToolError('config-invalid', `repo config at ${file} is invalid: ${String(error?.message ?? error)}`)
  }
  return { config: normalizeLegacy(parsed), path: file, present: true }
}

/**
 * Effective config for one repository: profile config (already resolved with
 * code defaults) overridden by the repository config file. Tool arguments are
 * applied by the tool layer on top of this snapshot.
 */
export async function resolveRepoConfig(repo) {
  const base = runtimeConfig()
  const layer = await readRepoConfig(repo.commonDir)
  // The mode guard is a session/profile concern. A repository checkout may
  // only tighten it, never weaken denyTools, workspaceLock, allowAgentControl,
  // plan policy, or resume authorization.
  const repoLayer = { ...layer.config }
  delete repoLayer.mode
  delete repoLayer.section
  delete repoLayer.allowAgentControl
  const merged = deepMerge(base, repoLayer)
  const repoMode = layer.config.mode
  if (repoMode && typeof repoMode === 'object' && !Array.isArray(repoMode)) {
    merged.mode = { ...(merged.mode ?? {}) }
    if (repoMode.requireResumeAuthorization === true) merged.mode.requireResumeAuthorization = true
    if (repoMode.workspaceLock === true) merged.mode.workspaceLock = true
    if (repoMode.autoPauseGoal === true) merged.mode.autoPauseGoal = true
    if (repoMode.workspaceLockScope === 'all') merged.mode.workspaceLockScope = 'all'
    if (repoMode.planModePolicy === 'refuse') merged.mode.planModePolicy = 'refuse'
    if (repoMode.allowAgentControl === false) merged.mode.allowAgentControl = false
    if (Array.isArray(repoMode.denyTools)) {
      merged.mode.denyTools = [...new Set([...(base.mode?.denyTools ?? DEFAULT_DENY_TOOLS), ...repoMode.denyTools])]
    }
  }
  if (!Array.isArray(merged.mode?.denyTools) || merged.mode.denyTools.length === 0) {
    merged.mode = { ...(merged.mode ?? {}), denyTools: [...DEFAULT_DENY_TOOLS] }
  }
  merged.section = merged.mode?.promptSection ?? merged.section ?? ''
  return {
    ...merged,
    configPath: layer.path,
    repoConfigPresent: layer.present,
    profileConfigured: Object.keys(profileRaw).length > 0,
  }
}

