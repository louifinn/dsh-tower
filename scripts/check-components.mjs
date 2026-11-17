#!/usr/bin/env node
// Component-surface policy gate (#120).
//
// Principle 11 says optional capabilities are switches and the core is not. This
// gate is what makes that a rule instead of a slogan. It fails on:
//
//   1. a visible component without `title`, `summary` and `disables` in both
//      locale/en.json and locale/zh.json — and the same three strings for every
//      component that ships a generated row label, including the internal
//      worker preset (#121);
//   2. a forbidden-to-disable capability (host, health, recovery, merge gates)
//      that any group, row or boolean key can disable;
//   3. a component count that moved without a decision in
//      scripts/surface-baseline.json (the same brake `surface:check` applies);
//   4. #137/#F22: user-facing copy that leaks a config key, an internal tool id,
//      a slash command or a module specifier, leaves a term untranslated in
//      Chinese, drifts from the recorded glossary, or diverges between zh and en
//      in the root locale, the generated row locales, the ui-bundle locale, the
//      Web client string catalogue and the preset runtime failure copy;
//   5. #M42: the review policy presented as a row. `review.mode` is one
//      tri-state configuration control (off/optional/required) on the plugin
//      page, not a component row and not three mutually exclusive rows; no row
//      may own the policy, and the reviewer preset row may not be made
//      incompatible with the off/optional modes.
//
// It also refuses the quiet forms of the same drift: a shipped component row
// missing from the single source of truth, a live config key without a
// component-axis class, and a generated reference that is out of date.
//
// The single source of truth is `scripts/component-surface.json`; the generated
// table is `docs/reference/component-surface.md`; the policy is recorded in
// `docs/adr/0005-component-surface.md`.
//
// Usage:
//   node scripts/check-components.mjs [--root <dir>] [--json]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Config, configSurface } from '../domain/config/schema.js'
import {
  COMPONENT_PATCH_FILES,
  COMPONENT_REFERENCE_FILE,
  COMPONENT_SURFACE_FILE,
  LOCALE_FIELDS,
  LOCALE_FILES,
  META_LABEL_PATCHES,
  META_LOCALE_FILES,
  checkForbidden,
  checkGroupLabelCoverage,
  checkKeyClassifications,
  checkLocaleCoverage,
  checkMetaLabelCoverage,
  checkRowOverrides,
  mergeCordisPatches,
  parseComponentSurface,
  parseCordisPatch,
  renderComponentSurface,
  validateComponentSurface,
} from '../domain/components.js'
import { validateSurfaceBaselineKey } from '../domain/surface.js'
import { readBaseline } from './lib/surface.mjs'
import { parseArgs, runMain } from './lib/cli.mjs'
import { OFF_EFFECT_LABEL, ROW_LOCALES, rowLocalePaths } from './generate-capability-locale.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY_FILE = 'host/tool-registry.js'
const ROOT_PATCH = COMPONENT_PATCH_FILES[0]
const USAGE = `usage: node scripts/check-components.mjs [--root <dir>] [--json]

  --root   repository root to check (default: this package)
  --json   print the report as JSON
  --help   print this text

Reads every shipped cordis.patch.yml (${COMPONENT_PATCH_FILES.join(', ')}).
Fails on a visible component without title/summary/disables in both locale files,
a generated row label (capability or preset) whose component entry is missing,
a visible row with no label source at all, a group row whose plugin-page
description omits its off consequence, a forbidden-to-disable capability disabled
by a group, row or boolean key, a component count that moved without a
scripts/surface-baseline.json decision, an unclassified config key or component
row, a stale generated reference, (#137) any label copy that names a config key or
internal tool id, leaves a glossary term untranslated, or diverges between zh and
en, (#F22) the Web client catalogue or the preset runtime failure copy naming a
config key, a tool id or a non-glossary term, and (#M42) the review policy
exposed as a row instead of one tri-state configuration control.
Regenerate the table with \`npm run docs:generate:components\` and the row labels
with \`npm run docs:generate:locale\`.`

function finding(code, level, message) {
  return { code, level, message }
}

/** The recorded bilingual vocabulary lives at the repository root. */
export const GLOSSARY_FILE = 'GLOSSARY.md'

/**
 * #137: the canonical bilingual vocabulary for every user-facing label. The
 * glossary is the contract between the English and the Chinese copy: an English
 * concept that appears in a label must use the recorded Chinese term, and the
 * Chinese side may not leave the English word untranslated.
 *
 * `worker` and `reviewer` match the generic role at the start of a word, in
 * either case ("Workers are …"), but never the product names "Tower Worker" and
 * "Tower Reviewer": the negative lookbehind keeps the brand out of the role
 * check, so a label may say "Tower Worker preset" without owing 执行代理.
 */
export const COMPONENT_GLOSSARY = Object.freeze([
  { en: 'mission', zh: '任务线', pattern: /\b[Mm]issions?\b/ },
  { en: 'batch', zh: '批次', pattern: /\b[Bb]atch(?:es)?\b/ },
  { en: 'doctor', zh: '体检', pattern: /\b[Dd]octor\b/ },
  { en: 'board', zh: '看板', pattern: /\b[Bb]oard\b/ },
  { en: 'archive', zh: '归档', pattern: /\b[Aa]rchives?\b/ },
  { en: 'preset', zh: '预设', pattern: /\b[Pp]resets?\b/ },
  { en: 'worktree', zh: '工作树', pattern: /\b[Ww]orktrees?\b/ },
  { en: 'review', zh: '审查', pattern: /\b[Rr]eviews?\b/ },
  { en: 'lease', zh: '租约', pattern: /\b[Ll]eases?\b/ },
  { en: 'worker', zh: '执行代理', pattern: /\b(?<!Tower )[Ww]orkers?\b/ },
  { en: 'reviewer', zh: '审查代理', pattern: /\b(?<!Tower )[Rr]eviewers?\b/ },
  // #F22: acceptance is the human decision that lands an artifact mission. The
  // glossary records 接受 and explicitly rejects 验收, which belongs to the
  // reviewer. The row and reviewer copy used 验收, so the term joins the gate to
  // keep the distinction from drifting back.
  { en: 'acceptance', zh: '接受', pattern: /\b[Aa]ccept(?:ance|ed|s|ing)?\b/ },
])

/**
 * #137: copy is written by people, and a Chinese IME (or a careful editor) can
 * emit case variants and full-width punctuation. Normalize those before
 * matching so `Gates.requireTests`, `Tower_batch`, `gates。requireTests` and the
 * fully full-width `ｔｏｗｅｒ＿ｂａｔｃｈ` are all caught. Matching runs on the
 * normalized text; the reported token is then the actionable ASCII spelling.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeCopy(text) {
  return String(text ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/\u3002/g, '.')
}

// A section plus a dot is config-key syntax (`gates.requireTests:true`), not
// prose. The same rule catches every section a user can edit, in either
// language, so a new key family cannot sneak back into a label. Matching is
// case-insensitive: `Gates.requireTests` is the same leak.
export const CONFIG_KEY_SYNTAX =
  /\b(?:gates|review|spawn|tests|docs|mode|merge|git|worktrees|archive|leases|activity|dev)\.[A-Za-z][A-Za-z0-9_.]*/i
// Bare internal identifiers: tool ids, slash commands and package specifiers.
// Case-insensitive for the same reason: `Tower_batch` and `/Tower reload` are
// still internal spelling, not prose.
export const TOOL_ID_SYNTAX = /\btower_[a-z][a-z0-9_]*/i
export const COMMAND_SYNTAX = /\/tower\s/i
export const MODULE_SPECIFIER_SYNTAX = /\bdsh-tower\/[a-z][a-z0-9._/-]*/i
// #F69: a capability row id (`tower-leases`, `preset-tower-reviewer`) is
// plugin-page plumbing, not prose. The user sees the row title ("Lease
// coordination") and switches that on; the id stays in the locale source.
export const ROW_ID_SYNTAX = /\b(?:preset-)?tower-[a-z][a-z0-9-]*/i
// Words that must be translated in the Chinese copy. Lowercase only, so
// product names ("Tower Worker"), file names (MISSIONS.md) and brand names
// (Tower, DSH) are not mistakes.
export const ZH_UNTRANSLATED = Object.freeze([
  'mission',
  'batch',
  'doctor',
  'board',
  'archive',
  'preset',
  'worktree',
  'review',
  'lease',
  'host',
  'state',
  'worker',
  'reviewer',
])
const ZH_UNTRANSLATED_SYNTAX = ZH_UNTRANSLATED.map((term) => ({
  term,
  pattern: new RegExp(`\\b${term}\\b`),
}))

/**
 * Flatten the user-facing fields of one locale file into `{ path, text }`
 * entries: `meta.title`, `meta.description` and every
 * `components.<id>.title/summary/disables`. A missing field is kept as an empty
 * string so parity and emptiness are reported once, with its path.
 *
 * @param {string} file repository-relative path
 * @param {any} payload parsed locale JSON (or null when the file is missing)
 * @returns {Array<{ file: string, path: string, text: string }>}
 */
export function labelCopyFields(file, payload) {
  const fields = []
  const push = (key, value) => {
    fields.push({ file, path: key, text: typeof value === 'string' ? value : '' })
  }
  if (payload && typeof payload === 'object') {
    push('meta.title', payload.meta?.title)
    push('meta.description', payload.meta?.description)
    for (const [id, entry] of Object.entries(payload.components ?? {})) {
      for (const field of LOCALE_FIELDS) push(`components.${id}.${field}`, entry?.[field])
    }
  }
  return fields
}

// The finding codes of the banned-syntax rule, per surface. The rule is the
// same everywhere; the code says which surface failed, so a red gate points at
// the file family before the message is read (#F22).
const LOCALE_COPY_CODES = Object.freeze({
  configKey: 'locale-copy-config-key',
  toolId: 'locale-copy-tool-id',
  command: 'locale-copy-command',
  module: 'locale-copy-module',
  untranslated: 'locale-copy-untranslated',
})
const CLIENT_COPY_CODES = Object.freeze({
  configKey: 'client-copy-config-key',
  toolId: 'client-copy-tool-id',
  command: 'client-copy-command',
  module: 'client-copy-module',
  untranslated: 'client-copy-untranslated',
})
const PRESET_COPY_CODES = Object.freeze({
  configKey: 'preset-copy-config-key',
  toolId: 'preset-copy-tool-id',
  command: 'preset-copy-command',
  module: 'preset-copy-module',
  untranslated: 'preset-copy-untranslated',
})
const PRECHECK_COPY_CODES = Object.freeze({
  configKey: 'precheck-copy-config-key',
  toolId: 'precheck-copy-tool-id',
  command: 'precheck-copy-command',
  module: 'precheck-copy-module',
  rowId: 'precheck-copy-row-id',
  untranslated: 'precheck-copy-untranslated',
})
const DOCTOR_COPY_CODES = Object.freeze({
  configKey: 'doctor-copy-config-key',
  toolId: 'doctor-copy-tool-id',
  command: 'doctor-copy-command',
  module: 'doctor-copy-module',
  rowId: 'doctor-copy-row-id',
  untranslated: 'doctor-copy-untranslated',
})

/**
 * @param {{ file: string, path: string, text: string }} field
 * @param {'en' | 'zh'} lang
 * @param {(code: string, message: string) => void} record
 * @param {Record<string, string>} codes
 * @param {{ allowCommand?: boolean }} [options] `allowCommand` is only true for
 *        the client instruction strings that teach the composer command.
 */
function checkBannedCopy(field, lang, record, codes = LOCALE_COPY_CODES, options = {}) {
  const label = `${field.file} ${field.path}`
  // Match on the normalized spelling so case variants and full-width
  // punctuation cannot bypass the rule (#137).
  const text = normalizeCopy(field.text)
  const configKey = text.match(CONFIG_KEY_SYNTAX)
  if (configKey) {
    record(
      codes.configKey,
      `${label} names a config key ("${configKey[0]}"); describe the capability and its off consequence in plain language instead`,
    )
  }
  const toolId = text.match(TOOL_ID_SYNTAX)
  if (toolId) {
    record(
      codes.toolId,
      `${label} names the internal tool id "${toolId[0]}"; describe what the user can do instead`,
    )
  }
  const command = text.match(COMMAND_SYNTAX)
  if (command && options.allowCommand !== true) {
    record(
      codes.command,
      `${label} names the slash command "${command[0].trim()}"; describe the capability instead`,
    )
  }
  const specifier = text.match(MODULE_SPECIFIER_SYNTAX)
  if (specifier) {
    record(
      codes.module,
      `${label} names the module specifier "${specifier[0]}"; describe the capability instead`,
    )
  }
  if (codes.rowId) {
    const rowId = text.match(ROW_ID_SYNTAX)
    if (rowId) {
      record(
        codes.rowId,
        `${label} names the capability row id "${rowId[0]}"; name the plugin-page row by its visible title and the action the user takes`,
      )
    }
  }
  if (lang !== 'zh') return
  for (const { term, pattern } of ZH_UNTRANSLATED_SYNTAX) {
    if (pattern.test(text)) {
      record(
        codes.untranslated,
        `${label} leaves "${term}" untranslated; use the glossary term from ${GLOSSARY_FILE}`,
      )
    }
  }
}

/**
 * The Chinese side of the glossary check. Chinese has no word boundaries, so a
 * shorter term (审查) can be a substring of a longer one (审查代理). The longest
 * recorded term wins: it is removed before shorter terms are matched, which
 * keeps the two roles distinct instead of reporting a false mismatch.
 */
function checkZhGlossary(field, enText, enFile, record) {
  const ordered = [...COMPONENT_GLOSSARY].sort((a, b) => b.zh.length - a.zh.length)
  let remaining = field.text
  for (const term of ordered) {
    if (!remaining.includes(term.zh)) continue
    remaining = remaining.split(term.zh).join(' ')
    if (!term.pattern.test(enText)) {
      record(
        'locale-glossary',
        `${enFile} ${field.path} must name the English ${term.en} for the Chinese "${term.zh}"`,
      )
    }
  }
}

/**
 * #137: check one en/zh pair of locale files. Every user-facing field must be
 * non-empty, free of config-key and internal-identifier syntax, and consistent
 * with the recorded glossary in both directions. Both files must carry the same
 * field paths.
 *
 * @param {Array<{ en: { file: string, payload: any }, zh: { file: string, payload: any } }>} pairs
 */
export function checkLocaleCopy(pairs) {
  const findings = []
  const record = (code, message) => findings.push(finding(code, 'error', message))
  for (const pair of pairs ?? []) {
    if (!pair?.en?.payload || !pair?.zh?.payload) {
      record(
        'locale-copy-missing',
        `locale copy pair is incomplete: ${pair?.en?.file ?? '<en>'} and ${pair?.zh?.file ?? '<zh>'} must both exist`,
      )
      continue
    }
    const en = labelCopyFields(pair.en.file, pair.en.payload)
    const zh = labelCopyFields(pair.zh.file, pair.zh.payload)
    const enPaths = new Set(en.map((field) => field.path))
    const zhPaths = new Set(zh.map((field) => field.path))
    for (const path of enPaths) {
      if (!zhPaths.has(path)) {
        record('locale-copy-parity', `${pair.en.file} labels ${path} but ${pair.zh.file} does not`)
      }
    }
    for (const path of zhPaths) {
      if (!enPaths.has(path)) {
        record('locale-copy-parity', `${pair.zh.file} labels ${path} but ${pair.en.file} does not`)
      }
    }
    const enByPath = new Map(en.map((field) => [field.path, field.text]))
    const zhByPath = new Map(zh.map((field) => [field.path, field.text]))
    for (const side of [
      { lang: 'en', fields: en, other: zhByPath },
      { lang: 'zh', fields: zh, other: enByPath },
    ]) {
      for (const field of side.fields) {
        if (!field.text.trim()) {
          record('locale-copy-empty', `${field.file} ${field.path} is empty`)
          continue
        }
        checkBannedCopy(field, side.lang, record)
        const otherText = side.other.get(field.path)
        if (otherText === undefined) continue
        if (side.lang === 'en') {
          for (const term of COMPONENT_GLOSSARY) {
            if (term.pattern.test(field.text) && !otherText.includes(term.zh)) {
              record(
                'locale-glossary',
                `${pair.zh.file} ${field.path} must name "${term.zh}" for the English ${term.en} in ${pair.en.file}`,
              )
            }
          }
        } else {
          checkZhGlossary(field, otherText, pair.en.file, record)
        }
      }
    }
  }
  return findings
}

/**
 * #F22: the two user-facing surfaces that used to sit outside the copy gate —
 * the Web client string catalogue and the preset runtime errors.
 *
 * The client catalogue ships as a browser chunk, so the gate loads it the way
 * the Web client does: the chunk registers itself on `window.__ModuleLoader__`
 * and its factory returns the EN/ZH dictionaries. Reading the rendered
 * dictionaries (instead of scraping the source) keeps object keys such as
 * `dock.mode.tooltip` — dots are config-key syntax on paper — out of the copy
 * side of the check.
 */
export const CLIENT_CATALOG_FILE = 'ui-bundle/client.locales.js'
/** #F22: the module that owns the preset failure copy. */
export const PRESET_ERROR_FILE = 'host/presets.js'
/** #F69: the module that owns the spawn-precondition failure copy. */
export const PRECHECK_ERROR_FILE = 'app/spawn-prechecks.js'
/** #F69: the module that owns the environment-health remedy copy. */
export const DOCTOR_ERROR_FILE = 'host/doctor.js'
/**
 * Client strings whose job is to quote the composer command the user has to
 * type. The dock chip is a non-interactive status display, so `/tower off` is
 * the only affordance for leaving Tower mode: those instructions keep the
 * command, and every other client string must describe the result instead.
 */
export const CLIENT_COMMAND_KEYS = Object.freeze([
  'dock.hint.title',
  'dock.mode.tooltip',
  'dock.mode.lastKnown',
  'dock.mode.unknownTooltip',
  'deny.hint',
])

/** Fill the `{name}` placeholders of one copy string. */
function fillCopyText(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

/**
 * Load the shipped client catalogue through the browser module shim.
 *
 * @param {string} root
 * @returns {{ EN?: Record<string, string>, ZH?: Record<string, string>, error?: string }}
 */
export function loadClientCatalog(root) {
  const file = path.join(root, CLIENT_CATALOG_FILE)
  if (!fs.existsSync(file)) {
    return { error: `${CLIENT_CATALOG_FILE} is missing; the client string catalogue cannot be checked` }
  }
  const source = fs.readFileSync(file, 'utf8')
  let definition = null
  const window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  try {
    new Function('window', source)(window)
  } catch (error) {
    return { error: `${CLIENT_CATALOG_FILE} cannot be loaded: ${String(error?.message ?? error)}` }
  }
  if (!definition || typeof definition.factory !== 'function') {
    return { error: `${CLIENT_CATALOG_FILE} must register through window.__ModuleLoader__.load({ factory })` }
  }
  let catalog
  try {
    catalog = definition.factory()
  } catch (error) {
    return { error: `${CLIENT_CATALOG_FILE} factory threw: ${String(error?.message ?? error)}` }
  }
  if (!catalog || typeof catalog.EN !== 'object' || typeof catalog.ZH !== 'object' || !catalog.EN || !catalog.ZH) {
    return { error: `${CLIENT_CATALOG_FILE} must return { EN, ZH } dictionaries` }
  }
  return { EN: catalog.EN, ZH: catalog.ZH }
}

/**
 * Check one pair of client dictionaries: parity, non-emptiness, banned syntax
 * (with the documented command-key exemption) and the glossary in both
 * directions.
 *
 * @param {Record<string, string>} EN
 * @param {Record<string, string>} ZH
 */
export function checkClientDictionaries(EN, ZH) {
  const findings = []
  const record = (code, message) => findings.push(finding(code, 'error', message))
  const en = EN && typeof EN === 'object' ? EN : {}
  const zh = ZH && typeof ZH === 'object' ? ZH : {}
  const enKeys = Object.keys(en)
  const zhKeys = Object.keys(zh)
  if (enKeys.length === 0) {
    record('client-copy-empty', `${CLIENT_CATALOG_FILE} carries no English dictionary`)
  }
  if (zhKeys.length === 0) {
    record('client-copy-empty', `${CLIENT_CATALOG_FILE} carries no Chinese dictionary`)
  }
  const zhSet = new Set(zhKeys)
  const enSet = new Set(enKeys)
  for (const key of enKeys) {
    if (!zhSet.has(key)) record('client-copy-parity', `${CLIENT_CATALOG_FILE} labels "${key}" in English but not in Chinese`)
  }
  for (const key of zhKeys) {
    if (!enSet.has(key)) record('client-copy-parity', `${CLIENT_CATALOG_FILE} labels "${key}" in Chinese but not in English`)
  }
  const ordered = [...COMPONENT_GLOSSARY].sort((a, b) => b.zh.length - a.zh.length)
  for (const [lang, dictionary, other] of [
    ['en', en, zh],
    ['zh', zh, en],
  ]) {
    for (const [key, value] of Object.entries(dictionary)) {
      const field = { file: CLIENT_CATALOG_FILE, path: `${key} (${lang})`, text: typeof value === 'string' ? value : '' }
      if (!field.text.trim()) {
        record('client-copy-empty', `${field.file} ${field.path} is empty`)
        continue
      }
      checkBannedCopy(field, lang, record, CLIENT_COPY_CODES, {
        allowCommand: CLIENT_COMMAND_KEYS.includes(key),
      })
      const otherText = other[key]
      if (typeof otherText !== 'string') continue
      if (lang === 'en') {
        for (const term of COMPONENT_GLOSSARY) {
          if (term.pattern.test(field.text) && !otherText.includes(term.zh)) {
            record(
              'client-copy-glossary',
              `${field.file} ${key} (zh) must name "${term.zh}" for the English ${term.en}`,
            )
          }
        }
      } else {
        let remaining = field.text
        for (const term of ordered) {
          if (!remaining.includes(term.zh)) continue
          remaining = remaining.split(term.zh).join(' ')
          if (!term.pattern.test(otherText)) {
            record(
              'client-copy-glossary',
              `${field.file} ${key} (en) must name the English ${term.en} for the Chinese "${term.zh}"`,
            )
          }
        }
      }
    }
  }
  return findings
}

/**
 * #F22: read and check the shipped client catalogue.
 *
 * @param {string} root
 */
export function checkClientCopy(root) {
  const catalog = loadClientCatalog(root)
  if (catalog.error) return [finding('client-catalog-unreadable', 'error', catalog.error)]
  return checkClientDictionaries(catalog.EN, catalog.ZH)
}

/**
 * Minimal JavaScript tokenizer: enough to walk the `ERROR_COPY` object literal
 * in host/presets.js while ignoring comments (which quote internal names on
 * purpose) and to reject anything that is not a plain `key: 'copy'` entry.
 *
 * @param {string} source
 * @returns {{ tokens?: Array<{ type: string, value: string, quote?: string, interpolated?: boolean }>, comments?: Array<[number, number]>, error?: string }}
 */
function tokenizeScript(source) {
  const tokens = []
  const comments = []
  const n = source.length
  let i = 0
  const skipNestedLiteral = (start, quote) => {
    let j = start
    while (j < n) {
      const char = source[j]
      if (char === '\\') {
        j += 2
        continue
      }
      if (char === quote) return j + 1
      j += 1
    }
    return n
  }
  const skipTemplateExpression = (start) => {
    let depth = 1
    let j = start
    while (j < n) {
      const char = source[j]
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) return j + 1
      } else if (char === "'" || char === '"' || char === '`') {
        j = skipNestedLiteral(j + 1, char)
        continue
      }
      j += 1
    }
    return n
  }
  while (i < n) {
    const char = source[i]
    if (char === '\n' || char === ' ' || char === '\t' || char === '\r') {
      i += 1
      continue
    }
    if (char === '/' && source[i + 1] === '/') {
      let end = source.indexOf('\n', i)
      if (end === -1) end = n
      comments.push([i, end])
      i = end
      continue
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      comments.push([i, stop])
      i = stop
      continue
    }
    if (char === "'" || char === '"') {
      let value = ''
      let j = i + 1
      let closed = false
      while (j < n) {
        const next = source[j]
        if (next === '\\') {
          value += source[j + 1] ?? ''
          j += 2
          continue
        }
        if (next === char) {
          closed = true
          j += 1
          break
        }
        value += next
        j += 1
      }
      if (!closed) return { error: `unterminated string literal at offset ${i}` }
      tokens.push({ type: 'string', value, quote: char })
      i = j
      continue
    }
    if (char === '`') {
      let value = ''
      let j = i + 1
      let closed = false
      let interpolated = false
      while (j < n) {
        const next = source[j]
        if (next === '\\') {
          value += source[j + 1] ?? ''
          j += 2
          continue
        }
        if (next === '`') {
          closed = true
          j += 1
          break
        }
        if (next === '$' && source[j + 1] === '{') {
          interpolated = true
          j = skipTemplateExpression(j + 2)
          continue
        }
        value += next
        j += 1
      }
      if (!closed) return { error: `unterminated template literal at offset ${i}` }
      tokens.push({ type: 'string', value, quote: '`', interpolated })
      i = j
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j += 1
      tokens.push({ type: 'ident', value: source.slice(i, j) })
      i = j
      continue
    }
    if (/[0-9]/.test(char)) {
      let j = i + 1
      while (j < n && /[0-9a-fx._]/i.test(source[j])) j += 1
      tokens.push({ type: 'number', value: source.slice(i, j) })
      i = j
      continue
    }
    if ('{}()[].,:=;'.includes(char)) {
      tokens.push({ type: 'punct', value: char })
      i += 1
      continue
    }
    i += 1
  }
  return { tokens, comments }
}

/** Blank out comments while keeping their newlines, for call-site matching. */
function stripComments(source) {
  const scanned = tokenizeScript(source)
  if (scanned.error || !scanned.comments) return source
  let out = ''
  let cursor = 0
  for (const [start, end] of scanned.comments) {
    out += source.slice(cursor, start)
    out += source.slice(start, end).replace(/[^\n]/g, ' ')
    cursor = end
  }
  return out + source.slice(cursor)
}

/**
 * Read one `const <table> = Object.freeze({ key: 'copy', ... })` copy table.
 * The table is the user-facing surface of a runtime module, so the gate can
 * check the real rendered sentences without executing the module (#F22, #F69).
 *
 * @param {string} source
 * @param {string} tableName
 * @param {string} fileLabel repository-relative path for findings
 * @returns {{ entries: Array<{ name: string, text: string }>, error?: string }}
 */
function parseCopyTable(source, tableName, fileLabel) {
  const shapeError = () =>
    `${fileLabel} must declare \`const ${tableName} = Object.freeze({ key: 'copy', ... })\`; the copy gate cannot read the user-facing copy`
  const scanned = tokenizeScript(source)
  const tokens = scanned.tokens ?? []
  const start = tokens.findIndex(
    (token, index) => token.type === 'ident' && token.value === tableName && tokens[index - 1]?.value === 'const',
  )
  if (start === -1) return { entries: [], error: shapeError() }
  const isPunct = (index, value) => tokens[index]?.type === 'punct' && tokens[index]?.value === value
  if (tokens[start + 1]?.value !== '=') return { entries: [], error: shapeError() }
  const freeze =
    tokens[start + 2]?.value === 'Object' &&
    tokens[start + 3]?.value === '.' &&
    tokens[start + 4]?.value === 'freeze' &&
    isPunct(start + 5, '(') &&
    isPunct(start + 6, '{')
  if (!freeze) return { entries: [], error: shapeError() }
  const entries = []
  let index = start + 7
  while (index < tokens.length) {
    const key = tokens[index]
    if (isPunct(index, '}')) return { entries }
    if (!(key.type === 'ident' || (key.type === 'string' && key.quote !== '`'))) {
      return { entries: [], error: shapeError() }
    }
    if (!isPunct(index + 1, ':')) return { entries: [], error: shapeError() }
    const value = tokens[index + 2]
    if (!value || value.type !== 'string' || value.interpolated === true || value.quote === '`') {
      return {
        entries: [],
        error: `${fileLabel} ${tableName}.${key.value} must be a plain quoted string; use {name} placeholders instead of template interpolation`,
      }
    }
    entries.push({ name: key.value, text: value.value })
    if (isPunct(index + 3, ',')) {
      index += 4
      continue
    }
    if (isPunct(index + 3, '}')) return { entries }
    return { entries: [], error: shapeError() }
  }
  return { entries: [], error: shapeError() }
}

/**
 * #F22: extract the `const ERROR_COPY = Object.freeze({ ... })` table from
 * host/presets.js.
 *
 * @param {string} source
 * @returns {{ entries: Array<{ name: string, text: string }>, error?: string }}
 */
export function parseErrorCopy(source) {
  return parseCopyTable(source, 'ERROR_COPY', PRESET_ERROR_FILE)
}

/**
 * #F22: check the preset failure copy — banned syntax, no unfilled
 * placeholders, the user-visible capability row, and a remedy.
 *
 * @param {string} source host/presets.js source
 * @param {string[]} rowTitles capability row titles from the English locale
 */
export function presetCopyFindings(source, rowTitles = []) {
  const findings = []
  const record = (code, message) => findings.push(finding(code, 'error', message))
  const code = stripComments(source)
  const callSites = [...code.matchAll(/new TowerToolError\(/g)].length
  const inlinePattern =
    /new TowerToolError\(\s*(['"])([a-z][a-z0-9-]*)\1\s*,\s*(?:fillCopy\(\s*)?ERROR_COPY\.([A-Za-z][A-Za-z0-9_]*)/g
  const inline = [...code.matchAll(inlinePattern)]
  if (inline.length !== callSites) {
    record(
      'preset-copy-unparsed',
      `${PRESET_ERROR_FILE} has ${callSites} TowerToolError message(s) but only ${inline.length} read from ERROR_COPY; keep every user-facing failure in the table so the copy gate can check it`,
    )
  }
  const parsed = parseErrorCopy(source)
  if (parsed.error) {
    record('preset-copy-unreadable', parsed.error)
    return findings
  }
  if (parsed.entries.length === 0) {
    record('preset-copy-empty', `${PRESET_ERROR_FILE} ERROR_COPY is empty`)
  }
  const known = new Set(parsed.entries.map((entry) => entry.name))
  for (const match of inline) {
    if (!known.has(match[3])) {
      record('preset-copy-unknown', `${PRESET_ERROR_FILE} throws ERROR_COPY.${match[3]}, which the table does not define`)
    }
  }
  const titles = rowTitles.filter((title) => typeof title === 'string' && title.trim() !== '')
  for (const entry of parsed.entries) {
    const field = { file: PRESET_ERROR_FILE, path: `ERROR_COPY.${entry.name}`, text: entry.text }
    checkBannedCopy(field, 'en', record, PRESET_COPY_CODES)
    const filled = fillCopyText(entry.text, { detail: '', lease: 'sample-lease' })
    const leftover = filled.match(/\{([A-Za-z][A-Za-z0-9_]*)\}/)
    if (leftover) {
      record(
        'preset-copy-placeholder',
        `${field.file} ${field.path} leaves the placeholder "{${leftover[1]}}" unfilled; fill it in host/presets.js and in the copy-gate self-test`,
      )
    }
    if (titles.length > 0 && !titles.some((title) => filled.includes(title))) {
      record(
        'preset-copy-row',
        `${field.file} ${field.path} names no user-visible capability row; name the plugin-page row the user switches back on (for example "${titles[0]}")`,
      )
    }
    if (!/plugin page|plugin configuration form/i.test(filled)) {
      record(
        'preset-copy-remedy',
        `${field.file} ${field.path} names no remedy; tell the user to switch the capability back on in the plugin page or clear the requirement on the plugin configuration form`,
      )
    }
  }
  return findings
}

/**
 * @param {string} root
 * @param {string[]} rowTitles capability row titles from the English locale
 */
export function checkPresetErrorCopy(root, rowTitles = []) {
  const file = path.join(root, PRESET_ERROR_FILE)
  if (!fs.existsSync(file)) {
    return [finding('preset-copy-unreadable', 'error', `${PRESET_ERROR_FILE} is missing; the preset failure copy cannot be checked`)]
  }
  return presetCopyFindings(fs.readFileSync(file, 'utf8'), rowTitles)
}

/**
 * Collect every `fillCopy(ERROR_COPY.<name>, { params })` reference in a token
 * stream. Placeholders are validated against the params the call actually
 * passes, so a typo cannot render a literal `{name}` to the user. The value
 * expression of each named param is recorded too: #F69 needs to know that a
 * preset id went through the label helper, which the table text alone cannot
 * show.
 *
 * @param {Array<{ type: string, value: string }>} tokens
 * @returns {Array<{ name: string, params: Set<string>, values: Map<string, string> }>}
 */
function fillCopyReferences(tokens) {
  const references = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (!(tokens[index].type === 'ident' && tokens[index].value === 'fillCopy')) continue
    if (tokens[index + 1]?.value !== '(') continue
    if (tokens[index + 2]?.value !== 'ERROR_COPY' || tokens[index + 3]?.value !== '.') continue
    const name = tokens[index + 4]?.value
    if (!name) continue
    const params = new Set()
    const values = new Map()
    if (tokens[index + 5]?.value === ',') {
      let cursor = index + 6
      let depth = 0
      while (cursor < tokens.length) {
        const token = tokens[cursor]
        if (token.value === '{') {
          depth += 1
          cursor += 1
          continue
        }
        if (token.value === '}') {
          depth -= 1
          if (depth === 0) break
          cursor += 1
          continue
        }
        if (token.type === 'ident' && depth === 1) {
          const previous = tokens[cursor - 1]?.value
          const next = tokens[cursor + 1]?.value
          // Shorthand (`{ name }`) or explicit (`{ name: value }`) keys. The
          // identifiers inside a value expression are not parameters.
          if (next === ':' || previous === '{' || previous === ',') {
            params.add(token.value)
            if (next === ':') {
              const parts = []
              let inner = 0
              for (let scan = cursor + 2; scan < tokens.length; scan += 1) {
                const part = tokens[scan]
                if (part.value === '(' || part.value === '[' || part.value === '{') inner += 1
                else if (part.value === ')' || part.value === ']' || part.value === '}') {
                  if (inner === 0) break
                  inner -= 1
                } else if (part.value === ',' && inner === 0) break
                parts.push(part.value)
              }
              values.set(token.value, parts.join(' '))
            }
          }
        }
        cursor += 1
      }
    }
    references.push({ name, params, values })
  }
  return references
}

/**
 * #F69: check the spawn-precondition failure copy. Every `TowerToolError` in
 * app/spawn-prechecks.js must read its message from ERROR_COPY (except the
 * domain blocker passthrough, whose prose belongs to the role contract), the
 * table must avoid internal identifiers and row ids, every entry must be used,
 * and every `{placeholder}` must be filled by its call site.
 *
 * @param {string} source app/spawn-prechecks.js source
 * @returns {Array<{ code: string, level: string, message: string }>}
 */
export function precheckCopyFindings(source) {
  const findings = []
  const record = (code, message) => findings.push(finding(code, 'error', message))
  const code = stripComments(source)
  const callSites = [...code.matchAll(/new TowerToolError\(/g)].length
  const tablePattern =
    /new TowerToolError\(\s*(['"])([a-z][a-z0-9-]*)\1\s*,\s*(?:fillCopy\(\s*)?ERROR_COPY\.([A-Za-z][A-Za-z0-9_]*)/g
  const tableCalls = [...code.matchAll(tablePattern)]
  const blockerCalls = [...code.matchAll(/new TowerToolError\(\s*blocker\.code\s*,\s*blocker\.message\s*\)/g)].length
  if (tableCalls.length + blockerCalls !== callSites) {
    record(
      'precheck-copy-unparsed',
      `${PRECHECK_ERROR_FILE} has ${callSites} TowerToolError message(s) but only ${tableCalls.length + blockerCalls} are read from ERROR_COPY; keep every user-facing failure in the table so the copy gate can check it`,
    )
  }
  if (/nextAction:\s*(['"`])/.test(code)) {
    record(
      'precheck-copy-literal-action',
      `${PRECHECK_ERROR_FILE} passes a literal nextAction; keep the rendered next step in ERROR_COPY so the copy gate can check it`,
    )
  }
  const parsed = parseCopyTable(source, 'ERROR_COPY', PRECHECK_ERROR_FILE)
  if (parsed.error) {
    record('precheck-copy-unreadable', parsed.error)
    return findings
  }
  if (parsed.entries.length === 0) record('precheck-copy-empty', `${PRECHECK_ERROR_FILE} ERROR_COPY is empty`)
  const known = new Set(parsed.entries.map((entry) => entry.name))
  for (const match of tableCalls) {
    if (!known.has(match[3])) {
      record('precheck-copy-unknown', `${PRECHECK_ERROR_FILE} throws ERROR_COPY.${match[3]}, which the table does not define`)
    }
  }
  const tokens = tokenizeScript(source).tokens ?? []
  const references = fillCopyReferences(tokens)
  const referenced = new Set(references.map((reference) => reference.name))
  // #F69: the built-in preset id must never reach the message. The table text
  // only has a placeholder, so the check reads the call-site expression: the
  // `preset` parameter of these two entries has to come from the label helper.
  // (The custom-preset entry is checked separately and intentionally renders the
  // operator's configured id.)
  for (const reference of references) {
    if (reference.name !== 'presetMissing' && reference.name !== 'presetMissingNext') continue
    const value = reference.values?.get('preset') ?? ''
    if (!/\bpresetLabel\s*\(/.test(value)) {
      record(
        'precheck-copy-raw-preset',
        `${PRECHECK_ERROR_FILE} fills ERROR_COPY.${reference.name} with the raw preset id; render it through presetLabel() so a built-in row reads "Tower Worker preset" instead of "tower-worker"`,
      )
    }
  }
  const paramsByEntry = new Map()
  for (const reference of references) {
    if (!paramsByEntry.has(reference.name)) paramsByEntry.set(reference.name, new Set())
    for (const param of reference.params) paramsByEntry.get(reference.name).add(param)
  }
  for (const entry of parsed.entries) {
    const field = { file: PRECHECK_ERROR_FILE, path: `ERROR_COPY.${entry.name}`, text: entry.text }
    if (!referenced.has(entry.name)) {
      record(
        'precheck-copy-unused',
        `${PRECHECK_ERROR_FILE} ERROR_COPY.${entry.name} is never used; remove it or read it from the throw site`,
      )
    }
    checkBannedCopy(field, 'en', record, PRECHECK_COPY_CODES)
    const params = paramsByEntry.get(entry.name) ?? new Set()
    for (const match of entry.text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) {
      if (!params.has(match[1])) {
        record(
          'precheck-copy-placeholder',
          `${PRECHECK_ERROR_FILE} ERROR_COPY.${entry.name} renders the placeholder "{${match[1]}}" without a matching call-site parameter`,
        )
      }
    }
  }
  return findings
}

/**
 * @param {string} root
 */
export function checkPrecheckErrorCopy(root) {
  const file = path.join(root, PRECHECK_ERROR_FILE)
  if (!fs.existsSync(file)) {
    return [finding('precheck-copy-unreadable', 'error', `${PRECHECK_ERROR_FILE} is missing; the spawn-precondition failure copy cannot be checked`)]
  }
  return precheckCopyFindings(fs.readFileSync(file, 'utf8'))
}

/**
 * #F69: check the remedy copy of the environment-health checks. A doctor
 * `check(id, status, detail, action)` action is the sentence a reader acts on,
 * so it must name a capability and a next step, never a config key, a tool id,
 * a slash command or a capability row id. Diagnostic details stay in the detail
 * field, where naming a component or a path is the fact being reported.
 *
 * @param {string} source host/doctor.js source
 * @returns {Array<{ code: string, level: string, message: string }>}
 */
export function doctorCopyFindings(source) {
  const findings = []
  const record = (code, message) => findings.push(finding(code, 'error', message))
  const scanned = tokenizeScript(source)
  if (scanned.error) {
    record('doctor-copy-unreadable', `${DOCTOR_ERROR_FILE} cannot be read: ${scanned.error}`)
    return findings
  }
  const tokens = scanned.tokens
  let actions = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!(token.type === 'ident' && token.value === 'check')) continue
    if (tokens[index - 1]?.value === 'function') continue
    if (!(tokens[index + 1]?.type === 'punct' && tokens[index + 1].value === '(')) continue
    const args = []
    let current = []
    let depth = 0
    let closed = false
    for (let cursor = index + 2; cursor < tokens.length; cursor += 1) {
      const next = tokens[cursor]
      if (next.type === 'punct') {
        if (next.value === '(' || next.value === '[' || next.value === '{') depth += 1
        else if (next.value === ')' || next.value === ']' || next.value === '}') {
          if (depth === 0 && next.value === ')') {
            closed = true
            break
          }
          depth -= 1
        } else if (next.value === ',' && depth === 0) {
          args.push(current)
          current = []
          continue
        }
      }
      current.push(next)
    }
    if (!closed) continue
    args.push(current)
    if (args.length < 4) continue
    actions += 1
    for (const argument of args[3]) {
      if (argument.type !== 'string') continue
      checkBannedCopy(
        { file: DOCTOR_ERROR_FILE, path: 'check(..., action)', text: argument.value },
        'en',
        record,
        DOCTOR_COPY_CODES,
      )
    }
  }
  if (actions === 0) {
    record(
      'doctor-copy-unparsed',
      `${DOCTOR_ERROR_FILE} declares no check(..., action) remedy; the copy gate cannot read the environment-health remedy copy`,
    )
  }
  return findings
}

/**
 * @param {string} root
 */
export function checkDoctorCopy(root) {
  const file = path.join(root, DOCTOR_ERROR_FILE)
  if (!fs.existsSync(file)) {
    return [finding('doctor-copy-unreadable', 'error', `${DOCTOR_ERROR_FILE} is missing; the environment-health remedy copy cannot be checked`)]
  }
  return doctorCopyFindings(fs.readFileSync(file, 'utf8'))
}

/**
 * The plugin-page capability rows a failure may name: every labelled component
 * except the product row and the Web-client row, whose titles are brand names
 * rather than a switchable capability.
 *
 * @param {any} localePayload locale/en.json payload
 * @returns {string[]}
 */
export function capabilityRowTitles(localePayload) {
  const titles = []
  for (const entry of Object.values(localePayload?.components ?? {})) {
    const title = typeof entry?.title === 'string' ? entry.title.trim() : ''
    if (!title) continue
    if (title === 'Tower' || title === 'Tower UI') continue
    titles.push(title)
  }
  return titles
}

/**
 * #F22: the copy gate checks itself. Each planted leak must produce its code,
 * and each clean instruction must not. A green self-test is part of
 * `docs:check:components`, so a refactor that quiets the detectors turns the
 * gate red instead of silently passing every surface.
 *
 * @returns {Array<{ code: string, level: string, message: string }>}
 */
export function checkCopyGateSelfTest() {
  const failures = []
  const expectFinding = (name, findings, code) => {
    if (!Array.isArray(findings) || !findings.some((entry) => entry.code === code)) {
      failures.push(finding('copy-gate-self-test', 'error', `copy gate self-test: ${name} was not caught as ${code}`))
    }
  }
  const expectClean = (name, findings) => {
    const relevant = (findings ?? []).filter((entry) => entry.level === 'error')
    if (relevant.length > 0) {
      failures.push(
        finding(
          'copy-gate-self-test',
          'error',
          `copy gate self-test: ${name} reported ${[...new Set(relevant.map((entry) => entry.code))].join(', ')}`,
        ),
      )
    }
  }
  const localePair = (en, zh) => [
    {
      en: { file: 'locale/en.json', payload: { meta: { title: 'Tower', description: en } } },
      zh: { file: 'locale/zh.json', payload: { meta: { title: 'Tower', description: zh } } },
    },
  ]
  expectFinding(
    'a config key in label copy',
    checkLocaleCopy(localePair('Missions.', '任务线。gates.requireTests 已开启。')),
    'locale-copy-config-key',
  )
  expectFinding(
    'a config key in the client catalogue',
    checkClientDictionaries({ 'card.title': 'Gates.requireTests is on' }, { 'card.title': '任务线' }),
    'client-copy-config-key',
  )
  expectFinding(
    'a tool id in the client catalogue',
    checkClientDictionaries({ 'card.title': 'tower_batch is running' }, { 'card.title': '任务线' }),
    'client-copy-tool-id',
  )
  expectFinding(
    'a command outside the instruction keys',
    checkClientDictionaries(
      { 'card.title': 'Run /tower off first' },
      { 'card.title': '先执行 /tower off' },
    ),
    'client-copy-command',
  )
  expectClean(
    'a command in an instruction key',
    checkClientDictionaries(
      { 'dock.mode.tooltip': 'Run /tower off in the composer' },
      { 'dock.mode.tooltip': '在输入框中执行 /tower off 可退出' },
    ),
  )
  expectFinding(
    'a glossary drift in the client catalogue',
    checkClientDictionaries({ 'card.missionLine': 'mission {id}' }, { 'card.missionLine': '任务 {id}' }),
    'client-copy-glossary',
  )
  const plantedPreset = [
    '// `tower_resource` is quoted in this comment on purpose.',
    'const ERROR_COPY = Object.freeze({',
    "  requireTests: 'The Test evidence row is off; switch it back on in the plugin page. gates.requireTests is on.',",
    '})',
    "export function boom() { throw new TowerToolError('config-invalid', fillCopy(ERROR_COPY.requireTests)) }",
  ].join('\n')
  const planted = presetCopyFindings(plantedPreset, ['Test evidence'])
  expectFinding('a config key in the preset copy', planted, 'preset-copy-config-key')
  if (planted.some((entry) => entry.code === 'preset-copy-tool-id')) {
    failures.push(
      finding('copy-gate-self-test', 'error', 'copy gate self-test: a comment quoting an internal name was read as copy'),
    )
  }
  expectFinding(
    'a preset message outside the copy table',
    presetCopyFindings(
      [
        'const ERROR_COPY = Object.freeze({ ok: "The Test evidence row is off; switch it back on in the plugin page." })',
        "export function boom() { throw new TowerToolError('config-invalid', 'switch it back on in the plugin page') }",
      ].join('\n'),
      ['Test evidence'],
    ),
    'preset-copy-unparsed',
  )
  expectFinding(
    'a preset message with no capability row',
    presetCopyFindings(
      ['const ERROR_COPY = Object.freeze({', "  locked: 'Planning is refused. Switch it back on in the plugin page.',", '})'].join(
        '\n',
      ),
      ['Test evidence'],
    ),
    'preset-copy-row',
  )
  expectFinding(
    'a preset message with no remedy',
    presetCopyFindings(
      ['const ERROR_COPY = Object.freeze({', "  locked: 'The Test evidence row is off.',", '})'].join('\n'),
      ['Test evidence'],
    ),
    'preset-copy-remedy',
  )
  expectFinding(
    'an unknown preset placeholder',
    presetCopyFindings(
      [
        'const ERROR_COPY = Object.freeze({',
        '  lease: \'The lease "{tenant}" is missing; switch it back on in the plugin page.\',',
        '})',
      ].join('\n'),
      ['Test evidence'],
    ),
    'preset-copy-placeholder',
  )
  // #F69: the spawn-precondition failures and the environment-health remedies
  // are runtime copy the user reads mid-task. The same detectors must fire on
  // both, and a clean sentence with its placeholder must stay green.
  const cleanPrecheck = [
    'const ERROR_COPY = Object.freeze({',
    '  lease: \'the required lease "{lease}" cannot be satisfied: Lease coordination is switched off in the plugin page; switch it back on and restart DSH\',',
    '})',
    "export function precheckSpawnServices(lease) { throw new TowerToolError('lease-busy', fillCopy(ERROR_COPY.lease, { lease })) }",
  ].join('\n')
  expectClean('a clean spawn-precondition message', precheckCopyFindings(cleanPrecheck))
  expectFinding(
    'a config key in the spawn-precondition copy',
    precheckCopyFindings(
      [
        'const ERROR_COPY = Object.freeze({',
        "  lease: 'the required lease is not held, so spawn.requireLease is on and the spawn fails',",
        '})',
        "export function boom() { throw new TowerToolError('lease-busy', fillCopy(ERROR_COPY.lease)) }",
      ].join('\n'),
    ),
    'precheck-copy-config-key',
  )
  expectFinding(
    'a tool id in the spawn-precondition copy',
    precheckCopyFindings(
      [
        'const ERROR_COPY = Object.freeze({',
        "  lease: 'no live lease is held; acquire it with tower_resource before spawning',",
        '})',
        "export function boom() { throw new TowerToolError('lease-busy', fillCopy(ERROR_COPY.lease)) }",
      ].join('\n'),
    ),
    'precheck-copy-tool-id',
  )
  expectFinding(
    'a row id in the spawn-precondition copy',
    precheckCopyFindings(
      [
        'const ERROR_COPY = Object.freeze({',
        "  lease: 'the required lease is not held; switch the tower-leases row back on in the plugin page',",
        '})',
        "export function boom() { throw new TowerToolError('lease-busy', fillCopy(ERROR_COPY.lease)) }",
      ].join('\n'),
    ),
    'precheck-copy-row-id',
  )
  expectFinding(
    'a module specifier in the spawn-precondition copy',
    precheckCopyFindings(
      [
        'const ERROR_COPY = Object.freeze({',
        "  lease: 'the required lease is not held; install dsh-tower/preset-worker first',",
        '})',
        "export function boom() { throw new TowerToolError('lease-busy', fillCopy(ERROR_COPY.lease)) }",
      ].join('\n'),
    ),
    'precheck-copy-module',
  )
  expectFinding(
    'a slash command in the spawn-precondition copy',
    precheckCopyFindings(
      [
        'const ERROR_COPY = Object.freeze({',
        "  lease: 'the required lease is not held; run /tower takeover first',",
        '})',
        "export function boom() { throw new TowerToolError('lease-busy', fillCopy(ERROR_COPY.lease)) }",
      ].join('\n'),
    ),
    'precheck-copy-command',
  )
  expectFinding(
    'a raw preset id in the spawn-precondition copy',
    precheckCopyFindings(
      [
        'const ERROR_COPY = Object.freeze({',
        "  presetMissing: 'the {preset} is not registered',",
        "  presetMissingNext: 'switch the {preset} back on in the plugin page and restart DSH',",
        '})',
        "export function boom(preset) { throw new TowerToolError('preset-missing', fillCopy(ERROR_COPY.presetMissing, { preset }), { nextAction: fillCopy(ERROR_COPY.presetMissingNext, { preset }) }) }",
      ].join('\n'),
    ),
    'precheck-copy-raw-preset',
  )
  expectFinding(
    'a spawn-precondition message outside the copy table',
    precheckCopyFindings(
      [
        'const ERROR_COPY = Object.freeze({',
        "  lease: 'the required lease is not held; acquire it with the lease action before starting an agent',",
        '})',
        "export function boom() { throw new TowerToolError('lease-busy', 'spawn.requireLease is set') }",
      ].join('\n'),
    ),
    'precheck-copy-unparsed',
  )
  expectFinding(
    'a literal next step in a spawn-precondition failure',
    precheckCopyFindings(
      [
        'const ERROR_COPY = Object.freeze({',
        "  lease: 'the required lease is not held; acquire it with the lease action before starting an agent',",
        '})',
        "export function boom() { throw new TowerToolError('lease-busy', fillCopy(ERROR_COPY.lease), { nextAction: 'run tower_recover' }) }",
      ].join('\n'),
    ),
    'precheck-copy-literal-action',
  )
  const cleanDoctor = [
    'function doctor() {',
    "  check('spawn-lease', 'pass', 'A lease is required and Lease coordination is on')",
    "  check('state-lock', 'pass', 'the lock is held by this session', 'no action needed')",
    '}',
  ].join('\n')
  expectClean('a clean environment-health remedy', doctorCopyFindings(cleanDoctor))
  expectFinding(
    'a tool id in an environment-health remedy',
    doctorCopyFindings(
      ["function doctor() { check('state-lock', 'warn', 'the lock is silent', 'run tower_recover clear-stale-lock force:true to clear it') }"].join(
        '\n',
      ),
    ),
    'doctor-copy-tool-id',
  )
  expectFinding(
    'a config key in an environment-health remedy',
    doctorCopyFindings(
      ["function doctor() { check('activity-log', 'warn', 'rotation is off', 'set activity.maxBytes above 0 to bound the log') }"].join(
        '\n',
      ),
    ),
    'doctor-copy-config-key',
  )
  expectFinding(
    'a row id in an environment-health remedy',
    doctorCopyFindings(
      ["function doctor() { check('spawn-lease', 'fail', 'the lease is required', 'switch the tower-leases row back on in the plugin page') }"].join(
        '\n',
      ),
    ),
    'doctor-copy-row-id',
  )
  expectFinding(
    'a slash command in an environment-health remedy',
    doctorCopyFindings(
      ["function doctor() { check('takeover', 'fail', 'another session owns the repo', 'run /tower takeover <reason> to claim it') }"].join(
        '\n',
      ),
    ),
    'doctor-copy-command',
  )
  expectFinding(
    'a module specifier in an environment-health remedy',
    doctorCopyFindings(
      ["function doctor() { check('presets', 'fail', 'a preset is missing', 'install dsh-tower/preset-worker and restart DSH') }"].join('\n'),
    ),
    'doctor-copy-module',
  )
  return failures
}

/**
 * #137: the ui-bundle row labels its own package with a hand-written `meta`
 * block, but its single source is still `components['tower-ui']` in the root
 * locale. Pin the meta text to exactly what the row-locale generator would
 * render, so the hand-written copy cannot drift from the source of truth.
 *
 * @param {string[]} metaRowIds visible rows that ship their own meta label
 * @param {Record<string, any>} locales root locale file -> payload
 * @param {Record<string, any>} metaLocales package meta locale file -> payload
 * @param {Record<string, string>} markers off-effect label per language
 */
export function checkMetaRowCopy(metaRowIds, locales, metaLocales, markers) {
  const findings = []
  const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
  const rootLocaleFor = (lang) => LOCALE_FILES.find((file) => file.endsWith(`/${lang}.json`))
  for (const file of META_LOCALE_FILES) {
    const lang = path.basename(file, '.json') === 'zh' ? 'zh' : 'en'
    const meta = metaLocales?.[file]?.meta
    if (!meta || typeof meta.title !== 'string' || typeof meta.description !== 'string') continue
    const rootFile = rootLocaleFor(lang)
    const space = lang === 'zh' ? '' : ' '
    for (const id of metaRowIds ?? []) {
      const entry = locales?.[rootFile]?.components?.[id]
      if (!entry) {
        findings.push(
          finding(
            'meta-row-source',
            'error',
            `${file} labels ${id}, but ${rootFile} has no components.${id} entry to source it from`,
          ),
        )
        continue
      }
      if (
        typeof entry.title !== 'string' ||
        typeof entry.summary !== 'string' ||
        typeof entry.disables !== 'string'
      ) {
        continue // already reported by the locale coverage rule
      }
      if (normalize(meta.title) !== normalize(entry.title)) {
        findings.push(
          finding('meta-row-copy', 'error', `${file} meta.title must equal components.${id}.title in ${rootFile}`),
        )
      }
      const expected = normalize(`${entry.summary}${space}${markers[lang]}${space}${entry.disables}`)
      if (normalize(meta.description) !== expected) {
        findings.push(
          finding(
            'meta-row-copy',
            'error',
            `${file} meta.description must be components.${id} summary + off-effect label + disables, exactly as the row-locale generator renders it`,
          ),
        )
      }
    }
  }
  return findings
}

/**
 * #137: the glossary is a gate input, so the document that records it must
 * exist and still name every canonical term pair. Copy and policy cannot drift
 * apart silently.
 *
 * @param {string} root
 */
export function checkGlossaryFile(root) {
  const file = path.join(root, GLOSSARY_FILE)
  if (!fs.existsSync(file)) {
    return [
      finding(
        'glossary-missing',
        'error',
        `${GLOSSARY_FILE} is missing; the bilingual label vocabulary has to be recorded in one place`,
      ),
    ]
  }
  const text = fs.readFileSync(file, 'utf8')
  const findings = []
  for (const term of COMPONENT_GLOSSARY) {
    if (!text.includes(term.en) || !text.includes(term.zh)) {
      findings.push(
        finding(
          'glossary-term',
          'error',
          `${GLOSSARY_FILE} does not record both "${term.en}" and "${term.zh}"`,
        ),
      )
    }
  }
  return findings
}

/**
 * The generated row-label map is a coverage axis of its own (#121). A component
 * that ships a `<specifier>/locale/<lang>.json` label must carry `title`,
 * `summary` and `disables` in every shipped locale — including an internal
 * component such as the mandatory worker preset, which the visible-only rule in
 * `domain/components.js` deliberately does not cover.
 *
 * `rows` is the generator's declaration (`{ specifier, component, mandatory? }`).
 * When a row records `mandatory`, it must agree with the component-surface
 * scope: an internal component is a dependency, never a switch. That is how the
 * worker's "mandatory dependency" description and the component policy stay one
 * decision.
 *
 * @param {any} surface the parsed `scripts/component-surface.json`
 * @param {Record<string, any>} locales file path -> parsed locale JSON
 * @param {Array<{ specifier: string, component: string, mandatory?: boolean }>} rows
 */
export function checkRowLocaleCoverage(surface, locales, rows) {
  const findings = []
  const record = (code, message) => findings.push(finding(code, 'error', message))
  const components = new Map(surface.components.map((component) => [component.id, component]))
  for (const row of rows ?? []) {
    const component = components.get(row?.component)
    if (!component) {
      record(
        'row-locale-unknown',
        `row locale "${row?.specifier}" names component "${row?.component}", which the component surface does not declare`,
      )
      continue
    }
    if (typeof row.mandatory === 'boolean' && row.mandatory !== (component.scope === 'internal')) {
      record(
        'row-locale-scope',
        `row locale "${row.specifier}" labels ${component.id} ${row.mandatory ? 'mandatory' : 'optional'}, but the component surface scope is ${component.scope}`,
      )
    }
    for (const file of LOCALE_FILES) {
      const entry = locales?.[file]?.components?.[component.id]
      if (!entry || typeof entry !== 'object') {
        record('row-locale', `row locale ${component.id} has no entry in ${file}`)
        continue
      }
      for (const field of LOCALE_FIELDS) {
        const value = typeof entry[field] === 'string' ? entry[field].trim() : ''
        if (!value) record('row-locale', `row locale ${component.id} misses "${field}" in ${file}`)
      }
    }
  }
  return findings
}

/** The live config keys and their schema type, derived from schemastery. */
export function liveKeyTypes() {
  /** @type {Record<string, string>} */
  const types = {}
  for (const [key, schema] of Object.entries(Config.dict ?? {})) {
    const dict = schema?.dict
    if (dict && typeof dict === 'object') {
      for (const [child, childSchema] of Object.entries(dict)) {
        types[`${key}.${child}`] = childSchema?.type ?? 'unknown'
      }
    } else {
      types[key] = schema?.type ?? 'unknown'
    }
  }
  return types
}

/** The live boolean config keys, derived from the schemastery schema. */
function liveBooleanKeys() {
  return Object.entries(liveKeyTypes())
    .filter(([, type]) => type === 'boolean')
    .map(([key]) => key)
}

/**
 * #138.2: import the OPERATIONAL_TOOLS table from host/tool-registry.js. The old
 * regex scraper treated "found nothing" and "could not read the file" as the same
 * empty route table. An empty Map is a legitimate determined state; a missing
 * file, an import error or a missing/non-Map export is a gate failure.
 *
 * The import is dynamic and rooted at the checked directory, so the gate reads
 * the module the package actually ships. The table is checked for shape before
 * it reaches the denylist.
 *
 * @returns {Promise<{ routes?: Record<string, string>, error?: string }>}
 */
async function operationalRegistry(root) {
  const file = path.join(root, REGISTRY_FILE)
  if (!fs.existsSync(file)) {
    return { error: `${REGISTRY_FILE} is missing; the operational-tool route table cannot be determined` }
  }
  let module
  try {
    module = await import(pathToFileURL(file).href)
  } catch (error) {
    return { error: `${REGISTRY_FILE} cannot be imported: ${String(error?.message ?? error)}` }
  }
  const table = module.OPERATIONAL_TOOLS
  if (!(table instanceof Map)) {
    return { error: `${REGISTRY_FILE} must export OPERATIONAL_TOOLS as a Map; the route table cannot be determined` }
  }
  /** @type {Record<string, string>} */
  const routes = {}
  for (const [tool, flag] of table) {
    if (typeof tool !== 'string' || !tool || typeof flag !== 'string' || !flag) {
      return { error: `${REGISTRY_FILE} OPERATIONAL_TOOLS contains a route whose tool or switch is not a non-empty string` }
    }
    routes[tool] = flag
  }
  return { routes }
}

/** Read the live inputs the pure checks need: schema, patches, locales, registry. */
export async function componentCheckData(root) {
  const config = configSurface()
  const keyTypes = liveKeyTypes()
  const registry = await operationalRegistry(root)
  // #134: the policy gate reads every shipped patch, not only the root one. A row
  // added to `ui-bundle/cordis.patch.yml` without a classification must fail here.
  const patches = {}
  for (const file of COMPONENT_PATCH_FILES) {
    const patchFile = path.join(root, file)
    patches[file] = fs.existsSync(patchFile)
      ? parseCordisPatch(fs.readFileSync(patchFile, 'utf8'))
      : { rows: [], visible: [] }
  }
  const patch = mergeCordisPatches(patches)
  const locales = {}
  for (const file of LOCALE_FILES) {
    const localeFile = path.join(root, file)
    locales[file] = fs.existsSync(localeFile) ? JSON.parse(fs.readFileSync(localeFile, 'utf8')) : null
  }
  // A package that ships its own patch labels its rows with its own meta block.
  const metaLocales = {}
  for (const file of META_LOCALE_FILES) {
    const localeFile = path.join(root, file)
    metaLocales[file] = fs.existsSync(localeFile) ? JSON.parse(fs.readFileSync(localeFile, 'utf8')) : null
  }
  // #137: the generated row labels are user-facing copy too, so the copy gate
  // reads them alongside the hand-written root and ui-bundle locales.
  const rowLocales = {}
  for (const file of rowLocalePaths()) {
    const localeFile = path.join(root, file)
    rowLocales[file] = fs.existsSync(localeFile) ? JSON.parse(fs.readFileSync(localeFile, 'utf8')) : null
  }
  return {
    configKeys: config.keys,
    sections: config.sections,
    keyTypes,
    booleans: liveBooleanKeys(),
    registry: registry.routes ?? {},
    registryError: registry.error ?? null,
    patches,
    patch,
    locales,
    metaLocales,
    rowLocales,
  }
}

/**
 * #138.3: a shipped `cordis.patch.yml` that the policy does not read is an
 * unreviewed component surface. Discover every patch in the package and compare
 * it with COMPONENT_PATCH_FILES in both directions, so a new patch fails until
 * its rows are classified and a listed-but-missing patch fails rather than
 * silently contributing zero rows.
 *
 * @param {string} root
 * @returns {string[]} repository-relative paths, POSIX separators
 */
export function discoverShippedPatches(root) {
  const found = []
  const skip = new Set(['.git', 'node_modules', 'coverage', '.dsh-tower-worktrees'])
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'cordis.patch.yml') found.push(path.relative(root, full).replace(/\\/g, '/'))
    }
  }
  walk(root)
  return found.sort()
}

/**
 * @param {string[]} discovered repository-relative patch paths
 * @returns {Array<{ code: string, level: string, message: string }>}
 */
export function checkShippedPatchCoverage(discovered) {
  const findings = []
  for (const file of discovered) {
    if (!COMPONENT_PATCH_FILES.includes(file)) {
      findings.push(
        finding(
          'patch-unclassified',
          'error',
          `${file} is a shipped cordis.patch.yml but is not in COMPONENT_PATCH_FILES; add it to the policy before its rows can ship`,
        ),
      )
    }
  }
  for (const file of COMPONENT_PATCH_FILES) {
    if (!discovered.includes(file)) {
      findings.push(finding('patch-missing', 'error', `${file} is listed in COMPONENT_PATCH_FILES but does not exist`))
    }
  }
  return findings
}

/**
 * #134: every visible row needs a label source. Rows in the root patch use the
 * generated `<specifier>/locale/*.json` files (capability rows) or the package
 * root `meta` (the group); rows that ship in their own package use that package's
 * `meta.title` / `meta.description`. A visible row with neither source shows only
 * its module specifier on the Plugins page, so it is a gate failure.
 *
 * @param {{ rows: Array<{ id: string, scope: string, kind: string, patch: string }> }} patch merged patch
 * @param {Array<{ component: string }>} rowLocales the generator declaration
 */
export function checkRowLabelSources(patch, rowLocales) {
  const findings = []
  const generated = new Set((rowLocales ?? []).map((row) => row.component))
  for (const row of patch?.rows ?? []) {
    if (row.scope !== 'visible' || row.kind === 'group') continue
    if (generated.has(row.id)) continue
    if (META_LABEL_PATCHES.includes(row.patch)) continue
    findings.push(
      finding(
        'row-locale-missing',
        'error',
        `visible component "${row.id}" (${row.patch}) ships neither a generated <specifier>/locale label nor a package meta label`,
      ),
    )
  }
  return findings
}

// #M42: the review policy is one tri-state configuration control on the plugin
// page. These names are the policy-shaped rows the gate refuses to see: a row
// per mode (or one "review policy" row) is the shape the product replaced.
export const REVIEW_POLICY_KEY = 'review.mode'
export const REVIEW_REVIEWER_ROW = 'preset-tower-reviewer'
const REVIEW_POLICY_ROW_IDS = Object.freeze([
  'review',
  'review-policy',
  'review-mode',
  'review-modes',
  'tower-review',
  'tower-review-policy',
])

/**
 * #M42: hold the review control to its declared shape. The policy is one
 * tri-state control (`off`/`optional`/`required`) on the plugin-page
 * configuration form, not a component row and not three mutually exclusive rows.
 *
 * The gate fails when a review-policy-shaped row exists, when a component
 * `allowedOverrides` or a shipped row's `config:` block owns `review.mode` (the
 * only review policy key since 2.8.0 removed the boolean alias), when the
 * non-disableable required-mode gate is not recorded on the forbidden list, and
 * when a forbidden capability claims the reviewer preset row as a disabler. The
 * reviewer row is an optional capability: it may be off while the policy is off
 * or optional, and is only a precondition (with an explanatory refusal) under
 * required.
 *
 * @param {ReturnType<typeof parseComponentSurface>} surface
 * @param {{ patch?: ReturnType<typeof parseCordisPatch> }} live
 */
export function checkReviewPolicySurface(surface, live) {
  const findings = []
  const record = (code, message) => findings.push(finding(code, 'error', message))
  const components = surface?.components ?? []
  const byName = new Map((surface?.keys ?? []).map((key) => [key.name, key]))

  for (const name of [REVIEW_POLICY_KEY]) {
    const key = byName.get(name)
    if (!key) {
      record('review-policy-key', `${name} is missing from the component surface; the review policy needs an explicit class`)
      continue
    }
    if (key.class !== 'core') {
      record(
        'review-policy-class',
        `${name} is classified "${key.class}"; the review policy is one tri-state configuration control and its keys must be core, never a switch a row can turn off`,
      )
    }
  }

  const policyRow = components.find((component) => REVIEW_POLICY_ROW_IDS.includes(component.id))
  if (policyRow) {
    record(
      'review-policy-row',
      `component "${policyRow.id}" is a review-policy row; the review policy is one tri-state control on the plugin-page configuration form, not a component row and never one row per mode`,
    )
  }

  const reviewerRow = components.find((component) => component.id === REVIEW_REVIEWER_ROW)
  if (!reviewerRow) {
    record(
      'review-policy-reviewer-row',
      `${REVIEW_REVIEWER_ROW} is missing from the component surface; the reviewer preset must stay an optional capability the review policy may leave unused`,
    )
  }

  for (const component of components) {
    for (const override of component.allowedOverrides ?? []) {
      if (override !== REVIEW_POLICY_KEY) continue
      record(
        'review-policy-switch',
        `component "${component.id}" lists ${override} in allowedOverrides; the review policy is one tri-state configuration control and no component row may own it`,
      )
    }
  }

  for (const row of live?.patch?.rows ?? []) {
    for (const override of row.configOverrides ?? []) {
      if (override.key !== REVIEW_POLICY_KEY) continue
      record(
        'review-policy-switch',
        `row "${row.id}" sets ${override.key} in cordis.patch.yml; the review policy is one tri-state configuration control, not a per-row switch`,
      )
    }
  }

  const gate = (surface?.forbidden ?? []).find((capability) => (capability.gatedBy ?? []).includes(REVIEW_POLICY_KEY))
  if (!gate) {
    record(
      'review-policy-gate',
      `no forbidden capability records the required-mode review gate via gatedBy ${REVIEW_POLICY_KEY}; required mode must keep its review evidence and exemption path non-disableable`,
    )
  }

  for (const capability of surface?.forbidden ?? []) {
    if (!(capability.rowIds ?? []).includes(REVIEW_REVIEWER_ROW)) continue
    record(
      'review-policy-exclusive',
      `forbidden capability "${capability.id}" lists ${REVIEW_REVIEWER_ROW} as a row it may disable; a component may not be mutually exclusive with the review policy, which is one control, not a row`,
    )
  }

  return findings
}

/**
 * Run every component-surface rule against one repository root.
 * @param {string} root
 * @returns {Promise<{ ok: boolean, surface: any, live: any, findings: Array<{ code: string, level: string, message: string }> }>}
 */
export async function checkComponents(root) {
  const findings = []
  const live = await componentCheckData(root)
  const surfaceFile = path.join(root, COMPONENT_SURFACE_FILE)
  if (!fs.existsSync(surfaceFile)) {
    return {
      ok: false,
      surface: null,
      live,
      findings: [finding('surface-missing', 'error', `${COMPONENT_SURFACE_FILE} is missing`)],
    }
  }
  let surface
  try {
    surface = parseComponentSurface(fs.readFileSync(surfaceFile, 'utf8'))
  } catch (error) {
    return {
      ok: false,
      surface: null,
      live,
      findings: [finding('surface-invalid', 'error', `${COMPONENT_SURFACE_FILE}: ${String(error?.message ?? error)}`)],
    }
  }
  findings.push(...validateComponentSurface(surface, { configKeys: live.configKeys, patch: live.patch }))
  // #138.3: every shipped patch is discovered, and every listed patch exists. A
  // new package patch therefore fails until it joins COMPONENT_PATCH_FILES.
  findings.push(...checkShippedPatchCoverage(discoverShippedPatches(root)))
  // #138.1: a boolean (or recorded behaviour knob) cannot hide its capability on
  // the `optional-config` axis without a dated tuning-only exemption.
  findings.push(...checkKeyClassifications(surface, live))
  // #138.4: a row may only override the config keys its component owns.
  findings.push(...checkRowOverrides(surface, live))
  // #134: the root locale `components` block labels the rows that ship in the root
  // patch. A row that ships in its own package (`tower-ui`) is labelled by that
  // package's `meta` block and is checked below instead.
  const rootVisible = live.patches?.[ROOT_PATCH]?.visible ?? []
  findings.push(...checkLocaleCoverage(surface, live.locales, { ids: rootVisible }))
  // #121: a row that ships a generated `<specifier>/locale/*.json` label needs
  // the same three strings in both locales, including an internal row (the
  // mandatory worker preset) that the visible-only rule above does not cover.
  findings.push(...checkRowLocaleCoverage(surface, live.locales, ROW_LOCALES))
  // #134: every visible row must have a label source; one without is a page that
  // shows only `dsh-tower/board`.
  findings.push(...checkRowLabelSources(live.patch, ROW_LOCALES))
  // #132: the group row's plugin-page description must state its off consequence.
  findings.push(...checkGroupLabelCoverage(surface, live.locales))
  // #134: rows shipping in their own package are labelled by that package's meta.
  const metaRowIds = (live.patch?.rows ?? [])
    .filter((row) => META_LABEL_PATCHES.includes(row.patch) && row.scope === 'visible')
    .map((row) => row.id)
  findings.push(...checkMetaLabelCoverage(metaRowIds, live.metaLocales, OFF_EFFECT_LABEL))
  // #137: the package meta label is hand-written but sourced from the root
  // locale; pin it to the same composition the generator renders.
  findings.push(...checkMetaRowCopy(metaRowIds, live.locales, live.metaLocales, OFF_EFFECT_LABEL))
  // #137: every user-facing label is copy, not a config dump. Check both
  // languages of the root locale, the ui-bundle meta and every generated row
  // locale: plain language, zh/en parity, recorded glossary terms only.
  const labelPairs = [
    {
      en: { file: LOCALE_FILES[0], payload: live.locales[LOCALE_FILES[0]] },
      zh: { file: LOCALE_FILES[1], payload: live.locales[LOCALE_FILES[1]] },
    },
    {
      en: { file: META_LOCALE_FILES[0], payload: live.metaLocales[META_LOCALE_FILES[0]] },
      zh: { file: META_LOCALE_FILES[1], payload: live.metaLocales[META_LOCALE_FILES[1]] },
    },
    ...ROW_LOCALES.map((row) => ({
      en: { file: `locale/${row.specifier}/en.json`, payload: live.rowLocales?.[`locale/${row.specifier}/en.json`] },
      zh: { file: `locale/${row.specifier}/zh.json`, payload: live.rowLocales?.[`locale/${row.specifier}/zh.json`] },
    })),
  ]
  findings.push(...checkLocaleCopy(labelPairs))
  // #F22: the Web client string catalogue and the preset runtime failures are
  // user-facing copy too. The client chunk is loaded through the same browser
  // shim the Web client uses; the preset copy is read from the ERROR_COPY table
  // without executing the module. Both are checked with the same banned-syntax
  // and glossary rules. The self-test proves the detectors still fire, so a
  // refactor that quiets one cannot leave every surface silently green.
  findings.push(...checkCopyGateSelfTest())
  findings.push(...checkClientCopy(root))
  findings.push(...checkPresetErrorCopy(root, capabilityRowTitles(live.locales[LOCALE_FILES[0]])))
  // #F69: the spawn-precondition failures and the environment-health remedies
  // are runtime copy too. The precheck copy is read from its ERROR_COPY table;
  // the doctor remedy is the action (4th argument) of each check, so a reader
  // gets a capability and a next step instead of an internal id.
  findings.push(...checkPrecheckErrorCopy(root))
  findings.push(...checkDoctorCopy(root))
  findings.push(...checkGlossaryFile(root))
  // #138.2: the route table is imported, so an absent file, a failed import or a
  // missing/non-Map export fails closed. An empty Map remains the correct
  // determined state (#122): "nothing is gated" is distinct from "could not read".
  if (live.registryError) {
    findings.push(finding('registry-unreadable', 'error', live.registryError))
  }
  findings.push(...checkForbidden(surface, { booleans: live.booleans, registry: live.registry, patch: live.patch }))
  // #M42: the review policy is one tri-state configuration control, not a row.
  findings.push(...checkReviewPolicySurface(surface, live))

  // The decision record must exist: the ADR is where the policy is argued.
  if (!fs.existsSync(path.join(root, surface.adr))) {
    findings.push(finding('adr-missing', 'error', `component surface names ${surface.adr}, which does not exist`))
  }
  for (const key of surface.keys) {
    if (!key.exemption) continue
    if (!fs.existsSync(path.join(root, key.exemption.ref))) {
      findings.push(
        finding(
          'key-exemption-decision',
          'error',
          `${key.name} keeps optional-config by an exemption recorded in ${key.exemption.ref}, which does not exist`,
        ),
      )
    }
  }
  for (const capability of surface.forbidden) {
    const decision = capability.acceptedSwitches?.decision
    if (!decision) continue
    if (!fs.existsSync(path.join(root, decision.ref))) {
      findings.push(
        finding(
          'forbidden-decision',
          'error',
          `forbidden capability ${capability.id} records a decision in ${decision.ref}, which does not exist`,
        ),
      )
    }
  }

  // Check 3: the component count is a baselined surface. `surface:check` runs
  // the full baseline; this narrow call keeps the component brake available in
  // this gate too, so a moved count fails here without re-measuring the rest.
  const visible = live.patch.visible
  let baseline = null
  try {
    baseline = readBaseline(root)
    findings.push(
      ...validateSurfaceBaselineKey(
        baseline,
        'components',
        { components: visible.length, liveNames: { components: visible } },
        { exists: (relative) => fs.existsSync(path.join(root, relative)) },
      ),
    )
  } catch (error) {
    findings.push(finding('baseline-unreadable', 'error', `scripts/surface-baseline.json is unreadable: ${String(error?.message ?? error)}`))
  }

  // The reference is a rendering, not prose. There is exactly one way to update
  // it: edit the source of truth and run the generator.
  try {
    const expected = renderComponentSurface(surface, { baselineDate: baseline?.date })
    const referenceFile = path.join(root, COMPONENT_REFERENCE_FILE)
    const actual = fs.existsSync(referenceFile) ? fs.readFileSync(referenceFile, 'utf8') : ''
    if (actual !== expected) {
      findings.push(
        finding('reference-stale', 'error', `${COMPONENT_REFERENCE_FILE} is stale; run npm run docs:generate:components`),
      )
    }
  } catch (error) {
    findings.push(finding('reference-unreadable', 'error', `${COMPONENT_REFERENCE_FILE} cannot be rendered: ${String(error?.message ?? error)}`))
  }

  return { ok: findings.every((entry) => entry.level !== 'error'), surface, live, findings }
}

async function main(argv) {
  const options = parseArgs(argv, {
    initial: { root: PACKAGE_ROOT, json: false, help: false },
    values: { '--root': { key: 'root', parse: path.resolve } },
    flags: { '--json': 'json', '--help': 'help', '-h': 'help' },
  })
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const root = path.resolve(options.root)
  const report = await checkComponents(root)
  if (options.json) {
    console.log(JSON.stringify({ root, ...report }, null, 2))
    return report.ok ? 0 : 1
  }
  if (report.surface) {
    const visible = report.surface.components.filter((component) => component.scope === 'visible').length
    const internal = report.surface.components.length - visible
    console.log(
      `components: ${visible} visible, ${internal} internal, ${report.surface.keys.length} config keys classified (${COMPONENT_SURFACE_FILE})`,
    )
  }
  for (const item of report.findings) console.log(`components: ${item.level} [${item.code}] ${item.message}`)
  if (report.ok) console.log('components: ok — locale coverage, the forbidden denylist and the component baseline hold')
  else console.log(`components: ${report.findings.length} problem(s); see docs/adr/0005-component-surface.md`)
  return report.ok ? 0 : 1
}

await runMain(import.meta.url, () => main(process.argv.slice(2)), { errorPrefix: 'components', usage: USAGE })
