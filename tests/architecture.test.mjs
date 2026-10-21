import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FINDING_SEVERITIES, FINDING_STATUSES, FINDING_TYPES, MISSION_STATUSES } from '../lib/tower.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('architecture fitness functions pass at the current ratchet', () => {
  const output = execFileSync(process.execPath, ['scripts/architecture.mjs', '--json'], {
    cwd: root,
    encoding: 'utf8',
  })
  const result = JSON.parse(output)
  assert.equal(result.ok, true)
  assert.deepEqual(result.problems, [])
})

test('domain vocabulary is the single source for tool schema enums', async () => {
  const { Tower } = await import('../lib/tower.js')
  assert.ok(MISSION_STATUSES.length > 0)
  assert.ok(FINDING_TYPES.length > 0)
  assert.ok(FINDING_SEVERITIES.length > 0)
  assert.ok(FINDING_STATUSES.every((status) => typeof status === 'string'))
  assert.ok(Tower)
})
