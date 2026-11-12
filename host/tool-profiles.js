// Tool profiles (#163): one registry for the tools each shipped profile mounts
// and for the tool-level contracts the authorization kernel needs.
//
// The worker/reviewer presets restrict the model's tool list to these allow
// lists, and `scripts/surface-baseline.mjs` measures the same lists, so the
// measured profile can never drift from the mounted one. `TOWER_ONLY_TOOLS` and
// `REPOSITORY_OPTIONAL_TOOLS` are tool identity, not a guess about the
// arguments a caller happened to pass: the runtime consults this registry
// instead of inferring the contract from a present `repoRoot`.
//
// #163 Phases 3-4 already folded the five read-only views into `tower_inspect`
// and the same-resource pairs into their canonical tools; Phase 5 completes the
// role contract.

/** The tower-worker preset's tool list. */
export const WORKER_ALLOW = Object.freeze([
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'pwsh',
  'tower_mission',
  'tower_inspect',
  'tower_send',
  'tower_inbox',
  'tower_complete',
  'tower_finding',
  'skill',
])

/** The tower-reviewer preset's tool list (read-only plus the verdict tools). */
export const REVIEWER_ALLOW = Object.freeze([
  'read',
  'glob',
  'grep',
  'tower_inspect',
  'tower_send',
  'tower_inbox',
  'tower_finding',
  'tower_review',
  'skill',
])

/**
 * Tools only the tower profile may call. The authorization matrix owns the
 * access classes; this list is the composition-level registration so a profile
 * check can name the same set. Names are kept in sync by
 * `tests/tool-repo.test.mjs`.
 */
export const TOWER_ONLY_TOOLS = Object.freeze([
  'tower_batch',
  'tower_import',
  'tower_reload',
  'tower_resource',
])

/**
 * Tools that may run without a repository. `tower_reload` is the escape hatch
 * for a broken profile/config: it must stay callable when no repository can be
 * opened, and the worker/reviewer allow lists already keep it off those
 * profiles.
 */
export const REPOSITORY_OPTIONAL_TOOLS = Object.freeze(['tower_reload'])

/**
 * Tools a role session owns structurally (#163 Phase 5). The tool stays
 * registered for the build surface, but it is admitted only for the listed
 * roles: the tower profile does not advertise `tower_complete` or
 * `tower_review`, because completing a mission and auditing another agent's
 * work are worker/reviewer contracts. `tower_complete` is also a survey
 * contract: a survey mission finishes through it.
 */
export const ROLE_TOOLS = Object.freeze({
  tower_complete: Object.freeze(['worker', 'survey']),
  tower_review: Object.freeze(['reviewer']),
})

/** Actionable denial text for a role-owned tool called from the wrong profile. */
export const ROLE_DENIAL_HINTS = Object.freeze({
  tower_complete:
    'tower_complete is not a worker action available from this session; it belongs to assigned worker and survey role sessions. Spawn a worker with tower_spawn({ role: "worker" }) and let it complete the mission, or use role: "survey" for a survey mission.',
  tower_review:
    'tower_review is not a worker action available from this session; it belongs to assigned reviewer role sessions. Spawn a reviewer with tower_spawn({ role: "reviewer" }) after the mission is completed.',
})

/**
 * The role a parent preset id selects. Agent presets are configurable, so the
 * match is intentionally by the shipped role token in the preset id; an
 * ordinary tower session has no role preset and therefore no role-owned tools.
 *
 * @param {unknown} preset
 * @returns {'worker' | 'reviewer' | 'survey' | null}
 */
export function roleForPreset(preset) {
  if (typeof preset !== 'string' || preset.trim() === '') return null
  const value = preset.toLowerCase()
  if (value.includes('worker')) return 'worker'
  if (value.includes('reviewer')) return 'reviewer'
  if (value.includes('survey')) return 'survey'
  return null
}

/**
 * The role of one live agent, read from the child session header the presets
 * registry records. Undefined means a normal (tower) session.
 *
 * @param {any} agent
 */
export function roleForAgent(agent) {
  return roleForPreset(agent?.session?.header?.agentPreset)
}

/**
 * Whether the role-owned tool may be admitted to this agent's step.
 *
 * @param {any} agent
 * @param {string} name
 */
export function roleAllowsTool(agent, name) {
  const roles = ROLE_TOOLS[name]
  if (roles === undefined) return true
  return roles.includes(roleForAgent(agent))
}

/**
 * @param {string} name
 * @param {string | null | undefined} [role]
 */
export function roleDenialHint(name, role) {
  const hint = ROLE_DENIAL_HINTS[name] ?? `${name} is owned by another role profile`
  return `${hint} You are acting as: ${role ?? 'tower'}.`
}

/** @param {string} name */
export function isRoleOwnedTool(name) {
  return Object.hasOwn(ROLE_TOOLS, name)
}

/** Removed tool names and the merged tool that replaced them. */
export const LEGACY_TOOL_REPLACEMENTS = Object.freeze({
  tower_control: 'tower_mode',
  tower_adopt: 'tower_init({ op: "adopt" })',
  tower_findings: 'tower_finding({ op: "list" })',
  tower_import_legacy: 'tower_import({ op: "snapshot" })',
  tower_legacy_map: 'tower_import({ op: "map" })',
  tower_status: 'tower_inspect({ view: "status" })',
  tower_roster: 'tower_inspect({ view: "roster" })',
  tower_diff: 'tower_inspect({ view: "diff" })',
  tower_preflight: 'tower_inspect({ view: "preflight" })',
  tower_doctor: 'tower_inspect({ view: "doctor" })',
})

/** Component rows that ship disabled by default (#163 Phase 5). */
export const SUBSYSTEM_ROWS = Object.freeze(['tower-batch', 'tower-import', 'tower-leases', 'tower-tests', 'tower-hmr'])

/** The tool each default-off subsystem row owns and the exact enable step. */
export const COMPONENT_ENABLE_HINTS = Object.freeze({
  'tower-batch': Object.freeze({ tool: 'tower_batch', enable: 'remove `disabled: true` from the tower-batch row in cordis.patch.yml and restart DSH' }),
  'tower-import': Object.freeze({ tool: 'tower_import', enable: 'remove `disabled: true` from the tower-import row in cordis.patch.yml and restart DSH' }),
  'tower-leases': Object.freeze({ tool: 'tower_resource', enable: 'remove `disabled: true` from the tower-leases row in cordis.patch.yml and restart DSH' }),
  'tower-tests': Object.freeze({ tool: 'tower_test', enable: 'remove `disabled: true` from the tower-tests row in cordis.patch.yml and restart DSH' }),
  'tower-hmr': Object.freeze({ tool: 'tower_reload', enable: 'remove `disabled: true` from the tower-hmr row in cordis.patch.yml and restart DSH (developer tooling)' }),
})

/** @param {string} id */
export function isSubsystemRow(id) {
  return SUBSYSTEM_ROWS.includes(id)
}

/** @param {string} name */
export function isTowerOnlyTool(name) {
  return TOWER_ONLY_TOOLS.includes(name)
}

/** @param {string} name */
export function isRepositoryOptionalTool(name) {
  return REPOSITORY_OPTIONAL_TOOLS.includes(name)
}
