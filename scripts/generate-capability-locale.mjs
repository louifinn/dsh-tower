// Generate the per-capability row locale files (#121).
//
// The DSH Plugins page renders an optional row as
// `row.meta.title ?? row.moduleName` plus `row.meta.description`, and the Host
// fills `row.meta` by resolving `<specifier>/locale/en.json` and then every
// sibling `<lang>.json` in that directory. A subpath row without such a resource
// therefore shows only `dsh-tower/batch`, and the switch is not decidable from
// the page.
//
// Those files are generated, not hand-written: the single source of truth is the
// `components` block of `locale/<lang>.json` that `npm run docs:check:components`
// already audits. `meta.title` is the component `title`; `meta.description`
// composes that component's `summary` (what the capability enables) with its
// `disables` text (what turning it off removes), so the row explains the switch
// in both directions.
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
  { specifier: 'hmr', component: 'tower-hmr' },
]

export const CAPABILITY_LOCALE_LANGUAGES = LANGUAGES

/** Repo-relative paths of every generated capability locale file. */
export function capabilityLocalePaths() {
  return CAPABILITY_LOCALES.flatMap(({ specifier }) =>
    LANGUAGES.map((lang) => `locale/${specifier}/${lang}.json`),
  )
}

/** The `package.json` exports entry that exposes one capability's locale files. */
export function capabilityLocaleExport(specifier) {
  return { key: `./${specifier}/locale/*.json`, target: `./locale/${specifier}/*.json` }
}

function requireText(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${label} must be a non-empty string`)
  return text
}

/**
 * Compose the display metadata for one capability row in one language.
 * @param {{ title: string, summary: string, disables: string }} entry
 * @param {'en' | 'zh'} lang
 */
export function renderCapabilityMeta(entry, lang) {
  const title = requireText(entry?.title, `${lang} capability title`)
  const summary = requireText(entry?.summary, `${lang} capability summary`).replace(/\s+/g, ' ')
  const disables = requireText(entry?.disables, `${lang} capability disables`).replace(/\s+/g, ' ')
  // Chinese prose does not space CJK punctuation, so the label joins directly.
  const space = lang === 'zh' ? '' : ' '
  return {
    meta: { title, description: `${summary}${space}${OFF_EFFECT_LABEL[lang]}${space}${disables}` },
  }
}

/**
 * Render every generated file for one repository root.
 * @param {string} root
 * @returns {Map<string, string>} repo-relative path -> file text
 */
export function renderCapabilityLocaleFiles(root) {
  const locales = {}
  for (const lang of LANGUAGES) {
    const file = path.join(root, LANGUAGE_FILES[lang])
    if (!fs.existsSync(file)) throw new Error(`${LANGUAGE_FILES[lang]} is missing under ${root}`)
    locales[lang] = JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  const files = new Map()
  for (const { specifier, component } of CAPABILITY_LOCALES) {
    for (const lang of LANGUAGES) {
      const entry = locales[lang]?.components?.[component]
      if (!entry) throw new Error(`${LANGUAGE_FILES[lang]} has no components.${component} entry`)
      files.set(`locale/${specifier}/${lang}.json`, `${JSON.stringify(renderCapabilityMeta(entry, lang), null, 2)}\n`)
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
locale/zh.json; do not edit locale/<capability>/<lang>.json by hand.`)
    return 0
  }
  const root = path.resolve(options.root)
  const files = renderCapabilityLocaleFiles(root)
  if (options.check) {
    const stale = []
    for (const [relative, expected] of files) {
      const target = path.join(root, relative)
      const actual = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
      if (actual !== expected) stale.push(relative)
    }
    if (stale.length > 0) {
      console.error('capability locale files are stale; run npm run docs:generate:locale')
      for (const relative of stale) console.error(`  ${relative}`)
      return 1
    }
    console.log(`capability row locales: ${files.size} files in sync (${CAPABILITY_LOCALES.length} specifiers, en/zh)`)
    return 0
  }
  for (const [relative, text] of files) {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text)
  }
  console.log(`wrote ${files.size} capability row locale files (${CAPABILITY_LOCALES.length} specifiers, en/zh)`)
  return 0
}

await runMain(import.meta.url, () => main(process.argv.slice(2)), { errorPrefix: 'capability-locales' })
