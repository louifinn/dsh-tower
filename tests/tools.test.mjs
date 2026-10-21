// Tool-surface tests: output schemas, stable error codes, input aliases and
// the findings tool. These run the real registration against a mock Cordis
// context and a real temporary git repository. Run with:
//   node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { registerTowerTools } from '../lib/tools.js'
import { Tower } from '../lib/tower.js'
import { validateJsonSchema } from './schema-validator.mjs'

function makeCtx(services = {}) {
  const tools = new Map()
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      return services[name]
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
  return { ctx, tools }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo(prefix = 'dsh-tower-tools-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
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

// Validate an actual tool value against its declared output schema the same
// way DSH's tool registry does after every successful execute.
function validateAgainstSchema(value, schema, where = '$') {
  const violations = validateJsonSchema(schema, value, where)
  assert.deepEqual(violations, [], violations.join('; '))
}

test('tool surface: every tool declares a structured object output schema', () => {
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  assert.equal(tools.size, 27)
  for (const definition of tools.values()) {
    assert.equal(definition.output.schema.type, 'object', definition.name)
    assert.equal(typeof definition.output.render, 'function', definition.name)
    assert.ok(definition.description.length > 40, definition.name)
    assert.equal(definition.parameters.type, 'object', definition.name)
  }
  assert.ok(tools.has('tower_findings'), 'the finding lifecycle tool is registered')
  assert.ok(tools.get('tower_findings').description.includes('open'), 'statuses are documented')

  // Accepted input aliases are part of the parameter contract, not only of the
  // runtime normalizer.
  const aliasProperties = {
    tower_mission: ['missionId', 'taskDone', 'taskDrop', 'taskDropReason', 'clearBlockers'],
    tower_spawn: ['id', 'wait_ms'],
    tower_diff: ['id'],
    tower_merge: ['id', 'timeout_ms'],
    tower_inbox: ['includeRead'],
    tower_teardown: ['dryRun'],
    tower_finding: ['mission_id'],
    tower_findings: ['mission_id'],
  }
  for (const [name, keys] of Object.entries(aliasProperties)) {
    for (const key of keys) {
      assert.ok(key in tools.get(name).parameters.properties, `${name} parameter schema declares alias ${key}`)
    }
  }
})

test('tool aliases: missionId/id and taskDone/task_done/clearBlockers all work', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  const exec = { agent: { id: 'agent-tools' } }
  try {
    const initialized = await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    validateAgainstSchema(initialized, tools.get('tower_init').output.schema)

    const planned = await tools
      .get('tower_plan')
      .execute(
        { repoRoot: repo, missions: [{ title: 'Alias mission', scope: ['src/**'], tasks: ['write it', 'commit it'] }] },
        exec,
      )
    validateAgainstSchema(planned, tools.get('tower_plan').output.schema)
    const id = planned.missions[0].id

    // tower_mission canonical key is `id`; missionId is the accepted alias.
    const activated = await tools
      .get('tower_mission')
      .execute({ repoRoot: repo, missionId: id, status: 'active', taskDone: 'write it' }, exec)
    assert.equal(activated.mission.status, 'active')
    assert.equal(activated.mission.tasks.find((task) => task.text === 'write it').status, 'done')

    await tools.get('tower_mission').execute({ repoRoot: repo, id, blocker: 'waiting on review' }, exec)
    const cleared = await tools
      .get('tower_mission')
      .execute({ repoRoot: repo, missionId: id, clearBlockers: true }, exec)
    assert.deepEqual(cleared.mission.blockers, [])

    const status = await tools.get('tower_status').execute({ repoRoot: repo }, exec)
    validateAgainstSchema(status, tools.get('tower_status').output.schema)
    assert.equal(status.counts.blocked >= 1, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('tool errors: stable [tower:<code>] prefixes for common failures', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  const exec = { agent: { id: 'agent-errors' } }
  try {
    await assert.rejects(
      () => tools.get('tower_status').execute({ repoRoot: repo }, exec),
      /\[tower:not-initialized\]/,
    )
    const notRepo = path.join(root, 'not-a-repo')
    fs.mkdirSync(notRepo)
    await assert.rejects(
      () => tools.get('tower_init').execute({ repoRoot: notRepo }, exec),
      /\[tower:repo-invalid\]/,
    )
    await assert.rejects(
      () => tools.get('tower_diff').execute({ repoRoot: repo }, exec),
      /\[tower:invalid-argument\].*requires missionId/,
    )
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    await tools
      .get('tower_plan')
      .execute({ repoRoot: repo, missions: [{ title: 'Status guard', scope: ['src/**'] }] }, exec)
    await assert.rejects(
      () => tools.get('tower_mission').execute({ repoRoot: repo, id: '   ' }, exec),
      /\[tower:invalid-argument\].*requires id/,
    )
    await assert.rejects(
      () => tools.get('tower_mission').execute({ repoRoot: repo, id: 'M1', status: 'bogus' }, exec),
      /\[tower:invalid-argument\].*unknown mission status/,
    )
    await assert.rejects(
      () => tools.get('tower_diff').execute({ repoRoot: repo, id: 'M9' }, exec),
      /\[tower:mission-not-found\]/,
    )
    await assert.rejects(
      () => tools.get('tower_findings').execute({ repoRoot: repo, id: 'F9' }, exec),
      /\[tower:finding-not-found\]/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('findings tool: file, list, read and transition through the tool surface', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  const exec = { agent: { id: 'agent-findings' } }
  try {
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    await tools
      .get('tower_plan')
      .execute({ repoRoot: repo, missions: [{ title: 'Findings mission', scope: ['src/**'] }] }, exec)

    const filed = await tools
      .get('tower_finding')
      .execute(
        {
          repoRoot: repo,
          type: 'improve',
          title: 'flaky retry',
          summary: 'retry loop can spin',
          details: 'no backoff',
          suggested_fix: 'add backoff',
          missionId: 'M1',
        },
        exec,
      )
    validateAgainstSchema(filed, tools.get('tower_finding').output.schema)
    assert.equal(filed.status, 'open')

    const list = await tools.get('tower_findings').execute({ repoRoot: repo }, exec)
    validateAgainstSchema(list, tools.get('tower_findings').output.schema)
    assert.equal(list.total, 1)
    assert.equal(list.counts.open, 1)

    const read = await tools.get('tower_findings').execute({ repoRoot: repo, id: filed.id }, exec)
    validateAgainstSchema(read, tools.get('tower_findings').output.schema)
    assert.equal(read.finding.details, 'no backoff')

    const updated = await tools
      .get('tower_findings')
      .execute({ repoRoot: repo, id: filed.id, status: 'triaged', note: 'scheduled' }, exec)
    assert.equal(updated.finding.status, 'triaged')

    // A reviewer in the roster may read but must not mutate findings.
    const tower = await Tower.open(repo)
    await tower.recordSpawn({
      missionId: 'M1',
      name: 'reviewer-1',
      role: 'reviewer',
      agentId: 'agent-reviewer',
      parentSessionId: 'parent-1',
      cwd: null,
      branch: null,
    })
    const reviewerExec = { agent: { id: 'agent-reviewer' } }
    await assert.rejects(
      () => tools.get('tower_findings').execute({ repoRoot: repo, id: filed.id, status: 'fixed' }, reviewerExec),
      /\[tower:(?:invalid-transition|not-authorized)\].*reviewers may list and read/,
    )
    const reviewerRead = await tools.get('tower_findings').execute({ repoRoot: repo, id: filed.id }, reviewerExec)
    assert.equal(reviewerRead.finding.status, 'triaged')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('tower_plan refuses before creating missions when a preset is missing (#64)', async () => {
  const { root, repo } = makeRepo('dsh-tower-plan-preset-')
  const exec = { agent: { id: 'agent-plan-preset' } }
  const { ctx, tools } = makeCtx({ agentPresets: { list: async () => [{ id: 'tower-worker' }] } })
  registerTowerTools(ctx)
  try {
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    await assert.rejects(
      () => tools.get('tower_plan').execute({ repoRoot: repo, missions: [{ title: 'blocked', scope: ['x/**'] }] }, exec),
      (error) => {
        assert.equal(error.code, 'preset-missing')
        return true
      },
    )
    const state = await new Tower({ root: repo, commonDir: path.join(repo, '.git'), branch: 'main' }).load().catch(() => null)
    assert.equal(state?.missions?.length ?? 0, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('missing towerAgentId gives an actionable error and tower_init re-claims', async () => {
  const { root, repo } = makeRepo('dsh-tower-owner-missing-')
  const exec = { agent: { id: 'tower-agent' } }
  const restored = { agent: { id: 'restored-session' } }
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  try {
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    await tools.get('tower_plan').execute({ repoRoot: repo, missions: [{ title: 'Owner missing', scope: ['x/**'] }] }, exec)
    const tower = await Tower.open(repo)
    const state = await tower.load()
    delete state.towerAgentId
    state.revision += 1
    fs.writeFileSync(tower.paths.state, JSON.stringify(state, null, 2))
    await assert.rejects(
      () => tools.get('tower_plan').execute({ repoRoot: repo, missions: [{ title: 'Blocked', scope: ['y/**'] }] }, restored),
      /tower_init to re-claim/,
    )
    const status = await tools.get('tower_status').execute({ repoRoot: repo }, restored)
    assert.equal(status.ownerMissing, true)
    assert.equal(status.towerAgentId, null)
    await tools.get('tower_init').execute({ repoRoot: repo }, restored)
    const planned = await tools.get('tower_plan').execute({ repoRoot: repo, missions: [{ title: 'After claim', scope: ['z/**'] }] }, restored)
    assert.ok(planned.missions.length > 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
