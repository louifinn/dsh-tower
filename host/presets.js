// Cross-field preset and component validation (#64, #121): fail before work
// starts, not at spawn.
//
// Two invariants travel with the optional rows:
//
//   1. `preset-tower-worker` is a mandatory dependency: planning, mode entry and
//      spawn must refuse when the worker preset is absent.
//   2. `preset-tower-reviewer` is a *conditional* component. It may be off while
//      `review.mode` is `off` or `optional` (merge is unaffected; `off` does not
//      use the preset at all); with `review.mode:required` it must be locked with
//      an explanatory error, never silently allowed.
//
// `tower-tests` adds a third: with the component row off there is no
// `tower_test` tool and no receipt, so `gates.requireTests: true` is refused
// here rather than left to fail at merge time with a misleading blocker.
//
// `tower-leases` adds a fourth (#131): `spawn.requireLease` is satisfied through
// `tower_resource`, the tool the `tower-leases` row owns. With that row off every
// spawn would fail at `lease-busy` advising a tool that is not registered, so the
// contradiction is refused up front instead.
import { TowerToolError } from '../domain/errors.js'
import { reviewRequired } from '../domain/integration/review.js'
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
 * The reviewer preset is required only when `review.mode` is `required`; with
 * `off`/`optional` the off state is supported by the component contract.
 */
export async function assertPresetsAvailable(ctx, config = {}) {
  const service = ctx?.get?.('agentPresets')
  if (!service || typeof service.list !== 'function') return { checked: false, missing: [] }
  const presets = presetIds(config)
  const required = [presets.worker]
  if (reviewRequired(config)) required.push(presets.reviewer)
  const available = new Set((await service.list()).map((entry) => String(entry.id)))
  const missing = required.filter((id) => !available.has(id))
  if (missing.length === 0) return { checked: true, missing: [] }
  const rows = [...new Set(missing.map(rowId))]
  const reviewLock =
    reviewRequired(config) && missing.includes(presets.reviewer)
      ? ` review.mode is required, so the reviewer row may not be off; ${disabledReason(rowId(presets.reviewer))} is rejected`
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
  // #131: `spawn.requireLease` is acquired through `tower_resource`, which only
  // exists while the tower-leases row is mounted. Without this check the config
  // looks valid and every spawn dies at `lease-busy` pointing at a tool that is
  // not registered. Both remedies are named because either side may be the
  // accidental one.
  const requiredLease = String(config.spawn?.requireLease ?? '').trim()
  if (requiredLease && !componentEnabled('tower-leases')) {
    throw new TowerToolError(
      'config-invalid',
      `spawn.requireLease="${requiredLease}" is set but ${disabledReason('tower-leases')}; tower_resource is not registered, so the lease can never be acquired. Re-enable the tower-leases component or clear spawn.requireLease`,
    )
  }
  return presets
}
