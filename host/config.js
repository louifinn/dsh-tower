// Tower configuration: process-local profile snapshot and repository layer.
//
// The pure Schemastery schema, default resolution, and raw-config validation
// live in domain/config/schema.js (#56 P2a). This module keeps only the layers
// that need process or filesystem state:
//
//   profile -> the raw config `apply()` received, resolved with code defaults
//              on every read (runtimeConfig)
//   repo    -> <git-common-dir>/dsh-tower/config.json merged over the profile
//
// `Config` and `resolveTowerConfig` are re-exported for compatibility; new
// code should import them from domain/config/schema.js.
import { fsp } from '../adapters/store-fs.js'
import path from 'node:path'
import {
  Config,
  DEFAULT_DENY_TOOLS,
  assertKnownKeys,
  assertSafeKeys,
  clone,
  deepMerge,
  isPlainObject,
  normalizeLegacy,
  resolveTowerConfig,
} from '../domain/config/schema.js'
import { TowerToolError } from '../domain/errors.js'
import { materializeVolatile, resolveReviewPolicy, reviewUnavailable } from '../domain/integration/review.js'

export { Config, DEFAULT_DENY_TOOLS, resolveTowerConfig }

const REPO_CONFIG_MAX_BYTES = 1024 * 1024

// The last raw profile config `apply()` received; repository config is merged
// over it so a repo can tune spawn/merge/review without editing the profile.
//
// #M40: this must stay the *raw* object. A `.volatile()` field arrives as a
// live reference that Cordis updates in place on a settings write, and cloning
// (JSON) would freeze a copy and hide the new value from runtimeConfig(). Only
// readers that need plain data (profileConfig) materialize it.
let profileRaw = {}

export function configureRuntime(config) {
  profileRaw = config ?? {}
  return resolveTowerConfig(profileRaw)
}

export function runtimeConfig() {
  return resolveTowerConfig(profileRaw)
}

/** Raw profile config before defaults are materialized (for doctor warnings). */
export function profileConfig() {
  return clone(materializeVolatile(profileRaw)) ?? {}
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
    // #M39: the schema accepts both review keys; only the resolver knows that an
    // explicit `requireReview:true` next to a conflicting `review.mode` is a
    // contradiction. Reject it here, before the layer can be merged.
    resolveReviewPolicy(parsed.review)
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
  // #M39: the review policy is resolved per layer instead of deep-merging two
  // resolved shapes. A resolved base always carries both `review.mode` and its
  // mirrored alias, so a repository layer that sets only one of the two would
  // otherwise pair a stale inherited `mode` with the new alias. The repository
  // layer wins as a whole when it names either key; a layer that names neither
  // inherits the profile policy untouched.
  const repoReview = repoLayer.review
  if (repoReview && typeof repoReview === 'object' && !Array.isArray(repoReview)) {
    const explicit = repoReview.mode !== undefined || repoReview.requireReview !== undefined
    if (explicit) {
      const repoPolicy = resolveReviewPolicy(repoReview)
      if (reviewUnavailable(base) && repoPolicy.mode !== 'off') {
        // The tool surface is fixed when the plugin applies: a profile with
        // review off never registered tower_review, so a repository may relax
        // review further but cannot re-enable a tool that does not exist.
        throw new TowerToolError(
          'config-invalid',
          `review.mode is off in the profile, so tower_review is not registered; repository config cannot set review.mode:${repoPolicy.mode}. Set review.mode in the profile instead.`,
        )
      }
      merged.review = {
        ...(merged.review ?? {}),
        mode: repoPolicy.mode,
        requireReview: repoPolicy.mode === 'required',
      }
    }
  }
  merged.section = merged.mode?.promptSection ?? merged.section ?? ''
  return {
    ...merged,
    configPath: layer.path,
    repoConfigPresent: layer.present,
    profileConfigured: Object.keys(profileRaw).length > 0,
  }
}
