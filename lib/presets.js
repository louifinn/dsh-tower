// Cross-field preset validation (#64): fail before work starts, not at spawn.
import { TowerToolError } from './errors.js'

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
 * Resolve both presets against the profile's agentPresets service. Fail closed
 * with preset-missing before mode entry/planning when a required preset is not
 * registered. If the service is unavailable, doctor reports that separately and
 * this check cannot make a claim either way.
 */
export async function assertPresetsAvailable(ctx, config = {}) {
  const service = ctx?.get?.('agentPresets')
  if (!service || typeof service.list !== 'function') return { checked: false, missing: [] }
  const presets = presetIds(config)
  const available = new Set((await service.list()).map((entry) => String(entry.id)))
  const missing = [presets.worker, presets.reviewer].filter((id) => !available.has(id))
  if (missing.length > 0) {
    const rows = [...new Set(missing.map(rowId))]
    throw new TowerToolError(
      'preset-missing',
      `required Tower agent preset(s) missing: ${missing.join(', ')}; re-enable ${rows.join(', ')} in the plugin page, then restart DSH`,
    )
  }
  return { checked: true, missing: [] }
}
