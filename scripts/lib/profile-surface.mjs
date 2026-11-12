// Per-profile byte baseline (#164 stages 0 and 5).
//
// The concept budget counts *names*; this gate counts what a session actually
// pays per request: the serialized schema bytes of the tower tools one profile
// advertises. A profile is either a host-session phase (`host:mode-off`,
// `host:idle`, `host:active` — the exposure ladder) or a spawned role preset
// (`preset:worker`, ... — the allow-lists). The numbers are committed in
// `scripts/surface-baseline.json` under `profileBytes`; growth is refused
// without a decision that names an ADR, and any drift requires the baseline
// to be updated with a dated decision, so the bytes cannot creep back quietly.
//
// The measurement is deterministic: it serializes exactly the three fields a
// provider advertises (`name`, `description`, `parameters`) in that key order,
// over the same shipped-surface load `surface:check` already uses.
import { Buffer } from 'node:buffer'
import { exposedNames, PRESET_ALLOWS, SESSION_PHASES } from '../../domain/exposure.js'

/** The host-session phases measured as profiles, in ladder order. */
export const HOST_PHASE_PROFILES = Object.freeze(['host:mode-off', 'host:idle', 'host:active'])

/** The preset profiles measured, keyed by the preset id the registry reports. */
export const PRESET_PROFILES = Object.freeze([
  'preset:worker',
  'preset:reviewer',
  'preset:survey',
  'preset:survey-sandbox',
])

/** Every profile id this gate measures. */
export const PROFILE_IDS = Object.freeze([...HOST_PHASE_PROFILES, ...PRESET_PROFILES])

const PHASE_BY_PROFILE = Object.freeze({
  'host:mode-off': 'off',
  'host:idle': 'idle',
  'host:active': 'active',
})

const PRESET_BY_PROFILE = Object.freeze({
  'preset:worker': 'tower-worker',
  'preset:reviewer': 'tower-reviewer',
  'preset:survey': 'tower-survey',
  'preset:survey-sandbox': 'tower-survey-sandbox',
})

/**
 * The advertised byte size of one tool: the three model-facing schema fields,
 * serialized with a fixed key order so identical definitions measure
 * identically across runs.
 * @param {{ name: string, description: string, parameters: unknown }} definition
 * @returns {number}
 */
export function toolBytes(definition) {
  return Buffer.byteLength(
    JSON.stringify({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }),
  )
}

/**
 * The tower-owned tool names one profile advertises.
 * @param {string} profile one of PROFILE_IDS
 * @param {readonly string[]} registeredNames the shipped tool surface
 * @returns {string[]}
 */
export function profileToolNames(profile, registeredNames) {
  const phase = PHASE_BY_PROFILE[profile]
  if (phase) {
    if (!SESSION_PHASES.includes(phase)) throw new Error(`unknown host profile "${profile}"`)
    return exposedNames(phase, registeredNames)
  }
  const preset = PRESET_BY_PROFILE[profile]
  if (!preset) throw new Error(`unknown profile "${profile}"; expected one of ${PROFILE_IDS.join(', ')}`)
  const allow = new Set(PRESET_ALLOWS[preset])
  return [...registeredNames].filter((name) => allow.has(name)).sort()
}

/**
 * Measure every profile against the shipped surface.
 * @param {{ names: readonly string[], definitions: Map<string, any> }} surface
 * @returns {Record<string, { tools: number, bytes: number }>}
 */
export function collectProfileSurface(surface) {
  const out = {}
  for (const profile of PROFILE_IDS) {
    const names = profileToolNames(profile, surface.names)
    let bytes = 0
    for (const name of names) {
      const definition = surface.definitions.get(name)
      if (!definition) throw new Error(`profile ${profile} names "${name}" but the shipped surface did not register it`)
      bytes += toolBytes(definition)
    }
    out[profile] = { tools: names.length, bytes }
  }
  return out
}

/**
 * Validate the committed per-profile bytes against the measured ones.
 * Any drift is an error until the baseline is updated with a dated decision;
 * a growth additionally requires that decision to name an existing ADR.
 *
 * @param {any} entry the `profileBytes` object from surface-baseline.json
 * @param {Record<string, { tools: number, bytes: number }>} current
 * @param {{ exists?: (relativePath: string) => boolean }} [options]
 * @returns {Array<{ code: string, level: string, message: string }>}
 */
export function validateProfileBytes(entry, current, options = {}) {
  const exists = options.exists ?? (() => false)
  const findings = []
  const record = (code, message) => findings.push({ code, level: 'error', message })
  if (!entry || typeof entry !== 'object') {
    record('profile-bytes-missing', 'surface baseline has no "profileBytes" entry')
    return findings
  }
  const dateOk = typeof entry.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)
  if (!dateOk) record('profile-bytes-date', 'profileBytes needs a date (YYYY-MM-DD)')
  const decisions = Array.isArray(entry.decisions) ? entry.decisions : []
  const latest = decisions[decisions.length - 1]
  for (const profile of PROFILE_IDS) {
    const committed = entry.profiles?.[profile]
    if (!committed || !Number.isInteger(committed.bytes)) {
      record('profile-bytes-missing', `profileBytes.profiles needs an integer "bytes" for ${profile}`)
      continue
    }
    const measured = current[profile]
    if (!measured) {
      record('profile-bytes-missing', `the live measurement is missing ${profile}`)
      continue
    }
    if (measured.bytes !== committed.bytes) {
      const direction = measured.bytes > committed.bytes ? 'grew' : 'shrank'
      record(
        'profile-bytes-stale',
        `${profile} ${direction} from ${committed.bytes} to ${measured.bytes} bytes (${committed.tools} -> ${measured.tools} tools); update the profileBytes baseline with a dated decision`,
      )
      if (measured.bytes > committed.bytes) {
        const adr = typeof latest?.adr === 'string' ? latest.adr.trim().replace(/\\/g, '/') : ''
        const adrOk = adr.startsWith('docs/adr/') && adr.endsWith('.md') && exists(adr)
        if (!adrOk) {
          record(
            'profile-bytes-growth',
            `${profile} growth needs a decision that names an existing docs/adr/ ADR`,
          )
        }
      }
    }
  }
  const known = new Set(PROFILE_IDS)
  for (const profile of Object.keys(entry.profiles ?? {})) {
    if (!known.has(profile)) record('profile-bytes-unknown', `profileBytes names unknown profile "${profile}"`)
  }
  return findings
}
