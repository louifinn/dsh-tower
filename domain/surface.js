// Concept budget: surface metrics, the committed baseline and its classifications (#84).
//
// The repository does not measure "how many concepts a user has to hold" by
// counting lines. It measures the surface — config leaf keys, config sections and
// registered tools — and keeps a committed baseline. Growth is refused by
// default: a baseline decision that raises a count must name either an ADR (why
// the surface has to grow) or deletions that are provably gone from the live
// surface (the added concept replaced a removed one).
//
// This module is pure: no fs, no git. `scripts/surface-baseline.mjs` supplies
// the live counts and the file reads; `scripts/lib/surface.mjs` wraps them.
//
// Since #120 `components` is a fourth surface: the number of user-visible
// component rows in `cordis.patch.yml`. That is what makes a contraction (the
// 2.3.0 4 -> 1 group row) and the coming #121 growth require a written decision
// instead of arriving quietly.
export const SURFACE_BASELINE_FILE = 'scripts/surface-baseline.json'
export const SURFACE_CLASSIFICATION_FILE = 'docs/reference/surface-budget.md'
export const SURFACE_KEYS = ['configKeys', 'sections', 'tools', 'components']
// A count in this list is two-way: a contraction needs a decision record just
// like growth does. The component surface is where the failure actually
// happened (4 top-level rows -> 1 group row), so "a reduction is cheap" is
// exactly the policy hole #120 closes. #138 extends the same brake to the config
// keys: a removed switch is a capability decision too, so the key count may not
// shrink silently either. Sections and tools keep the ADR 0004 cheap-shrink rule.
export const SURFACE_TWO_WAY_KEYS = ['components', 'configKeys']
export const CONFIG_CLASSES = ['core', 'tuning', 'niche']
export const TOOL_CLASSES = ['core', 'optional']
export const SURFACE_SCHEMA_VERSION = 1

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The human-readable count line shared by `tower_doctor` and the generated
 * references: `config keys: N · sections: N · tools: N`.
 * @param {{ configKeys?: number, sections?: number, tools?: number }} counts
 */
export function surfaceLine(counts = {}) {
  const value = (key) => (Number.isInteger(counts[key]) ? String(counts[key]) : '?')
  return `config keys: ${value('configKeys')} · sections: ${value('sections')} · tools: ${value('tools')}`
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function surfaceError(message) {
  return new Error(message)
}

/**
 * Parse and validate `scripts/surface-baseline.json`. Throws with an actionable
 * message when the file is malformed; returns a normalized copy otherwise.
 * @param {string | object} source
 */
export function parseBaseline(source) {
  let value
  if (typeof source === 'string') {
    try {
      value = JSON.parse(source)
    } catch (error) {
      throw surfaceError(`surface baseline is not valid JSON: ${error?.message ?? error}`)
    }
  } else {
    value = source
  }
  if (!isPlainObject(value)) throw surfaceError('surface baseline must be a JSON object')
  if (value.schema !== undefined && value.schema !== SURFACE_SCHEMA_VERSION) {
    throw surfaceError(`surface baseline schema ${value.schema} is not supported (expected ${SURFACE_SCHEMA_VERSION})`)
  }
  if (typeof value.date !== 'string' || !ISO_DATE.test(value.date)) {
    throw surfaceError(`surface baseline needs a date (YYYY-MM-DD), got ${JSON.stringify(value.date)}`)
  }
  if (!isPlainObject(value.surfaces)) throw surfaceError('surface baseline needs a "surfaces" object')
  const surfaces = {}
  for (const key of SURFACE_KEYS) {
    const entry = value.surfaces[key]
    if (!isPlainObject(entry)) throw surfaceError(`surface baseline misses the "${key}" entry`)
    if (!Number.isInteger(entry.seed) || entry.seed < 0) {
      throw surfaceError(`surface baseline ${key}.seed must be a non-negative integer`)
    }
    if (!Number.isInteger(entry.value) || entry.value < 0) {
      throw surfaceError(`surface baseline ${key}.value must be a non-negative integer`)
    }
    if (!Array.isArray(entry.decisions)) throw surfaceError(`surface baseline ${key}.decisions must be an array`)
    surfaces[key] = {
      seed: entry.seed,
      value: entry.value,
      decisions: entry.decisions.map((decision, index) => {
        if (!isPlainObject(decision)) {
          throw surfaceError(`surface baseline ${key}.decisions[${index}] must be an object`)
        }
        if (!Number.isInteger(decision.from) || decision.from < 0) {
          throw surfaceError(`surface baseline ${key}.decisions[${index}].from must be a non-negative integer`)
        }
        if (!Number.isInteger(decision.to) || decision.to < 0) {
          throw surfaceError(`surface baseline ${key}.decisions[${index}].to must be a non-negative integer`)
        }
        return { ...decision }
      }),
    }
  }
  return { schema: SURFACE_SCHEMA_VERSION, date: value.date, surfaces }
}

/**
 * The rows of the classification table, already parsed. `kind` is `config` or
 * `tools`, `name` is the key/tool name, `className` is the declared class.
 * @param {string} markdown
 */
export function parseClassification(markdown) {
  const text = String(markdown ?? '')
  const dateMatch = /^\s*(?:[-*]\s*)?Decision date:\s*(\d{4}-\d{2}-\d{2})\s*$/im.exec(text)
  const entries = []
  let kind = null
  for (const rawLine of text.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(rawLine)
    if (heading) {
      const title = heading[1].toLowerCase()
      kind = title.includes('config') ? 'config' : title.includes('tool') ? 'tools' : null
      continue
    }
    if (!kind) continue
    const match = /^\|\s*`([^`]+)`\s*\|\s*([a-z-]+)\s*\|\s*(.*?)\s*\|\s*$/.exec(rawLine)
    if (!match) continue
    entries.push({ kind, name: match[1].trim(), className: match[2].trim().toLowerCase(), note: match[3].trim() })
  }
  return { date: dateMatch ? dateMatch[1] : null, entries }
}

/**
 * Validate the classification table against the live surface. Every live key and
 * tool must appear exactly once with a legal class; every `niche` row must carry
 * a removal note, so "we will remove it later" is a written promise rather than
 * an implication.
 * @param {string} markdown
 * @param {{ configKeys: string[], sections: string[], tools: string[] }} liveNames
 * @param {{ baselineDate?: string }} [options]
 * @returns {{ date: string | null, entries: Array<{ kind: string, name: string, className: string, note: string }>, findings: Array<{ code: string, level: string, message: string }> }}
 */
export function validateClassification(markdown, liveNames, options = {}) {
  const parsed = parseClassification(markdown)
  const findings = []
  const text = String(markdown ?? '')
  const record = (code, message) => findings.push({ code, level: 'error', message })
  if (!parsed.date) {
    record('classification-date', 'classification table needs a "Decision date: YYYY-MM-DD" line')
  } else if (options.baselineDate && parsed.date !== options.baselineDate) {
    record(
      'classification-date',
      `classification date ${parsed.date} does not match the baseline date ${options.baselineDate}`,
    )
  }

  const checkRows = (kind, expected, legal) => {
    const rows = parsed.entries.filter((entry) => entry.kind === kind)
    const seen = new Map()
    for (const row of rows) {
      if (seen.has(row.name)) record('classification-duplicate', `${kind === 'config' ? 'config key' : 'tool'} ${row.name} is classified twice`)
      seen.set(row.name, row)
      if (!legal.includes(row.className)) {
        record(
          'classification-class',
          `${kind === 'config' ? 'config key' : 'tool'} ${row.name} has class "${row.className}" (expected ${legal.join('/')})`,
        )
      }
    }
    for (const name of expected) {
      if (!seen.has(name)) record('classification-missing', `${kind === 'config' ? 'config key' : 'tool'} ${name} is not classified`)
    }
    const expectedSet = new Set(expected)
    for (const name of seen.keys()) {
      if (!expectedSet.has(name)) record('classification-unknown', `${kind === 'config' ? 'config key' : 'tool'} ${name} is not in the live surface`)
    }
    return rows
  }

  const configRows = checkRows('config', liveNames.configKeys, CONFIG_CLASSES)
  checkRows('tools', liveNames.tools, TOOL_CLASSES)
  const nicheRows = configRows.filter((row) => row.className === 'niche')
  for (const row of nicheRows) {
    if (!/removal note:/i.test(row.note)) {
      record('niche-removal-note', `niche config key ${row.name} needs a "Removal note:" in its table row`)
    }
  }
  if (nicheRows.length === 0 && !/no key qualifies as niche/i.test(text)) {
    record('niche-removal-note', 'no niche config key has a removal note and the table does not say "no key qualifies as niche"')
  }
  return { date: parsed.date, entries: parsed.entries, findings }
}

/**
 * Validate an explicit measurement-correction decision (#118).
 *
 * A correction says the live surface did not grow: the earlier measurement
 * missed a registration path. It is deliberately narrower than an ADR — it only
 * authorizes the written `from`/`to` step it carries, needs a reason and a date,
 * and (when it names a `ref`) that reference must resolve. A later count change
 * still needs its own decision, so the brake stays strict.
 *
 * @returns {boolean} true when the correction is valid evidence for the growth
 */
function correctionEvidence(decision, where, record, exists) {
  if (decision.correction === undefined) return false
  if (!isPlainObject(decision.correction)) {
    record('correction-invalid', `${where}.correction must be an object with a reason and a date`)
    return false
  }
  const correction = decision.correction
  const reason = typeof correction.reason === 'string' ? correction.reason.trim() : ''
  if (!reason) {
    record('correction-invalid', `${where}.correction needs a non-empty reason explaining why the measurement changed`)
  }
  const date = correction.date ?? decision.date
  const dateOk = typeof date === 'string' && ISO_DATE.test(date)
  if (!dateOk) {
    record('correction-invalid', `${where}.correction needs a date (YYYY-MM-DD)`)
  } else if (typeof decision.date === 'string' && date !== decision.date) {
    record('correction-invalid', `${where}.correction.date ${date} does not match the decision date ${decision.date}`)
  }
  let refOk = true
  if (correction.ref !== undefined) {
    const ref = typeof correction.ref === 'string' ? correction.ref.trim().replace(/\\/g, '/') : ''
    if (!ref) {
      record('correction-invalid', `${where}.correction.ref must be a repository path when present`)
      refOk = false
    } else if (!ref.startsWith('docs/') || !ref.endsWith('.md')) {
      record('correction-invalid', `${where}.correction.ref must name a docs/*.md record, got ${ref}`)
      refOk = false
    } else if (!exists(ref)) {
      record('correction-invalid', `${where}.correction.ref ${ref} does not exist`)
      refOk = false
    }
  }
  return reason.length > 0 && dateOk && refOk
}

/**
 * Validate one surface entry against its live count and its decision chain. This
 * is the brake: `live !== entry.value` fails, and every decision that grows a
 * count must name an existing ADR, deletions that are provably absent from the
 * live surface, or a valid measurement-correction record.
 *
 * A two-way surface (see SURFACE_TWO_WAY_KEYS) also refuses a contraction whose
 * new count is not reached by a decision record; the other surfaces keep the
 * "a reduction is cheap" rule from ADR 0004.
 *
 * Extracted from `validateBaseline` so a narrower gate (`docs:check:components`,
 * #120) can validate just the component count without re-measuring the others.
 *
 * @param {string} key one of SURFACE_KEYS
 * @param {{ seed: number, value: number, decisions: any[] }} entry
 * @param {number} live
 * @param {string[]} liveNames
 * @param {{ exists?: (relativePath: string) => boolean }} [options]
 * @returns {Array<{ code: string, level: string, message: string }>}
 */
export function validateSurfaceEntry(key, entry, live, liveNames, options = {}) {
  const exists = options.exists ?? (() => false)
  const findings = []
  const record = (code, message) => findings.push({ code, level: 'error', message })
  if (!Number.isInteger(live)) {
    record('surface-missing', `live ${key} count is unavailable`)
    return findings
  }
  if (live !== entry.value) {
    const direction = live > entry.value ? 'grew' : 'shrank'
    record(
      'stale-baseline',
      `${key} ${direction} from the committed baseline ${entry.value} to ${live}; update ${SURFACE_BASELINE_FILE} with an ADR or a deletion record before landing`,
    )
  }
  let running = entry.seed
  entry.decisions.forEach((decision, index) => {
    const where = `${key}.decisions[${index}]`
    if (decision.from !== running) {
      record('broken-chain', `${where}.from ${decision.from} does not continue from ${running}`)
    }
    if (decision.date !== undefined && !ISO_DATE.test(String(decision.date))) {
      record('broken-chain', `${where}.date is not YYYY-MM-DD`)
    }
    const growth = decision.to - decision.from
    if (growth > 0) {
      const deletions = Array.isArray(decision.deletions)
        ? decision.deletions.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim())
        : []
      const adr = typeof decision.adr === 'string' && decision.adr.trim() ? decision.adr.trim().replace(/\\/g, '/') : null
      const adrExists = Boolean(adr) && adr.startsWith('docs/adr/') && adr.endsWith('.md') && exists(adr)
      const liveSet = new Set(liveNames ?? [])
      const stillLive = deletions.filter((name) => liveSet.has(name))
      const deletionEvidence = deletions.length >= growth && stillLive.length === 0
      const correction = correctionEvidence(decision, where, record, exists)
      if (!adrExists && !deletionEvidence && !correction) {
        const reasons = []
        if (adr && !adrExists) reasons.push(`ADR ${adr} does not exist under docs/adr/`)
        if (deletions.length === 0) reasons.push('no deletions recorded')
        else if (stillLive.length > 0) reasons.push(`deleted name(s) are still in the live surface: ${stillLive.join(', ')}`)
        else if (deletions.length < growth) reasons.push(`only ${deletions.length} deletion(s) for a growth of ${growth}`)
        if (decision.correction !== undefined && !correction) reasons.push('the correction record is invalid')
        record('growth-without-evidence', `${where} grows ${key} by ${growth} without an ADR, a matching deletion or a valid correction (${reasons.join('; ')})`)
      }
    }
    running = decision.to
  })
  const twoWay = SURFACE_TWO_WAY_KEYS.includes(key)
  if (running !== entry.value && !(entry.decisions.length === 0 && entry.value < running && !twoWay)) {
    record(
      'broken-chain',
      `${key} value ${entry.value} does not match the last decision (${running}); every count change needs a decision record`,
    )
  }
  return findings
}

/**
 * Validate the whole committed baseline. Every surface in SURFACE_KEYS is
 * checked, so a missing `current` entry is a `surface-missing` finding.
 *
 * @param {ReturnType<typeof parseBaseline>} baseline
 * @param {{ configKeys: number, sections: number, tools: number, components: number, liveNames: { configKeys: string[], sections: string[], tools: string[], components: string[] } }} current
 * @param {{ exists?: (relativePath: string) => boolean }} [options]
 * @returns {Array<{ code: string, level: string, message: string }>}
 */
export function validateBaseline(baseline, current, options = {}) {
  const findings = []
  for (const key of SURFACE_KEYS) {
    findings.push(...validateSurfaceEntry(key, baseline.surfaces[key], current[key], current.liveNames?.[key], options))
  }
  return findings
}

/**
 * Validate one surface entry of the committed baseline (the narrower form used
 * by `docs:check:components`).
 *
 * @param {ReturnType<typeof parseBaseline>} baseline
 * @param {string} key
 * @param {Record<string, any>} current
 * @param {{ exists?: (relativePath: string) => boolean }} [options]
 * @returns {Array<{ code: string, level: string, message: string }>}
 */
export function validateSurfaceBaselineKey(baseline, key, current, options = {}) {
  if (!SURFACE_KEYS.includes(key)) {
    throw surfaceError(`surface ${key} is not one of ${SURFACE_KEYS.join('/')}`)
  }
  const entry = baseline.surfaces[key]
  if (!entry) throw surfaceError(`surface baseline has no "${key}" entry`)
  return validateSurfaceEntry(key, entry, current[key], current.liveNames?.[key], options)
}
