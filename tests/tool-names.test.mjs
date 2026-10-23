// #75 folded: briefings and skills must only name tools that exist in the
// registry. A rename would otherwise silently instruct workers to call a ghost.
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'

import { registerTowerTools } from '../host/tool-registry.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Register the real tool surface against a minimal mock context. */
function registeredToolNames() {
  const tools = new Map()
  const disposers = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      const disposer = typeof dispose === 'function' ? dispose : () => {}
      disposers.push(disposer)
      return disposer
    },
    get() {
      return undefined
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
      guard() {
        return () => {}
      },
      restrict() {},
    },
    systemPrompt: { section() {} },
    inject(_deps, callback) {
      callback(ctx)
    },
  }
  try {
    registerTowerTools(ctx)
    const names = new Set(tools.keys())
    // tower_mode/tower_control are registered by the Host entry itself, outside
    // the aggregator; they are part of the same registry surface.
    const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
    for (const match of indexSource.matchAll(/name:\s*'(tower_[a-z_]+)'/g)) names.add(match[1])
    return names
  } finally {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Every `tower_*` reference in one text, with its 1-based line.
 * @param {string} file
 * @param {string} text
 */
function references(file, text) {
  const found = []
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/tower_[a-z_]+/g)) found.push({ file, line: index + 1, name: match[0] })
  })
  return found
}

/**
 * @param {Array<{ file: string, text: string }>} files
 * @param {Set<string>} registry
 */
function unknownReferences(files, registry) {
  return files
    .flatMap(({ file, text }) => references(file, text))
    .filter((reference) => !registry.has(reference.name))
}

function referenceMessage(unknown) {
  return unknown.map((reference) => `${reference.file}:${reference.line} references unknown tool ${reference.name}`).join('\n')
}

function sourceFiles() {
  const files = [{ file: 'app/briefing.js', text: fs.readFileSync(path.join(root, 'app', 'briefing.js'), 'utf8') }]
  const skillsDir = path.join(root, 'skills')
  for (const name of fs.readdirSync(skillsDir).filter((entry) => entry.endsWith('.md')).sort()) {
    files.push({ file: `skills/${name}`, text: fs.readFileSync(path.join(skillsDir, name), 'utf8') })
  }
  return files
}

test('every tower_* name in app/briefing.js and skills/*.md exists in the tool registry', () => {
  const registry = registeredToolNames()
  assert.ok(registry.has('tower_plan'), 'the registry scan itself must see the real surface')
  const unknown = unknownReferences(sourceFiles(), registry)
  assert.deepEqual(unknown, [], referenceMessage(unknown))
})

test('the name check fails on a seeded rename fixture, naming file and line', () => {
  const registry = registeredToolNames()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-name-fixture-'))
  const fixture = path.join(dir, 'briefing-fixture.js')
  fs.writeFileSync(fixture, 'call tower_plan first\nthen tower_ghost with the same arguments\n')
  try {
    const unknown = unknownReferences([{ file: fixture, text: fs.readFileSync(fixture, 'utf8') }], registry)
    assert.equal(unknown.length, 1)
    assert.deepEqual(unknown[0], { file: fixture, line: 2, name: 'tower_ghost' })
    const message = referenceMessage(unknown)
    assert.match(message, /briefing-fixture\.js:2 references unknown tool tower_ghost/)
  } finally {
    removeTemp(dir)
  }
})
