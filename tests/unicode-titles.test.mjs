// Non-ASCII mission titles (#88): tower_plan accepts printable Unicode, the
// title is persisted as NFC, and it round-trips unchanged through tower_status,
// the MISSIONS.md board and the worker briefing. Mission ids stay ASCII.
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { registerTowerTools } from '../lib/tool-registry.js'
import { Tower } from '../lib/tower.js'
import { workerBriefing } from '../lib/briefing.js'
import { validateJsonSchema } from './schema-validator.mjs'

const exec = { agent: { id: 'tower-unicode' } }
const CJK_TITLE = '修复登录态过期'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function seedRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-unicode-'))
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

function makeCtx() {
  const tools = new Map()
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
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
  registerTowerTools(ctx)
  return { tools }
}

async function call(tools, name, args) {
  const tool = tools.get(name)
  assert.ok(tool, `${name} is registered`)
  const value = await tool.execute(args, exec)
  const violations = validateJsonSchema(tool.output.schema, value)
  assert.deepEqual(violations, [], `${name}: ${violations.join('; ')}`)
  return value
}

// Every row of the mission table must keep the header's cell count, or the
// Markdown collapses into a paragraph when rendered.
function missionTableRows(board) {
  const lines = board.split('\n')
  const header = lines.findIndex((line) => line.startsWith('| Mission | Status |'))
  assert.ok(header >= 0, 'the board has a mission table header')
  const rows = []
  for (let index = header; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.startsWith('|')) break
    rows.push(line)
  }
  return rows
}

test('CJK title round-trips plan -> state -> status -> MISSIONS.md -> briefing', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const planned = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [
        { title: CJK_TITLE, scope: ['src/**'], tasks: ['实现登录态刷新'] },
        { title: 'Cafe\u0301 lineup', scope: ['docs/**'] },
      ],
    })
    assert.equal(planned.missions[0].title, CJK_TITLE)
    assert.match(planned.missions[0].id, /^M\d+$/, 'mission ids stay ASCII')
    assert.match(planned.missions[1].id, /^M\d+$/, 'mission ids stay ASCII')

    const status = await call(tools, 'tower_status', { repoRoot: repo, format: 'markdown' })
    assert.equal(status.missions[0].title, CJK_TITLE)
    assert.equal(status.missions[1].title, 'Café lineup', 'the persisted title is NFC')
    assert.ok(status.markdown.includes(CJK_TITLE), 'the markdown board carries the title')

    const stateFile = path.join(status.commonDir, 'dsh-tower', 'state.json')
    const persisted = fs.readFileSync(stateFile, 'utf8')
    assert.ok(persisted.includes(CJK_TITLE), 'state.json stores the title unchanged')
    assert.ok(persisted.includes('Café'), 'state.json stores the NFC form')
    assert.ok(!persisted.includes('Cafe\u0301'), 'state.json does not store the NFD form')

    const board = fs.readFileSync(status.boardPath, 'utf8')
    assert.ok(board.includes(CJK_TITLE), 'MISSIONS.md carries the title unchanged')
    const rows = missionTableRows(board)
    assert.equal(rows.length, 4, 'header, separator and one row per mission')
    const headerCells = rows[0].split('|').length
    for (const row of rows) {
      assert.equal(row.split('|').length, headerCells, `the table row stays aligned: ${row}`)
    }
    const missionRow = rows.find((row) => row.startsWith('| M1 |'))
    assert.ok(missionRow, 'M1 has a board row')
    assert.equal(missionRow.split('|')[4].trim(), CJK_TITLE, 'the title is one unbroken table cell')

    const tower = await Tower.open(repo)
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === 'M1')
    const briefing = workerBriefing({
      repoRoot: repo,
      base: state.base,
      mission,
      deps: [],
      worktree: {
        path: path.join(root, 'worktree'),
        branch: 'tower/m1-repair-login',
        baseCommit: 'a'.repeat(40),
      },
      instructions: '',
    })
    assert.equal(briefing.split('\n')[0], `# Tower mission M1 — ${CJK_TITLE}`, 'the briefing heading keeps the title')
    assert.ok(briefing.includes(CJK_TITLE), 'the briefing body keeps the title')
  } finally {
    removeTemp(root)
  }
})

test('tower_plan rejects invisible and over-long titles with distinct stable codes', async () => {
  const { root, repo } = seedRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const cases = [
      ['a'.repeat(200), /120/],
      [`Fix \u202Elogin`, /bidi override/],
      [`Fix \u200Blogin`, /zero-width/],
      ['line\nbreak', /control/],
    ]
    for (const [title, pattern] of cases) {
      await assert.rejects(
        () =>
          tools.get('tower_plan').execute(
            { repoRoot: repo, missions: [{ title, scope: ['src/**'] }] },
            exec,
          ),
        (error) => {
          assert.equal(error.code, 'invalid-argument')
          assert.match(error.message, pattern)
          assert.doesNotMatch(error.message, /printable ASCII/)
          return true
        },
      )
    }
    const status = await call(tools, 'tower_status', { repoRoot: repo })
    assert.equal(status.total, 0, 'no mission is created when a title is rejected')
  } finally {
    removeTemp(root)
  }
})
