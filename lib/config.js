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
  'spawn_teammate',
]

const LEGACY_KEYS = ['section', 'allowAgentControl']
const GROUP_KEYS = ['mode', 'review', 'merge', 'worktrees', 'spawn']

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
  mode: Schema.object({
    promptSection: Schema.string().description('Replacement Tower-mode system prompt text. Empty keeps the built-in reminder.'),
    sectionAppend: Schema.string().description('Extra text appended to the Tower-mode system prompt section (team conventions).'),
    allowAgentControl: Schema.boolean().default(false).description('Register tower_control so the model may enter/leave the mode with a reason.'),
    autoPauseGoal: Schema.boolean().default(true).description('Pause an active goal when entering Tower mode.'),
    denyTools: Schema.array(Schema.string())
      .default(DEFAULT_DENY_TOOLS)
      .description('Tools refused while Tower mode is active.'),
    storePath: Schema.string().description('Directory for modes.json; defaults to $DSH_HOME/tower-mode.'),
    maxEntries: Schema.natural().min(1).max(2000).default(200).description('Maximum persisted mode entries.'),
  })
    .default({})
    .description('Tower-mode behavior and persistence.'),
  review: Schema.object({
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
  })
    .default({})
    .description('Worker and reviewer presets plus model routing.'),
}).description('DSH Tower configuration')

let effective = null
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

function assertKnownKeys(raw, label) {
  const unknown = Object.keys(raw).filter((key) => !LEGACY_KEYS.includes(key) && !GROUP_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new TowerToolError(
      'config-unknown-key',
      `${label} has unknown key(s) ${unknown.join(', ')} — config is { section?, allowAgentControl?, mode?, review?, merge?, worktrees?, spawn? }`,
    )
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
  // Canonical keys win; the legacy top-level aliases only fill gaps.
  const rawMode = raw.mode ?? {}
  if (rawMode.promptSection === undefined && raw.section !== undefined) mode.promptSection = raw.section
  if (rawMode.allowAgentControl === undefined && raw.allowAgentControl !== undefined) {
    mode.allowAgentControl = raw.allowAgentControl
  }
  if (!Array.isArray(mode.denyTools) || mode.denyTools.length === 0) mode.denyTools = [...DEFAULT_DENY_TOOLS]
  return {
    section: mode.promptSection ?? '',
    mode,
    review: clone(parsed.review ?? {}),
    merge: clone(parsed.merge ?? {}),
    worktrees: clone(parsed.worktrees ?? {}),
    spawn: clone(parsed.spawn ?? {}),
  }
}

export function configureRuntime(config) {
  profileRaw = clone(config ?? {}) ?? {}
  effective = resolveTowerConfig(config)
  return effective
}

export function runtimeConfig() {
  if (!effective) effective = resolveTowerConfig({})
  return effective
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
  const merged = deepMerge(base, layer.config)
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

