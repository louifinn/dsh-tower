// Optional capability rows must explain themselves on the Plugins page (#121).
//
// The DSH client renders a row as `row.meta.title ?? row.moduleName` plus
// `row.meta.description`, and the Host fills `row.meta` by resolving
// `<specifier>/locale/en.json` and then every sibling `<lang>.json` in that
// directory. A subpath row without such a resource shows only `dsh-tower/batch`,
// so the user cannot decide what the switch does.
//
// These tests resolve every capability subpath through the package's own exports
// (Node self-reference, exactly the Host's lookup) and assert the generated files
// stay a rendering of the single source of truth: the `components` block of
// `locale/en.json` and `locale/zh.json`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CAPABILITY_LOCALES,
  CAPABILITY_LOCALE_LANGUAGES,
  capabilityLocaleExport,
  capabilityLocalePaths,
  renderCapabilityLocaleFiles,
} from '../scripts/generate-capability-locale.mjs'
import { removeTemp } from './helpers/cleanup.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const readJson = (file) => JSON.parse(read(file))

const packageJson = readJson('package.json')
const surface = readJson('scripts/component-surface.json')
const locales = { en: readJson('locale/en.json'), zh: readJson('locale/zh.json') }
const patch = read('cordis.patch.yml')
const capabilityPaths = capabilityLocalePaths()

// The off-effect label is what makes the description decidable: it separates what
// the capability enables (the summary) from what turning it off removes (the
// disables text). It is generated per language, so both must carry one.
const OFF_EFFECT = { en: 'When off:', zh: '关闭后：' }

// Every visible component row must get its display text from a known source. A
// new visible row makes this map stale, so the coverage test fails until the row
// either ships a subpath locale resource or records why its label comes from
// somewhere else.
const ROW_DISPLAY_SOURCE = {
  tower: 'package-root locale meta',
  'tower-skills': 'skills subpath locale',
  'tower-batch': 'batch subpath locale',
  'tower-import': 'import subpath locale',
  'tower-leases': 'leases subpath locale',
  'tower-tests': 'tests subpath locale',
  'tower-hmr': 'hmr subpath locale',
  'preset-tower-reviewer': 'preset manifest (cordis.patch.yml config name/description)',
}

const componentIdBySpecifier = new Map(
  CAPABILITY_LOCALES.map(({ specifier, component }) => [specifier, component]),
)

test('every optional capability subpath resolves its locale files through the package exports', () => {
  assert.equal(capabilityPaths.length, CAPABILITY_LOCALES.length * CAPABILITY_LOCALE_LANGUAGES.length)
  for (const { specifier } of CAPABILITY_LOCALES) {
    const mapping = capabilityLocaleExport(specifier)
    assert.equal(
      packageJson.exports[mapping.key],
      mapping.target,
      `package.json must map ${mapping.key} to ${mapping.target}`,
    )
    for (const lang of CAPABILITY_LOCALE_LANGUAGES) {
      const specifierPath = `dsh-tower/${specifier}/locale/${lang}.json`
      // Node self-reference: the same exports resolution the Host performs.
      const resolved = require.resolve(specifierPath)
      assert.ok(fs.existsSync(resolved), `${specifierPath} must resolve to a shipped file`)
      assert.match(
        resolved.replace(/\\/g, '/'),
        new RegExp(`/locale/${specifier}/${lang}\\.json$`),
        `${specifierPath} must resolve to locale/${specifier}/${lang}.json`,
      )
      const meta = JSON.parse(fs.readFileSync(resolved, 'utf8')).meta
      assert.deepEqual(Object.keys(meta).sort(), ['description', 'title'])
      assert.equal(typeof meta.title, 'string')
      assert.ok(meta.title.trim().length > 0, `${specifierPath} needs a non-empty meta.title`)
      assert.equal(typeof meta.description, 'string')
      assert.ok(meta.description.trim().length > 0, `${specifierPath} needs a non-empty meta.description`)
    }
  }
})

test('each row title is the localized component title, never the module specifier', () => {
  for (const { specifier, component } of CAPABILITY_LOCALES) {
    assert.ok(patch.includes(`name: 'dsh-tower/${specifier}'`), `cordis.patch.yml mounts dsh-tower/${specifier}`)
    for (const lang of CAPABILITY_LOCALE_LANGUAGES) {
      const meta = readJson(`locale/${specifier}/${lang}.json`).meta
      const expected = locales[lang].components[component].title
      assert.equal(meta.title, expected, `${specifier}/${lang}.json title comes from components.${component}.title`)
      assert.notEqual(meta.title, `dsh-tower/${specifier}`, 'the title is never the module specifier')
      assert.notEqual(meta.title, specifier)
    }
  }
})

test('each row description states what the capability enables and what turning it off removes', () => {
  for (const { specifier, component } of CAPABILITY_LOCALES) {
    for (const lang of CAPABILITY_LOCALE_LANGUAGES) {
      const entry = locales[lang].components[component]
      const meta = readJson(`locale/${specifier}/${lang}.json`).meta
      assert.ok(meta.description.includes(entry.summary), `${specifier}/${lang} names what the capability enables`)
      assert.ok(meta.description.includes(entry.disables), `${specifier}/${lang} names the off effect`)
      assert.ok(
        meta.description.includes(OFF_EFFECT[lang]),
        `${specifier}/${lang} labels the off effect (${OFF_EFFECT[lang]})`,
      )
      assert.doesNotMatch(meta.description, /\r|\n/, `${specifier}/${lang} description is one paragraph`)
    }
  }
})

test('coverage: every visible component row has a display-metadata source', () => {
  const visible = surface.components
    .filter((component) => component.scope === 'visible')
    .map((component) => component.id)
    .sort()
  assert.deepEqual(Object.keys(ROW_DISPLAY_SOURCE).sort(), visible)

  const capabilityRows = visible.filter((id) => id.startsWith('tower-'))
  assert.deepEqual(capabilityRows, [...componentIdBySpecifier.values()].sort())
  for (const { specifier } of CAPABILITY_LOCALES) {
    assert.equal(ROW_DISPLAY_SOURCE[componentIdBySpecifier.get(specifier)], `${specifier} subpath locale`)
  }
  // The mandatory group and the reviewer preset are visible too, but neither is a
  // capability module: the group reads the package root meta and the preset row
  // reads its own manifest label. Both sources are asserted, not assumed.
  assert.equal(ROW_DISPLAY_SOURCE.tower, 'package-root locale meta')
  assert.match(patch, /id: preset-tower-reviewer[\s\S]*?name: Tower Reviewer\n\s+description: /)
})

test('the root package locale meta for the Tower group is unchanged', () => {
  assert.deepEqual(locales.en.meta, {
    title: 'Tower',
    description: 'Mission planning, isolated worktrees, worker/reviewer agents, and review-gated merges.',
  })
  assert.deepEqual(locales.zh.meta, {
    title: 'Tower',
    description: '多代理任务规划、隔离工作树与审查门禁合并。',
  })
})

test('the generated capability locale files are in sync with the generator', () => {
  const output = execFileSync(process.execPath, ['scripts/generate-capability-locale.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.match(output, /12 files in sync/)
  // And the committed files are byte-for-byte the rendering, not a hand edit.
  const expected = renderCapabilityLocaleFiles(root)
  assert.deepEqual([...expected.keys()].sort(), capabilityPaths.slice().sort())
  for (const [relative, text] of expected) assert.equal(read(relative), text, `${relative} is generated output`)
})

test('the generator --check fails when a committed capability file drifts (fixture)', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-cap-locale-'))
  try {
    for (const lang of CAPABILITY_LOCALE_LANGUAGES) {
      const target = path.join(fixture, 'locale', `${lang}.json`)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(root, 'locale', `${lang}.json`), target)
    }
    const run = (...args) =>
      spawnSync(
        process.execPath,
        [path.join(root, 'scripts', 'generate-capability-locale.mjs'), '--root', fixture, ...args],
        { cwd: root, encoding: 'utf8' },
      )

    let result = run()
    assert.equal(result.status, 0, result.stderr)
    result = run('--check')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /12 files in sync/)

    fs.writeFileSync(
      path.join(fixture, 'locale', 'batch', 'en.json'),
      `${JSON.stringify({ meta: { title: 'drifted', description: 'hand edited' } }, null, 2)}\n`,
    )
    result = run('--check')
    assert.notEqual(result.status, 0, 'a hand-edited capability locale must fail --check')
    assert.match(result.stderr, /stale; run npm run docs:generate:locale/)
    assert.match(result.stderr, /locale\/batch\/en\.json/)
  } finally {
    removeTemp(fixture)
  }
})

test('the generated capability files are in package.json files and the reviewed pack snapshot', () => {
  assert.ok(packageJson.files.includes('locale/'), 'package.json files must ship the nested locale tree')
  const manifest = read('scripts/pack-manifest.txt').split('\n').filter(Boolean)
  for (const relative of capabilityPaths) {
    assert.ok(manifest.includes(relative), `${relative} must be in scripts/pack-manifest.txt`)
  }
})
