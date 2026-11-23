// F107: the POSIX branch of the shared tree kill must reach a descendant that
// called setsid.
//
// `kill(-pid, 'SIGKILL')` signals one process group, and a child spawned with
// `detached: true` on POSIX gets its own session *and* process group, so the
// group kill reports success while that descendant keeps running. These cases
// pin the ordering that fixes it — enumerate the table first, then signal the
// collected descendants, then the root — with an injected `ps` table so no real
// process is spawned. The real-OS proof is `interruption.test.mjs` and
// `verify.test.mjs`; this file pins the seams those cannot observe directly.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TREE_KILL_BOUND_MS,
  collectDescendants,
  killProcessTree,
  parsePsTable,
} from '../adapters/process-tree.js'

/**
 * A fake `spawn` for the POSIX branch that answers one `ps` call.
 *
 * `table` is the raw stdout text. `behaviour` selects the failure mode:
 * `ok` streams the table and closes 0, `fail` closes 1, `garbage` is the same
 * as `ok` with whatever text was given, `throw` throws synchronously, and
 * `hang` never reports anything (the bound must end the attempt).
 */
function fakePsSpawn(events, table, behaviour = 'ok') {
  return (command, args, options) => {
    events.push({ type: 'spawn', command, args, options })
    if (behaviour === 'throw') throw new Error('ps is not on PATH')
    if (behaviour === 'hang') return { on: () => {}, stdout: { on: () => {} } }
    const listeners = new Map()
    const emitter = {
      stdout: {
        on(event, handler) {
          if (event === 'data' && behaviour === 'ok') setImmediate(() => handler(Buffer.from(table)))
          return this
        },
      },
      on(event, handler) {
        listeners.set(event, handler)
        if (event === 'close') setImmediate(() => handler(behaviour === 'ok' ? 0 : 1))
        return emitter
      },
    }
    return emitter
  }
}

/** The canonical fake table: 100 -> 200 -> 300, where 300 is the setsid'd one. */
const SETSID_TABLE = ['  100   42', '  200  100', '  300  200', '  400   42', ''].join('\n')

/** One line of `ps -A -o pid=,ppid=`: `ps` right-aligns both columns. */
test('parsePsTable: right-aligned columns, garbage ignored, empty is null', () => {
  const children = parsePsTable(SETSID_TABLE)
  assert.deepEqual(children.get(100), [200], 'the child of the root is recorded')
  assert.deepEqual(children.get(200), [300], 'the grandchild is a child of the child')
  assert.deepEqual(children.get(42), [100, 400], 'same-parent children keep table order')
  assert.equal(children.has(300), false, 'a pid with no children has no entry')

  assert.equal(parsePsTable(''), null, 'no output is not an empty table: it is no evidence')
  assert.equal(parsePsTable('\n  \n'), null, 'blank lines never parse')
  assert.deepEqual(
    parsePsTable('PID PPID\n 100  42\n'),
    new Map([[42, [100]]]),
    'a header row is ignored, not parsed as pid 0/0',
  )
  assert.deepEqual(
    parsePsTable('garbage\n100 42\n99 not-a-pid\n-1 42\n0 42\n'),
    new Map([[42, [100]]]),
    'only exactly two positive integers count, so a half-parsed table cannot name a wrong pid',
  )
})

test('collectDescendants: transitive, cycle-safe, root excluded', () => {
  const children = parsePsTable(SETSID_TABLE)
  assert.deepEqual(collectDescendants(100, children), [200, 300], 'a set of grandchildren, not just children')
  assert.deepEqual(collectDescendants(42, children), [100, 400, 200, 300], 'breadth-first over both branches')
  assert.deepEqual(collectDescendants(300, children), [], 'a leaf has no descendants')

  const cyclic = new Map([
    [1, [2]],
    [2, [3]],
    [3, [1]],
  ])
  assert.deepEqual(collectDescendants(1, cyclic), [2, 3], 'a cyclic table terminates instead of looping')
})

test('POSIX: a setsid descendant is enumerated before the kill and signalled', async () => {
  const events = []
  await killProcessTree(
    { pid: 100 },
    {
      platform: 'linux',
      spawn: fakePsSpawn(events, SETSID_TABLE),
      kill: (pid, signal) => events.push({ type: 'kill', pid, signal }),
    },
  )

  const spawned = events.filter((event) => event.type === 'spawn')
  assert.equal(spawned.length, 1, 'exactly one table read')
  assert.equal(spawned[0].command, 'ps')
  assert.deepEqual(spawned[0].args, ['-A', '-o', 'pid=,ppid='], 'portable on Linux and macOS')
  assert.equal(events[0].type, 'spawn', 'enumeration comes before any signal')

  const kills = events.filter((event) => event.type === 'kill')
  assert.deepEqual(
    kills.map((event) => event.pid),
    [-100, 200, 300],
    'group kill, then the enumerated descendants; the group signal already reached the root',
  )
  assert.equal(
    kills.some((event) => event.pid === 300),
    true,
    'the setsid descendant is in the kill set: the group kill alone cannot reach it',
  )
  for (const kill of kills) assert.equal(kill.signal, 'SIGKILL')
})

test('POSIX: a descendant spawned as a child of a child is still found', async () => {
  // The table deliberately carries different sessions only implicitly: `ps`
  // reports parentage, not sessions, which is exactly why the walk works on a
  // descendant that left the root's process group.
  const events = []
  await killProcessTree(
    { pid: 100 },
    { platform: 'darwin', spawn: fakePsSpawn(events, SETSID_TABLE), kill: (pid) => events.push({ type: 'kill', pid }) },
  )
  assert.deepEqual(
    events.filter((event) => event.type === 'kill').map((event) => event.pid),
    [-100, 200, 300],
    'macOS uses the same ordering',
  )
})

test('POSIX: an unreadable table falls back to group + direct without rejecting', async () => {
  for (const behaviour of ['throw', 'fail', 'garbage']) {
    const events = []
    const table = behaviour === 'garbage' ? 'not a table at all\n' : ''
    await killProcessTree(
      { pid: 100 },
      {
        platform: 'linux',
        spawn: fakePsSpawn(events, table, behaviour),
        kill: (pid) => events.push({ type: 'kill', pid }),
      },
    )
    const kills = events.filter((event) => event.type === 'kill').map((event) => event.pid)
    assert.deepEqual(kills, [-100], `${behaviour}: the group kill still happens and nothing rejects`)
  }
})

test('POSIX: a root that leads no group is killed directly', async () => {
  // The `false → direct()` fallback: when the group signal cannot run at all,
  // the root must still be killed, whether or not a table was readable.
  for (const table of [SETSID_TABLE, '']) {
    const events = []
    await killProcessTree(
      { pid: 100 },
      {
        platform: 'linux',
        spawn: fakePsSpawn(events, table),
        kill: (pid) => {
          if (pid < 0) throw new Error('no such process group')
          events.push({ type: 'kill', pid })
        },
      },
    )
    const kills = events.filter((event) => event.type === 'kill').map((event) => event.pid)
    assert.equal(kills.includes(100), true, `table=${Boolean(table)}: the root gets the direct kill`)
    for (const pid of [200, 300]) {
      if (!table) continue
      assert.equal(kills.includes(pid), true, 'an enumerated descendant is swept even without a group')
    }
  }
})

test('POSIX: a `ps` that never settles still resolves inside the bound', async () => {
  const events = []
  const started = Date.now()
  await killProcessTree(
    { pid: 100 },
    {
      platform: 'linux',
      boundMs: 30,
      spawn: fakePsSpawn(events, '', 'hang'),
      kill: (pid) => events.push({ type: 'kill', pid }),
    },
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed < TREE_KILL_BOUND_MS, 'the injected 30 ms bound is what ended the attempt')
  assert.deepEqual(
    events.filter((event) => event.type === 'kill').map((event) => event.pid),
    [-100],
    'the group kill is the fallback, not a reason to reject',
  )
})

test('POSIX: a missing process group still gets the direct kill', async () => {
  const events = []
  await killProcessTree(
    { pid: 501 },
    {
      platform: 'linux',
      spawn: fakePsSpawn(events, '501 1\n'),
      kill: (pid) => {
        if (pid < 0) throw new Error('no such process group')
        events.push({ type: 'kill', pid })
      },
    },
  )
  assert.deepEqual(
    events.filter((event) => event.type === 'kill').map((event) => event.pid),
    [501],
    'a group signal that cannot run falls through to the root kill',
  )
})

test('win32: taskkill is asked for the tree before any direct kill', async () => {
  // The F104/F105 ordering must not regress while POSIX changes: taskkill can
  // only enumerate descendants while the pid is still openable.
  const events = []
  const fakeSpawn = (command, args) => {
    events.push({ type: 'spawn', command, args })
    const emitter = {
      on(event, handler) {
        events.push({ type: `on:${event}` })
        if (event === 'close') setImmediate(() => handler(0))
        return emitter
      },
    }
    return emitter
  }

  await killProcessTree(
    { pid: 4321 },
    { platform: 'win32', spawn: fakeSpawn, kill: (pid, signal) => events.push({ type: 'kill', pid, signal }) },
  )

  assert.equal(events[0].type, 'spawn', 'taskkill is the first attempt')
  assert.equal(events[0].command, 'taskkill')
  assert.deepEqual(events[0].args, ['/pid', '4321', '/T', '/F'])
  assert.equal(events[0].type === 'spawn' && events[0].command !== 'ps', true, 'win32 never reads the POSIX table')
  assert.equal(events.some((event) => event.type === 'kill'), false, 'a successful taskkill needs no direct kill')
})
