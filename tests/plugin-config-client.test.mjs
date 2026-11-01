// #M40: contract test for the core `dsh-tower` Web Client half.
//
// No browser, no Harness install: this loads client.js through a fake
// `window.__ModuleLoader__`, supplies React from a tiny hook runtime, runs
// `apply(ctx)` against a recording Cordis-like context, and renders the single
// `plugins.bundle.config` registration with a fake Host config form. It pins the
// package/loader shape, the slot key, exactly three options (off/optional/
// required), the settings-form mutate path, and the loading/unavailable/
// read-only/save-failure render states. The review policy is one keyed config
// slot, never a component row.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCordisPatch } from '../domain/components.js'
import { resolveTowerConfig } from '../domain/config/schema.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT_PATH = path.join(ROOT, 'client.js')
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const PATCH = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')

// ---------------------------------------------------------------------------
// Fakes: hook runtime, module loader, Cordis context, Host config form.
// ---------------------------------------------------------------------------
function createReact() {
  const states = []
  const refs = []
  const effects = []
  let cursor = 0
  let dirty = false
  const React = {
    createElement(tag, props, ...children) {
      return { tag, props: props || {}, children }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (states[index] === undefined) states[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [
        states[index].value,
        (next) => {
          const value = typeof next === 'function' ? next(states[index].value) : next
          if (!Object.is(value, states[index].value)) {
            states[index].value = value
            dirty = true
          }
        },
      ]
    },
    useEffect(fn, deps) {
      const index = cursor
      cursor += 1
      const previous = effects[index]
      const same =
        previous &&
        Array.isArray(deps) &&
        Array.isArray(previous.deps) &&
        deps.length === previous.deps.length &&
        deps.every((dep, i) => Object.is(dep, previous.deps[i]))
      if (same) return
      if (previous && typeof previous.cleanup === 'function') previous.cleanup()
      effects[index] = { deps, cleanup: fn() }
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (refs[index] === undefined) refs[index] = { current: initial }
      return refs[index]
    },
  }
  function expand(element) {
    if (element === null || element === undefined || typeof element !== 'object') return element
    if (Array.isArray(element)) return element.map(expand)
    if (typeof element.tag === 'function') return expand(element.tag(element.props))
    return Object.assign({}, element, { children: element.children.map(expand) })
  }
  function render(Component, props) {
    for (let pass = 0; pass < 20; pass += 1) {
      dirty = false
      cursor = 0
      const tree = expand(Component(props))
      if (!dirty) return tree
    }
    throw new Error('component did not settle')
  }
  return { React, render }
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
    throw new Error(`unexpected require("${id}") — the plugin client may only require react`)
  }
  return { loaded, plugin: loaded.factory(fakeRequire), required, window }
}

function createContext(form) {
  const injections = []
  const registrations = []
  const effects = []
  const locales = []
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
        locales.push({ namespace, dictionaries })
        return () => {}
      },
    },
    slots: {
      inject(owner, callback) {
        injections.push({ owner, callback })
        return () => {}
      },
      register(options, component) {
        const entry = { options, component }
        registrations.push(entry)
        return () => {
          const index = registrations.indexOf(entry)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
    get(name) {
      if (name !== 'configForms') return undefined
      return {
        get(id) {
          return id === 'tower-host' ? form : undefined
        },
      }
    },
  }
  return {
    ctx,
    injections,
    registrations,
    effects,
    locales,
    runInjections() {
      for (const injection of injections) injection.callback()
    },
  }
}

function setPath(target, pathParts, value) {
  let cursor = target
  for (const part of pathParts.slice(0, -1)) {
    if (cursor[part] === undefined || typeof cursor[part] !== 'object') cursor[part] = {}
    cursor = cursor[part]
  }
  cursor[pathParts[pathParts.length - 1]] = value
}

// Apply Host form `set` ops to a plain profile patch, the way the settings form
// merges the accepted value into the profile.
function applyOps(profile, ops) {
  const next = JSON.parse(JSON.stringify(profile ?? {}))
  for (const op of ops) {
    assert.equal(op.op, 'set')
    setPath(next, op.path, op.value)
  }
  return next
}

function makeForm(value, options = {}) {
  const calls = []
  const listeners = new Set()
  let snapshot = {
    status: options.status ?? 'ready',
    value,
    base: {},
    user: {},
    revision: 1,
    writable: options.writable !== false,
  }
  return {
    calls,
    getSnapshot() {
      return snapshot
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate(ops, revision) {
      calls.push({ ops, revision })
      if (options.reject) return Promise.resolve(false)
      const next = JSON.parse(JSON.stringify(snapshot.value ?? {}))
      for (const op of ops) {
        assert.equal(op.op, 'set')
        setPath(next, op.path, op.value)
      }
      snapshot = { ...snapshot, value: next, revision: snapshot.revision + 1 }
      for (const listener of listeners) listener()
      return Promise.resolve(true)
    },
    emit() {
      for (const listener of listeners) listener()
    },
    patch(patchValue) {
      snapshot = { ...snapshot, value: patchValue }
    },
  }
}

function findNodes(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findNodes(child, predicate, out)
    return out
  }
  if (node.props && predicate(node)) out.push(node)
  for (const child of node.children || []) findNodes(child, predicate, out)
  return out
}

function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') {
    if (typeof node === 'string' || typeof node === 'number') out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  for (const child of node.children || []) collectText(child, out)
  return out
}

function textOf(node) {
  return collectText(node).join(' ')
}

function radios(tree) {
  return findNodes(tree, (node) => node.tag === 'input' && node.props.type === 'radio')
}

function mount(form) {
  const { React, render } = createReact()
  const bundle = loadBundle(React)
  const fakeCtx = createContext(form)
  bundle.plugin.apply(fakeCtx.ctx)
  return {
    bundle,
    fakeCtx,
    render(props = {}) {
      fakeCtx.runInjections()
      const registration = fakeCtx.registrations[0]
      return render(registration.component, { form, t: props.t })
    },
    // eslint-disable-next-line no-async-promise-executor
    async flush() {
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

// ---------------------------------------------------------------------------
// 1. Package and loader contract.
// ---------------------------------------------------------------------------
test('the package ships one plain-JS client half declared as a Web bundle', () => {
  assert.equal(PACKAGE.exports['./client'], './client.js')
  assert.ok(PACKAGE.files.includes('client.js'), 'client.js must be published')
  assert.equal(PACKAGE.dsh.client.platform, 'web')
  assert.equal(PACKAGE.dsh.client.immediately, true, 'the settings control must be available without a lazily loaded page')
  assert.equal(PACKAGE.dsh.bundle.patch, './cordis.patch.yml')

  const syntax = spawnSync(process.execPath, ['--check', CLIENT_PATH], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
  assert.doesNotMatch(SOURCE, /^\s*(import|export)\s/m, 'plain browser artifact, not an ES module')
  assert.doesNotMatch(SOURCE, /@deepseek-ai\//, 'the Client half must not import Harness packages')
  assert.doesNotMatch(SOURCE, /\brequire\(\s*['"](?!react['"])/, 'the Client half may only require react')

  const { loaded, plugin, required } = loadBundle(createReact().React)
  assert.equal(loaded.id, 'dsh-tower')
  assert.equal(loaded.chunk, undefined)
  assert.deepEqual(required, ['react'])
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
})

// ---------------------------------------------------------------------------
// 2. Registration: one keyed config slot, not component rows.
// ---------------------------------------------------------------------------
test('apply registers exactly one plugins.bundle.config slot for key dsh-tower', async () => {
  const form = makeForm({ review: { mode: 'optional' } })
  const { fakeCtx } = mount(form)
  fakeCtx.runInjections()

  assert.equal(fakeCtx.registrations.length, 1, 'the policy is one control, never three rows')
  const registration = fakeCtx.registrations[0]
  assert.equal(registration.options.name, 'plugins.bundle.config')
  assert.equal(registration.options.key, 'dsh-tower')
  assert.equal(registration.options.locale, 'dsh-tower')
  assert.equal(typeof registration.options.inject, 'function')
  assert.equal(registration.options.inject().form, form)

  // The source has exactly one slot registration call: a second row would have
  // to be another registration, and the fixture below proves rows stay
  // independent of this control.
  assert.equal((SOURCE.match(/ctx\.slots\.register\(/g) || []).length, 1)
  assert.equal((SOURCE.match(/ctx\.slots\.inject\(/g) || []).length, 1)
})

test('the locale registration carries both dictionaries with three labelled options', async () => {
  const form = makeForm({})
  const { fakeCtx } = mount(form)
  assert.equal(fakeCtx.locales.length, 1)
  const { namespace, dictionaries } = fakeCtx.locales[0]
  assert.equal(namespace, 'dsh-tower')
  for (const language of ['en', 'zh']) {
    assert.ok(dictionaries[language], `${language} dictionary is registered`)
    for (const mode of ['off', 'optional', 'required']) {
      assert.ok(dictionaries[language][`config.${mode}.label`], `${language} ${mode} label`)
      assert.ok(dictionaries[language][`config.${mode}.description`], `${language} ${mode} description`)
    }
    assert.equal(dictionaries[language]['config.off.label'], language === 'zh' ? '关闭' : 'Off')
    assert.equal(dictionaries[language]['config.optional.label'], language === 'zh' ? '可选' : 'Optional')
    assert.equal(dictionaries[language]['config.required.label'], language === 'zh' ? '必需' : 'Required')
    for (const value of Object.values(dictionaries[language])) {
      assert.doesNotMatch(String(value), /\breview\.[A-Za-z]|\btower_[a-z]|\/tower\b/, 'no raw config-key syntax in user copy')
    }
  }
})

// ---------------------------------------------------------------------------
// 3. Three options, default optional, current value reflected.
// ---------------------------------------------------------------------------
test('the section renders exactly three options with the optional default', async () => {
  const form = makeForm({})
  const mounted = mount(form)
  const tree = mounted.render()
  const inputs = radios(tree)
  assert.deepEqual(inputs.map((input) => input.props.value), ['off', 'optional', 'required'])
  assert.equal(inputs.filter((input) => input.props.checked).length, 1)
  assert.equal(inputs.find((input) => input.props.checked).props.value, 'optional')

  const text = textOf(tree)
  for (const label of ['Off', 'Optional', 'Required']) assert.match(text, new RegExp(label))
  assert.match(text, /no review can be recorded/i)
  assert.match(text, /never blocks a merge/i)
  assert.match(text, /clean review at the branch tip blocks merge/i)
  assert.equal(findNodes(tree, (node) => node.props && node.props.role === 'radiogroup').length, 1)
})

test('a resolved required value is reflected as the selected option', async () => {
  const form = makeForm({ review: { mode: 'required' } })
  const mounted = mount(form)
  const tree = mounted.render()
  const checked = radios(tree).find((input) => input.props.checked)
  assert.equal(checked.props.value, 'required')
  assert.equal(radios(tree).length, 3)
})

// R46 P1: the page must show the *resolved* policy, not only `review.mode`.
// The Host form projects a volatile field even when its sibling is absent, so a
// profile that still sets only the deprecated alias reaches this component as
// `{review:{requireReview:true}}` with no `mode`.
test('the displayed policy comes from the resolved mode, including the legacy alias', () => {
  for (const [value, expected] of [
    [{ review: { requireReview: true } }, 'required'],
    [{ review: { requireReview: false } }, 'optional'],
    [{ review: {} }, 'optional'],
    [{}, 'optional'],
    [{ review: { mode: 'off', requireReview: false } }, 'off'],
    [{ review: { mode: 'required', requireReview: true } }, 'required'],
    [{ review: { mode: 'optional', requireReview: false } }, 'optional'],
  ]) {
    const checked = radios(mount(makeForm(value)).render()).find((input) => input.props.checked)
    assert.equal(checked.props.value, expected, JSON.stringify(value))
    assert.equal(resolveTowerConfig(value).review.mode, expected, `resolver agrees: ${JSON.stringify(value)}`)
  }

  // Mode-first is the resolver's precedence: only a literal `true` raises the
  // mode, and `true` beside a non-required mode is a contradiction the runtime
  // rejects before this page can ever describe it.
  assert.throws(() => resolveTowerConfig({ review: { mode: 'off', requireReview: true } }), /review\.mode.*review\.requireReview/)
  assert.throws(() => resolveTowerConfig({ review: { mode: 'optional', requireReview: true } }), /review\.mode.*review\.requireReview/)
})

// ---------------------------------------------------------------------------
// 4. Saving through the Host config form.
// ---------------------------------------------------------------------------
test('choosing a mode writes review.mode through the Host config form', async () => {
  const form = makeForm({ review: { mode: 'optional' } })
  const mounted = mount(form)
  let tree = mounted.render()
  const required = radios(tree).find((input) => input.props.value === 'required')
  required.props.onChange()
  await mounted.flush()
  tree = mounted.render()

  assert.equal(form.calls.length, 1)
  assert.deepEqual(form.calls[0], {
    ops: [
      { op: 'set', path: ['review', 'mode'], value: 'required' },
      // The deprecated scalar alias is normalized in the same write, so the
      // stored profile patch can never contradict the selected mode.
      { op: 'set', path: ['review', 'requireReview'], value: false },
    ],
    revision: 1,
  })
  assert.equal(radios(tree).find((input) => input.props.checked).props.value, 'required')
  assert.match(textOf(tree), /Saved\./)
})

test('saving any of the three options writes the mode and normalizes the alias to false', async () => {
  const cases = [
    [{ review: { mode: 'optional' } }, 'off'],
    [{ review: { mode: 'required' } }, 'optional'],
    [{ review: { mode: 'off' } }, 'required'],
    // The same holds when the page started from the legacy-only shape.
    [{ review: { requireReview: true } }, 'off'],
    [{ review: { requireReview: false } }, 'required'],
  ]
  for (const [value, target] of cases) {
    const form = makeForm(value)
    const mounted = mount(form)
    radios(mounted.render())
      .find((input) => input.props.value === target)
      .props.onChange()
    await mounted.flush()

    assert.equal(form.calls.length, 1, JSON.stringify(value))
    assert.deepEqual(
      form.calls[0],
      {
        ops: [
          { op: 'set', path: ['review', 'mode'], value: target },
          { op: 'set', path: ['review', 'requireReview'], value: false },
        ],
        revision: 1,
      },
      JSON.stringify(value),
    )
    const tree = mounted.render()
    assert.equal(radios(tree).find((input) => input.props.checked).props.value, target)
  }
})

test('a legacy-only profile stays valid after a simulated save of every option', async () => {
  for (const [start, target] of [
    [{ review: { requireReview: true } }, 'off'],
    [{ review: { requireReview: true } }, 'optional'],
    [{ review: { requireReview: false } }, 'required'],
  ]) {
    const form = makeForm(start)
    const mounted = mount(form)
    radios(mounted.render())
      .find((input) => input.props.value === target)
      .props.onChange()
    await mounted.flush()

    // Replay the accepted ops onto a profile that still stored only the alias.
    const patched = applyOps({ review: { requireReview: true } }, form.calls[0].ops)
    assert.equal(patched.review.requireReview, false, 'the save normalizes the alias')
    assert.doesNotThrow(() => resolveTowerConfig(patched), 'the saved profile must not be config-invalid')
    const resolved = resolveTowerConfig(patched)
    assert.equal(resolved.review.mode, target)
    assert.equal(resolved.review.requireReview, target === 'required')
  }
})

test('a refused save keeps the previous selection and explains the failure', async () => {
  const form = makeForm({ review: { mode: 'optional' } }, { reject: true })
  const mounted = mount(form)
  let tree = mounted.render()
  radios(tree)
    .find((input) => input.props.value === 'off')
    .props.onChange()
  await mounted.flush()
  tree = mounted.render()

  assert.equal(radios(tree).find((input) => input.props.checked).props.value, 'optional')
  assert.match(textOf(tree), /could not be saved/i)
  assert.doesNotMatch(textOf(tree), /Saved\./)
})

// R46 P2 (documented limitation): the review tool is registered at apply time,
// so a session whose profile started with review off keeps it absent after a
// live switch to optional/required. The control says so instead of implying the
// tool is already available; the merge gate itself does read the new mode.
test('switching away from a profile that started with review off explains the restart requirement', async () => {
  const form = makeForm({ review: { mode: 'off' } })
  const mounted = mount(form)
  let tree = mounted.render()
  assert.equal(radios(tree).find((input) => input.props.checked).props.value, 'off')
  assert.doesNotMatch(textOf(tree), /restart/i)
  assert.equal(findNodes(tree, (node) => node.props && Object.hasOwn(node.props, 'data-dsh-tower-restart-hint')).length, 0)

  radios(tree)
    .find((input) => input.props.value === 'optional')
    .props.onChange()
  await mounted.flush()
  tree = mounted.render()
  assert.equal(radios(tree).find((input) => input.props.checked).props.value, 'optional')
  assert.match(textOf(tree), /merge gate already uses the new choice/i)
  assert.match(textOf(tree), /restart/i)
  assert.equal(findNodes(tree, (node) => node.props && Object.hasOwn(node.props, 'data-dsh-tower-restart-hint')).length, 1)

  // A profile that did not start off needs no restart: the tool was registered.
  const started = mount(makeForm({ review: { mode: 'optional' } }))
  let next = started.render()
  radios(next)
    .find((input) => input.props.value === 'required')
    .props.onChange()
  await started.flush()
  next = started.render()
  assert.doesNotMatch(textOf(next), /restart/i)
})

// ---------------------------------------------------------------------------
// 5. Unavailable / read-only states never crash the page.
// ---------------------------------------------------------------------------
test('a missing form renders an unavailable section instead of throwing', async () => {
  const { React, render } = createReact()
  const bundle = loadBundle(React)
  const fakeCtx = createContext(undefined)
  // Apply, then feed the component no form at all (as if configForms were absent).
  await bundle.plugin.apply(fakeCtx.ctx)
  fakeCtx.runInjections()
  const registration = fakeCtx.registrations[0]
  const tree = render(registration.component, {})
  assert.match(textOf(tree), /cannot be changed here/i)
  const inputs = radios(tree)
  assert.equal(inputs.length, 3)
  assert.ok(inputs.every((input) => input.props.disabled))
})

test('loading, unavailable and read-only snapshots render clear text and disable the options', async () => {
  for (const [status, writable, pattern] of [
    ['loading', true, /Loading the saved review policy/i],
    ['unavailable', true, /cannot be changed here/i],
    ['ready', false, /read-only/i],
  ]) {
    const form = makeForm({ review: { mode: 'required' } }, { status, writable })
    const mounted = mount(form)
    const tree = mounted.render()
    assert.match(textOf(tree), pattern, `${status}/${writable}`)
    assert.ok(radios(tree).every((input) => input.props.disabled))
    assert.equal(radios(tree).find((input) => input.props.checked).props.value, 'required')
  }
})

// ---------------------------------------------------------------------------
// 6. No component-row coupling: a second row cannot conflict with the control.
// ---------------------------------------------------------------------------
test('fixture: a second component row stays independent of the single config control', () => {
  // The shipped patch has no review-policy component row; only the reviewer
  // capability row exists, and it is not the policy.
  const shipped = parseCordisPatch(PATCH)
  const reviewRows = shipped.rows.filter((row) => /review/i.test(row.id))
  assert.deepEqual(reviewRows.map((row) => row.id), ['preset-tower-reviewer'])
  assert.equal(reviewRows[0].scope, 'visible')

  // A fixture with an extra row still parses as two independent rows. Neither
  // changes the client control: it is keyed by the bundle, not by rows, and it
  // renders exactly one radiogroup with three values.
  const fixture = `
- insert:
  - id: tower
    name: tower
    config:
      - id: tower-host
        name: dsh-tower
  - id: tower-review-policy
    name: a second row
`
  const parsed = parseCordisPatch(fixture)
  assert.deepEqual(parsed.visible, ['tower', 'tower-review-policy'])
  assert.equal(parsed.rows.length, 3)

  const form = makeForm({ review: { mode: 'required' } })
  const tree = mount(form).render()
  assert.equal(findNodes(tree, (node) => node.props && node.props.role === 'radiogroup').length, 1)
  assert.deepEqual(radios(tree).map((input) => input.props.value), ['off', 'optional', 'required'])
})
