// F10: the bounded local runner (`npm run test:shards`) is only a safe fallback
// if it covers exactly the files `npm test` covers and reports failures exactly
// like it. These cases pin the contract against the live tree — the planned set
// must equal the `tests/*.test.mjs` set, batching must not lose or duplicate a
// file, and a failing batch must produce a failing run that still finishes every
// batch. The failure cases inject `runBatch`; a deliberately failing fixture is
// never placed under tests/.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTemp } from './helpers/cleanup.mjs'

import {
  DEFAULT_BATCH_SIZE,
  OFFLINE_TEST_GLOB,
  listOfflineTests,
  main,
  normalizeBatchSize,
  parseCli,
  planBatches,
  planShards,
  runShards,
} from '../scripts/test-shards.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Repository-relative POSIX paths, the same normalization the runner applies. */
function relative(file) {
  return file.split(path.sep).join('/')
}

function readPackage() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
}

test('the npm test glob is still the one the runner mirrors', () => {
  const scripts = readPackage().scripts
  assert.equal(scripts.test, `node --test ${OFFLINE_TEST_GLOB}`, 'npm test must stay the canonical full-suite command')
  assert.equal(scripts['test:shards'], 'node scripts/test-shards.mjs')
  // CI keeps running `npm run check`; the runner is the constrained-machine path.
  assert.match(scripts.check, /npm test/, 'the CI gate must keep running the full suite')
  assert.doesNotMatch(scripts.check, /test:shards/)
})

test('the planned file set is exactly tests/*.test.mjs, with no duplicates or silent skips', () => {
  const planned = listOfflineTests(ROOT)
  const directory = fs
    .readdirSync(path.join(ROOT, 'tests'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => `tests/${entry.name}`)
    .sort()
  assert.ok(planned.length > 0)
  assert.deepEqual(planned, directory, 'every tests/*.test.mjs file must be planned exactly once')
  assert.equal(new Set(planned).size, planned.length, 'no file may be planned twice')
  for (const file of planned) assert.equal(fs.statSync(path.join(ROOT, file)).isFile(), true, `${file} must be a real file`)
  // The reference is Node's own expansion of the npm test glob: the runner and
  // `node --test tests/*.test.mjs` must not be able to drift apart.
  assert.deepEqual(
    planned,
    fs
      .globSync(OFFLINE_TEST_GLOB, { cwd: ROOT })
      .map(relative)
      .sort(),
  )
})

test('batch planning respects the size bound and reconstructs the file order exactly', () => {
  const files = planShards({ root: ROOT }).files
  const batches = planBatches(files, 7)
  assert.ok(batches.length > 1, 'the fixture must span several batches')
  for (const batch of batches) {
    assert.ok(batch.length >= 1 && batch.length <= 7, `batch of ${batch.length} must fit the bound`)
    assert.equal(new Set(batch).size, batch.length, 'a batch must not repeat a file')
  }
  assert.deepEqual(batches.flat(), files, 'batching must not drop, duplicate or reorder a file')
  assert.equal(batches.length, Math.ceil(files.length / 7))

  // The default batches the real suite into bounded chunks as documented.
  assert.equal(DEFAULT_BATCH_SIZE, 25)
  const planned = planShards({ root: ROOT })
  assert.equal(planned.batches[0].length, Math.min(DEFAULT_BATCH_SIZE, files.length))
  assert.equal(planned.batches.length, Math.ceil(files.length / DEFAULT_BATCH_SIZE))
  assert.deepEqual(planned.batches.flat(), planned.files)

  // Edges and rejections.
  assert.deepEqual(planBatches([], 25), [])
  assert.deepEqual(planBatches(['a'], 25), [['a']])
  assert.deepEqual(planBatches(['a', 'b', 'c'], 2), [['a', 'b'], ['c']])
  assert.equal(normalizeBatchSize('10'), 10)
  for (const bad of ['0', '-1', '2.5', 'abc', '', null, 0, -3, 1.5, Number.NaN]) {
    assert.throws(() => normalizeBatchSize(bad), /--size must be a positive integer/, `must reject ${String(bad)}`)
  }
  assert.throws(() => planBatches(['a'], 0), /positive integer/)
})

test('a failing batch fails the run, and every later batch still executes', async () => {
  const calls = []
  const logs = []
  const files = ['a.test.mjs', 'b.test.mjs', 'c.test.mjs', 'd.test.mjs', 'e.test.mjs']
  const outcome = await runShards(
    { files, batches: planBatches(files, 2) },
    {
      log: (line) => logs.push(line),
      runBatch: async (batch, index) => {
        calls.push({ batch, index })
        return { code: index === 2 ? 1 : 0, ms: 5 }
      },
    },
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.exitCode, 1)
  assert.equal(calls.length, 3, 'a failing batch must not stop the remaining batches')
  assert.deepEqual(calls.map((call) => call.batch), [['a.test.mjs', 'b.test.mjs'], ['c.test.mjs', 'd.test.mjs'], ['e.test.mjs']])
  assert.deepEqual(outcome.failed.map((batch) => batch.index), [2])
  assert.equal(outcome.failed[0].code, 1)
  assert.deepEqual(outcome.total, { files: 5, batches: 3, failed: 1 })
  const text = logs.join('\n')
  assert.match(text, /batch 2\/3 FAILED/)
  assert.match(text, /3 batch\(es\), 5 file\(s\), 1 failed: batch 2 \(exit 1\)/)
})

test('a green run reports success and the totals', async () => {
  const logs = []
  const outcome = await runShards(
    { files: ['a.test.mjs', 'b.test.mjs'], batches: planBatches(['a.test.mjs', 'b.test.mjs'], 1) },
    { log: (line) => logs.push(line), runBatch: async () => ({ code: 0, ms: 1 }) },
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.exitCode, 0)
  assert.deepEqual(outcome.failed, [])
  assert.deepEqual(outcome.total, { files: 2, batches: 2, failed: 0 })
  assert.match(logs.join('\n'), /2 batch\(es\), 2 file\(s\), 0 failed/)
})

test('fixture directories are enumerated exactly like the npm test glob', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-test-shards-'))
  try {
    const tests = path.join(root, 'tests')
    fs.mkdirSync(tests)
    for (const name of ['a.test.mjs', 'b.test.mjs', 'notes.md', 'c.mjs']) fs.writeFileSync(path.join(tests, name), '')
    fs.mkdirSync(path.join(tests, 'sub'))
    fs.writeFileSync(path.join(tests, 'sub', 'nested.test.mjs'), '')
    assert.deepEqual(listOfflineTests(root), ['tests/a.test.mjs', 'tests/b.test.mjs'])
    assert.deepEqual(
      fs.globSync(OFFLINE_TEST_GLOB, { cwd: root }).map(relative).sort(),
      ['tests/a.test.mjs', 'tests/b.test.mjs'],
    )
    // A nested suite is not part of `npm test` either: matching it here would
    // change the suite the shard runner measures.
    assert.equal(listOfflineTests(root).includes('tests/sub/nested.test.mjs'), false)
  } finally {
    removeTemp(root)
  }
})

test('parseCli keeps the node --test arguments after a bare -- and validates --size', () => {
  assert.deepEqual(parseCli([]), { help: false, size: DEFAULT_BATCH_SIZE, forwarded: [] })
  assert.deepEqual(parseCli(['--size', '10']), { help: false, size: 10, forwarded: [] })
  assert.deepEqual(parseCli(['--size=3', '--help']), { help: true, size: 3, forwarded: [] })
  const forwarded = ['--test-name-pattern', 'state-lock', '--test-timeout', '60000']
  assert.deepEqual(parseCli(['--size', '4', '--', ...forwarded]), { help: false, size: 4, forwarded })
  assert.deepEqual(parseCli(['--', ...forwarded]), { help: false, size: DEFAULT_BATCH_SIZE, forwarded })
  for (const bad of [['--size', '0'], ['--size=2.5'], ['--size', 'x'], ['--size']]) {
    assert.throws(() => parseCli(bad), /positive integer|needs a value/, `must reject ${bad.join(' ')}`)
  }
  assert.throws(() => parseCli(['--bogus']), /unknown argument/)
})

test('main prints usage for --help and propagates the runner exit code', async (t) => {
  const usage = t.mock.method(console, 'log', () => {})
  assert.equal(
    await main(['--help'], {
      runShards: () => {
        throw new Error('--help must not run a batch')
      },
    }),
    0,
  )
  assert.match(String(usage.mock.calls[0]?.arguments[0]), /usage: node scripts\/test-shards\.mjs/)
  usage.mock.restore()

  const logs = []
  const code = await main(['--size', '7'], {
    log: (line) => logs.push(line),
    runShards: async (plan, options) => {
      assert.equal(plan.batches[0].length, 7)
      assert.deepEqual(plan.batches.flat(), plan.files)
      assert.equal(typeof options.runBatch, 'function')
      return { exitCode: 1 }
    },
  })
  assert.equal(code, 1)
  assert.match(logs[0], /sequential batch\(es\) of at most 7/)
})

test('main fails when the test directory has no matching files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-test-shards-empty-'))
  const error = t.mock.method(console, 'error', () => {})
  try {
    const code = await main([], { root, log: () => {}, runShards: () => ({ exitCode: 0 }) })
    assert.equal(code, 1, 'an empty plan must not be a silent green run')
    assert.match(String(error.mock.calls[0]?.arguments[0]), /no tests\/\*\.test\.mjs files/)
  } finally {
    removeTemp(root)
  }
})
