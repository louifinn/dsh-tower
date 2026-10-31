// Generate the per-row locale files (#121).
//
// The DSH Plugins page renders a row as
// `row.meta.title ?? row.moduleName` plus `row.meta.description`, and the Host
// fills `row.meta` by resolving `<specifier>/locale/en.json` and then every
// sibling `<lang>.json` in that directory. A subpath row without such a resource
// therefore shows only `dsh-tower/batch`, and the switch is not decidable from
// the page.
//
// Those files are generated, not hand-written: the single source of truth is the
// `components` block of `locale/<lang>.json` that `npm run docs:check:components`
// already audits. `meta.title` is the component `title`; `meta.description`
// composes that component's `summary` (what the row provides) with either its
// `disables` text (what turning it off removes) or, for the mandatory worker
// preset, an explicit "mandatory dependency, not a switch" label. The same
// generator covers capability rows and the two preset-declaring rows, so their
// labels cannot drift apart.
//
// Usage:
//   node scripts/generate-capability-locale.mjs [--root <dir>] [--check]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, runMain } from './lib/cli.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LANGUAGE_FILES = { en: 'locale/en.json', zh: 'locale/zh.json' }
const LANGUAGES = Object.keys(LANGUAGE_FILES)
// The off-effect marker is generated, not recovered from the hand-written
// `disables` prose, so the check can prove every description names what the
// switch removes without depending on one English or Chinese phrasing.
const OFF_EFFECT_LABEL = { en: 'When off:', zh: '关闭后：' }
export { OFF_EFFECT_LABEL }
// The worker preset has no off state; it is a mandatory dependency of the Tower
// host. Its description says so with an explicit marker instead of a "When off"
// label that would make the row read like a switch.
const DEPENDENCY_LABEL = { en: 'Mandatory dependency, not a switch:', zh: '强制依赖，不是开关：' }

/**
 * The optional capability rows that need their own subpath locale resource, in
 * the row order of `cordis.patch.yml`. The specifier is the module subpath the
 * row mounts; the component id is the key in the locale `components` block.
 */
export const CAPABILITY_LOCALES = [
  { specifier: 'skills', component: 'tower-skills' },
  { specifier: 'batch', component: 'tower-batch' },
  { specifier: 'import', component: 'tower-import' },
  { specifier: 'leases', component: 'tower-leases' },
  { specifier: 'tests', component: 'tower-tests' },
  { specifier: 'board', component: 'tower-board' },
  { specifier: 'archive', component: 'tower-archive' },
  { specifier: 'hmr', component: 'tower-hmr' },
]

/**
 * The two preset-declaring rows. They used to mount the shared
 * `@deepseek-ai/dsh-agent-preset`, so DSH resolved one locale resource for both
 * and rendered the same title twice. Each now owns a Tower declaration module
 * (`host/preset-*.js`) and therefore its own `<specifier>/locale/*.json` label.
 * `mandatory` is the worker dependency; it is asserted against the component
 * surface scope by the gate/tests so the flag cannot drift from the policy.
 */
export const PRESET_LOCALES = [
  { specifier: 'preset-worker', component: 'preset-tower-worker', mandatory: true },
  { specifier: 'preset-reviewer', component: 'preset-tower-reviewer', mandatory: false },
]

/** Every row that ships a generated subpath locale resource. */
export const ROW_LOCALES = [...CAPABILITY_LOCALES, ...PRESET_LOCALES]

export const CAPABILITY_LOCALE_LANGUAGES = LANGUAGES

/** Repo-relative paths of every generated capability locale file. */
export function capabilityLocalePaths() {
  return CAPABILITY_LOCALES.flatMap(({ specifier }) =>
    LANGUAGES.map((lang) => `locale/${specifier}/${lang}.json`),
  )
}

/** Repo-relative paths of every generated preset row locale file. */
export function presetLocalePaths() {
  return PRESET_LOCALES.flatMap(({ specifier }) =>
    LANGUAGES.map((lang) => `locale/${specifier}/${lang}.json`),
  )
}

/** Repo-relative paths of every generated row locale file (capability + preset). */
export function rowLocalePaths() {
  return [...capabilityLocalePaths(), ...presetLocalePaths()]
}

/** The `package.json` exports entry that exposes one row's locale files. */
export function capabilityLocaleExport(specifier) {
  return { key: `./${specifier}/locale/*.json`, target: `./locale/${specifier}/*.json` }
}

function requireText(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${label} must be a non-empty string`)
  return text
}

/** Normalize the three locale prose fields a generated row label needs. */
function rowText(entry, lang) {
  return {
    title: requireText(entry?.title, `${lang} row title`),
    summary: requireText(entry?.summary, `${lang} row summary`).replace(/\s+/g, ' '),
    disables: requireText(entry?.disables, `${lang} row disables`).replace(/\s+/g, ' '),
  }
}

/**
 * Compose the display metadata for one capability row in one language.
 * @param {{ title: string, summary: string, disables: string }} entry
 * @param {'en' | 'zh'} lang
 */
export function renderCapabilityMeta(entry, lang) {
  const { title, summary, disables } = rowText(entry, lang)
  // Chinese prose does not space CJK punctuation, so the label joins directly.
  const space = lang === 'zh' ? '' : ' '
  return {
    meta: { title, description: `${summary}${space}${OFF_EFFECT_LABEL[lang]}${space}${disables}` },
  }
}

/**
 * Compose the display metadata for one preset-declaring row in one language.
 * The mandatory worker dependency is labelled as a dependency, never as a
 * switch; the conditional reviewer keeps the ordinary off-effect label.
 * @param {{ title: string, summary: string, disables: string }} entry
 * @param {'en' | 'zh'} lang
 * @param {boolean} mandatory
 */
export function renderPresetMeta(entry, lang, mandatory) {
  const { title, summary, disables } = rowText(entry, lang)
  const space = lang === 'zh' ? '' : ' '
  const label = mandatory ? DEPENDENCY_LABEL[lang] : OFF_EFFECT_LABEL[lang]
  return {
    meta: { title, description: `${summary}${space}${label}${space}${disables}` },
  }
}

function readLocales(root) {
  const locales = {}
  for (const lang of LANGUAGES) {
    const file = path.join(root, LANGUAGE_FILES[lang])
    if (!fs.existsSync(file)) throw new Error(`${LANGUAGE_FILES[lang]} is missing under ${root}`)
    locales[lang] = JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  return locales
}

/** Pull one row's components entry out of both locales, or throw a named error. */
function componentEntry(locales, lang, component) {
  const entry = locales[lang]?.components?.[component]
  if (!entry) throw new Error(`${LANGUAGE_FILES[lang]} has no components.${component} entry`)
  return entry
}

/**
 * Render every generated file for one repository root.
 * @param {string} root
 * @returns {Map<string, string>} repo-relative path -> file text
 */
export function renderRowLocaleFiles(root) {
  const locales = readLocales(root)
  const files = new Map()
  for (const { specifier, component } of CAPABILITY_LOCALES) {
    for (const lang of LANGUAGES) {
      const rendered = renderCapabilityMeta(componentEntry(locales, lang, component), lang)
      files.set(`locale/${specifier}/${lang}.json`, `${JSON.stringify(rendered, null, 2)}\n`)
    }
  }
  for (const { specifier, component, mandatory } of PRESET_LOCALES) {
    for (const lang of LANGUAGES) {
      const rendered = renderPresetMeta(componentEntry(locales, lang, component), lang, mandatory)
      files.set(`locale/${specifier}/${lang}.json`, `${JSON.stringify(rendered, null, 2)}\n`)
    }
  }
  return files
}

function main(argv) {
  const options = parseArgs(argv, {
    initial: { root: PACKAGE_ROOT, check: false, help: false },
    values: { '--root': { key: 'root', parse: path.resolve } },
    flags: { '--check': 'check', '--help': 'help', '-h': 'help' },
  })
  if (options.help) {
    console.log(`usage: node scripts/generate-capability-locale.mjs [--root <dir>] [--check]

  --root   repository root to read and write (default: this package)
  --check  fail when a committed file differs instead of writing it
  --help   print this text

The files are generated from the components block of locale/en.json and
locale/zh.json; do not edit locale/<row>/<lang>.json by hand. Capability and
preset-declaring rows share this generator so their labels cannot drift.`)
    return 0
  }
  const root = path.resolve(options.root)
  const files = renderRowLocaleFiles(root)
  if (options.check) {
    const stale = []
    for (const [relative, expected] of files) {
      const target = path.join(root, relative)
      const actual = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
      if (actual !== expected) stale.push(relative)
    }
    if (stale.length > 0) {
      console.error('row locale files are stale; run npm run docs:generate:locale')
      for (const relative of stale) console.error(`  ${relative}`)
      return 1
    }
    console.log(`row locales: ${files.size} files in sync (${ROW_LOCALES.length} specifiers, en/zh)`)
    return 0
  }
  for (const [relative, text] of files) {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text)
  }
  console.log(`wrote ${files.size} row locale files (${ROW_LOCALES.length} specifiers, en/zh)`)
  return 0
}

await runMain(import.meta.url, () => main(process.argv.slice(2)), { errorPrefix: 'capability-locales' })
