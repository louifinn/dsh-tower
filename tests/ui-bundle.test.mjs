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
const CLIENT_PATH = path.join(ROOT, 'ui-bundle', 'client.js')
const PACKAGE_PATH = path.join(ROOT, 'ui-bundle', 'package.json')
const EN_PATH = path.join(ROOT, 'ui-bundle', 'locale', 'en.json')
const ZH_PATH = path.join(ROOT, 'ui-bundle', 'locale', 'zh.json')
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')

const TOOL_NAMES = [
  'tower_status',
  'tower_roster',
  'tower_spawn',
  'tower_mission',
  'tower_complete',
  'tower_review',
  'tower_preflight',
  'tower_merge',
  'tower_teardown',
  'tower_interrupt',
  'tower_doctor',
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

function loadBundle(react) {
  let loaded = null
  const window = {
    __ModuleLoader__: {
      load(definition) {
        loaded = definition
      },
    },
  }
  // eslint-disable-next-line no-new-func -- the bundle is a plain browser script
  new Function('window', SOURCE)(window)
  assert.ok(loaded, 'client.js must call window.__ModuleLoader__.load')
  const required = []
  const fakeRequire = (id) => {
    required.push(id)
    if (id === 'react') return react
    throw new Error(`unexpected require("${id}") — plugin bundles may only require react`)
  }
  const plugin = loaded.factory(fakeRequire)
  return { loaded, plugin, window, required }
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
        registrations.push({ owner: activeOwner, options, component })
        return () => {}
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
test('client.js is a plain-JS __ModuleLoader__ module and syntax-checks', () => {
  assert.match(SOURCE, /window\.__ModuleLoader__\.load\(/)
  assert.match(SOURCE, /id:\s*'dsh-tower-ui'/)
  assert.doesNotMatch(SOURCE, /^\s*(import|export)\s/m, 'plain browser artifact, not an ES module')

  // node --check does the full parse (new Function is the no-browser fallback).
  const check = spawnSync(process.execPath, ['--check', CLIENT_PATH], { encoding: 'utf8' })
  assert.equal(check.status, 0, `node --check failed: ${check.stderr}`)
  assert.doesNotThrow(() => new Function('window', SOURCE))

  const { loaded, plugin, required } = loadBundle(createFakeReact())
  assert.equal(loaded.id, 'dsh-tower-ui')
  assert.deepEqual(required, ['react'], 'the Client half may only require react')
  assert.ok(Array.isArray(plugin.inject))
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
})

test('bundle manifest is private 0.2.0 and exports the client artifact', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'))
  assert.equal(pkg.name, 'dsh-tower-ui')
  assert.equal(pkg.version, '0.2.0')
  assert.equal(pkg.private, true)
  assert.equal(pkg.exports['./client'], './client.js')
  assert.ok(pkg.files.includes('client.js'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
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

test('theme references are limited to --dsw-alias-* tokens', () => {
  const tokens = SOURCE.match(/--dsw-[a-z0-9-]+/g) || []
  assert.ok(tokens.length > 0, 'the cards must use DSH theme tokens')
  for (const token of tokens) {
    assert.match(token, /^--dsw-alias-/, `non-alias theme token: ${token}`)
  }
})

test('client code contains no DOM writes, iframe, host.call, or client package imports', () => {
  assert.doesNotMatch(SOURCE, /\bdocument\./)
  assert.doesNotMatch(SOURCE, /\bhost\.call\b/)
  assert.doesNotMatch(SOURCE, /<iframe|createElement\(\s*'iframe'/i)
  assert.doesNotMatch(SOURCE, /require\(\s*'@deepseek-ai\//)
  assert.doesNotMatch(SOURCE, /from\s*'@deepseek-ai\//)
  assert.match(SOURCE, /ctx\.locale\.register/)
  assert.match(SOURCE, /ctx\.effect/)
})

// ---------------------------------------------------------------------------
// 2. Slot registrations and locale dictionaries.
// ---------------------------------------------------------------------------
function registerAll() {
  const react = createFakeReact()
  const { plugin, window } = loadBundle(react)
  const fakeCtx = createFakeContext()
  CLEANUPS.push(fakeCtx)
  plugin.apply(fakeCtx.ctx)
  fakeCtx.runInjections()
  return { react, plugin, window, ...fakeCtx }
}

test('registers the twelve keyed tool.call.toolview entries', () => {
  const { registrations } = registerAll()
  const toolviews = registrations.filter((entry) => entry.options.name === 'tool.call.toolview')
  assert.equal(toolviews.length, TOOL_NAMES.length)
  assert.deepEqual(toolviews.map((entry) => entry.options.key).sort(), TOOL_NAMES)
  for (const entry of toolviews) {
    assert.equal(entry.options.locale, 'tower-ui')
    assert.equal(typeof entry.component, 'function')
  }
  assert.ok(registrations.some((entry) => entry.options.key === 'tower_doctor'))
  assert.ok(registrations.some((entry) => entry.options.key === 'tower_batch'))
})

test('registers the composer dock hint/summary entry', () => {
  const { registrations } = registerAll()
  const dock = registrations.filter((entry) => entry.options.name === 'conversation.composer.dock')
  assert.equal(dock.length, 1)
  assert.equal(dock[0].options.id, 'tower-hint')
  assert.equal(dock[0].options.order, 6)
  assert.equal(dock[0].options.locale, 'tower-ui')
  assert.equal(typeof dock[0].component, 'function')
})

test('registers the shell.overlay status strip with an injected notice hook', () => {
  const { registrations } = registerAll()
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

test('locale dictionaries registered for tower-ui are complete in en/zh', () => {
  const { localeRegistrations } = registerAll()
  assert.equal(localeRegistrations.length, 1)
  const { namespace, dictionaries } = localeRegistrations[0]
  assert.equal(namespace, 'tower-ui')
  const en = dictionaries.en
  const zh = dictionaries.zh
  assert.ok(en && zh)
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'en/zh key sets must match')
  for (const key of ['card.title', 'card.blockers', 'card.tasks', 'card.checks', 'tool.status', 'dock.running', 'strip.started']) {
    assert.equal(typeof en[key], 'string')
    assert.equal(typeof zh[key], 'string')
  }
  for (const tool of TOOL_NAMES) {
    assert.equal(typeof en[`tool.${tool.replace('tower_', '')}`], 'string', `missing label for ${tool}`)
  }
})

test('diagnostics record every registration and no guarded failure', () => {
  const { window } = registerAll()
  const diagnostics = window.__TOWER_UI_DIAG__
  assert.ok(diagnostics && typeof diagnostics === 'object')
  assert.equal(diagnostics.plugin, 'dsh-tower-ui')
  assert.equal(diagnostics.version, '0.2.0')
  assert.equal(diagnostics.applied, true)
  assert.equal(diagnostics.errors.length, 0, JSON.stringify(diagnostics.errors))
  assert.deepEqual(diagnostics.toolviews.slice().sort(), TOOL_NAMES)
  const slots = diagnostics.slots.map((entry) => entry.slot)
  assert.ok(slots.includes('tool.call.toolview'))
  assert.ok(slots.includes('conversation.composer.dock'))
  assert.ok(slots.includes('shell.overlay'))
})

// ---------------------------------------------------------------------------
// 3. Component behaviour (fake hooks, no browser).
// ---------------------------------------------------------------------------
function components() {
  const bundle = registerAll()
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

test('toolview renders a compact card and publishes start/result notices', () => {
  const { react, toolviews, noticeSource } = components()
  const Card = toolviews.get('tower_status')

  const startElement = render(react, Card, {
    toolName: 'tower_status',
    phase: 'start',
    callId: 'call-1',
    block: { callId: 'call-1', name: 'tower_status' },
    t,
  })
  assert.equal(startElement.props['data-tower-toolview'], 'tower_status')
  assert.equal(startElement.props['data-tower-phase'], 'start')
  assert.match(textOf(startElement), /card\.running/)
  assert.equal(noticeSource.getSnapshot().tool, 'tower_status')
  assert.equal(noticeSource.getSnapshot().running, true)

  const resultElement = render(react, Card, {
    toolName: 'tower_status',
    phase: 'result',
    callId: 'call-1',
    block: {
      kind: 'tool/result',
      callId: 'call-1',
      call: { name: 'tower_status' },
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            counts: { planned: 0, active: 1, completed: 0 },
            openTasks: 2,
            roster: 1,
            findings: 0,
            revision: 3,
            missions: [{ id: 'M1', status: 'active', tasks: { total: 3, done: 1, open: 2 } }],
          }),
        },
      ],
    },
    t,
  })
  assert.equal(resultElement.props['data-tower-phase'], 'result')
  const resultText = textOf(resultElement)
  assert.match(resultText, /card\.statusHeadline/)
  assert.match(resultText, /card\.openTasks/)
  const notice = noticeSource.getSnapshot()
  assert.equal(notice.tool, 'tower_status')
  assert.equal(notice.running, false)
  assert.equal(notice.ok, true)
})

test('toolview cards render review, preflight, merge, roster, complete and blocker shapes', () => {
  const { react, toolviews } = components()
  const cases = [
    ['tower_review', { review: { status: 'p1-2items', mergeVerdict: 'fix-then-merge', round: 2, findings: 'two problems', decision: 'fix first', checks: ['tests'] }, round: 2, branchTip: 'abcdef1234567' }],
    ['tower_preflight', { ok: false, blockers: [{ code: 'no-review', detail: 'review missing' }], changedFiles: ['a.js'] }],
    ['tower_merge', { ok: true, mergedCommit: 'abcdef1234567', baseTip: '1234567abcdef', warnings: ['slow hook'] }],
    ['tower_roster', { roster: [{ name: 'worker-m1', role: 'worker', missionId: 'M1', activity: 'running' }, { name: 'worker-m2', role: 'worker', missionId: 'M2', activity: 'missing', stale: true }], parentStatus: { s1: 'ok' } }],
    ['tower_complete', { mission: { id: 'M1', completionReport: { report: 'done', checks: [{ name: 'npm test', exitCode: 0 }, { name: 'lint', exitCode: 1 }] } }, commits: 2, unread: 0 }],
    ['tower_mission', { mission: { id: 'M1', status: 'blocked', tasks: [{ status: 'done' }, { status: 'open' }], blockers: ['waiting on base'], reviewPolicy: 'required-clean' } }],
    ['tower_spawn', { name: 'worker-m1', role: 'worker', missionId: 'M1', agentId: 'agent-123', worktree: { branch: 'tower/m1' }, created: true }, /card\.spawnLine/],
    ['tower_teardown', { ok: true, dryRun: false, removed: ['M1'], decisions: [{ missionId: 'M1', action: 'remove' }, { missionId: 'M2', action: 'keep', reason: 'live agent' }] }, /card\.teardownLine/],
    ['tower_interrupt', { ok: true, interrupted: true, previousActivity: 'running', entry: { name: 'worker-m1' } }, /card\.interruptYes/],
    ['tower_doctor', { ok: false, checks: [{ id: 'git', status: 'pass', detail: 'git version' }, { id: 'hmr', status: 'warn', detail: 'not mounted' }, { id: 'state', status: 'fail', detail: 'missing', action: 'init' }], environmentContract: {} }, /card\.doctorChecks/],
    ['tower_batch', { ok: true, action: 'status', batches: [], summary: { batchId: 'B1', status: 'open', members: [{ id: 'M1' }], checks: [{ missionId: 'M1', name: 'check', ok: true, outcome: 'passed' }], pendingChecks: [], failedChecks: [] } }, /card\.batchLine/],
  ]
  for (const [tool, payload, expectedKey] of cases) {
    const element = render(react, toolviews.get(tool), {
      toolName: tool,
      phase: 'result',
      callId: 'call-' + tool,
      block: { kind: 'tool/result', callId: 'call-' + tool, call: { name: tool }, content: [{ type: 'text', text: JSON.stringify(payload) }] },
      t,
    })
    assert.equal(element.props['data-tower-toolview'], tool)
    assert.ok(textOf(element).length > 0)
    if (expectedKey) assert.match(textOf(element), expectedKey)
  }
})

test('toolview stays defensive for errors, plain text, and partial/absent blocks', () => {
  const { react, toolviews } = components()
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

test('composer dock keeps the static hint without tower results and summarises the latest one', () => {
  const { react, dock } = components()

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
            call: { name: 'tower_status' },
            content: [{ type: 'text', text: JSON.stringify(statusPayload) }],
          },
        ],
        runningCalls: [],
      },
    })
  const summary = render(react, dock, { t, useChat: useChatStatus })
  assert.equal(findNode(summary, (node) => node.props['data-tower-ui'] === 'dock') !== null, true)
  assert.match(textOf(summary), /dock\.statusCounts/)

  const useChatRunning = (selector) => selector({ legacy: { nodes: [], runningCalls: [{ name: 'tower_spawn' }] } })
  const running = render(react, dock, { t, useChat: useChatRunning })
  assert.match(textOf(running), /dock\.running/)
})

test('overlay strip renders the notice, is pointer-transparent, and auto-dismiss is owned by ctx.effect', () => {
  const { react, overlay, noticeSource, effects, toolviews } = components()
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
  assert.equal(strip.props.style.pointerEvents, 'none')
  assert.match(textOf(strip), /strip\.started/)

  // The auto-dismiss timer lives in the plugin body and its cleanup is
  // registered with ctx.effect; freeing effects must be safe and idempotent.
  assert.ok(effects.some((effect) => effect.label === 'tower-ui: status strip timer'))
  assert.doesNotThrow(() => freeTimer({ effects }))
})
