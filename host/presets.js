// Cross-field preset and component validation (#64, #121): fail before work
// starts, not at spawn.
//
// Two invariants travel with the optional rows:
//
//   1. `preset-tower-worker` is a mandatory dependency: planning, mode entry and
//      spawn must refuse when the worker preset is absent.
//   2. `preset-tower-reviewer` is a *conditional* component. It may be off while
//      `review.requireReview` is false (merge is unaffected); with the review
//      gate on it must be locked with an explanatory error, never silently
//      allowed.
//
// `tower-tests` adds a third: with the component row off there is no
// `tower_test` tool and no receipt, so `gates.requireTests: true` is refused
// here rather than left to fail at merge time with a misleading blocker.
import { TowerToolError } from '../domain/errors.js'
import { componentEnabled, disabledReason } from './capability-registry.js'

export function presetIds(config = {}) {
  return {
    worker: String(config.spawn?.workerPreset ?? 'tower-worker'),
    reviewer: String(config.spawn?.reviewerPreset ?? 'tower-reviewer'),
  }
}

function rowId(preset) {
  return preset === 'tower-worker' ? 'preset-tower-worker' : preset === 'tower-reviewer' ? 'preset-tower-reviewer' : preset
}

/**
 * Resolve the presets against the profile's agentPresets service. Fail closed
 * with preset-missing before mode entry/planning when a *required* preset is not
 * registered. If the service is unavailable, doctor reports that separately and
 * this check cannot make a claim either way.
 *
 * The reviewer preset is required only when `review.requireReview` is true; the
 * off state is otherwise supported by the component contract.
 */
export async function assertPresetsAvailable(ctx, config = {}) {
  const service = ctx?.get?.('agentPresets')
  if (!service || typeof service.list !== 'function') return { checked: false, missing: [] }
  const presets = presetIds(config)
  const required = [presets.worker]
  if (config.review?.requireReview === true) required.push(presets.reviewer)
  const available = new Set((await service.list()).map((entry) => String(entry.id)))
  const missing = required.filter((id) => !available.has(id))
  if (missing.length === 0) return { checked: true, missing: [] }
  const rows = [...new Set(missing.map(rowId))]
  const reviewLock =
    config.review?.requireReview === true && missing.includes(presets.reviewer)
      ? ` review.requireReview is true, so the reviewer row may not be off; ${disabledReason(rowId(presets.reviewer))} is rejected`
      : ''
  throw new TowerToolError(
    'preset-missing',
    `required Tower agent preset(s) missing: ${missing.join(', ')}; re-enable ${rows.join(', ')} in the plugin page, then restart DSH.${reviewLock}`,
  )
}

/**
 * Every runtime invariant that depends on which component rows are mounted.
 * Called before planning and before entering Tower mode, so a configuration
 * that a component switch has invalidated is rejected with an explanation
 * instead of failing later at merge time.
 *
 * @param {any} ctx
 * @param {Record<string, any>} config
 */
export async function assertRuntimePreconditions(ctx, config = {}) {
  const presets = await assertPresetsAvailable(ctx, config)
  if (config.gates?.requireTests === true && !componentEnabled('tower-tests')) {
    throw new TowerToolError(
      'config-invalid',
      `gates.requireTests is true but ${disabledReason('tower-tests')}; re-enable the tower-tests component or set gates.requireTests:false`,
    )
  }
  return presets
}
