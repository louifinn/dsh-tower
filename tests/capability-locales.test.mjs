// Optional capability rows and preset-declaring rows must explain themselves
// on the Plugins page (#121).
//
// The DSH client renders a row as `row.meta.title ?? row.moduleName` plus
// `row.meta.description`, and the Host fills `row.meta` by resolving
// `<specifier>/locale/en.json` and then every sibling `<lang>.json` in that
// directory. A subpath row without such a resource shows only `dsh-tower/batch`,
// so the user cannot decide what the switch does. Two preset rows that mount the
// same shared module show the same label, so the mandatory worker dependency and
// the conditional reviewer switch are indistinguishable.
//
// These tests resolve every row subpath through the package's own exports (Node
// self-reference, exactly the Host's lookup) and assert the generated files stay
// a rendering of the single source of truth: the `components` block of
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
  PRESET_LOCALES,
  capabilityLocaleExport,
  capabilityLocalePaths,
  presetLocalePaths,
  renderPresetMeta,
  renderRowLocaleFiles,
  rowLocalePaths,
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
const presetPaths = presetLocalePaths()
const rowPaths = rowLocalePaths()

// The off-effect label is what makes the description decidable: it separates what
// the capability enables (the summary) from what turning it off removes (the
// disables text). It is generated per language, so both must carry one.
const OFF_EFFECT = { en: 'When off:', zh: '关闭后：' }
// The mandatory worker dependency is labelled as a dependency, never a switch.
const DEPENDENCY = { en: 'Mandatory dependency, not a switch:', zh: '强制依赖，不是开关：' }

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
  'tower-board': 'board subpath locale',
  'tower-archive': 'archive subpath locale',
  'tower-hmr': 'hmr subpath locale',
  'preset-tower-reviewer': 'preset-reviewer subpath locale',
  'tower-ui': 'ui-bundle package locale meta',
}

// #134: the tower-ui row ships in ui-bundle/ and is labelled by that package's
// own meta block; it is the one visible row that is not a dsh-tower subpath.
const META_LABELED_ROWS = new Set(['tower-ui'])

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

test('both preset-declaring subpaths resolve their own locale files through the package exports', () => {
  assert.equal(presetPaths.length, PRESET_LOCALES.length * CAPABILITY_LOCALE_LANGUAGES.length)
  for (const { specifier } of PRESET_LOCALES) {
    const mapping = capabilityLocaleExport(specifier)
    assert.equal(
      packageJson.exports[mapping.key],
      mapping.target,
      `package.json must map ${mapping.key} to ${mapping.target}`,
    )
    for (const lang of CAPABILITY_LOCALE_LANGUAGES) {
      const specifierPath = `dsh-tower/${specifier}/locale/${lang}.json`
      const resolved = require.resolve(specifierPath)
      assert.ok(fs.existsSync(resolved), `${specifierPath} must resolve to a shipped file`)
      assert.match(
        resolved.replace(/\\/g, '/'),
        new RegExp(`/locale/${specifier}/${lang}\\.json$`),
        `${specifierPath} must resolve to locale/${specifier}/${lang}.json`,
      )
      const meta = JSON.parse(fs.readFileSync(resolved, 'utf8')).meta
      assert.ok(meta.title.trim().length > 0, `${specifierPath} needs a non-empty meta.title`)
      assert.ok(meta.description.trim().length > 0, `${specifierPath} needs a non-empty meta.description`)
    }
  }
})

test('each capability row title is the localized component title, never the module specifier', () => {
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

test('each capability row description states what it enables and what turning it off removes', () => {
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

test('both preset rows carry distinct labels that name their preset', () => {
  // The rows must not share the shared agent-preset module any more: that is
  // exactly what made the two rows render the same title.
  assert.doesNotMatch(patch, /@deepseek-ai\/dsh-agent-preset'/)
  for (const { specifier, component } of PRESET_LOCALES) {
    assert.ok(patch.includes(`name: 'dsh-tower/${specifier}'`), `cordis.patch.yml mounts dsh-tower/${specifier}`)
    assert.equal(patch.includes(`name: '@deepseek-ai/dsh-agent-preset'`), false)
  }
  const workerName = 'Tower Worker'
  const reviewerName = 'Tower Reviewer'
  for (const lang of CAPABILITY_LOCALE_LANGUAGES) {
    const worker = readJson(`locale/preset-worker/${lang}.json`).meta
    const reviewer = readJson(`locale/preset-reviewer/${lang}.json`).meta
    assert.notEqual(worker.title, reviewer.title, `${lang} preset titles must differ`)
    assert.notEqual(worker.description, reviewer.description, `${lang} preset descriptions must differ`)
    assert.ok(worker.title.includes(workerName), `${lang} worker title names ${workerName}`)
    assert.ok(reviewer.title.includes(reviewerName), `${lang} reviewer title names ${reviewerName}`)
    assert.match(worker.title, /预设|preset/, `${lang} worker title names the preset role`)
    assert.match(reviewer.title, /预设|preset/, `${lang} reviewer title names the preset role`)
    assert.ok(worker.description.includes(workerName), `${lang} worker description names its preset`)
    assert.ok(reviewer.description.includes(reviewerName), `${lang} reviewer description names its preset`)

    // The mandatory worker dependency is never described as a switch; the
    // conditional reviewer keeps the ordinary off-effect wording.
    assert.ok(worker.description.includes(DEPENDENCY[lang]), `${lang} worker description marks the dependency`)
    // The dependency label is generated; the source summary must not repeat it
    // (it used to append its own "Not a switch: Tower depends on it." /
    // "它不是开关：Tower 依赖它。" sentence, so the row said it twice).
    const workerSource = locales[lang].components['preset-tower-worker'].summary
    for (const phrase of ['Not a switch', 'not a switch', 'Tower depends on it', '不是开关', 'Tower 依赖它']) {
      assert.equal(workerSource.includes(phrase), false, `${lang} worker summary must not repeat "${phrase}"`)
    }
    assert.equal(
      worker.description.split(DEPENDENCY[lang]).length - 1,
      1,
      `${lang} worker description marks the dependency exactly once`,
    )
    assert.equal(worker.description.includes(OFF_EFFECT[lang]), false, `${lang} worker is not a switch`)
    assert.ok(reviewer.description.includes(OFF_EFFECT[lang]), `${lang} reviewer labels the off effect`)
    assert.ok(
      reviewer.description.includes(locales[lang].components['preset-tower-reviewer'].disables),
      `${lang} reviewer description names what turning it off removes`,
    )

    // The committed files are the rendering, not a hand edit.
    assert.deepEqual(
      readJson(`locale/preset-worker/${lang}.json`),
      renderPresetMeta(locales[lang].components['preset-tower-worker'], lang, true),
    )
    assert.deepEqual(
      readJson(`locale/preset-reviewer/${lang}.json`),
      renderPresetMeta(locales[lang].components['preset-tower-reviewer'], lang, false),
    )
    assert.deepEqual(Object.keys(worker).sort(), ['description', 'title'])
    assert.deepEqual(Object.keys(reviewer).sort(), ['description', 'title'])
  }
})

test('coverage: every visible component row has a display-metadata source', () => {
  const visible = surface.components
    .filter((component) => component.scope === 'visible')
    .map((component) => component.id)
    .sort()
  assert.deepEqual(Object.keys(ROW_DISPLAY_SOURCE).sort(), visible)

  const capabilityRows = visible.filter((id) => id.startsWith('tower-') && !META_LABELED_ROWS.has(id))
  assert.deepEqual(capabilityRows, [...componentIdBySpecifier.values()].sort())
  for (const { specifier } of CAPABILITY_LOCALES) {
    assert.equal(ROW_DISPLAY_SOURCE[componentIdBySpecifier.get(specifier)], `${specifier} subpath locale`)
  }
  // The mandatory group reads the package root meta. Both preset rows are
  // package specifiers now, so the reviewer's source is a generated label too;
  // the internal worker row is not a visible key in the map but must still ship
  // one (asserted by the preset tests above).
  assert.equal(ROW_DISPLAY_SOURCE.tower, 'package-root locale meta')
  const componentsById = new Map(surface.components.map((component) => [component.id, component]))
  for (const { specifier, component } of PRESET_LOCALES) {
    assert.ok(componentsById.has(component), `the component surface classifies ${component}`)
    assert.match(
      locales.en.components[component].title,
      /预设|preset/,
      `${component} ships a preset label`,
    )
    if (componentsById.get(component).scope === 'visible') {
      assert.equal(ROW_DISPLAY_SOURCE[component], `${specifier} subpath locale`)
    }
  }
})

test('the root package locale meta states the Tower group off consequence (#132)', () => {
  // #132: the plugin page renders the group row from the root meta, so the
  // off-equals-uninstall consequence must live there, not only in the dead
  // `components.tower.disables` field.
  for (const lang of CAPABILITY_LOCALE_LANGUAGES) {
    const consequence = locales[lang].components.tower.disables
    assert.ok(
      locales[lang].meta.description.includes(consequence),
      `${lang} meta.description states the tower group's off consequence verbatim`,
    )
  }
  assert.equal(locales.en.meta.title, 'Tower')
  assert.equal(locales.zh.meta.title, 'Tower')
  assert.match(locales.en.meta.description, /^Plan and track missions/)
  assert.match(locales.zh.meta.description, /^规划并跟踪任务线/)
})

test('the tower-ui row is labelled by the ui-bundle package meta, off consequence included (#134)', () => {
  const uiEn = readJson('ui-bundle/locale/en.json')
  const uiZh = readJson('ui-bundle/locale/zh.json')
  const markers = { en: 'When off:', zh: '关闭后：' }
  for (const [lang, file] of [
    ['en', uiEn],
    ['zh', uiZh],
  ]) {
    assert.equal(typeof file.meta.title, 'string')
    assert.ok(file.meta.title.trim().length > 0, `${lang} ui-bundle meta.title`)
    assert.ok(file.meta.description.includes(markers[lang]), `${lang} ui-bundle meta.description labels the off effect`)
  }
  assert.equal(uiEn.meta.title, locales.en.components['tower-ui'].title)
  assert.equal(uiZh.meta.title, locales.zh.components['tower-ui'].title)
})

test('the generated row locale files are in sync with the generator', () => {
  const output = execFileSync(process.execPath, ['scripts/generate-capability-locale.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.match(output, /20 files in sync/)
  // And the committed files are byte-for-byte the rendering, not a hand edit.
  const expected = renderRowLocaleFiles(root)
  assert.deepEqual([...expected.keys()].sort(), rowPaths.slice().sort())
  for (const [relative, text] of expected) assert.equal(read(relative), text, `${relative} is generated output`)
})

test('the generator --check fails when a committed row locale file drifts (fixture)', () => {
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
    assert.match(result.stdout, /20 files in sync/)

    fs.writeFileSync(
      path.join(fixture, 'locale', 'batch', 'en.json'),
      `${JSON.stringify({ meta: { title: 'drifted', description: 'hand edited' } }, null, 2)}\n`,
    )
    result = run('--check')
    assert.notEqual(result.status, 0, 'a hand-edited capability locale must fail --check')
    assert.match(result.stderr, /stale; run npm run docs:generate:locale/)
    assert.match(result.stderr, /locale\/batch\/en\.json/)

    // A preset label drifting is caught by the same single-source check.
    fs.writeFileSync(
      path.join(fixture, 'locale', 'preset-worker', 'zh.json'),
      `${JSON.stringify({ meta: { title: 'shared label', description: 'hand edited' } }, null, 2)}\n`,
    )
    result = run('--check')
    assert.notEqual(result.status, 0, 'a hand-edited preset locale must fail --check')
    assert.match(result.stderr, /locale\/preset-worker\/zh\.json/)
  } finally {
    removeTemp(fixture)
  }
})

test('the generated row locale files are in package.json files and the reviewed pack snapshot', () => {
  assert.ok(packageJson.files.includes('locale/'), 'package.json files must ship the nested locale tree')
  const manifest = read('scripts/pack-manifest.txt').split('\n').filter(Boolean)
  for (const relative of rowPaths) {
    assert.ok(manifest.includes(relative), `${relative} must be in scripts/pack-manifest.txt`)
  }
})
