// Tower configuration: one declared schema, resolved defaults, and the
// process-local effective snapshot consumed by the domain modules.
//
// Defaults are exactly the 1.2.0 behavior; the shipped cordis patch keeps
// `allowAgentControl: true` via the legacy top-level key.
import Schema from '@deepseek-ai/schemastery'

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

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

export function resolveTowerConfig(rawConfig) {
  const raw = rawConfig ?? {}
  if (raw !== null && typeof raw !== 'object') throw new Error('Tower config must be an object')
  const unknown = Object.keys(raw).filter((key) => !LEGACY_KEYS.includes(key) && !GROUP_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new Error(
      `Tower config has unknown key(s) ${unknown.join(', ')} — config is { section?, allowAgentControl?, mode?, review?, merge?, worktrees?, spawn? }`,
    )
  }
  let parsed
  try {
    parsed = Config(raw)
  } catch (error) {
    throw new Error(`Tower config is invalid: ${String(error?.message ?? error)}`)
  }
  const mode = clone(parsed.mode ?? {})
  if (raw.section !== undefined) mode.promptSection = raw.section
  if (raw.allowAgentControl !== undefined) mode.allowAgentControl = raw.allowAgentControl
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
  effective = resolveTowerConfig(config)
  return effective
}

export function runtimeConfig() {
  if (!effective) effective = resolveTowerConfig({})
  return effective
}
