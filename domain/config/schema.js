// Pure Tower configuration schema and default resolution (#56 P2a).
//
// This module is pure: it declares the Schemastery schema, validates raw config
// objects, and materializes defaults. Profile and repository loading (fs and the
// process-local profile snapshot) live in host/config.js, which re-exports
// `Config` and `resolveTowerConfig` for compatibility.
//
// Layers, lowest precedence first:
//   1. code defaults (the schemastery `.default(...)` values)
//   2. profile config (the Cordis patch passes it to `apply()`)
//   3. repository config: <git-common-dir>/dsh-tower/config.json
//   4. per-tool arguments (e.g. worktreeRoot, timeoutMs)
//
// Defaults are exactly the 1.2.0 behavior; the shipped cordis patch keeps
// `allowAgentControl: true` via the legacy top-level key.
import Schema from '@deepseek-ai/schemastery'
import { TowerToolError } from '../errors.js'
import { DEFAULT_MAX_REPORT_BYTES } from '../missions/completion.js'

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
// #121: the `tools` group is gone. Every capability that used to be a
// `tools.expose*` boolean is now a component row in `cordis.patch.yml`, and a
// component row is the switch. What remains here is genuine tuning policy.
const GROUP_KEYS = ['init', 'mode', 'review', 'merge', 'git', 'worktrees', 'spawn', 'send', 'tests', 'gates', 'docs', 'archive', 'leases', 'dev']

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
  tests: ['admission', 'timeoutMs', 'maxBytes', 'autoChecks', 'allowPackageDiscovery'],
  gates: ['requireChecks', 'requireTests', 'allowReviewExemption', 'maxReportBytes'],
  docs: ['boardLocation'],
  archive: ['afterDays', 'maxMissions'],
  leases: ['ttlMs'],
  dev: ['reloadDelayMs', 'reloadRequiredIds'],
}

// #133/#135: `docs.board` and `archive.enabled` were component-shaped switches
// hiding in the config form. They are component rows now, so a legacy config
// keeps failing as an unknown key — with an upgrade note naming the row that
// replaced it.
/** @type {Record<string, string>} */
const REMOVED_KEYS = {
  'docs.board': 'tower-board',
  'archive.enabled': 'tower-archive',
}

/**
 * Upgrade note for a removed component switch, appended to the unknown-key error.
 * @param {string} group
 * @param {string} key
 * @returns {string}
 */
function removedKeyNote(group, key) {
  const component = REMOVED_KEYS[`${group}.${key}`]
  if (!component) return ''
  return ` — ${group}.${key} was removed: the ${component} component row in cordis.patch.yml is the switch (see docs/adr/0005-component-surface.md)`
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
    // #136: no `enabled` switch. The `tower-tests` component row *is* the
    // switch; a second boolean could only disagree with it, and a row-off
    // profile has no tower_test tool and no receipt to gate on.
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
    maxReportBytes: Schema.natural()
      .min(1024)
      .max(16 * 1024 * 1024)
      .default(DEFAULT_MAX_REPORT_BYTES)
      .description('Hard cap, in UTF-8 bytes, for tower_complete.report; a larger report is rejected with an actionable nextAction, never truncated.'),
  })
    .default({})
    .description('Merge-gate strictness.'),
  docs: Schema.object({
    boardLocation: Schema.union(['common', 'repo'])
      .default('common')
      .description('common = <git-common-dir>/dsh-tower/MISSIONS.md; repo = <repoRoot>/MISSIONS.md. Whether the board is written at all is the tower-board component row (#133).'),
  })
    .default({})
    .description('Human-readable artifact location. Turning the board off is a component row, not a tuning key.'),
  archive: Schema.object({
    afterDays: Schema.natural()
      .min(0)
      .default(30)
      .description('Terminal missions untouched for at least this many days are archived on the next mutation (0 archives them immediately). Archival itself is the tower-archive component row (#135).'),
    maxMissions: Schema.natural()
      .min(0)
      .default(100)
      .description('Maximum terminal missions kept hot; once exceeded, the oldest eligible terminal missions are archived until the cap holds (0 archives every eligible terminal mission).'),
  })
    .default({})
    .description('Terminal-mission archival tuning. Whether archival runs at all is the tower-archive component row; archived missions are moved, never deleted.'),
  leases: Schema.object({
    ttlMs: Schema.natural().min(1000).max(86400000).default(900000).description('Default advisory lease lifetime; expiry never auto-releases.'),
  })
    .default({})
    .description('Advisory resource leases.'),
  dev: Schema.object({
    reloadDelayMs: Schema.natural().min(1).max(5000).default(50).description('Delay before a scheduled reload, so the tool result is delivered first.'),
    reloadRequiredIds: Schema.array(Schema.string())
      .default(['tower', 'tower-host', 'preset-tower-worker'])
      .description('Loader entry ids passed to reconcileProfile as required. Optional component rows are deliberately not required, so a row switched off is not a reload failure.'),
  })
    .default({})
    .description('Development and hot-reload behavior.'),
}).description('DSH Tower configuration')

/**
 * The user-facing config surface (#84): every leaf key one level deep plus the
 * names of the object sections. The generated config reference, `tower_doctor`
 * and the surface baseline all count this same shape, so "how many concepts"
 * is one number rather than three near-identical ones.
 *
 * @param {any} [config] the Schemastery root (defaults to the live `Config`)
 * @returns {{ keys: string[], sections: string[], count: number }}
 */
export function configSurface(config = Config) {
  const keys = []
  const sections = []
  for (const [key, schema] of Object.entries(config?.dict ?? {})) {
    const dict = schema?.dict
    if (dict && typeof dict === 'object') {
      sections.push(key)
      for (const child of Object.keys(dict)) keys.push(`${key}.${child}`)
    } else {
      keys.push(key)
    }
  }
  return { keys, sections, count: keys.length }
}

/** @param {any} value */
export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * @param {any} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {any} base
 * @param {any} override
 */
export function deepMerge(base, override) {
  if (override === undefined) return clone(base) ?? {}
  if (!isPlainObject(base) || !isPlainObject(override)) return clone(override)
  const out = clone(base)
  for (const [key, value] of Object.entries(override)) {
    out[key] = value === undefined ? out[key] : deepMerge(base[key], value)
  }
  return out
}

/** Move the legacy top-level aliases into their canonical group keys. */
export function normalizeLegacy(raw = {}) {
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

/**
 * @param {any} value
 * @param {string} label
 */
function assertModelKeys(value, label) {
  const bad = Object.keys(value).filter((key) => !MODEL_KEYS.includes(key))
  if (bad.length > 0) {
    throw new TowerToolError('config-unknown-key', `${label} has unknown key(s) ${bad.join(', ')}`)
  }
}

/**
 * @param {any} raw
 * @param {string} label
 */
export function assertKnownKeys(raw, label) {
  const unknown = Object.keys(raw).filter((key) => !LEGACY_KEYS.includes(key) && !GROUP_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new TowerToolError(
      'config-unknown-key',
      `${label} has unknown key(s) ${unknown.join(', ')} — config is { section?, allowAgentControl?, init?, mode?, review?, merge?, git?, worktrees?, spawn?, send?, tests?, gates?, docs?, archive?, leases?, dev? }`,
    )
  }
  for (const [group, allowed] of Object.entries(SECTION_KEYS)) {
    const value = raw[group]
    if (value === undefined) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const bad = Object.keys(value).filter((key) => !allowed.includes(key))
    if (bad.length > 0) {
      const notes = bad.map((key) => removedKeyNote(group, key)).join('')
      throw new TowerToolError(
        'config-unknown-key',
        `${label} has unknown key(s) ${bad.map((key) => `${group}.${key}`).join(', ')}${notes}`,
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

/**
 * Reject prototype-pollution style keys anywhere in a repository config.
 * @param {any} value
 * @param {string} label
 */
export function assertSafeKeys(value, label) {
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

/** @param {any} [rawConfig] */
export function resolveTowerConfig(rawConfig) {
  const raw = rawConfig ?? {}
  if (raw !== null && typeof raw !== 'object') throw new TowerToolError('config-invalid', 'Tower config must be an object')
  assertKnownKeys(raw, 'Tower config')
  let parsed
  try {
    parsed = Config(raw)
  } catch (error) {
    throw new TowerToolError('config-invalid', `Tower config is invalid: ${String(error?.message ?? error)}`)
  }
  const mode = clone(parsed.mode ?? {})
  // #136: `tests.enabled` is gone, so this resolver can no longer disagree with
  // the mounted rows. The component-level invariant (`gates.requireTests:true`
  // with the `tower-tests` row off) is enforced where the rows are known:
  // host/presets.js at plan/mode entry, and the merge gate reports its cause.
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
  // F17/#130: materialize the resolved prompt section as well. `section` always
  // mirrors `mode.promptSection`, so leaving the canonical field absent for a
  // config with neither key would make a *second* pass copy the just-added
  // `section:''` back into `mode` (`promptSection:''`): one pass would not be a
  // fixed point. Filling it here makes `resolve(resolve(raw))` equal
  // `resolve(raw)` for every valid config without changing any resolved value.
  if (mode.promptSection === undefined) mode.promptSection = ''
  if (!Array.isArray(mode.denyTools) || mode.denyTools.length === 0) mode.denyTools = [...DEFAULT_DENY_TOOLS]
  return {
    section: mode.promptSection,
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
    archive: clone(parsed.archive ?? {}),
    leases: clone(parsed.leases ?? {}),
    dev: clone(parsed.dev ?? {}),
  }
}
