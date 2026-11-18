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
//
// #F22: the failure copy lives in one table below, and
// `scripts/check-components.mjs` reads that table. Every message names the
// capability row the user can see in the plugin page and the remedy; none names
// a config key, a tool id or a command. Keep it that way: a new message that
// skips the table is a copy-gate failure, not a style choice.
import { TowerToolError } from '../domain/errors.js'
import { reviewRequired } from '../domain/integration/review.js'
import { ROLES, rolePresetConfig } from '../domain/roles.js'
import { componentEnabled } from './capability-registry.js'

// User-facing failure copy. `{detail}` and `{lease}` are filled from the live
// configuration; the rest is fixed prose. @see the copy gate in
// scripts/check-components.mjs for the rules these strings are checked against.
const ERROR_COPY = Object.freeze({
  workerPresetMissing:
    'Tower cannot start: the Tower Worker preset is not loaded, so planning, entering Tower mode and starting an agent are refused with an explanation. Switch the Tower Worker preset back on in the plugin page, then restart DSH.{detail}',
  reviewerPresetMissing:
    'Tower cannot start: the Tower Reviewer preset is not loaded and review before merging is set to required, so reviewing and merging are refused with an explanation. Switch the Tower Reviewer preset back on in the plugin page, then restart DSH.{detail}',
  bothPresetsMissing:
    'Tower cannot start: the Tower Worker preset and the Tower Reviewer preset are not loaded, so planning, entering Tower mode, reviewing and merging are refused with an explanation. Switch both presets back on in the plugin page, then restart DSH.{detail}',
  // #F79: the rendered next step. The error registry is label-agnostic, so this
  // module owns the copy that names the visible row; the preset ids stay inside
  // the plugin-page plumbing and never reach the operator.
  workerPresetMissingNext:
    'switch the Tower Worker preset row back on in the plugin page and restart DSH, or choose a registered preset on the plugin configuration form',
  reviewerPresetMissingNext:
    'switch the Tower Reviewer preset row back on in the plugin page and restart DSH, or choose a registered preset on the plugin configuration form',
  bothPresetsMissingNext:
    'switch the Tower Worker preset and the Tower Reviewer preset rows back on in the plugin page, then restart DSH, or choose a registered preset on the plugin configuration form',
  requireTests:
    'Test evidence is required before merging, but the Test evidence capability is switched off, so planning and entering Tower mode are refused with an explanation. Switch the Test evidence capability back on in the plugin page, or stop requiring test evidence on the plugin configuration form.',
  requireLease:
    'A lease "{lease}" is required before an execution agent starts, but the Lease coordination capability is switched off, so no lease can be acquired and planning and entering Tower mode are refused with an explanation. Switch the Lease coordination capability back on in the plugin page, or clear the lease requirement on the plugin configuration form.',
})

/** Fill the `{name}` placeholders of one copy table entry. */
function fillCopy(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

export function presetIds(config = {}) {
  const ids = {}
  const spawn = config.spawn ?? {}
  for (const role of ROLES) {
    const spec = rolePresetConfig(role)
    if (!spec) continue
    ids[role] = String(spawn[spec.slot] ?? spec.fallback)
  }
  return ids
}

const PRESET_IDS = Object.freeze(['tower-worker', 'tower-reviewer'])

/** A configured preset name that is not one of the two built-in ids. */
function configuredPresetDetail(missing) {
  const custom = [...new Set(missing.filter((id) => !PRESET_IDS.includes(id)))]
  if (custom.length === 0) return ''
  const names = custom.map((id) => `"${id}"`).join(', ')
  return ` The profile asks for the preset ${names}, which is not registered; choose a registered preset on the plugin configuration form.`
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
  const detail = configuredPresetDetail(missing)
  const workerMissing = missing.includes(presets.worker)
  const reviewerMissing = missing.includes(presets.reviewer)
  if (workerMissing && reviewerMissing) {
    throw new TowerToolError('preset-missing', fillCopy(ERROR_COPY.bothPresetsMissing, { detail }), {
      nextAction: fillCopy(ERROR_COPY.bothPresetsMissingNext),
    })
  }
  if (reviewerMissing) {
    throw new TowerToolError('preset-missing', fillCopy(ERROR_COPY.reviewerPresetMissing, { detail }), {
      nextAction: fillCopy(ERROR_COPY.reviewerPresetMissingNext),
    })
  }
  throw new TowerToolError('preset-missing', fillCopy(ERROR_COPY.workerPresetMissing, { detail }), {
    nextAction: fillCopy(ERROR_COPY.workerPresetMissingNext),
  })
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
    throw new TowerToolError('config-invalid', fillCopy(ERROR_COPY.requireTests))
  }
  // #131: `spawn.requireLease` is acquired through `tower_resource`, which only
  // exists while the tower-leases row is mounted. Without this check the config
  // looks valid and every spawn dies at `lease-busy` pointing at a tool that is
  // not registered. Both remedies are named because either side may be the
  // accidental one.
  const requiredLease = String(config.spawn?.requireLease ?? '').trim()
  if (requiredLease && !componentEnabled('tower-leases')) {
    throw new TowerToolError('config-invalid', fillCopy(ERROR_COPY.requireLease, { lease: requiredLease }))
  }
  return presets
}
