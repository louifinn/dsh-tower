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
// Phase 3+ of #163 folds the five read-only views into `tower_inspect` and the
// same-resource pairs into their canonical tools; those names move here when
// they land.

/** The tower-worker preset's tool list. */
export const WORKER_ALLOW = Object.freeze([
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'pwsh',
  'tower_mission',
  'tower_status',
  'tower_diff',
  'tower_send',
  'tower_inbox',
  'tower_complete',
  'tower_finding',
  'tower_findings',
  'skill',
])

/** The tower-reviewer preset's tool list (read-only plus the verdict tools). */
export const REVIEWER_ALLOW = Object.freeze([
  'read',
  'glob',
  'grep',
  'tower_diff',
  'tower_status',
  'tower_send',
  'tower_inbox',
  'tower_finding',
  'tower_findings',
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
  'tower_import_legacy',
  'tower_legacy_map',
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

/** @param {string} name */
export function isTowerOnlyTool(name) {
  return TOWER_ONLY_TOOLS.includes(name)
}

/** @param {string} name */
export function isRepositoryOptionalTool(name) {
  return REPOSITORY_OPTIONAL_TOOLS.includes(name)
}
