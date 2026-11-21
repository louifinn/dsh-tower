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
import { removeTemp } from './helpers/cleanup.mjs'

import { registerTowerTools } from '../host/tool-registry.js'
import { ToolInputs } from '../domain/contracts/tool-inputs/index.js'
import { SCHEMAS } from '../domain/contracts/outputs.js'
import { Tower } from '../host/tower.js'
import { teardownWorktreeRoot } from '../app/teardown.js'
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
  git(repo, ['config', 'core.autocrlf', 'false'])
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
  const agentPresets = {
    list: async () => [
      { id: 'tower-worker' },
      { id: 'custom-worker' },
      { id: 'tower-reviewer' },
      // F60: a survey mission is spawned with the survey shape's own preset.
      { id: 'tower-survey' },
      { id: 'tower-survey-sandbox' },
    ],
  }
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
    await call('tower_inspect', { repoRoot: repo, view: 'status' })

    // #201: a bounded wait returns one conclusion. The planned mission cannot
    // reach `completed` inside the timeout, and an absent mission is unknown —
    // never a timeout.
    const waited = await call('tower_wait', { repoRoot: repo, missionId, timeoutMs: 1000 })
    assert.equal(waited.status, 'timeout')
    assert.equal(waited.target.missionId, missionId)
    const missing = await call('tower_wait', { repoRoot: repo, missionId: 'M999', timeoutMs: 1000 })
    assert.equal(missing.status, 'unknown')

    const spawned = await call('tower_spawn', { repoRoot: repo, missionId, role: 'worker' })
    assert.equal(spawned.preset, 'custom-worker', 'repo config spawn.workerPreset wins over the profile')
    const workerExec = { agent: { id: spawned.agentId } }
    const worktree = spawned.worktree.path
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true })
    fs.writeFileSync(path.join(worktree, 'src', 'out.txt'), 'schema walk\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-m', 'schema walk'])

    const appended = await call('tower_mission', { repoRoot: repo, missionId, taskAdd: ['schema-added'] })
    assert.deepEqual(appended.mission.tasks.at(-1), { text: 'schema-added', status: 'open' })
    await call('tower_mission', { repoRoot: repo, missionId, taskDone: 'schema-added' })
    await call('tower_mission', { repoRoot: repo, missionId, taskDone: 'write it' })
    await call('tower_mission', { repoRoot: repo, id: ` ${missionId} `, taskDone: 'commit it' })
    await call('tower_inspect', { repoRoot: repo, view: 'status' })
    await call('tower_inspect', { repoRoot: repo, view: 'diff', missionId })

    const completed = await call('tower_complete', { repoRoot: repo, missionId, report: 'done' }, workerExec)
    assert.equal(completed.mission.status, 'completed')

    // #207: `agent` narrows both views to one row plus its bounded activity and
    // never returns the whole table.
    const lone = await call('tower_inspect', { repoRoot: repo, view: 'roster', agent: 'worker-m1', tail: 3 })
    assert.equal(lone.agent.name, 'worker-m1')
    assert.equal(lone.roster, undefined, 'an agent view is not the roster table')
    assert.ok(Array.isArray(lone.activity))
    assert.ok(lone.activity.length <= 3)
    const single = await call('tower_inspect', { repoRoot: repo, view: 'status', agent: 'worker-m1' })
    assert.equal(single.agent.name, 'worker-m1')
    assert.equal(single.missions, undefined, 'an agent status view is not a mission page')
    assert.equal(single.total, undefined)
    assert.ok(Array.isArray(single.activity))
    assert.ok(single.activity.length <= 5, 'the default activity tail is bounded')
    // #207 P2: `compact` keeps only the agent identity, plus the bound
    // mission's id/status/kind for the status view — no activity/observed/stale
    // or outcome keys on the projected agent object.
    const rosterCompact = await call('tower_inspect', { repoRoot: repo, view: 'roster', agent: 'worker-m1', compact: true })
    assert.deepEqual(Object.keys(rosterCompact.agent).sort(), ['missionId', 'name', 'role', 'state'])
    assert.equal(rosterCompact.agent.name, 'worker-m1')
    assert.ok(Array.isArray(rosterCompact.activity), 'the compact view still carries the separate bounded activity tail')
    const statusCompact = await call('tower_inspect', { repoRoot: repo, view: 'status', agent: 'worker-m1', compact: true })
    assert.deepEqual(Object.keys(statusCompact.agent).sort(), ['missionId', 'name', 'role', 'state'])
    assert.deepEqual(Object.keys(statusCompact.mission).sort(), ['id', 'kind', 'status'])
    assert.ok('observed' in single.agent && 'stale' in single.agent, 'non-compact keeps the observation fields')
    await assert.rejects(
      () => tools.get('tower_inspect').execute({ repoRoot: repo, view: 'roster', agent: 'worker-ghost' }, towerExec),
      (error) => error.code === 'invalid-argument' && /unknown roster agent/.test(error.message),
    )
    await assert.rejects(
      () => tools.get('tower_inspect').execute({ repoRoot: repo, view: 'status', agent: 'worker-m1', missionId }, towerExec),
      (error) => error.code === 'invalid-argument',
    )
    await assert.rejects(
      () => tools.get('tower_inspect').execute({ repoRoot: repo, view: 'status', tail: 51 }, towerExec),
      (error) => error.code === 'invalid-argument',
    )
    // R186: `tail` bounds one agent's activity or the newest roster rows; the
    // status dashboard has no tail to cut, so the combination is refused
    // instead of silently ignored.
    await assert.rejects(
      () => tools.get('tower_inspect').execute({ repoRoot: repo, view: 'status', tail: 3 }, towerExec),
      (error) => error.code === 'invalid-argument' && /tail only with agent/.test(error.message),
    )
    // With `agent`, tail still bounds that one row's status activity.
    const statusTail = await call('tower_inspect', { repoRoot: repo, view: 'status', agent: 'worker-m1', tail: 2 })
    assert.ok(statusTail.activity.length <= 2, 'status + agent + tail bounds the activity')
    // R186: an unknown agent on `status` alone is refused, never answered with
    // the dashboard.
    await assert.rejects(
      () => tools.get('tower_inspect').execute({ repoRoot: repo, view: 'status', agent: 'worker-ghost' }, towerExec),
      (error) => error.code === 'invalid-argument' && /unknown roster agent/.test(error.message),
    )

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
    await call('tower_finding', { repoRoot: repo })
    await call('tower_finding', { repoRoot: repo, id: finding.id })
    await call('tower_finding', { repoRoot: repo, op: 'update', id: finding.id, status: 'triaged', note: 'noted' })

    await call('tower_rebase', { repoRoot: repo, missionId })

    const reviewer = await call('tower_spawn', { repoRoot: repo, missionId, role: 'reviewer' })
    assert.equal(reviewer.preset, 'tower-reviewer')
    assert.equal(activations.length, 2)
    const reviewerExec = { agent: { id: reviewer.agentId } }
    // #202: the reviewer produces run evidence through the same read-only
    // whitelist the shipped tool advertises; this walk validates the output
    // shape (the worktree has no node_modules here, so tsc is unavailable and
    // the summary carries the documented spawn.nodeModules remedy).
    const verified = await call('tower_verify', { repoRoot: repo, missionId, checks: [{ kind: 'tsc' }] }, reviewerExec)
    assert.equal(verified.ok, false)
    assert.equal(verified.checks[0].status, 'unavailable')
    assert.match(verified.checks[0].runId, /^run-\d+$/)
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
    await call('tower_inspect', { repoRoot: repo, view: 'status', missionId })
    const merged = await call('tower_merge', { repoRoot: repo, missionId })
    assert.equal(merged.ok, true)
    await call('tower_inspect', { repoRoot: repo, view: 'status' })
    const torn = await call('tower_teardown', { repoRoot: repo })
    assert.deepEqual(torn.removed, [missionId])
    await call('tower_init', { repoRoot: repo, op: 'adopt' })
  } finally {
    removeTemp(root)
  }
})

// F60: a survey runs in the shared checkout (or, with `survey.sandbox:
// 'detached'`, a disposable detached sandbox) and owns no branch, so
// `tower_spawn` reports `worktree: null` (tools/spawn.js). The declared schema
// used to require an object, so every successful survey spawn ended in
// `tool "tower_spawn" returned invalid output: "value.worktree" must be an
// object` and the operator retried into "mission already has a live worker".
// The placement is a union: the branch-worktree object or null.
test('spawn output schema accepts the survey (null) and build (object) placements', () => {
  const schema = SCHEMAS.spawn
  const identity = {
    name: 'worker-m1',
    agentId: 'agent-1',
    role: 'worker',
    missionId: 'M1',
    preset: 'tower-survey',
    provider: 'default',
  }
  const survey = { ...identity, worktree: null }
  const build = {
    ...identity,
    preset: 'tower-worker',
    worktree: { path: 'D:/worktrees/M1', branch: 'tower/m1', baseCommit: 'a'.repeat(40) },
  }
  assert.deepEqual(validateJsonSchema(schema, survey), [], 'a survey spawn has no worktree')
  assert.deepEqual(validateJsonSchema(schema, build), [], 'a build spawn names its branch worktree')

  // Only the placement is nullable: the identity fields every successful spawn
  // returns stay required and type-checked.
  for (const field of ['name', 'agentId', 'role', 'missionId', 'preset', 'provider']) {
    const value = { ...build }
    delete value[field]
    const violations = validateJsonSchema(schema, value)
    assert.ok(
      violations.some((entry) => entry.includes(`"value.${field}"`) && entry.includes('required')),
      `a spawn result without ${field} must be rejected: ${violations.join('; ')}`,
    )
  }
  for (const [field, bad] of [['name', 1], ['role', 7], ['missionId', null], ['provider', false]]) {
    const violations = validateJsonSchema(schema, { ...build, [field]: bad })
    assert.ok(
      violations.some((entry) => entry.includes(`"value.${field}"`)),
      `a spawn result with ${field}=${JSON.stringify(bad)} must be rejected: ${violations.join('; ')}`,
    )
  }

  // A build placement must still be the documented object: a string, a scalar,
  // an array and a wrong-typed member are all rejected (never `S.any`).
  for (const worktree of ['tower/m1', 42, true, [], { path: 42 }, { path: 'D:/wt', branch: 7 }, { path: 'D:/wt', baseCommit: false }]) {
    const violations = validateJsonSchema(schema, { ...build, worktree })
    assert.ok(
      violations.some((entry) => entry.includes('"value.worktree"')),
      `worktree ${JSON.stringify(worktree)} must be rejected: ${violations.join('; ')}`,
    )
  }

  // The key is invariant even though its value is nullable: tools/spawn.js
  // always writes `worktree` (`{path, branch, baseCommit}` for a build, `null`
  // for a survey, which owns no checkout), so a report that drops the key has
  // lost its placement and must be rejected. Presence is required; null is legal.
  for (const [label, report] of [['build', build], ['survey', survey]]) {
    const omitted = { ...report }
    delete omitted.worktree
    const missing = validateJsonSchema(schema, omitted)
    assert.ok(
      missing.some((entry) => entry.includes('"value.worktree"') && entry.includes('required')),
      `a ${label} spawn result without worktree must be rejected: ${missing.join('; ')}`,
    )
  }
})

test('a survey spawn reports worktree: null and satisfies the real spawn schema (F60)', async () => {
  // The end-to-end regression: the value comes from the shipped tower_spawn,
  // not a hand-written fixture, so this walk fails exactly the way the runtime
  // did before the schema fix.
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  const towerExec = { agent: { id: 'tower-agent' } }
  try {
    await tools.get('tower_init').execute({ repoRoot: repo }, towerExec)
    const planned = await tools.get('tower_plan').execute(
      { repoRoot: repo, missions: [{ title: 'Read the seed commit', kind: 'survey', tasks: ['read the seed commit'] }] },
      towerExec,
    )
    const missionId = planned.missions[0].id
    const spawn = tools.get('tower_spawn')
    const value = await spawn.execute({ repoRoot: repo, missionId, role: 'worker' }, towerExec)
    assert.equal(value.worktree, null, 'a survey placement owns no worktree')
    assert.equal(value.missionId, missionId)
    assert.equal(value.preset, 'tower-survey')
    const violations = validateJsonSchema(spawn.output.schema, value)
    assert.deepEqual(violations, [], `survey spawn output violates its schema: ${violations.join('; ')}`)
  } finally {
    removeTemp(root)
  }
})

// F88: the opt-in orphan sweep lives in app/teardown.js and is gated on
// `orphans === true`, but the tool contract was still the closed
// `{force, exclude, dry_run}` object. A caller therefore could not reach the
// capability at all: the host's closed-schema admission rejected `orphans`
// before the app saw it. This walks the registered definition (not
// `tower.teardown`) so the regression is the one a tool caller would hit, and
// proves the opt-in reaches the app by observing the sweep.
test('tower_teardown admits the opt-in orphan sweep through its registered contract (F88)', async () => {
  const { root, repo } = makeRepo()
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  const towerExec = { agent: { id: 'tower-agent' } }
  const teardown = tools.get('tower_teardown')
  assert.ok(teardown, 'tower_teardown is registered')

  try {
    // The schema stays closed: `orphans` is admitted as the one new optional
    // boolean, an unknown key and a wrong-typed value are still rejected.
    assert.equal(teardown.parameters.additionalProperties, false, 'the contract stays closed')
    assert.ok(teardown.parameters.properties.orphans, 'the contract advertises the orphans option')
    assert.equal(teardown.parameters.properties.orphans.type, 'boolean')
    assert.deepEqual(validateJsonSchema(teardown.parameters, { orphans: true }), [])
    assert.deepEqual(validateJsonSchema(teardown.parameters, { orphans: false }), [])
    const unknownKey = validateJsonSchema(teardown.parameters, { orphans: true, bogus: 1 })
    assert.ok(
      unknownKey.some((entry) => entry.includes('"value.bogus"') && entry.includes('not allowed')),
      `an unknown key is still rejected: ${unknownKey.join('; ')}`,
    )
    const wrongType = validateJsonSchema(teardown.parameters, { orphans: 'yes' })
    assert.ok(
      wrongType.some((entry) => entry.includes('"value.orphans"') && entry.includes('boolean')),
      `orphans must be a boolean: ${wrongType.join('; ')}`,
    )
    // The advertised description tells the caller the sweep exists and is opt-in.
    assert.match(teardown.description, /orphan sweep/)
    assert.match(teardown.description, /opt-in/)

    await tools.get('tower_init').execute({ repoRoot: repo }, towerExec)
    const tower = await Tower.open(repo)
    const worktreeRoot = teardownWorktreeRoot(tower)
    fs.mkdirSync(worktreeRoot, { recursive: true })
    const orphan = path.join(worktreeRoot, 'unrecorded-clean')
    git(repo, ['worktree', 'add', '-b', 'orphan-unrecorded-clean', orphan, 'HEAD'])

    // Default-off: the same registered tool leaves the unrecorded checkout alone
    // and reports no orphan block.
    const plain = await teardown.execute({ repoRoot: repo }, towerExec)
    assert.equal(Object.hasOwn(plain, 'orphanWorktrees'), false, 'the sweep is opt-in')
    assert.equal(fs.existsSync(orphan), true, 'a default teardown touches no unrecorded checkout')

    // Opt-in through the tool surface: the app receives `orphans: true`, sweeps
    // the clean unrecorded checkout and returns the report.
    const swept = await teardown.execute({ repoRoot: repo, orphans: true }, towerExec)
    assert.ok(swept.orphanWorktrees, 'the opt-in reaches app/teardown.js')
    assert.equal(
      path.resolve(swept.orphanWorktrees.root),
      path.resolve(worktreeRoot),
      'the report names the resolved worktree root',
    )
    const decision = swept.orphanWorktrees.decisions.find(
      (entry) => path.resolve(entry.path) === path.resolve(orphan),
    )
    assert.ok(decision, 'the sweep inventories the unrecorded checkout')
    assert.equal(decision.action, 'removed')
    assert.equal(fs.existsSync(orphan), false, 'only clean unrecorded checkouts are removed')
    assert.deepEqual(
      validateJsonSchema(teardown.output.schema, swept),
      [],
      'the opt-in report still satisfies the declared teardown output schema',
    )
  } finally {
    removeTemp(root)
  }
})

// #206: `runId` belongs to the CompleteInput contract itself, not to a
// module-load patch in tools/complete.js. The registered parameters must be the
// same object the contract exports, and a second registration must not append
// anything to the shared schema.
test('tower_complete.runId is part of the input contract, not a module-load patch', () => {
  const checkItem = ToolInputs.tower_complete.properties.checks.items
  assert.equal(checkItem.properties.runId.type, 'string')
  assert.deepEqual(checkItem.required, ['name'], 'runId stays optional')
  const first = makeCtx()
  registerTowerTools(first.ctx)
  const registered = first.tools.get('tower_complete')
  assert.deepEqual(
    JSON.parse(JSON.stringify(registered.parameters)),
    JSON.parse(JSON.stringify(ToolInputs.tower_complete)),
    'the registered parameters are the contract object, not a mutated copy',
  )
  const snapshot = JSON.stringify(registered.parameters)
  const second = makeCtx()
  registerTowerTools(second.ctx)
  assert.equal(JSON.stringify(second.tools.get('tower_complete').parameters), snapshot)
  assert.deepEqual(Object.keys(registered.parameters.properties.checks.items.properties).sort(), [
    'command',
    'evidence',
    'exitCode',
    'name',
    'runId',
  ])
})

// #216: the bulk form is declared on the same closed object: item fields are
// exactly the single-form fields plus the required `id`, `ids` is a string
// array, and `atomic` is a boolean. Nothing widens `additionalProperties`.
test('tower_mission bulk form is a closed schema, not an unknown-field escape hatch', () => {
  const { ctx, tools } = makeCtx()
  registerTowerTools(ctx)
  const parameters = tools.get('tower_mission').parameters
  assert.equal(parameters.additionalProperties, false)
  assert.equal(parameters.properties.missions.type, 'array')
  assert.deepEqual(parameters.properties.missions.items.required, ['id'])
  assert.equal(parameters.properties.missions.items.additionalProperties, false)
  assert.equal(parameters.properties.ids.type, 'array')
  assert.equal(parameters.properties.ids.items.type, 'string')
  assert.equal(parameters.properties.atomic.type, 'boolean')
  const singleFields = Object.keys(parameters.properties).filter((key) => !['missions', 'ids', 'atomic'].includes(key))
  // Human acceptance remains a single-mission action: the bulk item schema
  // carries every other per-mission field and nothing more.
  const expected = singleFields.filter((key) => !['accept', 'accept_note'].includes(key))
  assert.deepEqual(Object.keys(parameters.properties.missions.items.properties).sort(), expected.sort())
})
