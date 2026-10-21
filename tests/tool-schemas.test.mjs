// Full-protocol output-schema test: DSH validates every successful tool value
// against its declared `output.schema`, so this walks the real tool surface
// through a complete mission and checks every returned value. A nullable field
// declared with a concrete type fails here before it can fail in the runtime.
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { registerTowerTools } from '../tools/index.js'
import { validateJsonSchema } from './schema-validator.mjs'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-schemas-'))
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
  let childSeq = 0
  const activations = []
  const subagents = {
    list: () => ['spawn'],
    startActivation: async (input) => {
      childSeq += 1
      const childId = `child-${childSeq}`
      activations.push({ ...input, childId })
      return {
        childId,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }], diagnostic: null }),
      }
    },
    sendMessage: async () => {},
    listDescendants: async () => [],
  }
  const agentPresets = { list: async () => [{ id: 'tower-worker' }, { id: 'custom-worker' }, { id: 'tower-reviewer' }] }
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
  return { ctx, tools, activations }
}

test('every tool output satisfies its declared schema across a full mission', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools, activations } = makeCtx()
  registerTowerTools(ctx)
  const towerExec = { agent: { id: 'tower-agent' } }
  const call = async (name, args, exec = towerExec) => {
    const tool = tools.get(name)
    assert.ok(tool, `${name} is registered`)
    const value = await tool.execute(args, exec)
    const violations = validateJsonSchema(tool.output.schema, value)
    assert.deepEqual(violations, [], `${name} output violates its schema: ${violations.join('; ')}`)
    return value
  }

  try {
    // The repository config layer must reach the spawn path too.
    const configFile = path.join(repo, '.git', 'dsh-tower', 'config.json')
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    fs.writeFileSync(configFile, JSON.stringify({ spawn: { workerPreset: 'custom-worker' } }))

    await call('tower_init', { repoRoot: repo })
    const planned = await call('tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Schema walk', scope: ['src/**'], tasks: ['write it', 'commit it'], kind: 'build' }],
    })
    const missionId = planned.missions[0].id
    await call('tower_status', { repoRoot: repo })

    const spawned = await call('tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    assert.equal(spawned.preset, 'custom-worker', 'repo config spawn.workerPreset wins over the profile')
    const workerExec = { agent: { id: spawned.agentId } }
    const worktree = spawned.worktree.path
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true })
    fs.writeFileSync(path.join(worktree, 'src', 'out.txt'), 'schema walk\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-m', 'schema walk'])

    await call('tower_mission', { repoRoot: repo, missionId, taskDone: 'write it' })
    await call('tower_mission', { repoRoot: repo, id: ` ${missionId} `, taskDone: 'commit it' })
    await call('tower_roster', { repoRoot: repo })
    await call('tower_diff', { repoRoot: repo, missionId })

    const completed = await call('tower_complete', { repoRoot: repo, missionId, report: 'done' }, workerExec)
    assert.equal(completed.mission.status, 'completed')

    await call('tower_send', { repoRoot: repo, to: 'worker-m1', subject: 'note', body: 'read me' })
    await call('tower_inbox', { repoRoot: repo }, workerExec)

    const finding = await call('tower_finding', {
      repoRoot: repo,
      type: 'improve',
      title: 'schema finding',
      summary: 'from the schema walk',
      details: 'details',
      suggested_fix: 'fix it',
    })
    await call('tower_findings', { repoRoot: repo })
    await call('tower_findings', { repoRoot: repo, id: finding.id })
    await call('tower_findings', { repoRoot: repo, id: finding.id, status: 'triaged', note: 'noted' })

    await call('tower_rebase', { repoRoot: repo, missionId })

    const reviewer = await call('tower_spawn', { repoRoot: repo, missionId, role: 'reviewer' })
    assert.equal(reviewer.preset, 'tower-reviewer')
    assert.equal(activations.length, 2)
    const reviewerExec = { agent: { id: reviewer.agentId } }
    await call(
      'tower_review',
      {
        repoRoot: repo,
        missionId,
        status: 'clean',
        merge: 'merge',
        findings: 'none',
        decision: 'schema walk verified',
        checks: ['scope', 'diff'],
      },
      reviewerExec,
    )
    await call('tower_preflight', { repoRoot: repo, missionId })
    const merged = await call('tower_merge', { repoRoot: repo, missionId })
    assert.equal(merged.ok, true)
    await call('tower_status', { repoRoot: repo })
    const torn = await call('tower_teardown', { repoRoot: repo })
    assert.deepEqual(torn.removed, [missionId])
    await call('tower_adopt', { repoRoot: repo })
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
