// #149 W3: `blocked` and `paused` are two distinct stopped states.
//
// `blocked` is derived machine state: the mission has open blockers and no
// transition can leave it except clearing them. `paused` is a deliberate stop
// with a cause. They never coexist: recording a blocker supersedes a pause, and
// a paused mission with open blockers is not a state this tower can hold.
//
// Run with: node --test tests/paused-blocked.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'

import { Tower } from '../host/tower.js'
import { markBlocked } from '../domain/missions/lifecycle.js'
import { validateState } from '../domain/state.js'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-paused-blocked-'))
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

async function plannedMission() {
  const { root, repo } = makeRepo()
  const tower = await Tower.open(repo)
  await tower.init({ towerAgentId: 'tower-agent' })
  await tower.plan({ missions: [{ title: 'Stop semantics', scope: ['src/**'], tasks: ['one task'] }] })
  await tower.mission({ id: 'M1', status: 'active' })
  return { root, tower, repo }
}

test('blocked is derived from blockers: it cannot be set, and clearing resumes', async () => {
  const { root, tower, repo } = await plannedMission()
  try {
    await tower.recordSpawn({
      missionId: 'M1',
      name: 'worker-m1',
      role: 'worker',
      agentId: 'agent-worker',
      parentSessionId: 'parent-1',
      cwd: repo,
      branch: null,
    })
    await assert.rejects(
      () => tower.mission({ id: 'M1', status: 'blocked' }),
      (error) => {
        assert.equal(error.code, 'invalid-transition')
        assert.match(error.message, /blocked is derived from open blockers/)
        assert.match(error.message, /blocker:/)
        return true
      },
    )
    assert.equal((await tower.load()).missions[0].status, 'active')

    await tower.mission({ id: 'M1', blocker: 'waiting on the API key' })
    const stopped = (await tower.load()).missions[0]
    assert.equal(stopped.status, 'blocked')
    assert.deepEqual(stopped.blockers, ['waiting on the API key'])

    // A blocked mission cannot jump straight to another status.
    await assert.rejects(
      () => tower.mission({ id: 'M1', status: 'paused' }),
      (error) => {
        assert.match(error.message, /is blocked/)
        assert.match(error.message, /clear_blockers resumes it/)
        assert.match(error.message, /paused directly/)
        return true
      },
    )
    await assert.rejects(
      () => tower.mission({ id: 'M1', status: 'active' }),
      (error) => {
        assert.match(error.message, /clear_blockers resumes it/)
        return true
      },
    )
    await assert.rejects(
      () => tower.complete({ missionId: 'M1', agentId: 'agent-worker', report: 'done' }),
      (error) => {
        assert.match(error.message, /unresolved blockers/)
        assert.match(error.message, /clear the blockers to resume it/)
        return true
      },
    )

    const resumed = await tower.mission({ id: 'M1', clear_blockers: true })
    assert.equal(resumed.mission.status, 'active')
    const state = await tower.load()
    assert.equal(state.missions[0].status, 'active')
    assert.deepEqual(state.missions[0].blockers, [])
    // `{clear_blockers:true,status:"active"}` is one coherent resume step: the
    // redundant status patch must not be read as a second (same-state) move.
    await tower.mission({ id: 'M1', blocker: 'second stop' })
    const resumedAgain = await tower.mission({ id: 'M1', clear_blockers: true, status: 'active' })
    assert.equal(resumedAgain.mission.status, 'active')
    assert.deepEqual(resumedAgain.mission.blockers, [])
    const activity = await tower.deps.store.readActivityTail(tower.paths.activity, 3)
    assert.ok(
      activity.some((entry) => entry.type === 'mission' && /blockers cleared/.test(entry.text)),
      JSON.stringify(activity),
    )
  } finally {
    removeTemp(root)
  }
})

test('a pause and a blocker never coexist: the blocker wins and supersedes the pause', async () => {
  const { root, tower } = await plannedMission()
  try {
    await tower.mission({ id: 'M1', status: 'paused', pause_cause: 'failure' })
    let mission = (await tower.load()).missions[0]
    assert.equal(mission.status, 'paused')
    assert.equal(mission.pauseCause, 'failure')

    await tower.mission({ id: 'M1', blocker: 'the failure is now a recorded blocker' })
    mission = (await tower.load()).missions[0]
    assert.equal(mission.status, 'blocked')
    assert.equal(mission.pauseCause, undefined, 'the pause cause is deleted when a blocker takes over')
    assert.deepEqual(mission.blockers, ['the failure is now a recorded blocker'])

    // Pausing while blocked is not a transition: clear first, then pause.
    await assert.rejects(
      () => tower.mission({ id: 'M1', status: 'paused', pause_cause: 'user' }),
      /clear_blockers resumes it/,
    )
    await tower.mission({ id: 'M1', clear_blockers: true })
    await tower.mission({ id: 'M1', status: 'paused', pause_cause: 'user' })
    mission = (await tower.load()).missions[0]
    assert.equal(mission.status, 'paused')
    assert.equal(mission.pauseCause, 'user')
  } finally {
    removeTemp(root)
  }
})

test('state semantics rejects a mission whose stopped state and blockers disagree', async () => {
  const { root, tower } = await plannedMission()
  try {
    const state = await tower.load()

    const blockedWithoutBlocker = structuredClone(state)
    blockedWithoutBlocker.missions[0].status = 'blocked'
    blockedWithoutBlocker.missions[0].blockers = []
    assert.throws(
      () => validateState(blockedWithoutBlocker, 'state.json'),
      /is blocked but records no blocker/,
    )

    const activeWithBlocker = structuredClone(state)
    activeWithBlocker.missions[0].status = 'active'
    activeWithBlocker.missions[0].blockers = ['left behind']
    assert.throws(
      () => validateState(activeWithBlocker, 'state.json'),
      /has open blockers but is active; blocked is derived from open blockers/,
    )

    // Batches have their own canonical lifecycle: the legacy synonym is
    // normalized by the v5 migration, never accepted at rest (#149 W3).
    const legacyBatch = structuredClone(state)
    legacyBatch.batches = [{ id: 'B1', status: 'active' }]
    assert.throws(
      () => validateState(legacyBatch, 'state.json'),
      /batch B1 has unknown status active/,
    )
    const canonicalBatch = structuredClone(state)
    canonicalBatch.batches = [{ id: 'B1', status: 'open' }]
    assert.doesNotThrow(() => validateState(canonicalBatch, 'state.json'))

    // Terminal missions keep their blockers as history, and the invariant does
    // not rewrite the past.
    const terminal = structuredClone(state)
    terminal.missions[0].status = 'abandoned'
    terminal.missions[0].abandonReason = 'fixture'
    terminal.missions[0].blockers = ['historical blocker']
    assert.doesNotThrow(() => validateState(terminal, 'state.json'))
  } finally {
    removeTemp(root)
  }
})

test('markBlocked is the single writer of the blocked status', async () => {
  const mission = { id: 'M1', status: 'paused', blockers: [], pauseCause: 'user' }
  const now = 42
  markBlocked(mission, 'the shared checkout is dirty', now)
  assert.equal(mission.status, 'blocked')
  assert.deepEqual(mission.blockers, ['the shared checkout is dirty'])
  assert.equal(mission.pauseCause, undefined)
  assert.equal(mission.updatedAt, now)
  assert.throws(() => markBlocked({ ...mission, blockers: [] }, ''), /non-empty string/)
})
