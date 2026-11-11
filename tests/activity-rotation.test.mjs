// Bounded activity-log rotation (#M76, W5-B).
//
// activity.jsonl is the append-only audit trail. It must stay bounded without
// ever losing a line that was already written: the live file is renamed to a
// numbered segment, reads follow the segments in chronological order, and a
// failed rotation falls back to appending to the live file instead of dropping
// the record. These tests use real temp files (the adapter is the unit that
// owns the filesystem) but no Git repository and no timers.
//
// Run with: node --test tests/activity-rotation.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTemp } from './helpers/cleanup.mjs'
import { appendJsonl, activityPolicy, activityRotationPlan, activitySegmentIndices, activitySegmentPath, shouldRotateActivity } from '../adapters/persistence.js'
import { inspectActivityLog, readActivityTail } from '../adapters/store.js'

const lineBytes = (value) => Buffer.byteLength(`${JSON.stringify(value)}\n`, 'utf8')

function tempFile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-activity-'))
  t.after(() => removeTemp(root))
  return { root, file: path.join(root, 'activity.jsonl') }
}

test('activityPolicy keeps the bounded default, disables on zero and clamps retention', () => {
  assert.deepEqual(activityPolicy(), { maxBytes: 4 * 1024 * 1024, retention: 5, enabled: true })
  assert.deepEqual(activityPolicy({ maxBytes: 0 }), { maxBytes: 0, retention: 5, enabled: false })
  assert.deepEqual(activityPolicy({ maxBytes: 1024, retention: 0 }), { maxBytes: 1024, retention: 1, enabled: true })
  assert.deepEqual(activityPolicy({ maxBytes: -1, retention: 1000 }), { maxBytes: 0, retention: 100, enabled: false })
})

test('activitySegmentIndices parses only numbered siblings and orders them ascending', () => {
  assert.deepEqual(
    activitySegmentIndices('/tmp/activity.jsonl', [
      'activity.jsonl',
      'activity.jsonl.1',
      'activity.jsonl.10',
      'activity.jsonl.2',
      'activity.jsonl.0',
      'activity.jsonl.x',
      'other.jsonl.3',
      'activity.jsonl.2.bak',
    ]),
    [1, 2, 10],
  )
  assert.deepEqual(activitySegmentIndices('/tmp/activity.jsonl', []), [])
})

test('shouldRotateActivity only crosses a positive cap on a non-empty live file', () => {
  assert.equal(shouldRotateActivity(0, 10, 5), false)
  assert.equal(shouldRotateActivity(5, 10, 5), true)
  assert.equal(shouldRotateActivity(5, 10, 0), false)
  assert.equal(shouldRotateActivity(5, 1, 100), false)
})

test('activityRotationPlan prunes the whole window above retention, shifts up, then rotates the live file', () => {
  const file = path.join(os.tmpdir(), 'activity.jsonl')
  const plan = activityRotationPlan(file, 2)
  // Every stale segment must go, not only the oldest index: lowering retention
  // from 4 to 2 has to remove `.2`, `.3` and `.4` on the next rotation.
  assert.deepEqual(plan.remove, Array.from({ length: 99 }, (_, offset) => `${file}.${offset + 2}`))
  assert.deepEqual(plan.moves, [{ from: `${file}.1`, to: `${file}.2` }])
  assert.equal(plan.liveTo, `${file}.1`)

  assert.deepEqual(activityRotationPlan(file, 1).remove, Array.from({ length: 100 }, (_, offset) => `${file}.${offset + 1}`))

  const plan3 = activityRotationPlan(file, 3)
  assert.deepEqual(plan3.remove, Array.from({ length: 98 }, (_, offset) => `${file}.${offset + 3}`))
  assert.deepEqual(plan3.moves, [
    { from: `${file}.2`, to: `${file}.3` },
    { from: `${file}.1`, to: `${file}.2` },
  ])

  // The top of the range is the adapter's own clamp: no removal beyond 100.
  assert.deepEqual(activityRotationPlan(file, 100).remove, [`${file}.100`])
  assert.deepEqual(activityRotationPlan(file, 1000).remove, [`${file}.100`])
})

test('lowering retention prunes every higher segment and keeps the newest data', async (t) => {
  const { root, file } = tempFile(t)
  const writeLines = (target, entries) => {
    fs.writeFileSync(target, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8')
  }
  // Four rotated segments (.1 newest … .4 oldest) plus the live file, as left
  // behind by retention 4. Line id 4 is the newest line.
  writeLines(file, [{ index: 4 }])
  for (let index = 1; index <= 4; index += 1) writeLines(activitySegmentPath(file, index), [{ index: 4 - index }])

  await appendJsonl(file, { index: 5 }, { maxBytes: 1, retention: 2 })

  const names = fs.readdirSync(root).filter((name) => /^activity\.jsonl\.\d+$/.test(name)).sort()
  assert.deepEqual(names, ['activity.jsonl.1', 'activity.jsonl.2'], 'stale segments above the new retention are gone')
  // The retained history is the newest suffix: 0, 1 and 2 were pruned.
  assert.deepEqual((await readActivityTail(file, 100)).map((entry) => entry.index), [3, 4, 5])
  assert.equal(fs.readFileSync(activitySegmentPath(file, 2), 'utf8'), '{"index":3}\n')
  assert.equal(fs.readFileSync(activitySegmentPath(file, 1), 'utf8'), '{"index":4}\n')

  const inspected = await inspectActivityLog(file, { maxBytes: 1, retention: 2 })
  assert.equal(inspected.retention, 2)
  assert.deepEqual(inspected.segments.map((segment) => segment.index), [1, 2])
})

test('appending past the cap rotates and keeps the newest retention segments plus the live file', async (t) => {
  const { file } = tempFile(t)
  const entries = Array.from({ length: 5 }, (_, index) => ({ at: `2026-11-12T00:00:0${index}Z`, type: 'mission.note', index }))
  const maxBytes = Math.ceil(lineBytes(entries[0]) * 1.5)
  for (const entry of entries) await appendJsonl(file, entry, { maxBytes, retention: 2 })

  for (const index of [0, 1]) {
    assert.equal(fs.existsSync(activitySegmentPath(file, index + 1)), true, `expected segment ${index + 1}`)
  }
  // Entries 0 and 1 are the two oldest and fall outside retention 2 + live.
  assert.deepEqual((await readActivityTail(file, 100)).map((entry) => entry.index), [2, 3, 4])
  assert.deepEqual((await readActivityTail(file, 2)).map((entry) => entry.index), [3, 4])

  const inspected = await inspectActivityLog(file, { maxBytes, retention: 2 })
  assert.equal(inspected.rotationEnabled, true)
  assert.equal(inspected.retention, 2)
  assert.deepEqual(inspected.segments.map((segment) => segment.index), [1, 2])
  assert.ok(inspected.rotatedBytes > 0)
  assert.ok(inspected.liveBytes > 0)
})

test('readActivityTail tolerates corrupt and truncated lines across segments', async (t) => {
  const { file } = tempFile(t)
  const entries = Array.from({ length: 4 }, (_, index) => ({ index }))
  const maxBytes = Math.ceil(lineBytes(entries[0]) * 1.5)
  for (const entry of entries) await appendJsonl(file, entry, { maxBytes, retention: 3 })

  fs.appendFileSync(file, 'not-json-at-all\n{"index": 99', 'utf8')
  fs.appendFileSync(activitySegmentPath(file, 1), 'also broken\n', 'utf8')

  const tail = await readActivityTail(file, 100)
  assert.deepEqual(tail.map((entry) => entry.index), [0, 1, 2, 3])
})

test('a rotation failure falls back to the live file and never loses the appended line', async (t) => {
  const { file } = tempFile(t)
  const first = { index: 0 }
  const second = { index: 1 }
  const maxBytes = 1 // every non-empty append wants to rotate
  await appendJsonl(file, first, { maxBytes, retention: 1 })

  // A directory where the oldest segment belongs makes the unlink/rename of
  // the rotation plan fail; the adapter must append to the live file instead.
  fs.mkdirSync(activitySegmentPath(file, 1))
  await appendJsonl(file, second, { maxBytes, retention: 1 })

  const live = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(live, [first, second])
  assert.equal(fs.statSync(activitySegmentPath(file, 1)).isDirectory(), true)
})

test('rotation disabled keeps appending to the live file without creating segments', async (t) => {
  const { file } = tempFile(t)
  for (let index = 0; index < 3; index += 1) await appendJsonl(file, { index }, { maxBytes: 0 })
  assert.deepEqual((await readActivityTail(file, 10)).map((entry) => entry.index), [0, 1, 2])
  assert.equal(fs.existsSync(activitySegmentPath(file, 1)), false)
  const inspected = await inspectActivityLog(file, { maxBytes: 0 })
  assert.equal(inspected.rotationEnabled, false)
  assert.deepEqual(inspected.segments, [])
})
