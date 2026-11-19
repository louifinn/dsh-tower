// Offline contract test for the optional Tower Web Client bundle.
//
// No browser, no Harness install: the test loads ui-bundle/client.js through a
// fake `window.__ModuleLoader__`, supplies a fake `react` module, runs
// `apply(ctx)` against a recording Cordis-like context, then renders the
// registered components directly with fake hooks. This checks the shipped
// slot ids/keys, the loader format, locale dictionary parity, theme-token
// discipline, and the defensive component behaviour.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT_DIR = path.join(ROOT, 'ui-bundle')
const CLIENT_PATH = path.join(CLIENT_DIR, 'client.js')
const PACKAGE_PATH = path.join(CLIENT_DIR, 'package.json')
const EN_PATH = path.join(CLIENT_DIR, 'locale', 'en.json')
const ZH_PATH = path.join(CLIENT_DIR, 'locale', 'zh.json')
const LOCALES_PATH = path.join(CLIENT_DIR, 'client.locales.js')
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')
// The bundle is split into an entry plus package-local chunks (#71); the
// loader-format, theme-token and no-DOM checks cover every client source file.
const CLIENT_FILES = fs
  .readdirSync(CLIENT_DIR)
  .filter((name) => /^client(\.[A-Za-z0-9._-]+)?\.js$/.test(name))
  .sort()
const ALL_SOURCE = CLIENT_FILES.map((name) => fs.readFileSync(path.join(CLIENT_DIR, name), 'utf8')).join('\n')

// #163 Phase 3: the five read-only views are one tower_inspect toolview.
const TOOL_NAMES = [
  'tower_inspect',
  'tower_spawn',
  'tower_mission',
  'tower_complete',
  'tower_review',
  'tower_merge',
  'tower_teardown',
  'tower_interrupt',
  'tower_batch',
].sort()

// ---------------------------------------------------------------------------
// Fakes: module loader, React, Cordis context.
// ---------------------------------------------------------------------------
function createFakeReact() {
  const hookSlots = []
  let cursor = 0
  return {
    createElement(tag, props, ...children) {
      return { tag, props: props || {}, children }
    },
    useEffect(fn) {
      fn()
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (hookSlots[index] === undefined) hookSlots[index] = { current: initial }
      return hookSlots[index]
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useMemo(fn) {
      return fn()
    },
    resetHooks() {
      cursor = 0
    },
  }
}

function loadBundle(react, options = {}) {
  let loaded = null
  const chunkDefinitions = new Map()
  const window = {
    __ModuleLoader__: {
      load(definition) {
        // A package-local split chunk registers with { id, chunk, factory },
        // exactly like the compiled DSH sibling chunks; the entry has no chunk.
        if (definition && typeof definition.chunk === 'string') {
          chunkDefinitions.set(definition.chunk, definition)
          return
        }
        loaded = definition
      },
    },
  }
  // eslint-disable-next-line no-new-func -- the bundle is a plain browser script
  new Function('window', SOURCE)(window)
  assert.ok(loaded, 'client.js must call window.__ModuleLoader__.load')
  // The Web shell's static module table also seeds the UI-primitives namespace.
  // The fake mirrors the slice the bundle uses: a DisclosureRow that renders
  // `open && children` and keeps the collapsed summary while open, plus the
  // icon family.
  const primitives = {
    DisclosureRow(props) {
      const children = []
      if (props.icon !== undefined) children.push(props.icon)
      children.push(react.createElement('span', { key: 'title', 'data-primitives-title': '' }, props.title))
      if (props.keepContentWhenOpen === true || props.open !== true) children.push(props.collapsedContent)
      if (props.open === true) children.push(props.children)
      return react.createElement(
        'div',
        {
          'data-primitives-disclosure': '',
          'data-primitives-running': props.running === true ? 'true' : 'false',
          'data-open': props.open === true ? 'true' : 'false',
          'data-expandable': props.expandable === true ? 'true' : 'false',
          role: props.expandable === true ? 'button' : undefined,
          'aria-expanded': props.expandable === true ? props.open === true : undefined,
          onClick: props.expandable === true && props.expandOnRowClick === true ? props.onToggle : undefined,
          onKeyDown: props.expandable === true && props.expandOnRowClick === true ? props.onToggle : undefined,
        },
        children,
      )
    },
    IconChecklistOutlineRegular(props) {
      return react.createElement('svg', { 'data-primitives-icon': '', width: props.size })
    },
  }
  const required = []
  const asyncRequired = []
  const fakeRequire = (id) => {
    required.push(id)
    if (id === 'react') return react
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      if (options.missingPrimitives === true) {
        throw new Error(
          'client-modules: require("@deepseek-ai/dsh-client-ui-primitives") missed the module table — not a platform seed word',
        )
      }
      return primitives
    }
    throw new Error(
      `unexpected require("${id}") — plugin bundles may only require react and the declared UI-primitives static-table word`,
    )
  }
  const materialized = new Map()
  // Real DSH `require.async("./client.<name>.js")` fetches and registers the
  // sibling chunk script, then materializes its factory once.
  fakeRequire.async = async (spec) => {
    asyncRequired.push(spec)
    assert.match(spec, /^\.\/client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/, `invalid chunk request ${spec}`)
    const file = spec.slice(2)
    if (!chunkDefinitions.has(file)) {
      // eslint-disable-next-line no-new-func -- the chunk is a plain browser script
      new Function('window', fs.readFileSync(path.join(CLIENT_DIR, file), 'utf8'))(window)
    }
    const definition = chunkDefinitions.get(file)
    assert.ok(definition, `${file} must register through window.__ModuleLoader__.load`)
    assert.equal(definition.id, 'dsh-tower-ui', `${file} must register for the bundle id`)
    assert.equal(definition.chunk, file)
    if (!materialized.has(file)) materialized.set(file, definition.factory(fakeRequire))
    return materialized.get(file)
  }
  const plugin = loaded.factory(fakeRequire)
  return { loaded, plugin, window, required, asyncRequired, chunkDefinitions, materialized }
}

function createFakeContext() {
  const injections = []
  const registrations = []
  const effects = []
  const localeRegistrations = []
  let activeOwner = null
  const ctx = {
    effect(fn, label) {
      const cleanup = fn()
      effects.push({ label, cleanup })
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
    locale: {
      register(namespace, dictionaries) {
        localeRegistrations.push({ namespace, dictionaries })
        return () => {}
      },
      bind() {
        return (key) => key
      },
    },
    slots: {
      inject(owner, callback) {
        injections.push({ owner, callback })
        return () => {}
      },
      register(options, component) {
        const entry = { owner: activeOwner, options, component }
        registrations.push(entry)
        return () => {
          const index = registrations.indexOf(entry)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
    get() {
      return undefined
    },
  }
  function runInjections() {
    for (const injection of injections) {
      activeOwner = injection.owner
      const result = injection.callback()
      if (result && typeof result === 'object' && typeof result.next === 'function') {
        let step = result.next()
        while (step.done !== true) step = result.next()
      }
      activeOwner = null
    }
  }
  return { ctx, injections, registrations, effects, localeRegistrations, runInjections }
}

function expand(react, element) {
  if (element === null || element === undefined || typeof element !== 'object') return element
  if (Array.isArray(element)) return element.map((child) => expand(react, child))
  if (typeof element.tag === 'function') {
    react.resetHooks()
    return expand(react, element.tag(element.props))
  }
  if (Array.isArray(element.children)) {
    return Object.assign({}, element, { children: element.children.map((child) => expand(react, child)) })
  }
  return element
}

function render(react, Component, props) {
  react.resetHooks()
  return expand(react, Component(props))
}

function collectText(node, out) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) collectText(child, out)
  }
  return out
}

function textOf(node) {
  return collectText(node, []).join(' ')
}

function findNode(node, predicate) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate)
      if (found) return found
    }
    return null
  }
  if (node.props && predicate(node)) return node
  let found = null
  for (const child of node.children || []) {
    found = findNode(child, predicate)
    if (found) return found
  }
  return found
}

function findAll(node, predicate, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (node.props && predicate(node)) out.push(node)
  for (const child of node.children || []) findAll(child, predicate, out)
  return out
}

function freeTimer(fakeCtx) {
  for (const effect of fakeCtx.effects) {
    if (typeof effect.cleanup === 'function') effect.cleanup()
  }
}

// Every bundle instance owns one auto-dismiss timer effect; dispose them after
// the suite so the test process does not wait for the 4.5 s notice timeout.
const CLEANUPS = []
after(() => {
  for (const fakeCtx of CLEANUPS) freeTimer(fakeCtx)
})

// ---------------------------------------------------------------------------
// 1. Loader + manifest contract.
// ---------------------------------------------------------------------------
test('client chunks are plain-JS __ModuleLoader__ modules and syntax-check', () => {
  assert.ok(CLIENT_FILES.length > 1, 'the entry must be split into package-local chunks')
  for (const name of CLIENT_FILES) {
    const text = fs.readFileSync(path.join(CLIENT_DIR, name), 'utf8')
    assert.match(text, /window\.__ModuleLoader__\.load\(/, `${name} must register through the loader`)
    assert.match(text, /id:\s*'dsh-tower-ui'/, `${name} must register for the same bundle id`)
    assert.doesNotMatch(text, /^\s*(import|export)\s/m, `${name}: plain browser artifact, not an ES module`)
    const check = spawnSync(process.execPath, ['--check', path.join(CLIENT_DIR, name)], { encoding: 'utf8' })
    assert.equal(check.status, 0, `node --check failed for ${name}: ${check.stderr}`)
    assert.doesNotThrow(() => new Function('window', text))
  }
  assert.match(SOURCE, /window\.__ModuleLoader__\.load\(/)
  assert.doesNotMatch(SOURCE, /\bchunk:/, 'the entry is not a package-local chunk')

  const { loaded, plugin, required } = loadBundle(createFakeReact())
  assert.equal(loaded.id, 'dsh-tower-ui')
  assert.deepEqual(required, ['react'], 'the entry factory may only require react')
  assert.ok(Array.isArray(plugin.inject))
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
})

test('the entry resolves the declared UI-primitives static-table word exactly once', async () => {
  const { required } = await registerAll()
  assert.deepEqual(
    required,
    ['react', '@deepseek-ai/dsh-client-ui-primitives'],
    'the entry may only resolve react plus the declared UI-primitives static-table word',
  )
})

test('a shell without the UI-primitives word leaves the host native tool rows alone', async () => {
  const react = createFakeReact()
  const bundle = loadBundle(react, { missingPrimitives: true })
  const fakeCtx = createFakeContext()
  CLEANUPS.push(fakeCtx)
  await bundle.plugin.apply(fakeCtx.ctx)
  fakeCtx.runInjections()
  const toolviews = fakeCtx.registrations.filter((entry) => entry.options.name === 'tool.call.toolview')
  assert.deepEqual(toolviews, [], 'without the native row component no keyed card may replace the host row')
  assert.equal(
    fakeCtx.registrations.filter((entry) => entry.options.name === 'conversation.composer.dock').length,
    1,
    'the other surfaces still register',
  )
  const diagnostics = bundle.window.__TOWER_UI_DIAG__
  assert.ok(
    diagnostics.errors.some((error) => error.where === 'primitives'),
    'the missing static-table word must be recorded, not thrown',
  )
  assert.ok(diagnostics.errors.every((error) => /DisclosureRow|primitives/i.test(error.message) || error.where === 'primitives'))

  // A Tower-mode history would normally add the dynamic deny rows; without the
  // native DisclosureRow they must stay unregistered too, so the host keeps
  // its own rows instead of receiving a hand-built lookalike.
  const dockEntry = fakeCtx.registrations.find((entry) => entry.options.name === 'conversation.composer.dock')
  assert.ok(dockEntry)
  render(react, dockEntry.component, { t, useChat: chatUse(chatSnapshot([commandNode('on')])) })
  assert.deepEqual(
    fakeCtx.registrations.filter((entry) => entry.options.name === 'tool.call.toolview'),
    [],
    'a shell without the native row component must not register deny lookalikes',
  )
})

test('client logic stays within 10% of the 1980-line #71 budget and every file at most 400 lines', () => {
  // #71: the pre-split client.js was 1,980 lines. #F67: the ratchet covers
  // client *logic*; client.locales.js is the bilingual translation catalogue,
  // whose copy must grow with the surface, so it is excluded from the sum and
  // measured by the data guards below. Every file, the catalogue included,
  // still has to stay under the 400-line split target.
  const BASELINE = 1980
  const CATALOGUE = 'client.locales.js'
  const files = fs
    .readdirSync(CLIENT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
  const sizes = files.map((name) => ({
    name,
    lines: fs.readFileSync(path.join(CLIENT_DIR, name), 'utf8').split('\n').length,
  }))
  for (const file of sizes) {
    assert.ok(file.lines <= 400, `${file.name} is ${file.lines} lines (split target: <= 400)`)
  }
  assert.ok(
    sizes.some((file) => file.name === CATALOGUE),
    `${CATALOGUE} must be one of the declared client files`,
  )
  const total = sizes.reduce((sum, file) => sum + (file.name === CATALOGUE ? 0 : file.lines), 0)
  assert.ok(
    total >= BASELINE * 0.9,
    `client logic total ${total} lines fell below 90% of ${BASELINE} (excluding ${CATALOGUE} translation data)`,
  )
  assert.ok(
    total <= BASELINE * 1.1,
    `client logic total ${total} lines exceeds 110% of ${BASELINE} (excluding ${CATALOGUE} translation data)`,
  )
  // The chunk list is the shipped surface list; every client.<surface>.js file
  // is a real chunk the entry loads exactly once.
  const chunks = CLIENT_FILES.filter((name) => name !== 'client.js')
  assert.deepEqual(chunks, [
    'client.cards.js',
    'client.denied.js',
    'client.dock.js',
    'client.helpers.js',
    'client.locales.js',
    'client.mode.js',
    'client.overlay.js',
    'client.styles.js',
    'client.toolview.js',
  ])
  for (const name of chunks) {
    assert.ok(SOURCE.includes(`'./${name}'`), `${name} must be loaded by the entry`)
  }
})

// The catalogue is a plain browser chunk: load it the way the Web client (and
// scripts/check-components.mjs) does — `window.__ModuleLoader__.load` then
// `factory()` — so the guards read the rendered dictionaries instead of
// scraping string literals out of the source.
function loadClientCatalog() {
  const source = fs.readFileSync(LOCALES_PATH, 'utf8')
  let definition = null
  const window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  // eslint-disable-next-line no-new-func -- the chunk is a plain browser script
  new Function('window', source)(window)
  assert.ok(definition && typeof definition.factory === 'function', 'client.locales.js must register a factory')
  assert.equal(definition.id, 'dsh-tower-ui')
  assert.equal(definition.chunk, 'client.locales.js')
  const catalog = definition.factory()
  assert.ok(
    catalog && typeof catalog.EN === 'object' && typeof catalog.ZH === 'object',
    'the catalogue factory must return { EN, ZH }',
  )
  return { source, EN: catalog.EN, ZH: catalog.ZH }
}

test('the client locale catalogue is bounded data, not a logic escape hatch (#F67)', () => {
  const { source, EN, ZH } = loadClientCatalog()
  const enKeys = Object.keys(EN).sort()
  const zhKeys = Object.keys(ZH).sort()
  // 153 entries today: one [English, Chinese] pair per key. The floor keeps a
  // copy collapse from passing as a "smaller budget"; the ceiling (~2x today)
  // lets the surface grow without turning the catalogue into a second product.
  const KEY_FLOOR = 133
  const KEY_CEILING = 260
  // Today's longest value is 162 characters; 240 leaves ~48% headroom for a
  // normal sentence while a pasted paragraph still trips the guard.
  const VALUE_MAX = 240
  assert.deepEqual(
    {
      missingInZh: enKeys.filter((key) => !(key in ZH)),
      missingInEn: zhKeys.filter((key) => !(key in EN)),
    },
    { missingInZh: [], missingInEn: [] },
    'en/zh key sets must match',
  )
  assert.ok(enKeys.length >= KEY_FLOOR, `client catalogue has ${enKeys.length} keys (floor ${KEY_FLOOR})`)
  assert.ok(enKeys.length <= KEY_CEILING, `client catalogue has ${enKeys.length} keys (ceiling ${KEY_CEILING})`)
  for (const [lang, dictionary] of [
    ['en', EN],
    ['zh', ZH],
  ]) {
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, 'string', `${lang} "${key}" must be a string`)
      assert.ok(value.trim() !== '', `${lang} "${key}" must not be empty`)
      assert.ok(value.length <= VALUE_MAX, `${lang} "${key}" is ${value.length} characters (cap ${VALUE_MAX})`)
    }
  }
  // The exemption is for data: the catalogue region (the loader registration,
  // the [English, Chinese] pairs and the enum table) may carry no executable
  // construct, and the chunk may not require or import. Its fixed
  // translation-helper tail (fill/translate/seatT/toolLabel) is support code
  // outside the catalogue, not a place the ratchet exempted.
  const helperTail = source.indexOf('    function fill(')
  assert.ok(helperTail > 0, 'client.locales.js must keep its translation-helper tail')
  assert.doesNotMatch(
    source.slice(0, helperTail),
    /\bfunction\b|=>|\brequire\s*\(|\bimport\b/,
    'the client catalogue must stay data: no function, arrow, require or import',
  )
  assert.doesNotMatch(source, /\brequire\s*\(|^\s*import\s/m, 'client.locales.js must not require or import modules')
})

test('bundle manifest is private 0.2.2 and exports the client artifact', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'))
  assert.equal(pkg.name, 'dsh-tower-ui')
  assert.equal(pkg.version, '0.2.2')
  assert.equal(pkg.private, true)
  assert.equal(pkg.exports['./client'], './client.js')
  assert.ok(pkg.files.includes('client.js'))
  assert.ok(pkg.files.includes('client.*.js'), 'the split chunks must ship with the bundle')
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.deepEqual(
    pkg.dsh.client.external,
    ['@deepseek-ai/dsh-client-ui-primitives'],
    'the native row component is a static module-table word, not an installed package',
  )
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
  assert.ok(
    pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-tool'),
    'tool.call.toolview is declared by ui-tool; activation order must include it',
  )
})

test('locale metadata is present in en/zh', () => {
  const en = JSON.parse(fs.readFileSync(EN_PATH, 'utf8'))
  const zh = JSON.parse(fs.readFileSync(ZH_PATH, 'utf8'))
  assert.equal(typeof en.meta.title, 'string')
  assert.equal(typeof en.meta.description, 'string')
  assert.equal(typeof zh.meta.title, 'string')
  assert.equal(typeof zh.meta.description, 'string')
  assert.deepEqual(Object.keys(en.meta).sort(), Object.keys(zh.meta).sort())
})

// The expanded io-card reproduces the host `ToolRow.module.css` verbatim, and
// that native surface uses two non-alias design tokens for the card's corner
// radius and type scale. Everything else stays on the --dsw-alias-* family.
const NATIVE_NON_ALIAS_TOKENS = new Set(['--dsw-radius-lg', '--dsw-font-markdown-code-block-small'])

test('theme references are limited to --dsw-alias-* plus the native io-card radius/font tokens', () => {
  const tokens = ALL_SOURCE.match(/--dsw-[a-z0-9-]+/g) || []
  assert.ok(tokens.length > 0, 'the cards must use DSH theme tokens')
  for (const token of tokens) {
    assert.ok(
      token.startsWith('--dsw-alias-') || NATIVE_NON_ALIAS_TOKENS.has(token),
      `non-native theme token: ${token}`,
    )
  }
})

test('client code contains no DOM writes, iframe, host.call, or client package imports', () => {
  assert.doesNotMatch(ALL_SOURCE, /\bdocument\./)
  assert.doesNotMatch(ALL_SOURCE, /\bhost\.call\b/)
  assert.doesNotMatch(ALL_SOURCE, /<iframe|createElement\(\s*'iframe'/i)
  assert.doesNotMatch(
    ALL_SOURCE,
    /require\(\s*'@deepseek-ai\/(?!dsh-client-ui-primitives')/,
    'only the declared UI-primitives static-table word may be required from @deepseek-ai/',
  )
  assert.match(
    SOURCE,
    /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/,
    'the native row chrome must come from the UI-primitives static-table word',
  )
  assert.doesNotMatch(ALL_SOURCE, /from\s*'@deepseek-ai\//)
  assert.match(SOURCE, /ctx\.locale\.register/)
  assert.match(SOURCE, /ctx\.effect/)
})

// ---------------------------------------------------------------------------
// 2. Slot registrations and locale dictionaries.
// ---------------------------------------------------------------------------
async function registerAll() {
  const react = createFakeReact()
  const bundle = loadBundle(react)
  const fakeCtx = createFakeContext()
  CLEANUPS.push(fakeCtx)
  // The split client loads its surface chunks before registering, so apply
  // settles as a promise in the real loader as well.
  await bundle.plugin.apply(fakeCtx.ctx)
  fakeCtx.runInjections()
  return { react, ...bundle, ...fakeCtx }
}

test('registers the nine keyed tool.call.toolview entries', async () => {
  const { registrations } = await registerAll()
  const toolviews = registrations.filter((entry) => entry.options.name === 'tool.call.toolview')
  assert.equal(toolviews.length, TOOL_NAMES.length)
  assert.deepEqual(toolviews.map((entry) => entry.options.key).sort(), TOOL_NAMES)
  for (const entry of toolviews) {
    assert.equal(entry.options.locale, 'tower-ui')
    assert.equal(typeof entry.component, 'function')
  }
  assert.ok(registrations.some((entry) => entry.options.key === 'tower_inspect'))
  assert.ok(registrations.some((entry) => entry.options.key === 'tower_batch'))
})

test('registers the composer dock hint/summary entry', async () => {
  const { registrations } = await registerAll()
  const dock = registrations.filter((entry) => entry.options.name === 'conversation.composer.dock')
  assert.equal(dock.length, 1)
  assert.equal(dock[0].options.id, 'tower-hint')
  assert.equal(dock[0].options.order, 6)
  assert.equal(dock[0].options.locale, 'tower-ui')
  assert.equal(typeof dock[0].component, 'function')
})

test('registers the shell.overlay status strip with an injected notice hook', async () => {
  const { registrations } = await registerAll()
  const overlay = registrations.filter((entry) => entry.options.name === 'shell.overlay')
  assert.equal(overlay.length, 1)
  assert.equal(overlay[0].options.id, 'tower-status-strip')
  assert.equal(overlay[0].options.order, 20)
  assert.equal(overlay[0].options.locale, 'tower-ui')
  assert.equal(typeof overlay[0].options.inject, 'function')
  const injected = overlay[0].options.inject()
  assert.equal(typeof injected.hooks.towerNotice.getSnapshot, 'function')
  assert.equal(typeof injected.hooks.towerNotice.subscribe, 'function')
  assert.equal(injected.hooks.towerNotice.getSnapshot(), null)
})

test('locale dictionaries registered for tower-ui are complete in en/zh', async () => {
  const { localeRegistrations } = await registerAll()
  assert.equal(localeRegistrations.length, 1)
  const { namespace, dictionaries } = localeRegistrations[0]
  assert.equal(namespace, 'tower-ui')
  const en = dictionaries.en
  const zh = dictionaries.zh
  assert.ok(en && zh)
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'en/zh key sets must match')
  for (const key of ['card.title', 'card.blockers', 'card.tasks', 'card.checks', 'tool.inspect', 'dock.running', 'strip.started']) {
    assert.equal(typeof en[key], 'string')
    assert.equal(typeof zh[key], 'string')
  }
  for (const tool of TOOL_NAMES) {
    assert.equal(typeof en[`tool.${tool.replace('tower_', '')}`], 'string', `missing label for ${tool}`)
  }
})

test('client locale copy uses the glossary terms and localizes known enums', async () => {
  const { localeRegistrations } = await registerAll()
  const { en, zh } = localeRegistrations[0].dictionaries
  const canonical = {
    'tool.mission': ['Mission', '任务线'],
    'tool.review': ['Review', '审查'],
    'tool.batch': ['Batch', '批次'],
    'tool.inspect': ['Inspect', '查看'],
    'card.batchLine': ['batch {status}', '批次 {status}'],
    'dock.batch': ['batch {status}', '批次 {status}'],
    'card.reviewLine': ['review {status} · merge verdict {merge} · round {round}', '审查 {status} · 合并结论 {merge} · 第 {round} 轮'],
    'card.reviewPolicy': ['review policy: {policy}', '审查策略：{policy}'],
    'card.missionLine': ['mission {id} {status}', '任务线 {id} {status}'],
    'enum.mergeVerdict.fix-then-merge': ['fix first, then merge', '先修复再合并'],
    'enum.reviewStatus.p1': ['{count} blocking problem(s)', '{count} 个阻塞性问题'],
    'enum.reviewPolicy.required-clean': ['clean review expected', '需要干净审查'],
    'enum.role.worker': ['worker', '执行代理'],
    'enum.role.reviewer': ['reviewer', '审查代理'],
  }
  for (const [key, [english, chinese]] of Object.entries(canonical)) {
    assert.equal(en[key], english, `en ${key}`)
    assert.equal(zh[key], chinese, `zh ${key}`)
  }
  for (const [key, value] of Object.entries(en)) {
    if (key.startsWith('enum.reviewStatus.')) assert.doesNotMatch(value, /^p[12]-\d+items$/)
    if (key.startsWith('enum.mergeVerdict.')) assert.doesNotMatch(value, /^[a-z]+-[a-z-]+$/)
  }
})

test('rendered client copy avoids internal ids and names the composer command (#F22)', async () => {
  const { localeRegistrations } = await registerAll()
  const { en, zh } = localeRegistrations[0].dictionaries
  const configKey = /\b(?:gates|review|spawn|tests|docs|mode|merge|git|worktrees|archive|leases|dev)\.[A-Za-z]/
  for (const [key, value] of [...Object.entries(en), ...Object.entries(zh)]) {
    assert.doesNotMatch(value, /\btower_[a-z][a-z0-9_]*/, `${key} names a tool id`)
    assert.doesNotMatch(value, configKey, `${key} names a config key`)
  }
  // The dock chip is a status display, not a control: it may quote the composer
  // command, but it must never surface the host-side tool name.
  for (const key of ['dock.mode.tooltip', 'dock.mode.lastKnown', 'dock.mode.unknownTooltip']) {
    assert.match(en[key], /\/tower/, `en ${key} must name the composer command`)
    assert.match(zh[key], /\/tower/, `zh ${key} must name the composer command`)
    assert.doesNotMatch(en[key], /tower_mode/, `en ${key} must not name the internal tool id`)
    assert.doesNotMatch(zh[key], /tower_mode/, `zh ${key} must not name the internal tool id`)
  }
})

test('diagnostics record every registration and no guarded failure', async () => {
  const { window } = await registerAll()
  const diagnostics = window.__TOWER_UI_DIAG__
  assert.ok(diagnostics && typeof diagnostics === 'object')
  assert.equal(diagnostics.plugin, 'dsh-tower-ui')
  assert.equal(diagnostics.version, '0.2.2')
  assert.equal(diagnostics.applied, true)
  assert.equal(diagnostics.errors.length, 0, JSON.stringify(diagnostics.errors))
  assert.deepEqual(diagnostics.toolviews.slice().sort(), TOOL_NAMES)
  const slots = diagnostics.slots.map((entry) => entry.slot)
  assert.ok(slots.includes('tool.call.toolview'))
  assert.ok(slots.includes('conversation.composer.dock'))
  assert.ok(slots.includes('shell.overlay'))
})

test('the entry loads every split chunk through the module system exactly once', async () => {
  const { asyncRequired, chunkDefinitions } = await registerAll()
  assert.deepEqual(asyncRequired.slice().sort(), CLIENT_FILES.filter((name) => name !== 'client.js').map((name) => './' + name))
  assert.deepEqual(
    [...chunkDefinitions.keys()].sort(),
    CLIENT_FILES.filter((name) => name !== 'client.js'),
  )
  for (const definition of chunkDefinitions.values()) {
    assert.equal(definition.id, 'dsh-tower-ui')
    assert.equal(typeof definition.factory, 'function')
  }
})

// ---------------------------------------------------------------------------
// 3. Component behaviour (fake hooks, no browser).
// ---------------------------------------------------------------------------
async function components() {
  const bundle = await registerAll()
  const toolviews = new Map()
  for (const entry of bundle.registrations) {
    if (entry.options.name === 'tool.call.toolview') toolviews.set(entry.options.key, entry.component)
  }
  const dock = bundle.registrations.find((entry) => entry.options.name === 'conversation.composer.dock').component
  const overlayEntry = bundle.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const overlay = overlayEntry.component
  const noticeSource = overlayEntry.options.inject().hooks.towerNotice
  return { ...bundle, toolviews, dock, overlay, noticeSource }
}

function t(key, params) {
  if (!params) return key
  return key + ':' + Object.keys(params).sort().map((name) => `${name}=${params[name]}`).join(',')
}

// The native row contract: the outer element carries only the two data
// attributes, and every piece of chrome is the primitives DisclosureRow. The
// fake DisclosureRow renders `open && children`, so these assertions also prove
// the curated detail body does not exist while the row is collapsed.
function disclosureRow(layout) {
  return findNode(
    layout,
    (node) => node.props && Object.prototype.hasOwnProperty.call(node.props, 'data-primitives-disclosure'),
  )
}

function disclosureSeat(expanded, toggle) {
  return () => ({ expanded, toggle })
}

test('toolview renders the native DisclosureRow and publishes start/result notices', async () => {
  const { react, toolviews, noticeSource } = await components()
  const Card = toolviews.get('tower_inspect')
  let toggles = 0
  const collapsedSeat = disclosureSeat(false, () => {
    toggles += 1
  })

  const startElement = render(react, Card, {
    toolName: 'tower_inspect',
    phase: 'start',
    callId: 'call-1',
    block: { callId: 'call-1', name: 'tower_inspect' },
    t,
    useDisclosure: collapsedSeat,
  })
  assert.deepEqual(Object.keys(startElement.props).sort(), ['data-tower-phase', 'data-tower-toolview'])
  assert.equal(startElement.props['data-tower-toolview'], 'tower_inspect')
  assert.equal(startElement.props['data-tower-phase'], 'start')
  const startRow = disclosureRow(startElement)
  assert.ok(startRow, 'the card must render the primitives DisclosureRow')
  assert.equal(startRow.props['data-open'], 'false')
  assert.equal(startRow.props['data-primitives-running'], 'true', 'a non-result phase must render the native running row')
  assert.equal(startRow.props['data-expandable'], 'false', 'a running row is not expandable')
  assert.equal(startRow.props.role, undefined)
  assert.equal(startRow.props['aria-expanded'], undefined)
  assert.match(textOf(startElement), /tool\.inspect/, 'the title is the localized tool label')
  assert.match(textOf(startElement), /card\.running/)
  assert.ok(
    findNode(startElement, (node) => node.props && node.props['data-primitives-icon'] !== undefined),
    'the icon comes from the primitives icon family, not an asset',
  )
  assert.equal(noticeSource.getSnapshot().tool, 'tower_inspect')
  assert.equal(noticeSource.getSnapshot().running, true)
  assert.equal(toggles, 0)

  const block = {
    kind: 'tool/result',
    callId: 'call-1',
    call: { name: 'tower_inspect' },
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          view: 'status',
          counts: { planned: 0, active: 1, completed: 0 },
          openTasks: 2,
          roster: 1,
          findings: 0,
          revision: 3,
          missions: [{ id: 'M1', status: 'active', tasks: { total: 3, done: 1, open: 2 } }],
        }),
      },
    ],
  }
  const collapsedElement = render(react, Card, {
    toolName: 'tower_inspect',
    phase: 'result',
    callId: 'call-1',
    block,
    t,
    useDisclosure: collapsedSeat,
  })
  assert.equal(collapsedElement.props['data-tower-phase'], 'result')
  const collapsedRow = disclosureRow(collapsedElement)
  assert.equal(collapsedRow.props['data-open'], 'false')
  assert.equal(collapsedRow.props['data-primitives-running'], 'false', 'a settled result clears the native running row')
  assert.equal(collapsedRow.props['data-expandable'], 'true')
  assert.equal(collapsedRow.props.role, 'button', 'expandOnRowClick makes the settled row a button')
  assert.equal(collapsedRow.props['aria-expanded'], false)
  // The collapsed headline is styled with the live appearance font-size
  // variables the native row uses, so it scales with the text-size setting
  // instead of pinning the default 13px/24px.
  const collapsedSummary = findNode(collapsedElement, (node) => node.props && node.props.key === 'headline')
  assert.ok(collapsedSummary, 'the collapsed row must render its one-line summary')
  assert.equal(collapsedSummary.props.style.fontSize, 'var(--dsh-content-font-size-secondary, 13px)')
  assert.equal(collapsedSummary.props.style.lineHeight, 'calc(24px + var(--dsh-content-font-delta, 0px))')
  const collapsedText = textOf(collapsedElement)
  assert.match(collapsedText, /card\.statusHeadline/)
  assert.doesNotMatch(collapsedText, /card\.openTasks/, 'the curated body must not exist while collapsed')
  assert.equal(
    findNode(collapsedElement, (node) => node.props && node.props['data-tower-tone'] !== undefined),
    null,
    'curated rows belong to the expanded body only',
  )
  collapsedRow.props.onClick()
  assert.equal(toggles, 1, 'the row must route its click through the host DisclosureRow seat')

  const openElement = render(react, Card, {
    toolName: 'tower_inspect',
    phase: 'result',
    callId: 'call-1',
    block,
    t,
    useDisclosure: disclosureSeat(true, () => {}),
  })
  const openRow = disclosureRow(openElement)
  assert.equal(openRow.props['data-open'], 'true')
  assert.equal(openRow.props['aria-expanded'], true)
  const openText = textOf(openElement)
  assert.match(openText, /card\.statusHeadline/)
  assert.match(openText, /card\.openTasks/)
  assert.ok(
    findNode(openElement, (node) => node.props && node.props['data-tower-tone'] === 'warn'),
    'the expanded body keeps the curated tone rows',
  )
  const notice = noticeSource.getSnapshot()
  assert.equal(notice.tool, 'tower_inspect')
  assert.equal(notice.running, false)
  assert.equal(notice.ok, true)
})

// M117: the expanded body must be the native generic tool-result surface, not
// a local lookalike. These are the exact `ToolRow.module.css` rules the host
// renders for a generic result (`ioCard`/`ioSection`/`ioLabel`/`ioText`/
// `ioDivider`), in CSS-in-JS form.
const NATIVE_IO = {
  bodyWrap: { display: 'flex', flexDirection: 'column' },
  card: {
    border: '.5px solid var(--dsw-alias-border-l1)',
    borderRadius: 'var(--dsw-radius-lg)',
    background: 'var(--dsw-alias-markdown-code-block)',
    font: 'var(--dsw-font-markdown-code-block-small)',
    flexDirection: 'column',
    margin: '4px 0 4px 4px',
    display: 'flex',
  },
  section: {
    gridTemplateColumns: 'max-content 1fr',
    alignItems: 'baseline',
    columnGap: '14px',
    maxHeight: '150px',
    padding: '12px 16px',
    display: 'grid',
    overflowY: 'auto',
  },
  label: { color: 'var(--dsw-alias-label-caption)', alignSelf: 'start', position: 'sticky', top: 0 },
  text: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    minWidth: 0,
    color: 'var(--dsw-alias-label-secondary)',
  },
  textError: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    minWidth: 0,
    color: 'var(--dsw-alias-state-error-primary)',
  },
  divider: { background: 'var(--dsw-alias-border-l2)', flex: 'none', height: '.5px' },
}

function isIoCard(node) {
  return Boolean(node.props && node.props.style && node.props.style.borderRadius === 'var(--dsw-radius-lg)')
}
function isIoSection(node) {
  return Boolean(node.props && node.props.style && node.props.style.gridTemplateColumns === 'max-content 1fr')
}
function isIoDivider(node) {
  return Boolean(node.props && node.props.style && node.props.style.height === '.5px')
}

test('expanded toolview body is the native io-card surface, token for token', async () => {
  const { react, toolviews } = await components()
  const payload = {
    view: 'status',
    counts: { planned: 0, active: 1, completed: 0 },
    openTasks: 2,
    roster: 1,
    findings: 0,
    revision: 3,
    missions: [{ id: 'M1', status: 'active', tasks: { total: 3, done: 1, open: 2 } }],
  }
  const props = {
    toolName: 'tower_inspect',
    phase: 'result',
    callId: 'call-io',
    block: {
      kind: 'tool/result',
      callId: 'call-io',
      call: { name: 'tower_inspect' },
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    },
    t,
    useDisclosure: disclosureSeat(true, () => {}),
  }
  const open = render(react, toolviews.get('tower_inspect'), props)

  // bodyWrap > ioCard, with the native border, code-block background and the
  // `font` shorthand that carries the native type scale.
  const card = findNode(open, isIoCard)
  assert.ok(card, 'the open body must render the native ioCard')
  assert.deepEqual(card.props.style, NATIVE_IO.card, 'ioCard must be the native token set — no local border, background or type')
  const bodyWrap = findNode(open, (node) => {
    if (!node.props || !node.props.style) return false
    const style = node.props.style
    return style.display === 'flex' && style.flexDirection === 'column' && Object.keys(style).length === 2
  })
  assert.ok(bodyWrap, 'the ioCard must sit in the native bodyWrap flex column')
  assert.deepEqual(bodyWrap.props.style, NATIVE_IO.bodyWrap)

  // One ioSection per curated row; each section is exactly the ioLabel caption
  // plus the ioText value, both on their native token sets.
  const sections = findAll(open, isIoSection)
  assert.equal(sections.length, 3, 'one ioSection per curated row')
  assert.deepEqual(sections.map((section) => section.props['data-tower-tone']), ['warn', undefined, undefined])
  for (const section of sections) {
    assert.deepEqual(section.props.style, NATIVE_IO.section, 'ioSection must keep the native grid, gap, padding and scroll box')
    const spans = section.children.filter((child) => child && child.tag === 'span')
    assert.equal(spans.length, 2, 'an ioSection is the ioLabel + ioText pair')
    assert.deepEqual(spans[0].props.style, NATIVE_IO.label, 'the caption takes the ioLabel tokens')
    assert.deepEqual(spans[1].props.style, NATIVE_IO.text, 'the value takes the ioText tokens')
    assert.equal(spans[1].props['data-error'], undefined, 'only error rows are marked')
  }
  assert.match(textOf(sections[0]), /card\.tone\.warn/, 'a toned row is captioned with its localized tone word')
  assert.match(textOf(sections[1]), /card\.detail/, 'a toneless row is captioned with the neutral Details label')

  // Adjacent sections are separated by the native ioDivider, and the card's
  // immediate children alternate section / divider / section.
  const dividers = findAll(open, isIoDivider)
  assert.equal(dividers.length, sections.length - 1, 'adjacent sections are separated by an ioDivider')
  for (const divider of dividers) {
    assert.deepEqual(divider.props.style, NATIVE_IO.divider, 'the divider takes the border-l2 token and native height')
    assert.equal(divider.props['aria-hidden'], true)
  }
  const cardChildren = []
  for (const child of card.children) {
    if (Array.isArray(child)) cardChildren.push(...child)
    else cardChildren.push(child)
  }
  assert.equal(cardChildren.length, sections.length + dividers.length)
  cardChildren.forEach((child, index) => {
    if (index % 2 === 0) assert.ok(isIoSection(child), `card child ${index} must be an ioSection`)
    else assert.ok(isIoDivider(child), `card child ${index} must be an ioDivider`)
  })

  // No hardcoded px type or hex/rgb colour anywhere in the expanded surface:
  // those would ignore the appearance text-size setting and the light/dark
  // theme. Type comes from the ioCard `font` token; colour from --dsw-alias-*.
  const expandedStyles = [bodyWrap.props.style, card.props.style]
  for (const section of sections) {
    expandedStyles.push(section.props.style)
    for (const child of section.children) {
      if (child && child.props && child.props.style) expandedStyles.push(child.props.style)
    }
  }
  for (const divider of dividers) expandedStyles.push(divider.props.style)
  for (const style of expandedStyles) {
    for (const [prop, value] of Object.entries(style)) {
      assert.doesNotMatch(String(value), /#[0-9a-f]{3,8}\b/i, `expanded style ${prop} must not hardcode a hex colour`)
      assert.doesNotMatch(String(value), /^rgba?\(/i, `expanded style ${prop} must not hardcode an rgb colour`)
      if (prop === 'fontSize') {
        assert.doesNotMatch(String(value), /^\d+(\.\d+)?px$/, 'expanded type must come from the native font token, not a px size')
      }
    }
  }

  // An error row marks its value with data-error, so the native
  // `ioText[data-error]` error colour applies.
  const blocked = {
    mission: {
      id: 'M1',
      status: 'blocked',
      tasks: [{ status: 'done' }, { status: 'open' }],
      blockers: ['waiting on base'],
      reviewPolicy: 'required-clean',
    },
  }
  const errorCard = render(react, toolviews.get('tower_mission'), {
    toolName: 'tower_mission',
    phase: 'result',
    callId: 'call-err',
    block: {
      kind: 'tool/result',
      callId: 'call-err',
      call: { name: 'tower_mission' },
      content: [{ type: 'text', text: JSON.stringify(blocked) }],
    },
    t,
    useDisclosure: disclosureSeat(true, () => {}),
  })
  const errorSections = findAll(errorCard, isIoSection)
  const errorSection = errorSections.find((section) => section.props['data-tower-tone'] === 'error')
  assert.ok(errorSection, 'a blocker row must render as an error ioSection')
  const errorSpans = errorSection.children.filter((child) => child && child.tag === 'span')
  assert.deepEqual(errorSpans[0].props.style, NATIVE_IO.label)
  assert.equal(errorSpans[1].props['data-error'], true, 'error rows carry data-error, like the native ioText')
  assert.deepEqual(errorSpans[1].props.style, NATIVE_IO.textError, 'data-error takes the native error colour token')
  assert.match(textOf(errorSection), /card\.tone\.error/)
  assert.equal(findAll(errorCard, isIoCard).length, 1)

  // Collapsed: the fake DisclosureRow renders `open && children`, so the card
  // and every section/divider must be absent.
  const collapsed = render(
    react,
    toolviews.get('tower_inspect'),
    Object.assign({}, props, { useDisclosure: disclosureSeat(false, () => {}) }),
  )
  assert.equal(findAll(collapsed, isIoCard).length, 0, 'the expanded ioCard must not exist while collapsed')
  assert.equal(findAll(collapsed, isIoSection).length, 0, 'no curated section may exist while collapsed')
  assert.equal(findAll(collapsed, isIoDivider).length, 0, 'no divider may exist while collapsed')
})

test('toolview cards render review, preflight, merge, roster, complete and blocker shapes', async () => {
  const { react, toolviews } = await components()
  const cases = [
    ['tower_review', { review: { status: 'p1-2items', mergeVerdict: 'fix-then-merge', round: 2, findings: 'two problems', decision: 'fix first', checks: ['tests'] }, round: 2, branchTip: 'abcdef1234567' }],
    ['tower_inspect', { view: 'preflight', ok: false, blockers: [{ code: 'no-review', detail: 'review missing' }], changedFiles: ['a.js'] }],
    ['tower_merge', { ok: true, mergedCommit: 'abcdef1234567', baseTip: '1234567abcdef', warnings: ['slow hook'] }],
    ['tower_inspect', { view: 'roster', roster: [{ name: 'worker-m1', role: 'worker', missionId: 'M1', activity: 'running' }, { name: 'worker-m2', role: 'worker', missionId: 'M2', activity: 'missing', stale: true }], parentStatus: { s1: 'ok' } }],
    ['tower_complete', { mission: { id: 'M1', completionReport: { report: 'done', checks: [{ name: 'npm test', exitCode: 0 }, { name: 'lint', exitCode: 1 }] } }, commits: 2, unread: 0 }],
    ['tower_mission', { mission: { id: 'M1', status: 'blocked', tasks: [{ status: 'done' }, { status: 'open' }], blockers: ['waiting on base'], reviewPolicy: 'required-clean' } }],
    ['tower_spawn', { name: 'worker-m1', role: 'worker', missionId: 'M1', agentId: 'agent-123', worktree: { branch: 'tower/m1' }, created: true }, /card\.spawnLine/],
    ['tower_teardown', { ok: true, dryRun: false, removed: ['M1'], decisions: [{ missionId: 'M1', action: 'remove' }, { missionId: 'M2', action: 'keep', reason: 'live agent' }] }, /card\.teardownLine/],
    ['tower_interrupt', { ok: true, interrupted: true, previousActivity: 'running', entry: { name: 'worker-m1' } }, /card\.interruptYes/],
    ['tower_inspect', { view: 'doctor', ok: false, checks: [{ id: 'git', status: 'pass', detail: 'git version' }, { id: 'hmr', status: 'warn', detail: 'not mounted' }, { id: 'state', status: 'fail', detail: 'missing', action: 'init' }], environmentContract: {} }, /card\.doctorChecks/],
    ['tower_batch', { ok: true, action: 'status', batches: [], summary: { batchId: 'B1', status: 'open', members: [{ id: 'M1' }], checks: [{ missionId: 'M1', name: 'check', ok: true, outcome: 'passed' }], pendingChecks: [], failedChecks: [] } }, /card\.batchLine/],
  ]
  for (const [tool, payload, expectedKey] of cases) {
    const element = render(react, toolviews.get(tool), {
      toolName: tool,
      phase: 'result',
      callId: 'call-' + tool,
      block: { kind: 'tool/result', callId: 'call-' + tool, call: { name: tool }, content: [{ type: 'text', text: JSON.stringify(payload) }] },
      t,
      useDisclosure: disclosureSeat(true, () => {}),
    })
    assert.equal(element.props['data-tower-toolview'], tool)
    assert.deepEqual(Object.keys(element.props).sort(), ['data-tower-phase', 'data-tower-toolview'])
    const row = disclosureRow(element)
    assert.ok(row, `${tool} must render the primitives DisclosureRow`)
    assert.equal(row.props['data-open'], 'true')
    assert.equal(row.props['data-expandable'], 'true')
    assert.ok(textOf(element).length > 0)
    if (expectedKey) assert.match(textOf(element), expectedKey)
  }
})

test('tool cards and the dock expose labelled, localized status instead of raw enums', async () => {
  const { react, toolviews, dock, localeRegistrations } = await components()
  const { en, zh } = localeRegistrations[0].dictionaries
  const dictionaryT = (dictionary) => (key, params) =>
    String(dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, name) =>
      params && params[name] !== undefined ? String(params[name]) : match,
    )
  const zhT = dictionaryT(zh)
  const reviewPayload = {
    review: { status: 'p1-2items', mergeVerdict: 'fix-then-merge', round: 2, findings: 'two problems' },
    round: 2,
    branchTip: 'abcdef1234567',
  }
  const card = render(react, toolviews.get('tower_review'), {
    toolName: 'tower_review',
    phase: 'result',
    callId: 'call-review',
    block: {
      kind: 'tool/result',
      callId: 'call-review',
      call: { name: 'tower_review' },
      content: [{ type: 'text', text: JSON.stringify(reviewPayload) }],
    },
    t: zhT,
    useDisclosure: disclosureSeat(true, () => {}),
  })
  const text = textOf(card)
  assert.match(text, /2 个阻塞性问题/)
  assert.match(text, /先修复再合并/)
  assert.match(text, /审查/)
  assert.doesNotMatch(text, /p1-2items|fix-then-merge/)
  const toned = findNode(card, (node) => node.props && node.props['data-tower-tone'] === 'warn')
  assert.ok(toned, 'a review finding row must carry its tone as data, not only colour')
  assert.equal(toned.props.style.gridTemplateColumns, 'max-content 1fr', 'the row is a native ioSection')
  assert.match(textOf(toned), /警告/, 'the caption is the localized tone word')
  assert.equal(en['enum.reviewStatus.p1'], '{count} blocking problem(s)')
  assert.equal(en['card.reviewLine'], 'review {status} · merge verdict {merge} · round {round}')

  // An explicit off command lets the dock summary (rather than the chip) show.
  let rawSelector = null
  const useChatSummary = (selector) => {
    rawSelector = selector(chatSnapshot([commandNode('off'), toolResultNode('tower_review', reviewPayload)]))
    return rawSelector
  }
  const summary = render(react, dock, { t: zhT, useChat: useChatSummary })
  assert.equal(summary.props['data-tower-ui'], 'dock', String(rawSelector))
  assert.equal(summary.props.role, 'status')
  assert.equal(summary.props['aria-label'], summary.props.title)
  assert.match(summary.props['aria-label'], /审查/)
  assert.match(summary.props['aria-label'], /2 个阻塞性问题/)
})

test('toolview stays defensive for errors, plain text, and partial/absent blocks', async () => {
  const { react, toolviews } = await components()
  for (const tool of TOOL_NAMES) {
    const Card = toolviews.get(tool)
    for (const props of [
      { toolName: tool, phase: 'preparing', callId: 'c', block: undefined, t },
      { toolName: tool, phase: 'start', callId: 'c', block: { callId: 'c', name: tool }, t },
      { toolName: tool, phase: 'result', callId: 'c', block: { kind: 'tool/result', callId: 'c', content: [{ type: 'text', text: 'plain text result' }] }, t },
      { toolName: tool, phase: 'result', callId: 'c', block: { kind: 'tool/result', isError: true, error: { name: 'TowerToolError', code: 'invalid-argument' }, content: [] }, t },
      { toolName: tool, phase: 'result', callId: 'c', block: { kind: 'tool/result', callId: 'c', call: { name: tool }, content: [] }, t },
    ]) {
      assert.doesNotThrow(() => render(react, Card, props))
    }
  }
})

test('composer dock keeps the static hint without tower results and marks unknown history explicitly', async () => {
  const { react, dock } = await components()

  const noHook = render(react, dock, { t })
  assert.equal(findNode(noHook, (node) => node.props['data-tower-ui'] === 'dock-hint') !== null, true)
  assert.match(textOf(noHook), /\/tower/)

  const useChatEmpty = (selector) => selector({ legacy: { nodes: [], runningCalls: [] } })
  const empty = render(react, dock, { t, useChat: useChatEmpty })
  assert.match(textOf(empty), /\/tower/)

  const statusPayload = {
    counts: { planned: 1, active: 2, completed: 0 },
    openTasks: 4,
    roster: 2,
    findings: 1,
    revision: 7,
    missions: [],
  }
  const useChatStatus = (selector) =>
    selector({
      legacy: {
        nodes: [
          {
            kind: 'tool/result',
            call: { name: 'tower_inspect' },
            content: [{ type: 'text', text: JSON.stringify(statusPayload) }],
          },
        ],
        runningCalls: [],
      },
    })
  const summary = render(react, dock, { t, useChat: useChatStatus })
  assert.equal(summary.props['data-tower-ui'], 'dock-mode')
  assert.equal(summary.props['data-tower-mode'], 'unknown')
  assert.match(textOf(summary), /dock\.mode\.unknownLabel/)

  const useChatRunning = (selector) => selector({ legacy: { nodes: [], runningCalls: [{ name: 'tower_spawn' }] } })
  const running = render(react, dock, { t, useChat: useChatRunning })
  assert.match(textOf(running), /dock\.running/)
})

test('dock persists last-known mode per session when the history window loses it', async () => {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  }
  try {
    const first = await components()
    const on = render(first.react, first.dock, {
      t,
      sessionId: 'session-persist',
      useChat: chatUse(chatSnapshot([commandNode('on')])),
    })
    assert.equal(on.props['data-tower-mode'], 'on')

    const second = await components()
    const restored = render(second.react, second.dock, {
      t,
      sessionId: 'session-persist',
      useChat: chatUse(chatSnapshot([])),
    })
    assert.equal(restored.props['data-tower-ui'], 'dock-mode')
    assert.equal(restored.props['data-tower-mode'], 'on')
    assert.match(restored.props.title, /dock\.mode\.lastKnown/)
  } finally {
    delete globalThis.localStorage
  }
})

test('dock discards corrupt, foreign and oversized stored snapshots without throwing', async () => {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  }
  const key = 'dsh-tower-ui:mode:session-corrupt'
  const base = { on: true, denied: null, repo: null, lock: null, lastBy: 'user', lastReason: null, at: Date.now() }
  const cases = [
    ['invalid json', '{not-json'],
    ['scalar json', '42'],
    ['null json', 'null'],
    ['array json', JSON.stringify([base])],
    ['on is not boolean', JSON.stringify({ ...base, on: 'true' })],
    ['at is not a number', JSON.stringify({ ...base, at: 'now' })],
    ['at is negative', JSON.stringify({ ...base, at: -1 })],
    ['at is too far in the future', JSON.stringify({ ...base, at: Date.now() + 60 * 60 * 1000 })],
    ['expired', JSON.stringify({ ...base, at: Date.now() - 8 * 24 * 60 * 60 * 1000 })],
    ['foreign key', JSON.stringify({ ...base, unexpected: true })],
    ['missing key', JSON.stringify({ on: true, at: Date.now() })],
    ['denied is not an array', JSON.stringify({ ...base, denied: 'todo_write' })],
    ['denied holds a non-string', JSON.stringify({ ...base, denied: ['todo_write', 7] })],
    ['denied is too long', JSON.stringify({ ...base, denied: Array.from({ length: 65 }, (_, index) => 'tool-' + index) })],
    ['lock has the wrong shape', JSON.stringify({ ...base, lock: { enabled: true, held: 'yes' } })],
    ['repo is empty', JSON.stringify({ ...base, repo: '' })],
    ['oversized raw value', 'x'.repeat(4097)],
  ]
  try {
    for (const [name, raw] of cases) {
      store.set(key, raw)
      const bundle = await components()
      const element = render(bundle.react, bundle.dock, {
        t,
        sessionId: 'session-corrupt',
        useChat: chatUse(chatSnapshot([])),
      })
      assert.equal(element.props['data-tower-ui'], 'dock-hint', name)
    }

    // A fully valid snapshot with the exact expected fields still restores.
    store.set(key, JSON.stringify({ ...base, denied: ['todo_write'], repo: 'demo', lock: { enabled: true, held: true }, lastReason: 'release' }))
    const bundle = await components()
    const restored = render(bundle.react, bundle.dock, {
      t,
      sessionId: 'session-corrupt',
      useChat: chatUse(chatSnapshot([])),
    })
    assert.equal(restored.props['data-tower-mode'], 'on')
    assert.match(restored.props.title, /dock\.mode\.repo:repo=demo/)
    assert.match(restored.props.title, /dock\.mode\.lockHeld/)

    // Oversized snapshots are not written in the first place.
    store.clear()
    const huge = render(bundle.react, bundle.dock, {
      t,
      sessionId: 'session-corrupt',
      useChat: chatUse(chatSnapshot([toolResultNode('tower_mode', { mode: 'on', lastChange: { by: 'user', reason: 'x'.repeat(5000) } })])),
    })
    assert.equal(huge.props['data-tower-mode'], 'on')
    assert.equal(store.size, 0)
  } finally {
    delete globalThis.localStorage
  }
})

test('dock rendering survives localStorage failures', async () => {
  globalThis.localStorage = {
    getItem() {
      throw new Error('storage blocked')
    },
    setItem() {
      throw new Error('storage blocked')
    },
    removeItem() {
      throw new Error('storage blocked')
    },
  }
  try {
    const bundle = await components()
    const on = render(bundle.react, bundle.dock, {
      t,
      sessionId: 'session-throws',
      useChat: chatUse(chatSnapshot([commandNode('on')])),
    })
    assert.equal(on.props['data-tower-mode'], 'on')
    const hint = render(bundle.react, bundle.dock, {
      t,
      sessionId: 'session-throws',
      useChat: chatUse(chatSnapshot([])),
    })
    assert.equal(hint.props['data-tower-ui'], 'dock-hint')
  } finally {
    delete globalThis.localStorage
  }
})

test('overlay strip renders the notice, is pointer-transparent, and auto-dismiss is owned by ctx.effect', async () => {
  const { react, overlay, noticeSource, effects, toolviews } = await components()
  const useTowerNotice = (selector) => selector(noticeSource.getSnapshot())

  const empty = render(react, overlay, { t, useTowerNotice })
  assert.equal(empty, null)

  // A chat-driven toolview start publishes the transient notice the root-scoped
  // overlay injects (the overlay slot itself receives no chat hooks).
  const Card = toolviews.get('tower_spawn')
  render(react, Card, { toolName: 'tower_spawn', phase: 'start', callId: 'call-spawn', block: { callId: 'call-spawn', name: 'tower_spawn' }, t })

  const strip = render(react, overlay, { t, useTowerNotice })
  assert.equal(strip.props['data-tower-ui'], 'status-strip')
  assert.equal(strip.props.role, 'status')
  assert.equal(strip.props['aria-atomic'], 'true')
  assert.equal(strip.props['aria-label'], textOf(strip).trim())
  assert.equal(strip.props.style.pointerEvents, 'none')
  assert.match(textOf(strip), /strip\.started/)

  // The auto-dismiss timer lives in the plugin body and its cleanup is
  // registered with ctx.effect; freeing effects must be safe and idempotent.
  assert.ok(effects.some((effect) => effect.label === 'tower-ui: status strip timer'))
  assert.doesNotThrow(() => freeTimer({ effects }))
})

// ---------------------------------------------------------------------------
// 4. Tower-mode indicator (#11) and mode-aware denied rows (#12).
// ---------------------------------------------------------------------------
function chatSnapshot(nodes, runningCalls = []) {
  return { legacy: { nodes, runningCalls } }
}
function chatUse(snapshot) {
  return (selector) => selector(snapshot)
}
function commandNode(args, outcomeKind = 'success') {
  return {
    kind: 'command',
    name: 'tower',
    args,
    outcome: { kind: outcomeKind, text: outcomeKind === 'error' ? 'error' : 'ok' },
  }
}
function toolResultNode(name, payload) {
  return {
    kind: 'tool/result',
    call: { name },
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  }
}
function toolErrorNode(name, message) {
  return {
    kind: 'tool/result',
    isError: true,
    call: { name },
    error: { message },
    content: [{ type: 'text', text: 'Error: ' + message }],
  }
}
function deniedRegistrations(registrations) {
  return registrations.filter(
    (entry) => entry.options.name === 'tool.call.toolview' && entry.options.priority === -10,
  )
}

test('dock shows a persistent Tower-mode chip derived from durable command history', async () => {
  const nodes = [commandNode('on')]

  const first = await components()
  const chip = render(first.react, first.dock, { t, useChat: chatUse(chatSnapshot(nodes)) })
  assert.equal(chip.props['data-tower-ui'], 'dock-mode')
  assert.equal(chip.props['data-tower-mode'], 'on')
  assert.equal(chip.props.role, 'status')
  assert.equal(chip.props['aria-live'], 'polite')
  assert.equal(chip.props['aria-atomic'], 'true')
  assert.equal(chip.props['aria-label'], chip.props.title)
  assert.match(chip.props['aria-label'], /dock\.mode\.tooltip/)
  assert.equal(chip.tag, 'div')
  assert.equal(chip.props.onClick, undefined)
  assert.match(textOf(chip), /dock\.mode\.onLabel/)
  assert.match(chip.props.title, /dock\.mode\.tooltip/)

  // A page refresh re-derives the same stance from the same history.
  const refreshed = await components()
  const again = render(refreshed.react, refreshed.dock, { t, useChat: chatUse(chatSnapshot(nodes)) })
  assert.equal(again.props['data-tower-ui'], 'dock-mode')
  assert.equal(again.props['data-tower-mode'], 'on')
})

test('dock surfaces mode unknown when history has Tower activity but no mode event', async () => {
  const bundle = await components()
  const dock = render(bundle.react, bundle.dock, {
    t,
    useChat: chatUse(chatSnapshot([toolResultNode('tower_inspect', { ok: true, repoRoot: 'C:/repo' })])),
  })
  assert.equal(dock.props['data-tower-ui'], 'dock-mode')
  assert.equal(dock.props['data-tower-mode'], 'unknown')
  assert.equal(dock.props.role, 'status')
  assert.equal(dock.props['aria-label'], dock.props.title)
  assert.match(textOf(dock), /dock\.mode\.unknownLabel/)
  assert.match(dock.props.title, /dock\.mode\.unknownTooltip/)
})

test('dock mode inference follows /tower commands and tower_mode reads/writes', async () => {
  const cases = [
    ['on command', [commandNode('on')], 'dock-mode'],
    ['bare command means on', [commandNode('')], 'dock-mode'],
    ['free text means on', [commandNode('plan the release')], 'dock-mode'],
    ['off after on', [commandNode('on'), commandNode('off')], 'dock-hint'],
    ['reload leaves stance', [commandNode('on'), commandNode('reload')], 'dock-mode'],
    ['base leaves stance', [commandNode('on'), commandNode('base main')], 'dock-mode'],
    ['ack leaves stance', [commandNode('on'), commandNode('ack')], 'dock-mode'],
    ['ack without a prior mode does not enter it', [commandNode('ack')], 'dock-hint'],
    ['takeover leaves stance', [commandNode('on'), commandNode('takeover worker is stuck')], 'dock-mode'],
    ['takeover without a reason leaves stance', [commandNode('on'), commandNode('takeover')], 'dock-mode'],
    ['base without a token is a message', [commandNode('base')], 'dock-mode'],
    ['failed mode command is ignored', [commandNode('on'), commandNode('off', 'error')], 'dock-mode'],
    ['tower_mode off', [toolResultNode('tower_mode', { mode: 'off' })], 'dock-hint'],
    ['tower_mode unknown is not on', [toolResultNode('tower_mode', { mode: 'unknown' })], 'dock-hint'],
    ['tower_mode on', [toolResultNode('tower_mode', { mode: 'on' })], 'dock-mode'],
    ['tower_mode enter', [toolResultNode('tower_mode', { ok: true, action: 'enter', mode: 'on', changedBy: 'agent', reason: 'x' })], 'dock-mode'],
    [
      'tower_mode exit',
      [toolResultNode('tower_mode', { ok: true, action: 'enter', mode: 'on' }), toolResultNode('tower_mode', { ok: true, action: 'exit', mode: 'off' })],
      'dock-hint',
    ],
    ['failed tower_mode write is ignored', [commandNode('on'), toolResultNode('tower_mode', { ok: false, error: 'nope' })], 'dock-mode'],
  ]
  for (const [name, nodes, expected] of cases) {
    const bundle = await components()
    const element = render(bundle.react, bundle.dock, { t, useChat: chatUse(chatSnapshot(nodes)) })
    assert.equal(element.props['data-tower-ui'], expected, name)
  }
})

test('towerCommandAction treats acknowledgement and takeover as non-transitions', async () => {
  const { materialized } = await registerAll()
  const { towerCommandAction } = materialized.get('client.mode.js')
  const cases = [
    ['on', 'on'],
    ['off', 'off'],
    ['on ship it', 'on'],
    ['off after this', 'off'],
    [' ON ', 'on'],
    ['', 'on'],
    ['ship the release', 'on'],
    ['ack', null],
    ['ack please', 'on'],
    ['takeover', null],
    ['takeover worker is stuck', null],
    ['reload', null],
    ['reload now', 'on'],
    ['base main', null],
    ['base', 'on'],
    ['base main extra', 'on'],
  ]
  for (const [args, expected] of cases) {
    assert.equal(towerCommandAction(args), expected, JSON.stringify(args))
  }
})

test('Tower mode dynamically registers the denied toolviews and disposes them off-mode', async () => {
  const bundle = await components()
  const { react, dock, registrations } = bundle
  const modeNode = toolResultNode('tower_mode', {
    mode: 'on',
    deniedWhileActive: ['todo_write', 'custom_tool'],
    workspaceLock: { enabled: true, held: true, commonDir: 'D:/projects/demo/.git' },
    lastChange: { by: 'user', reason: 'release work' },
  })
  const chip = render(react, dock, { t, useChat: chatUse(chatSnapshot([modeNode])) })
  assert.equal(chip.props['data-tower-ui'], 'dock-mode')
  assert.match(chip.props.title, /dock\.mode\.repo:repo=demo/)
  assert.match(chip.props.title, /dock\.mode\.lockHeld/)
  assert.match(chip.props.title, /dock\.mode\.lastBy:by=user/)

  // Configured denyTools replace the default list; update_goal is always in.
  const registered = deniedRegistrations(registrations)
  assert.deepEqual(
    registered.map((entry) => entry.options.key).sort(),
    ['custom_tool', 'todo_write', 'update_goal'],
  )
  for (const entry of registered) {
    assert.equal(entry.options.locale, 'tower-ui')
    assert.equal(entry.options.priority, -10)
    assert.equal(typeof entry.component, 'function')
  }
  const diagnostics = bundle.window.__TOWER_UI_DIAG__
  assert.equal(diagnostics.denied.active, true)
  assert.deepEqual(diagnostics.denied.keys.slice().sort(), ['custom_tool', 'todo_write', 'update_goal'])

  // `/tower off` disposes every dynamic registration, so native views return.
  const hint = render(react, dock, {
    t,
    useChat: chatUse(chatSnapshot([modeNode, commandNode('off')])),
  })
  assert.equal(hint.props['data-tower-ui'], 'dock-hint')
  assert.equal(deniedRegistrations(registrations).length, 0)
  assert.equal(diagnostics.denied.active, false)
  assert.deepEqual(diagnostics.denied.keys, [])
})

test('mode on without tower_mode uses the default deny list plus update_goal', async () => {
  const bundle = await components()
  render(bundle.react, bundle.dock, { t, useChat: chatUse(chatSnapshot([commandNode('on')])) })
  const keys = deniedRegistrations(bundle.registrations).map((entry) => entry.options.key).sort()
  // #161: the fallback list mirrors the host's deny-by-owner default, so the
  // expectation is derived from the same source instead of a second copy.
  const { DEFAULT_DENY_TOOLS } = await import('../domain/deny-owners.js')
  const expected = [...new Set([...DEFAULT_DENY_TOOLS, 'update_goal'])].sort()
  assert.deepEqual(keys, expected)

  // An empty deniedWhileActive list also falls back to the defaults.
  const emptyList = await components()
  render(emptyList.react, emptyList.dock, {
    t,
    useChat: chatUse(chatSnapshot([toolResultNode('tower_mode', { mode: 'on', deniedWhileActive: [] })])),
  })
  assert.deepEqual(
    deniedRegistrations(emptyList.registrations)
      .map((entry) => entry.options.key)
      .sort(),
    expected,
  )
})

function dictionaryTranslator(bundle, lang) {
  const dictionary = bundle.localeRegistrations[0].dictionaries[lang]
  return (key, params) =>
    String(dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, name) =>
      params && params[name] !== undefined ? String(params[name]) : match,
    )
}

test('denied rows are the native DisclosureRow with the io-card body only while open', async () => {
  const bundle = await components()
  const { react, dock, registrations } = bundle
  render(react, dock, { t, useChat: chatUse(chatSnapshot([commandNode('on')])) })
  const en = bundle.localeRegistrations[0].dictionaries.en
  const enT = dictionaryTranslator(bundle, 'en')
  const wait = deniedRegistrations(registrations).find((entry) => entry.options.key === 'wait_agent')
  const todo = deniedRegistrations(registrations).find((entry) => entry.options.key === 'todo_write')
  assert.ok(wait && todo)

  const denialMessage = 'tower mode: wait_agent is disabled while Tower mode is active; use the Tower tools or /tower off'
  const base = {
    toolName: 'wait_agent',
    phase: 'result',
    callId: 'call-denied',
    block: toolErrorNode('wait_agent', denialMessage),
    t: enT,
  }
  let toggles = 0
  const collapsed = render(
    react,
    wait.component,
    Object.assign({}, base, { useDisclosure: disclosureSeat(false, () => (toggles += 1)) }),
  )
  assert.equal(collapsed.props['data-tower-toolview'], 'wait_agent')
  assert.equal(collapsed.props['data-tower-denied-view'], 'denied')
  assert.equal(collapsed.props.style, undefined, 'the row wrapper carries no self-drawn card style')
  const collapsedRow = disclosureRow(collapsed)
  assert.ok(collapsedRow, 'the blocked row must be the native row, not a self-drawn card')
  assert.equal(collapsedRow.props['data-primitives-running'], 'false')
  assert.equal(collapsedRow.props['data-expandable'], 'true', 'a settled denial is expandable')
  assert.equal(collapsedRow.props['data-open'], 'false')
  assert.equal(collapsedRow.props.role, 'button', 'expandOnRowClick makes the settled row a button')
  assert.equal(collapsedRow.props['aria-expanded'], false)
  const icon = findNode(collapsed, (node) => node.props && node.props['data-primitives-icon'] !== undefined)
  assert.ok(icon, 'the leading icon comes from the primitives icon family')
  assert.equal(icon.props.width, 14)
  const sep = findNode(collapsed, (node) => node.props && node.props.key === 'sep')
  assert.ok(sep, 'the collapsed row carries the native 2px caption dot')
  assert.equal(sep.props.style.width, '2px')
  assert.equal(sep.props['aria-hidden'], true)
  const summary = findNode(collapsed, (node) => node.props && node.props.key === 'summary')
  assert.equal(summary.props.style.color, 'var(--dsw-alias-state-warn-label)', 'the blocked summary takes the native warn text token')
  const collapsedText = textOf(collapsed)
  assert.match(collapsedText, /Wait for agent/, 'the title is the friendly localized name')
  assert.match(collapsedText, /Unavailable in Tower mode/)
  assert.doesNotMatch(collapsedText, /wait_agent/, 'a mapped tool never leaks its wire id into visible copy')
  assert.doesNotMatch(collapsedText, /tower mode:/i, 'the raw host denial sentence is never visible')
  assert.doesNotMatch(collapsedText, /is disabled while Tower mode is active/)
  assert.equal(findAll(collapsed, isIoCard).length, 0, 'the io-card body exists only while open')
  assert.equal(findAll(collapsed, isIoSection).length, 0)
  collapsedRow.props.onClick()
  assert.equal(toggles, 1, 'the row routes its click through the host DisclosureRow seat')

  // Expanded: bodyWrap > ioCard with exactly two ioSections and one ioDivider,
  // both on the M117 native tokens, carrying only the localized explanation.
  const open = render(
    react,
    wait.component,
    Object.assign({}, base, { useDisclosure: disclosureSeat(true, () => {}) }),
  )
  const openRow = disclosureRow(open)
  assert.equal(openRow.props['data-open'], 'true')
  assert.equal(openRow.props['aria-expanded'], true)
  const bodyWrap = findNode(open, (node) => {
    if (!node.props || !node.props.style) return false
    const style = node.props.style
    return style.display === 'flex' && style.flexDirection === 'column' && Object.keys(style).length === 2
  })
  assert.ok(bodyWrap, 'the io-card sits in the native bodyWrap flex column')
  const cards = findAll(open, isIoCard)
  assert.equal(cards.length, 1, 'the open body is exactly one native ioCard')
  assert.deepEqual(cards[0].props.style, NATIVE_IO.card)
  const sections = findAll(open, isIoSection)
  assert.equal(sections.length, 2, 'reason and next step are two native ioSections')
  assert.deepEqual(sections.map((section) => section.props.style), [NATIVE_IO.section, NATIVE_IO.section])
  for (const section of sections) {
    const spans = section.children.filter((child) => child && child.tag === 'span')
    assert.equal(spans.length, 2, 'an ioSection is the ioLabel + ioText pair')
    assert.deepEqual(spans[0].props.style, NATIVE_IO.label)
    assert.deepEqual(spans[1].props.style, NATIVE_IO.text)
    assert.equal(spans[1].props['data-error'], undefined)
  }
  const sectionTexts = sections.map((section) => textOf(section))
  assert.ok(sectionTexts[0].includes(en['deny.reasonLabel']))
  assert.ok(sectionTexts[0].includes(en['deny.reason']))
  assert.ok(sectionTexts[1].includes(en['deny.nextLabel']))
  assert.ok(sectionTexts[1].includes(en['deny.hint']))
  const dividers = findAll(open, isIoDivider)
  assert.equal(dividers.length, 1, 'the two sections are separated by the native ioDivider')
  assert.deepEqual(dividers[0].props.style, NATIVE_IO.divider)
  const cardChildren = cards[0].children.flat()
  assert.equal(cardChildren.length, 3)
  assert.ok(isIoSection(cardChildren[0]))
  assert.ok(isIoDivider(cardChildren[1]))
  assert.ok(isIoSection(cardChildren[2]))
  const openText = textOf(open)
  assert.doesNotMatch(openText, /tower mode:/i, 'the expanded body never shows the raw host sentence')
  assert.doesNotMatch(openText, /is disabled while Tower mode is active/)
  assert.doesNotMatch(openText, /wait_agent/)
  // No hardcoded px type or hex/rgb colour anywhere in the row or its body.
  for (const node of findAll(open, () => true)) {
    const style = node.props && node.props.style
    if (!style) continue
    for (const [prop, value] of Object.entries(style)) {
      assert.doesNotMatch(String(value), /#[0-9a-f]{3,8}\b/i, `denied style ${prop} must not hardcode a hex colour`)
      assert.doesNotMatch(String(value), /^rgba?\(/i, `denied style ${prop} must not hardcode an rgb colour`)
      if (prop === 'fontSize') {
        assert.doesNotMatch(String(value), /^\d+(\.\d+)?px$/, 'the row type scales with the native font tokens, not a px size')
      }
    }
  }

  // A live row keeps the native running row and never opens, even if the seat
  // reports an expanded disclosure.
  const running = render(react, wait.component, {
    toolName: 'wait_agent',
    phase: 'start',
    callId: 'call-running',
    block: { callId: 'call-running', name: 'wait_agent' },
    t: enT,
    useDisclosure: disclosureSeat(true, () => {}),
  })
  assert.equal(running.props['data-tower-denied-view'], 'running')
  const runningRow = disclosureRow(running)
  assert.ok(runningRow)
  assert.equal(runningRow.props['data-primitives-running'], 'true')
  assert.equal(runningRow.props['data-expandable'], 'false')
  assert.equal(runningRow.props['data-open'], 'false', 'a running row cannot open')
  assert.equal(findAll(running, isIoCard).length, 0)
  assert.match(textOf(running), /Blocked while Tower mode is on/)
  assert.match(textOf(running), /Wait for agent/)
  assert.doesNotMatch(textOf(running), /wait_agent/)

  // Non-denial results keep the same native row shape, never a self-drawn card.
  const ordinary = render(react, todo.component, {
    toolName: 'todo_write',
    phase: 'result',
    callId: 'call-ordinary',
    block: { kind: 'tool/result', call: { name: 'todo_write' }, content: [{ type: 'text', text: 'Todo list updated.' }] },
    t: enT,
    useDisclosure: disclosureSeat(true, () => {}),
  })
  assert.equal(ordinary.props['data-tower-denied-view'], 'generic')
  const ordinaryRow = disclosureRow(ordinary)
  assert.ok(ordinaryRow, 'the fallback row is the native row too')
  assert.equal(ordinaryRow.props['data-expandable'], 'false')
  assert.equal(ordinaryRow.props['data-open'], 'false')
  assert.match(textOf(ordinary), /done/)
  assert.equal(findAll(ordinary, isIoCard).length, 0)

  // An ordinary failure is not a Tower-mode denial: localized error summary,
  // and the localized error line in the io-card once expanded.
  const failure = render(react, todo.component, {
    toolName: 'todo_write',
    phase: 'result',
    callId: 'call-failure',
    block: toolErrorNode('todo_write', 'boom: backend unavailable'),
    t: enT,
    useDisclosure: disclosureSeat(false, () => {}),
  })
  assert.equal(failure.props['data-tower-denied-view'], 'generic')
  const failureRow = disclosureRow(failure)
  assert.ok(failureRow)
  assert.equal(failureRow.props['data-expandable'], 'true')
  const failureSummary = findNode(failure, (node) => node.props && node.props.key === 'summary')
  assert.equal(failureSummary.props.style.color, 'var(--dsw-alias-state-error-primary)')
  assert.match(textOf(failure), /Tool failed/)
  assert.equal(findAll(failure, isIoCard).length, 0)

  const failureOpen = render(react, todo.component, {
    toolName: 'todo_write',
    phase: 'result',
    callId: 'call-failure',
    block: toolErrorNode('todo_write', 'boom: backend unavailable'),
    t: enT,
    useDisclosure: disclosureSeat(true, () => {}),
  })
  const errorSections = findAll(failureOpen, isIoSection)
  assert.equal(errorSections.length, 1, 'the error body is one ioSection')
  const errorSpans = errorSections[0].children.filter((child) => child && child.tag === 'span')
  assert.deepEqual(errorSpans[0].props.style, NATIVE_IO.label)
  assert.equal(errorSpans[1].props['data-error'], true)
  assert.deepEqual(errorSpans[1].props.style, NATIVE_IO.textError)
  assert.match(textOf(errorSections[0]), /Error/)
  assert.ok(textOf(errorSections[0]).includes('boom: backend unavailable'))
})

test('every default denied tool renders its localized name, unknown tools keep theirs', async () => {
  const bundle = await components()
  const { react, dock, registrations } = bundle
  render(react, dock, { t, useChat: chatUse(chatSnapshot([commandNode('on')])) })
  const zh = bundle.localeRegistrations[0].dictionaries.zh
  const zhT = dictionaryTranslator(bundle, 'zh')
  const registered = deniedRegistrations(registrations)
  // The default deny surface (17 foreign tools, update_goal included); every
  // name must have a friendly label in the catalogue.
  assert.equal(registered.length, 17)
  for (const entry of registered) {
    const name = entry.options.key
    const message = `tower mode: ${name} is disabled while Tower mode is active; use the Tower tools or /tower off`
    const element = render(react, entry.component, {
      toolName: name,
      phase: 'result',
      callId: 'call-' + name,
      block: toolErrorNode(name, message),
      t: zhT,
      useDisclosure: disclosureSeat(false, () => {}),
    })
    const text = textOf(element)
    assert.ok(text.includes(zh['deny.tool.' + name]), `${name} must render its localized friendly name`)
    assert.doesNotMatch(text, new RegExp(`\\b${name}\\b`), `${name} must not leak its wire id into visible copy`)
    assert.doesNotMatch(text, /tower mode:/i, `${name} must not render the raw host sentence`)
    assert.match(text, /Tower 模式中不可用/)
  }

  // A custom denied tool has no friendly entry, so the native fallback is the
  // wire name itself — the same thing the native row shows for an unknown tool.
  render(react, dock, {
    t,
    useChat: chatUse(chatSnapshot([toolResultNode('tower_mode', { mode: 'on', deniedWhileActive: ['custom_tool'] })])),
  })
  const custom = deniedRegistrations(registrations).find((entry) => entry.options.key === 'custom_tool')
  assert.ok(custom)
  const element = render(react, custom.component, {
    toolName: 'custom_tool',
    phase: 'result',
    callId: 'call-custom',
    block: toolErrorNode('custom_tool', 'tower mode: custom_tool is disabled while Tower mode is active; use /tower off'),
    t: zhT,
    useDisclosure: disclosureSeat(false, () => {}),
  })
  assert.match(textOf(element), /custom_tool/, 'an unknown tool falls back to its own name')
  assert.doesNotMatch(textOf(element), /tower mode:/i)
})

test('mode off keeps the native priority-0 registrations and no dynamic entries', async () => {
  const bundle = await components()
  const element = render(bundle.react, bundle.dock, {
    t,
    useChat: chatUse(chatSnapshot([toolResultNode('tower_mode', { mode: 'off' })])),
  })
  assert.equal(element.props['data-tower-ui'], 'dock-hint')
  assert.equal(deniedRegistrations(bundle.registrations).length, 0)
  const staticToolviews = bundle.registrations.filter(
    (entry) => entry.options.name === 'tool.call.toolview' && entry.options.priority === undefined,
  )
  assert.equal(staticToolviews.length, TOOL_NAMES.length)
})
