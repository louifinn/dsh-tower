// Component-surface rules split out of `domain/components.js` (#138) so the
// policy module stays under the architecture aggregate-size brake (800 lines).
// These are pure checks over the parsed source of truth: a key's class must
// match its value shape, and a row may only override config its component owns.
// `domain/components.js` re-exports them for the gate and the tests.

// A row's `config:` mapping mixes Tower's config with the row package's own
// metadata (`id`, `name`, `description`, `order`) and its nested `plugins:` list.
// Only the Tower config leaves are overrides of the component surface.
const ROW_CONFIG_METADATA = new Set(['id', 'name', 'description', 'order'])

function scalarText(value) {
  const trimmed = String(value ?? '').trim()
  const quoted = /^(['"])(.*)\1$/.exec(trimmed)
  return quoted ? quoted[2] : trimmed
}

/**
 * Read the scalar overrides under a row's own top-level `config:` mapping.
 *
 * The group rows are skipped by the parser: their `config:` is the list of
 * nested component rows, so the overrides belong to the child row, not the group.
 * A `plugins:` list is skipped for the same reason. This is what keeps a
 * legitimate plugin config (`write: false`, `sampleOverCapGlobResults: false`)
 * from being mistaken for a Tower config key, while a removed switch
 * (`docs.board: false`) is captured as `docs.board` and refused.
 *
 * @param {string[]} lines
 * @param {{ indent: number, line: number }} row
 * @returns {Array<{ key: string, value: string }>}
 */
export function collectConfigOverrides(lines, row) {
  let configIndent = null
  let start = null
  for (let index = row.line + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = /^(\s*)/.exec(line)?.[1].length ?? 0
    const nextId = /^\s*-\s+id:/.exec(line)
    if (nextId && indent <= row.indent) break
    if (indent <= row.indent && !/^\s*-\s+/.test(line)) break
    if (/^\s*config:\s*$/.test(line)) {
      configIndent = indent
      start = index + 1
      break
    }
  }
  if (start === null || configIndent === null) return []
  /** @type {Array<{ indent: number, key: string }>} */
  const stack = []
  const overrides = []
  let skipIndent = null
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = /^(\s*)/.exec(line)?.[1].length ?? 0
    if (indent <= configIndent) break
    if (skipIndent !== null) {
      if (indent > skipIndent) continue
      skipIndent = null
    }
    if (/^\s*-\s+/.test(line)) {
      // A list item: the group config list or a `plugins:` entry. Skip its whole
      // subtree; it does not belong to this row's config.
      skipIndent = indent
      continue
    }
    const match = /^\s*([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    const key = match[1]
    const value = match[2].trim()
    if (value === '') {
      if (key === 'plugins') {
        skipIndent = indent
        continue
      }
      stack.push({ indent, key })
      continue
    }
    const parts = [...stack.map((entry) => entry.key), key]
    if (ROW_CONFIG_METADATA.has(parts[0]) || parts[0] === 'plugins') continue
    overrides.push({ key: parts.join('.'), value: scalarText(value) })
  }
  return overrides
}

/**
 * #138.1: the class is not free text. A boolean key that removes a capability
 * cannot file as `optional-config`; it must be `core`, `optional-component` or
 * `forbidden-to-disable`, or carry a dated tuning-only exemption. The same rule
 * covers the non-boolean behaviour knobs recorded in `behaviorKnobs`, so a
 * string/union switch cannot hide on the tuning axis.
 *
 * @param {{ keys: Array<{ name: string, class: string, exemption?: any }>, behaviorKnobs?: string[] }} surface
 * @param {{ keyTypes?: Record<string, string> }} live live schema key -> type
 * @returns {Array<{ code: string, level: string, message: string }>}
 */
export function checkKeyClassifications(surface, live = {}) {
  const findings = []
  const record = (code, message) => findings.push({ code, level: 'error', message })
  const declared = new Map(surface.keys.map((key) => [key.name, key]))
  const types = live.keyTypes ?? {}
  const behavior = new Set(surface.behaviorKnobs ?? [])
  const reviewedClasses = ['core', 'optional-component', 'forbidden-to-disable']
  for (const name of behavior) {
    if (!declared.has(name)) {
      record('behavior-knob-unknown', `behaviorKnobs records ${name}, which has no component-axis class`)
    }
    if (types[name] === undefined) {
      record('behavior-knob-unknown', `behaviorKnobs records ${name}, which is not a live config key`)
    }
  }
  for (const key of surface.keys) {
    const type = types[key.name]
    const isBoolean = type === 'boolean'
    const isBehavior = behavior.has(key.name)
    if (isBoolean || isBehavior) {
      if (key.class === 'optional-config') {
        if (!key.exemption) {
          record(
            'boolean-class',
            `${key.name} is a ${isBoolean ? 'boolean' : 'recorded behaviour knob'} classified optional-config; it needs core/optional-component/forbidden-to-disable or a dated tuning-only exemption`,
          )
        } else if (!/tuning|tune/i.test(key.exemption.reason)) {
          record(
            'boolean-exemption',
            `${key.name} keeps optional-config but its exemption reason does not name a tuning-only nature: ${key.exemption.reason}`,
          )
        }
      } else if (!reviewedClasses.includes(key.class)) {
        record('boolean-class', `${key.name} is a ${isBoolean ? 'boolean' : 'behaviour knob'} with unknown class "${key.class}"`)
      }
    }
    if (key.exemption) {
      if (!isBoolean && !isBehavior) {
        record('exemption-invalid', `${key.name} carries a tuning exemption but is neither a boolean nor a recorded behaviour knob`)
      }
      if (key.class !== 'optional-config') {
        record('exemption-invalid', `${key.name} carries a tuning exemption but is classified "${key.class}", not optional-config`)
      }
      if (!/tuning|tune/i.test(key.exemption.reason)) {
        record('exemption-invalid', `${key.name} exemption reason must name its tuning-only nature: ${key.exemption.reason}`)
      }
    }
  }
  return findings
}

/**
 * #138.4: a row may only override config it owns. The parser captures the scalar
 * leaves under the row's own `config:` mapping; each one must be a live config
 * key (so a removed switch such as `docs.board:false` fails) and must be listed
 * in that component's `allowedOverrides` (so a row cannot enable or disable a
 * capability it does not own). `allowedOverrides` itself is checked in the other
 * direction: every listed key must be live and must not be forbidden-to-disable.
 *
 * @param {{ keys: Array<{ name: string, class: string }>, components: Array<{ id: string, allowedOverrides?: string[] }> }} surface
 * @param {{ configKeys?: string[], patch?: { rows?: Array<{ id: string, configOverrides?: Array<{ key: string, value: string }> }> } }} live
 * @returns {Array<{ code: string, level: string, message: string }>}
 */
export function checkRowOverrides(surface, live = {}) {
  const findings = []
  const record = (code, message) => findings.push({ code, level: 'error', message })
  const rows = live.patch?.rows ?? []
  const liveKeys = new Set(live.configKeys ?? [])
  const keyClass = new Map(surface.keys.map((key) => [key.name, key.class]))
  const classified = new Map(surface.components.map((component) => [component.id, component]))
  for (const component of surface.components) {
    const allowed = component.allowedOverrides ?? []
    const seen = new Set()
    for (const key of allowed) {
      if (seen.has(key)) record('row-override-duplicate', `component "${component.id}" lists ${key} twice in allowedOverrides`)
      seen.add(key)
      if (!liveKeys.has(key)) {
        record('component-override-unknown', `component "${component.id}" allows ${key}, which is not a live config key`)
      }
      if (keyClass.get(key) === 'forbidden-to-disable') {
        record('row-override-forbidden', `component "${component.id}" allows ${key}, which is classified forbidden-to-disable`)
      }
    }
  }
  for (const row of rows) {
    const component = classified.get(row.id)
    if (!component) continue
    const allowed = new Set(component.allowedOverrides ?? [])
    for (const entry of row.configOverrides ?? []) {
      const key = entry?.key
      if (typeof key !== 'string' || !key) {
        record('row-override-invalid', `row "${row.id}" has an override without a config key`)
        continue
      }
      if (!liveKeys.has(key)) {
        record(
          'row-override-unknown',
          `row "${row.id}" sets ${key}:${entry.value}; it is not a live config key (a switch removed in favour of a component must not keep working from a row config)`,
        )
        continue
      }
      if (keyClass.get(key) === 'forbidden-to-disable') {
        record(
          'row-override-forbidden',
          `row "${row.id}" sets ${key}:${entry.value}; a component may not switch off a forbidden-to-disable key`,
        )
        continue
      }
      if (!allowed.has(key)) {
        record(
          'row-override-foreign',
          `row "${row.id}" sets ${key}:${entry.value}; that key is outside the overrides allowed for component "${component.id}"`,
        )
      }
    }
  }
  return findings
}
