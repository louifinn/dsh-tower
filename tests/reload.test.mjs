// HMR wiring tests: /tower reload and tower_reload must drive the DSH HMR
// service through runExclusive + reconcileProfile, and must degrade cleanly
// when the profile has no HMR service.
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// index.js reads the mode store at import time; isolate it before importing.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-reload-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')

function makeCtx(hmr) {
  const tools = new Map()
  const commands = new Map()
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'hmr') return hmr
      return undefined
    },
    emit() {},
    logger: { warn() {} },
    inject(_deps, callback) {
      callback(ctx)
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
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => {}
      },
    },
  }
  return { ctx, tools, commands }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-reload-repo-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo }
}

test('HMR wiring: tower_reload and /tower reload reconcile the profile', async () => {
  const calls = []
  const hmr = {
    async runExclusive(operation) {
      calls.push('runExclusive')
      return operation()
    },
    async reconcileProfile(ids) {
      calls.push({ ids })
      return { warnings: [], pending: [] }
    },
  }
  const { ctx, tools, commands } = makeCtx(hmr)
  apply(ctx, {})
  try {
    assert.ok(tools.has('tower_reload'), 'tower_reload is registered when HMR is available')
    const result = await tools.get('tower_reload').execute({}, { agent: { id: 'agent-hmr' } })
    assert.equal(result.ok, true)
    assert.equal(result.scheduled, true)
    assert.ok(result.delayMs <= 1000)
    await new Promise((resolve) => setTimeout(resolve, Math.max(20, result.delayMs) + 80))
    assert.ok(calls.includes('runExclusive'), 'reload runs inside hmr.runExclusive')
    const call = calls.find((entry) => entry && Array.isArray(entry.ids))
    assert.ok(call, 'reconcileProfile was called with requiredIds')
    assert.ok(call.ids.includes('tower'), 'the tower entry is a required id')

    const reply = await commands.get('tower').handler({
      agent: { id: 'agent-hmr' },
      rawInput: 'reload',
      attachments: [],
    })
    assert.equal(reply.kind, 'success')
    assert.match(reply.text, /reload scheduled/i)
    await new Promise((resolve) => setTimeout(resolve, 120))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('HMR wiring: without HMR the tool reports reload-unavailable and /tower reload explains why', async () => {
  const { ctx, tools, commands } = makeCtx(undefined)
  apply(ctx, {})
  assert.ok(tools.has('tower_reload'), 'tower_reload is still registered so the failure is actionable')
  await assert.rejects(
    () => tools.get('tower_reload').execute({}, { agent: { id: 'agent-no-hmr' } }),
    /\[tower:reload-unavailable\]/,
  )
  const reply = await commands.get('tower').handler({
    agent: { id: 'agent-no-hmr' },
    rawInput: 'reload',
    attachments: [],
  })
  assert.equal(reply.kind, 'error')
  assert.match(reply.text, /HMR|restart/i)
})

test('HMR wiring: /tower reload does not disturb on/off parsing', async () => {
  const hmr = {
    async runExclusive(operation) {
      return operation()
    },
    async reconcileProfile() {
      return { warnings: [], pending: [] }
    },
  }
  const { ctx, commands } = makeCtx(hmr)
  apply(ctx, {})
  const on = await commands.get('tower').handler({ agent: { id: 'agent-parse' }, rawInput: 'on', attachments: [] })
  assert.match(on.text, /Tower mode ON/)
  const off = await commands.get('tower').handler({ agent: { id: 'agent-parse' }, rawInput: 'off', attachments: [] })
  assert.match(off.text, /Tower mode OFF/)
})
