// Unit tests for the pure /tasks panel projection (#160): sorting, silence
// labels, the "(no tool yet)" fallback, hidden terminal states, the row cap,
// and the shared staleness rule itself.
import test from 'node:test'
import assert from 'node:assert/strict'

const { tasksPanelText, TASKS_PANEL_ROW_LIMIT } = await import('../domain/read/tasksView.js')
const { rosterEntryStale } = await import('../domain/collab/roster.js')

const MINUTE = 60_000
const NOW = 1_700_000_000_000

function row(overrides = {}) {
  return {
    name: 'worker-m1',
    role: 'worker',
    agentId: 'child-1',
    parentSessionId: 'tower-agent',
    missionId: 'M1',
    branch: 'tower/m1-fix-login',
    state: 'active',
    spawnedAt: NOW - 30 * MINUTE,
    ...overrides,
  }
}

test('rows are sorted by silence, most silent first', () => {
  const text = tasksPanelText({
    roster: [
      row({ name: 'worker-a', agentId: 'a', missionId: 'M1' }),
      row({ name: 'worker-b', agentId: 'b', missionId: 'M2', spawnedAt: NOW - 5 * MINUTE }),
    ],
    activity: { a: 'running', b: 'running' },
    parentStatus: { 'tower-agent': 'ok' },
    activityLog: [],
    staleMs: 0,
    now: NOW,
  })
  const names = text.split('\n').filter((line) => line.startsWith('M'))
  assert.match(names[0], /worker-a\s+\S+\s+active\s+30m/)
  assert.match(names[1], /worker-b\s+\S+\s+active\s+5m/)
})

test('silence labels cover seconds through days', () => {
  const text = tasksPanelText({
    roster: [
      row({ name: 's', agentId: 's', missionId: 'M1', spawnedAt: NOW - 42_000 }),
      row({ name: 'h', agentId: 'h', missionId: 'M2', spawnedAt: NOW - 185 * MINUTE }),
      row({ name: 'd', agentId: 'd', missionId: 'M3', spawnedAt: NOW - 52 * 60 * MINUTE }),
    ],
    activity: { s: 'running', h: 'running', d: 'running' },
    parentStatus: { 'tower-agent': 'ok' },
    activityLog: [],
    staleMs: 0,
    now: NOW,
  })
  assert.match(text, /active\s+42s\s+/)
  assert.match(text, /active\s+3h 5m\s+/)
  assert.match(text, /active\s+2d 4h\s+/)
})

test('a row with no recorded event falls back to its spawn with "(no tool yet)"', () => {
  const text = tasksPanelText({
    roster: [row({ missionId: 'M9', spawnedAt: NOW - 2 * MINUTE })],
    activity: { 'child-1': 'running' },
    parentStatus: { 'tower-agent': 'ok' },
    activityLog: [{ at: NOW - 60 * MINUTE, type: 'mission', missionId: 'M1', text: 'unrelated' }],
    staleMs: 0,
    now: NOW,
  })
  assert.match(text, /M9\s+worker\s+worker-m1\s+m1-fix-login\s+active\s+2m\s+last: \(no tool yet\)/)
})

test('the newest mission event wins regardless of tail order', () => {
  const text = tasksPanelText({
    roster: [row()],
    activity: { 'child-1': 'running' },
    parentStatus: { 'tower-agent': 'ok' },
    activityLog: [
      { at: NOW - 20 * MINUTE, type: 'mission', missionId: 'M1', text: 'blocker added' },
      { at: NOW - 10 * MINUTE, type: 'mission', missionId: 'M1', text: 'task_done="auth"' },
    ],
    staleMs: 0,
    now: NOW,
  })
  assert.match(text, /10m\s+last: task_done="auth"/)
})

test('terminal roster states are hidden; stale and interrupted stay visible', () => {
  const text = tasksPanelText({
    roster: [
      row({ name: 'gone', agentId: 'g', state: 'retired' }),
      row({ name: 'lost', agentId: 'l', state: 'missing' }),
      row({ name: 'botched', agentId: 'x', state: 'failed' }),
      row({ name: 'idle', agentId: 'i', state: 'inactive' }),
      row({ name: 'stopped', agentId: 's', state: 'interrupted', missionId: 'M2' }),
      row({ name: 'quiet', agentId: 'q', missionId: 'M3', spawnedAt: NOW - 40 * MINUTE }),
    ],
    activity: {},
    parentStatus: { 'tower-agent': 'ok' },
    activityLog: [],
    staleMs: 15_000,
    now: NOW,
  })
  const lines = text.split('\n')
  assert.equal(lines.filter((line) => /^(M|No)/.test(line)).length, 2, `two visible rows: ${JSON.stringify(lines)}`)
  assert.match(lines[0], /M3\s+worker\s+quiet\s+\S+\s+stale\s+40m/)
  assert.match(lines[1], /M2\s+worker\s+stopped\s+\S+\s+interrupted/)
  assert.match(text, /2 live, 1 stale/)
})

test('a row already marked stale by the watchdog stays stale and counted', () => {
  const text = tasksPanelText({
    roster: [row({ state: 'stale', spawnedAt: NOW - 2 * MINUTE })],
    activity: { 'child-1': 'running' },
    parentStatus: { 'tower-agent': 'ok' },
    activityLog: [],
    staleMs: 15_000,
    now: NOW,
  })
  assert.match(text, /M1\s+worker\s+worker-m1\s+m1-fix-login\s+stale\s+2m\s+last: \(no tool yet\)/)
  assert.match(text, /1 live, 1 stale/)
})

test('a reserved row shows and counts its silence from reservation time', () => {
  const text = tasksPanelText({
    roster: [row({ name: 'worker-r', agentId: null, sessionId: null, state: 'reserved', branch: null, spawnedAt: undefined, reservedAt: NOW - 3 * MINUTE })],
    activity: {},
    parentStatus: { 'tower-agent': 'ok' },
    activityLog: [],
    staleMs: 0,
    now: NOW,
  })
  assert.match(text, /M1\s+worker\s+worker-r\s+-\s+reserved\s+3m\s+last: \(no tool yet\)/)
})

test('bounded output: the row cap applies and names what is hidden', () => {
  const roster = Array.from({ length: TASKS_PANEL_ROW_LIMIT + 3 }, (_unused, index) =>
    row({ name: `worker-${index}`, agentId: `agent-${index}`, missionId: `M${index}`, spawnedAt: NOW - (index + 1) * MINUTE }),
  )
  const text = tasksPanelText({
    roster,
    activity: Object.fromEntries(roster.map((entry) => [entry.agentId, 'running'])),
    parentStatus: { 'tower-agent': 'ok' },
    activityLog: [],
    staleMs: 0,
    now: NOW,
  })
  const lines = text.split('\n')
  assert.equal(lines.filter((line) => /^M\d+\s/.test(line)).length, TASKS_PANEL_ROW_LIMIT)
  assert.match(lines[lines.length - 2], /^\(3 more not shown\)$/)
  assert.match(lines[lines.length - 1], /23 live, 0 stale/)
})

test('rosterEntryStale: the one spawn.staleMs rule', () => {
  const entry = row({ state: 'active', spawnedAt: NOW - 10 * MINUTE })
  const base = { parentKnown: true, staleMs: 5 * MINUTE, now: NOW }
  assert.equal(rosterEntryStale(entry, base), true)
  assert.equal(rosterEntryStale(entry, { ...base, staleMs: 30 * MINUTE }), false, 'a larger window clears it')
  assert.equal(rosterEntryStale(entry, { ...base, staleMs: 0 }), false, '0 disables staleness')
  assert.equal(rosterEntryStale(entry, { ...base, observed: 'running' }), false, 'a catalog row is never stale')
  assert.equal(rosterEntryStale(entry, { ...base, observed: 'inactive' }), false)
  assert.equal(rosterEntryStale(entry, { ...base, parentKnown: false }), false, 'an unreachable catalog decides nothing')
  assert.equal(rosterEntryStale(row({ state: 'retired', spawnedAt: NOW - 10 * MINUTE }), base), false, 'terminal rows are exempt')
})
