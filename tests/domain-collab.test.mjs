// Focused unit tests for the pure collaboration policy modules extracted in P3a.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clearStale,
  recordRosterObservations,
  reconcileObservedInactive,
  retireEntries,
  markMissingEntries,
  sweepRosterState,
} from '../domain/collab/roster.js'
import {
  isWorkerRole,
  liveWorkerLimit,
  applySpawnOutcome,
  applyInterrupt,
  reservedRosterEntry,
  reserveRosterEntry,
  recordSpawnEntry,
  rosterProjection,
} from '../domain/collab/spawn.js'
import {
  assertMessageRecipient,
  createMessage,
  addDelivery,
  inboxView,
  unreadMessages,
} from '../domain/collab/messages.js'
import {
  nextBatchId,
  createBatchRecord,
  closeBatchRecord,
  abandonBatchCheck,
  applyBatchAbandon,
  batchStatusPayload,
} from '../domain/collab/batch.js'

const worker = (overrides = {}) => ({ name: 'w', role: 'worker', state: 'active', agentId: 'a1', ...overrides })

test('roster observations count absences and clear on presence', () => {
  const roster = [worker({ absentObservations: undefined, spawnedAt: 0 })]
  const first = recordRosterObservations(roster, { absent: ['a1'], confirmations: 2 }, 100)
  assert.deepEqual(first, { candidates: [], changed: true })
  assert.equal(roster[0].absentObservations, 1)
  assert.equal(roster[0].absentSince, 100)
  const second = recordRosterObservations(roster, { absent: ['a1'], confirmations: 2 }, 200)
  assert.deepEqual(second.candidates, ['a1'])
  const present = recordRosterObservations(roster, { present: ['a1'] }, 300)
  assert.deepEqual(present, { candidates: [], changed: true })
  assert.equal(roster[0].absentObservations, undefined)
  assert.equal(roster[0].absentSince, undefined)
})

test('roster reconcile/retire/missing/sweep policies are pure transitions', () => {
  const roster = [
    worker({ name: 'active', agentId: 'a1', stale: true, staleAt: 1 }),
    worker({ name: 'reserved', agentId: undefined, state: 'reserved' }),
    worker({ name: 'gone', agentId: 'a2', state: 'failed' }),
  ]
  assert.deepEqual(reconcileObservedInactive(roster, { a1: 'inactive', undefined: 'inactive' }, 10), { released: ['active'] })
  assert.equal(roster[0].state, 'inactive')
  assert.equal(roster[0].outcome, 'catalog reported inactive')
  assert.equal(roster[0].outcomeAt, 10)
  assert.equal(roster[0].stale, undefined)
  assert.equal(roster[1].state, 'reserved')

  const retireRoster = [worker({ agentId: 'x', state: 'retired' }), worker({ agentId: 'y', name: 'y' })]
  assert.deepEqual(retireEntries(retireRoster, ['x', 'y'], 20), { retired: ['y'] })
  assert.equal(retireRoster[1].state, 'retired')
  assert.equal(retireRoster[1].retiredAt, 20)
  assert.deepEqual(retireEntries(retireRoster, [], 20), { retired: [] })

  const missingRoster = [worker({ agentId: 'inactive', state: 'inactive' }), worker({ agentId: 'live', name: 'live' })]
  assert.deepEqual(markMissingEntries(missingRoster, ['inactive', 'live'], 30), { missing: ['live'] })
  assert.equal(missingRoster[1].missingSince, 30)
  assert.deepEqual(markMissingEntries(missingRoster, [], 30), { missing: [] })

  const sweepRoster = [
    worker({ name: 'stale', agentId: 's1', spawnedAt: 0 }),
    worker({ name: 'idle', agentId: 's2', spawnedAt: 0 }),
    worker({ name: 'running', agentId: 's3', spawnedAt: 0 }),
  ]
  assert.deepEqual(
    sweepRosterState(sweepRoster, { staleMs: 10, authoritative: true, activity: { s2: 'inactive', s3: 'running' } }, 100),
    { marked: ['stale'], idled: ['idle'] },
  )
  assert.equal(sweepRoster[0].state, 'stale')
  assert.equal(sweepRoster[0].stale, true)
  assert.equal(sweepRoster[0].staleAt, 100)
  assert.equal(sweepRoster[1].state, 'inactive')
  assert.equal(sweepRoster[1].outcome, 'idle (catalog)')
  assert.equal(sweepRoster[2].state, 'active')
  assert.deepEqual(sweepRosterState(sweepRoster, { staleMs: 0, authoritative: true }, 100), { marked: [], idled: [] })
  assert.deepEqual(sweepRosterState(sweepRoster, { staleMs: 10, authoritative: false }, 100), { marked: [], idled: [] })
  clearStale(sweepRoster[0])
  assert.equal(sweepRoster[0].stale, undefined)
})

test('spawn policy projects entries and enforces worker limits', () => {
  assert.equal(isWorkerRole('worker'), true)
  assert.equal(isWorkerRole('reviewer'), false)
  assert.equal(liveWorkerLimit(undefined), 4)
  assert.equal(liveWorkerLimit(0), 4)
  assert.equal(liveWorkerLimit('2'), 2)

  const reserved = reservedRosterEntry(
    { name: 'worker-m1', role: 'worker', missionId: 'M1', parentSessionId: 'p', cwd: '/w', branch: 'b' },
    5,
  )
  assert.equal(reserved.state, 'reserved')
  assert.equal(reserved.agentId, null)
  assert.equal(reserved.reservedAt, 5)
  assert.throws(
    () => reserveRosterEntry({ roster: [worker({ name: 'worker-m1' })], input: { name: 'worker-m1' }, now: 6 }),
    /roster name already used: worker-m1/,
  )

  const mission = { id: 'M1', status: 'planned', owner: null, ownerGeneration: 0 }
  const roster = []
  const entry = recordSpawnEntry({
    roster,
    mission,
    input: { name: 'worker-m1', role: 'worker', agentId: 'a1', missionId: 'M1' },
    spawnTip: 'tip',
    maxLiveWorkers: 4,
    now: 7,
  })
  assert.equal(entry.generation, 1)
  assert.equal(entry.spawnTip, 'tip')
  assert.equal(roster.length, 1)
  assert.equal(mission.owner, 'worker-m1')
  assert.equal(mission.status, 'active')
  assert.equal(mission.ownerGeneration, 1)

  assert.throws(
    () => recordSpawnEntry({ roster, mission, input: { name: 'worker-m1', role: 'worker', agentId: 'a2', missionId: 'M1' }, spawnTip: null, maxLiveWorkers: 4, now: 8 }),
    /roster name already used/,
  )
  assert.throws(
    () => recordSpawnEntry({ roster, mission, input: { name: 'other', role: 'worker', agentId: 'a1', missionId: 'M1' }, spawnTip: null, maxLiveWorkers: 4, now: 8 }),
    /is already in the roster/,
  )
  assert.throws(
    () => recordSpawnEntry({ roster, mission, input: { name: 'worker-m1-b', role: 'worker', agentId: 'a3', missionId: 'M1' }, spawnTip: null, maxLiveWorkers: 4, now: 8 }),
    /already has a live worker/,
  )

  const takeoverMission = { id: 'M2', status: 'active', owner: null, ownerGeneration: 0 }
  const takeoverRoster = [worker({ name: 'old', agentId: 'o1', missionId: 'M2' })]
  const takeover = recordSpawnEntry({
    roster: takeoverRoster,
    mission: takeoverMission,
    input: { name: 'new', role: 'worker', agentId: 'o2', missionId: 'M2', takeover: true },
    spawnTip: null,
    maxLiveWorkers: 4,
    now: 9,
  })
  assert.equal(takeover.name, 'new')
  assert.equal(takeoverRoster[0].state, 'retired')
  assert.match(takeoverRoster[0].outcome, /replaced by new \(takeover\)/)

  const limitedMission = { id: 'M3', status: 'planned', owner: null, ownerGeneration: 0 }
  const limitedRoster = [worker({ name: 'busy', agentId: 'b1', missionId: 'M-other' })]
  assert.throws(
    () =>
      recordSpawnEntry({
        roster: limitedRoster,
        mission: limitedMission,
        input: { name: 'new-m3', role: 'worker', agentId: 'b2', missionId: 'M3' },
        spawnTip: null,
        maxLiveWorkers: 1,
        now: 10,
      }),
    /live worker limit reached \(1\)/,
  )
})

test('spawn outcome and interrupt projections mutate only their draft row', () => {
  const failed = applySpawnOutcome(worker({ stale: true, staleAt: 1 }), { state: 'failed', detail: 'boom' }, 11)
  assert.equal(failed.state, 'failed')
  assert.equal(failed.outcome, 'boom')
  assert.equal(failed.outcomeAt, 11)
  assert.equal(failed.stale, undefined)
  assert.equal(applySpawnOutcome(worker(), { state: 'inactive' }, 12).outcome, null)

  const interrupted = applyInterrupt(worker(), {}, 13)
  assert.equal(interrupted.state, 'interrupted')
  assert.equal(interrupted.outcome, 'interrupted by tower')
  assert.equal(applyInterrupt(worker(), { reason: 'stop' }, 14).outcome, 'stop')
})

test('roster projection exposes mission worktree summaries', () => {
  const view = rosterProjection({
    revision: 3,
    roster: [worker()],
    missions: [
      { id: 'M1', status: 'active', owner: 'w', worktree: { path: '/w', branch: 'b', baseCommit: 'c' } },
      { id: 'M2', status: 'planned', owner: undefined },
    ],
  })
  assert.equal(view.revision, 3)
  assert.equal(view.roster.length, 1)
  assert.deepEqual(view.missions[0].worktree, { path: '/w', branch: 'b', baseCommit: 'c' })
  assert.equal(view.missions[1].owner, null)
  assert.equal(view.missions[1].worktree, null)
})

test('message routing and inbox reads are validated in the domain', () => {
  assert.doesNotThrow(() => assertMessageRecipient({ roster: [worker({ name: 'w' })], to: 'w', from: 'tower' }))
  assert.doesNotThrow(() => assertMessageRecipient({ roster: [], to: 'all', from: 'tower' }))
  assert.doesNotThrow(() => assertMessageRecipient({ roster: [], to: 'tower', from: 'w' }))
  assert.throws(
    () => assertMessageRecipient({ roster: [worker({ name: 'w' })], to: 'ghost', from: 'tower' }),
    /unknown message recipient "ghost" \(known: w, tower, all\)/,
  )
  assert.throws(
    () => assertMessageRecipient({ roster: [worker({ name: 'w' })], to: 'w', from: 'w' }),
    /refusing to send a message to yourself/,
  )

  const message = createMessage({ from: 'tower', to: 'w', subject: 's', body: 'b' }, 2, 3)
  assert.equal(message.id, 'msg-2')
  assert.equal(message.scope, null)
  assert.deepEqual(message.delivery, [])
  assert.deepEqual(addDelivery(message, [{ ok: true }]), [{ ok: true }])
  assert.deepEqual(addDelivery(message, [{ ok: false }]), [{ ok: true }, { ok: false }])

  const messages = [
    { id: 'm1', from: 'tower', to: 'all', subject: 's1', body: 'b1', at: 1, readBy: [], delivery: [], readAt: {} },
    { id: 'm2', from: 'tower', to: 'w', subject: 's2', body: 'b2', at: 2, readBy: [], delivery: [], readAt: {} },
    { id: 'm3', from: 'w', to: 'w', subject: 's3', body: 'b3', at: 3, readBy: [], delivery: [], readAt: {} },
  ]
  const first = inboxView(messages, { reader: 'w', limit: 1 }, 50)
  assert.equal(first.changed, true)
  assert.deepEqual(first.payload.messages.map((entry) => entry.id), ['m2'])
  assert.equal(first.payload.messages[0].ackAt, 50)
  assert.equal(first.payload.unreadRemaining, 1)
  assert.deepEqual(messages[1].readBy, ['w'])
  const second = inboxView(messages, { reader: 'w', includeRead: true, limit: 10 }, 60)
  assert.equal(second.changed, true)
  assert.deepEqual(second.payload.messages.map((entry) => entry.id), ['m2', 'm1'])
  assert.equal(second.payload.unreadRemaining, 0)

  assert.deepEqual(
    unreadMessages(
      {
        messages: [
          { from: 'tower', to: 'all', readBy: [] },
          { from: 'tower', to: 'w', readBy: ['w'] },
          { from: 'w', to: 'w', readBy: [] },
          { from: 'tower', to: 'other', readBy: [] },
        ],
      },
      'w',
    ).length,
    1,
  )
})

test('batch lifecycle decisions assign ids and project status', () => {
  assert.equal(nextBatchId([]), 'B1')
  assert.equal(nextBatchId([{ id: 'B2' }, { id: 'B10' }, { id: 'bad' }]), 'B11')
  const created = createBatchRecord('B1', { missionIds: ['M1'], exclusions: [], requiredChecks: ['check'], receiptPaths: [] }, 'tower', 5)
  assert.equal(created.status, 'open')
  assert.equal(created.createdBy, 'tower')
  assert.equal(created.createdAt, 5)

  const closed = closeBatchRecord(created, { checks: [{ name: 'check' }], treeTip: 't', receiptHashes: { 'r.txt': 'a' } }, 'tower', 6)
  assert.equal(closed.status, 'closed')
  assert.equal(closed.closedAt, 6)
  assert.deepEqual(closed.close, {
    checks: [{ name: 'check' }],
    treeTip: 't',
    receiptHashes: { 'r.txt': 'a' },
    at: 6,
  })
  assert.throws(() => abandonBatchCheck(closed, 'B1'), (error) => error.code === 'batch-invalid' && /already closed/.test(error.message))
  assert.deepEqual(abandonBatchCheck({ status: 'abandoned' }, 'B2'), { alreadyAbandoned: true })
  assert.deepEqual(abandonBatchCheck({ status: 'open' }, 'B3'), { alreadyAbandoned: false })

  const abandoned = applyBatchAbandon({ batch: { status: 'open' }, actor: 'tower', reason: ' stale ', now: 7 })
  assert.equal(abandoned.status, 'abandoned')
  assert.equal(abandoned.abandonReason, 'stale')
  assert.equal(applyBatchAbandon({ batch: {}, actor: 'tower', reason: '   ', now: 8 }).abandonReason, null)

  const state = {
    missions: [
      {
        id: 'M1',
        status: 'completed',
        completionReport: { checks: [{ name: 'check', status: 'passed' }] },
      },
    ],
    batches: [
      { id: 'B1', status: 'open', missionIds: ['M1'], requiredChecks: ['check'], receiptPaths: [], exclusions: [] },
    ],
  }
  const payload = batchStatusPayload(state, 'B1')
  assert.equal(payload.batches.length, 1)
  assert.equal(payload.batch.batchId, 'B1')
  assert.equal(payload.batch.ok, true)
  assert.throws(() => batchStatusPayload(state, 'B9'), (error) => error.code === 'batch-invalid')
})
