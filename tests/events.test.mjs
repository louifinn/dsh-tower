// #75: domain events describe what changed (not which tool ran), are emitted
// only after the state write, and keep the tool-shaped `tower/<tool>` alias for
// one minor release. Run with: node --test "tests/*.test.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'

import { createDefaultDeps } from '../adapters/default.js'
import { registerTowerTools } from '../host/tool-registry.js'
import { Tower } from '../host/tower.js'
import {
  MISSION_EVENT_TABLE,
  buildMissionEvent,
  missionEventDescriptor,
} from '../domain/events.js'
import { newMission, applyPlan } from '../domain/missions/plan.js'
import { applyMissionUpdate } from '../domain/missions/lifecycle.js'
import { applyCompletion } from '../domain/missions/completion.js'
import { applyReviewOutcome } from '../domain/missions/review.js'
import { applyMergeSuccess, applyLandedMerge } from '../domain/integration/merge.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo(prefix = 'dsh-tower-events-') {
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

function recorder() {
  /** @type {Array<{ name: string, payload: any }>} */
  const events = []
  return {
    events,
    port: {
      emit(name, payload) {
        events.push({ name, payload })
      },
    },
    named(name) {
      return events.filter((event) => event.name === name)
    },
  }
}

/** The mock Cordis context: tools are captured and the emitter records events. */
function makeCtx() {
  const tools = new Map()
  const events = []
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
    emit(name, payload) {
      events.push({ name, payload })
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
  return { ctx, tools, events, dispose: () => disposers.forEach((dispose) => dispose()) }
}

test('domain transitions return { state, events }', () => {
  const mission = newMission(
    'M1',
    {
      title: 'Event shape',
      kind: 'build',
      scope: ['src/**'],
      tasks: [],
      deps: [],
      context: '',
      references: [],
      reviewPolicy: 'required-clean',
      reviewExemptionReason: '',
    },
    10,
  )
  const state = { missions: [], caseInsensitive: false }

  const planned = applyPlan(state, [mission])
  assert.equal(planned.state, state)
  assert.deepEqual(planned.events, [{ type: 'planned', missionId: 'M1' }])

  const abandoned = applyMissionUpdate({
    mission,
    state,
    input: { status: 'abandoned', note: 'descoped' },
    config: { mode: { requireResumeAuthorization: false } },
  })
  assert.equal(abandoned.state, mission)
  assert.deepEqual(abandoned.events, [{ type: 'abandoned', missionId: 'M1' }])

  const completed = applyCompletion({ mission, report: { report: 'done' }, now: 11 })
  assert.equal(completed.state, mission)
  assert.deepEqual(completed.events, [{ type: 'completed', missionId: 'M1' }])

  const reviewed = applyReviewOutcome({ mission, outcome: { returnToActive: false, note: 'clean' }, now: 12 })
  assert.equal(reviewed.state, mission)
  assert.deepEqual(reviewed.events, [{ type: 'reviewed', missionId: 'M1' }])

  const merged = applyMergeSuccess({ mission, branchTip: 'bbbbbbb', base: 'main', newTip: 'ccccccc', now: 13 })
  assert.equal(merged.state, mission)
  assert.deepEqual(merged.events, [{ type: 'merged', missionId: 'M1', commit: 'ccccccc' }])

  const landed = applyLandedMerge({ mission, mergedCommit: 'ddddddd', note: 'landed', now: 14 })
  assert.deepEqual(landed.events, [{ type: 'merged', missionId: 'M1', commit: 'ddddddd' }])

  // The descriptors finalise to the documented payload shapes.
  assert.deepEqual(buildMissionEvent(planned.events[0], { revision: 4, at: 99 }), {
    name: 'tower.mission.planned',
    payload: { missionId: 'M1', revision: 4, at: 99 },
  })
  assert.deepEqual(buildMissionEvent(merged.events[0], { revision: 5, at: 100 }), {
    name: 'tower.mission.merged',
    payload: { missionId: 'M1', revision: 5, at: 100, commit: 'ccccccc' },
  })
  assert.throws(() => missionEventDescriptor('merged', 'M1'), /requires the merge commit/)
})

test('a full mission lifecycle emits planned, completed, reviewed, merged and abandoned once each', async () => {
  const { root, repo } = makeRepo()
  const record = recorder()
  const deps = createDefaultDeps({ events: record.port })
  const tower = await Tower.open(repo, deps)
  let returned = false
  let firstPlan = true
  const originalEmit = record.port.emit
  record.port.emit = (name, payload) => {
    // Persist-then-emit: the first planning event is observed while the tool is
    // still running (never after the tool returns).
    if (firstPlan && name === 'tower.mission.planned') assert.equal(returned, false)
    originalEmit(name, payload)
  }
  try {
    await tower.init({})
    const planned = await tower.plan({
      missions: [{ title: 'Event mission', scope: ['src/**'], tasks: ['write it'] }],
    })
    firstPlan = false
    returned = true
    assert.equal(planned.revision, (await tower.load()).revision)
    const plannedEvent = record.named('tower.mission.planned').at(-1)
    assert.ok(plannedEvent)
    assert.equal(plannedEvent.payload.missionId, planned.missions[0].id)
    assert.equal(plannedEvent.payload.revision, planned.revision)
    assert.equal(typeof plannedEvent.payload.at, 'number')

    // A second mission is abandoned without touching the first.
    const second = await tower.plan({ missions: [{ title: 'Abandon me', scope: ['other/**'] }] })
    const missionId = planned.missions[0].id
    const provisioned = await tower.provision({ missionId })
    const wt = provisioned.worktree.path
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'a\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'M1 a'])
    await tower.mission({ id: missionId, status: 'active' })
    await tower.mission({ id: missionId, task_done: 'write it' })

    const agentId = 'agent-events'
    await tower.recordSpawn({
      missionId,
      name: 'worker-events',
      role: 'worker',
      agentId,
      parentSessionId: 'session-events',
      cwd: wt,
      branch: provisioned.worktree.branch,
    })
    const completed = await tower.complete({ missionId, agentId, report: 'done' })
    assert.equal(completed.mission.status, 'completed')
    const completedEvent = record.named('tower.mission.completed').at(-1)
    assert.equal(completedEvent.payload.missionId, missionId)
    assert.equal(completedEvent.payload.revision, (await tower.load()).revision)

    await tower.submitReview({
      missionId,
      agentId: 'reviewer-not-in-roster',
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'one in-scope file',
      actor: { name: 'tower', role: 'tower' },
      breakGlassReason: 'events test has no independent reviewer',
    })
    const reviewedEvent = record.named('tower.mission.reviewed').at(-1)
    assert.equal(reviewedEvent.payload.missionId, missionId)
    assert.equal(reviewedEvent.payload.revision, (await tower.load()).revision)

    const merged = await tower.merge({ missionId, activity: {} })
    assert.equal(merged.ok, true)
    const mergedEvent = record.named('tower.mission.merged').at(-1)
    assert.equal(mergedEvent.payload.missionId, missionId)
    assert.equal(mergedEvent.payload.commit, merged.mergedCommit)
    assert.equal(mergedEvent.payload.revision, (await tower.load()).revision)

    await tower.mission({ id: second.missions[0].id, status: 'abandoned', note: 'descoped' })
    const abandonedEvent = record.named('tower.mission.abandoned').at(-1)
    assert.equal(abandonedEvent.payload.missionId, second.missions[0].id)
    assert.equal(abandonedEvent.payload.revision, (await tower.load()).revision)

    for (const event of record.events) {
      const keys = Object.keys(event.payload).sort()
      assert.deepEqual(
        keys,
        event.name === 'tower.mission.merged' ? ['at', 'commit', 'missionId', 'revision'] : ['at', 'missionId', 'revision'],
        event.name,
      )
    }
    assert.equal(record.named('tower.mission.planned').length, 2)
    assert.equal(record.named('tower.mission.completed').length, 1)
    assert.equal(record.named('tower.mission.reviewed').length, 1)
    assert.equal(record.named('tower.mission.merged').length, 1)
    assert.equal(record.named('tower.mission.abandoned').length, 1)

    // A failed tool emits no success event: assert by count, not by the error.
    const before = record.events.length
    await assert.rejects(() => tower.plan({ missions: [] }), /needs at least one mission/)
    assert.equal(record.events.length, before)
    await assert.rejects(() => tower.complete({ missionId, agentId: 'nobody', report: 'again' }))
    assert.equal(record.events.length, before)
  } finally {
    removeTemp(root)
  }
})

test('the tool layer emits the domain event and keeps tower/<tool> as a deprecated alias', async () => {
  const { root, repo } = makeRepo('dsh-tower-event-tools-')
  const { ctx, tools, events, dispose } = makeCtx()
  registerTowerTools(ctx)
  const exec = { agent: { id: 'agent-event-tools' } }
  try {
    await tools.get('tower_init').execute({ repoRoot: repo }, exec)
    const before = events.length
    const planned = await tools
      .get('tower_plan')
      .execute({ repoRoot: repo, missions: [{ title: 'Alias mission', scope: ['src/**'] }] }, exec)

    const domain = events.filter((event) => event.name === 'tower.mission.planned')
    const alias = events.filter((event) => event.name === 'tower/plan')
    assert.equal(domain.length, 1)
    assert.deepEqual(domain[0].payload, {
      missionId: planned.missions[0].id,
      revision: planned.revision,
      at: domain[0].payload.at,
    })
    assert.equal(alias.length, 1)
    assert.equal(alias[0].payload.tool, 'tower_plan')
    assert.equal(alias[0].payload.repoRoot, repo)
    assert.equal(alias[0].payload.value.missions[0].id, planned.missions[0].id)

    // A failed tool emits neither the success domain event nor the alias.
    const failedFrom = events.length
    await assert.rejects(
      () => tools.get('tower_plan').execute({ repoRoot: repo, missions: [] }, exec),
      /needs at least one mission/,
    )
    assert.equal(events.length, failedFrom)
    assert.ok(before < failedFrom)
  } finally {
    dispose()
    removeTemp(root)
  }
})

test('the generated events reference marks the tool-shaped aliases deprecated and lists every domain event', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const text = fs.readFileSync(path.join(root, 'docs', 'reference', 'events.md'), 'utf8')
  assert.match(text, /deprecated/i)
  for (const entry of MISSION_EVENT_TABLE) {
    assert.ok(text.includes(`\`${entry.name}\``), entry.name)
    assert.ok(text.includes(`{ ${entry.payload.join(', ')} }`), entry.name)
  }
})
