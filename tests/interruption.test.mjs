// F105: `tower_test` used to kill the discovery shell *first* and only then ask
// win32's `taskkill /T` for the tree. By then the pid is gone, taskkill exits 128
// without enumerating anything, and every descendant the discovery command
// started (`node --test`'s per-file children included) keeps running in the
// mission worktree while the receipt already says "timed out". The regression
// below reproduces the orphan condition end to end and does not accept "the call
// returned promptly" as evidence: a descendant with *pending work* must die
// before that work happens.
//
// Timing budget: the discovery limit is 3000 ms, the descendant starts inside it,
// writes a start marker immediately, and only writes its sentinel 6 s later. The
// assertion window after `tower_test` returns covers 7 s, so a survivor has ample
// time to leave the sentinel behind. The start marker is the vacuity guard: it
// proves the descendant really ran inside the tree that got killed.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { removeTemp } from './helpers/cleanup.mjs'

import { registerTowerTools } from '../host/tool-registry.js'

const TIMEOUT_MS = 3000
const SENTINEL_SLEEP_MS = 6000
const ASSERT_WINDOW_MS = 7000

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-interruption-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  // Deterministic fixture bytes on every platform (Windows defaults to CRLF).
  git(repo, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo }
}

function makeCtx() {
  const tools = new Map()
  let seq = 0
  const subagents = {
    list: () => ['spawn'],
    startActivation: async () => {
      seq += 1
      return {
        childId: `child-${seq}`,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }], diagnostic: null }),
      }
    },
    sendMessage: async () => {},
    listDescendants: async () => [],
    interrupt: () => {},
  }
  const agentPresets = { list: async () => [{ id: 'tower-worker' }, { id: 'tower-reviewer' }] }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'subagents') return subagents
      if (name === 'agentPresets') return agentPresets
      return undefined
    },
    emit() {},
    tools: { register: (definition) => (tools.set(definition.name, definition), () => {}), guard: () => () => {}, restrict() {} },
    systemPrompt: { section() {} },
    inject(_deps, callback) { callback(ctx) },
  }
  return { ctx, tools }
}

/** Repository config lives at `<git-common-dir>/dsh-tower/config.json`. */
function writeRepoConfig(repo, value) {
  const file = path.join(repo, '.git', 'dsh-tower', 'config.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

test('tower_test: a timed-out discovery run kills the whole process tree (F105)', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  const towerExec = { agent: { id: 'tower-agent' } }
  const call = (name, args, exec = towerExec) => {
    const tool = tools.get(name)
    assert.ok(tool, `${name} is registered`)
    return tool.execute(args, exec)
  }
  try {
    await call('tower_init', { repoRoot: repo })
    const planned = await call('tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Timed out discovery', scope: ['README.md'], tasks: ['run discovery'] }],
    })
    const missionId = planned.missions[0].id
    const spawned = await call('tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    const workerExec = { agent: { id: spawned.agentId } }
    const worktree = spawned.worktree.path

    // The descendant's evidence lives beside the repository, not inside it, so a
    // survivor leaves proof without dirtying the worktree under test.
    const startedMarker = path.join(root, 'orphan-started.txt')
    const sentinel = path.join(root, 'orphan-sentinel.txt')
    const writer = path.join(root, 'orphan-writer.mjs')
    fs.writeFileSync(
      writer,
      [
        "import fs from 'node:fs'",
        `fs.writeFileSync(${JSON.stringify(startedMarker)}, 'the descendant started\\n')`,
        `await new Promise((resolve) => setTimeout(resolve, ${SENTINEL_SLEEP_MS}))`,
        `fs.writeFileSync(${JSON.stringify(sentinel)}, 'a descendant survived the timeout kill\\n')`,
        '',
      ].join('\n'),
    )
    // A plain child of the discovery fixture: on POSIX it stays inside the
    // detached shell's process group, and on Windows only a tree walk finds it.
    // Either way it is a descendant the kill must reach, and its stdio is ignored
    // so no parent pipe can take it down for the wrong reason.
    fs.writeFileSync(
      path.join(worktree, 'slow-discovery.mjs'),
      [
        "import { spawn } from 'node:child_process'",
        `spawn(process.execPath, [${JSON.stringify(writer)}], { stdio: 'ignore', windowsHide: true })`,
        'await new Promise((resolve) => setTimeout(resolve, 60000))',
        '',
      ].join('\n'),
    )

    // A discovery command that times out: the shell waits on a fixture that never
    // prints TAP, and that fixture leaves a busy descendant behind.
    const pkg = {
      name: 'discovery-interruption-fixture',
      version: '1.0.0',
      tower: {
        testDiscovery: {
          version: 1,
          commands: [{ id: 'slow', command: 'node slow-discovery.mjs', format: 'node-tap' }],
        },
      },
    }
    fs.writeFileSync(path.join(worktree, 'package.json'), JSON.stringify(pkg, null, 2))
    writeRepoConfig(repo, { tests: { timeoutMs: TIMEOUT_MS } })

    const started = Date.now()
    const tested = await call('tower_test', { repoRoot: repo, missionId }, workerExec)
    const elapsed = Date.now() - started

    // The receipt contract is unchanged by F105: a timeout is a failed receipt
    // with the duration in `error`, not a new status field.
    assert.equal(tested.configured, true)
    assert.equal(tested.ok, false)
    assert.equal(tested.receipt.ok, false)
    assert.match(tested.error, new RegExp(`timed out after ${TIMEOUT_MS}ms`))
    const command = tested.commands[0]
    assert.equal(command.id, 'slow')
    assert.equal(command.ok, false)
    assert.equal(command.error, `timed out after ${TIMEOUT_MS}ms`)
    assert.equal(command.exitCode, tested.receipt.commands[0].exitCode, 'the recorded receipt is returned as recorded')
    assert.ok(
      command.exitCode === null || Number.isInteger(command.exitCode),
      'a timed-out command still reports an exit status or null, never a fabricated one',
    )

    // Vacuity guard: the descendant really started inside the killed tree, so the
    // sentinel below is a statement about a process that existed, not about one
    // that never ran.
    assert.equal(
      fs.existsSync(startedMarker),
      true,
      'the descendant never started, so this run cannot prove anything about the tree kill',
    )
    assert.equal(fs.existsSync(sentinel), false, 'no descendant may outlive the kill long enough to finish its work')

    // Close the window after the descendant's pending write was due.
    await new Promise((resolve) => setTimeout(resolve, ASSERT_WINDOW_MS))
    assert.equal(
      fs.existsSync(sentinel),
      false,
      'a discovery descendant outlived the timeout kill and wrote its sentinel; the tree is not actually killed',
    )
    // A surviving descendant also holds the capture pipes open, so the old
    // ordering blocks the call until that descendant exits on its own. Returning
    // promptly is part of the same honesty claim as the sentinel.
    assert.ok(elapsed < 30000, 'the timeout must return promptly instead of waiting for the sleeping command')
  } finally {
    removeTemp(root)
  }
})
