// Bounded local runner for the offline suite (F10).
//
// `npm test` expands `tests/*.test.mjs` and lets one `node --test` process run
// the whole set: on a loaded Windows host that means dozens of concurrent test
// processes competing with agent sessions, the antivirus scanner and the search
// indexer, and the resulting timeouts are reported against files the change
// never touched. This runner keeps the same file set and the same per-file
// isolation, but feeds the files to `node --test` in sequential batches, so at
// most `--size` files are live at once. A failing batch never stops the run:
// every batch runs, every batch is reported, and the exit code is 1 if any of
// them failed (a fail-fast would hide the full picture a loaded run needs).
//
// CI keeps running `npm run check`; this is the constrained-machine path
// documented in tests/README.md, CONTRIBUTING.md and docs/agents/workflow.md.
//
// The planning and accounting functions are exported and side-effect free so
// tests/test-shards.test.mjs can pin the file set and the failure accounting
// without spawning processes.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UsageError, parseArgs, runMain } from './lib/cli.mjs'

export const DEFAULT_BATCH_SIZE = 25
/** The exact glob `npm test` expands; the runner must never drift from it. */
export const OFFLINE_TEST_GLOB = 'tests/*.test.mjs'

export const USAGE = `usage: node scripts/test-shards.mjs [--size <files>] [-- <node --test args>]

  --size <files>  files per sequential batch (default: ${DEFAULT_BATCH_SIZE})
  --help          print this text

Runs ${OFFLINE_TEST_GLOB} in sequential batches (the same file set as npm test),
prints a summary per batch plus a total, and exits 1 when any batch failed.
Arguments after a bare "--" are forwarded to node --test, for example:
  npm run test:shards -- --size 10 -- --test-name-pattern state-lock`

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function batchSizeError(value) {
  const error = new UsageError(`--size must be a positive integer (got ${JSON.stringify(value)})`)
  // Same contract as cli.mjs argument failures: the usage block is printed.
  error.showUsage = true
  return error
}

/**
 * Parse a batch size, rejecting zero, negatives, fractions and NaN.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeBatchSize(value) {
  const size = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isSafeInteger(size) || size < 1) throw batchSizeError(value)
  return size
}

/**
 * The file set `npm test` expands to, in a stable order. Node's own glob is
 * used on purpose: a hand-rolled filter can drift on separators, dotfiles, a
 * directory whose name happens to end in `.test.mjs`, or a renamed suffix, and
 * a silent skip is exactly the failure this runner must not have. Paths are
 * normalized to forward slashes for a platform-independent plan.
 *
 * @param {string} [root] repository root (a fixture directory in tests)
 * @returns {string[]} sorted, repository-relative paths
 */
export function listOfflineTests(root = ROOT) {
  return fs
    .globSync(OFFLINE_TEST_GLOB, { cwd: root })
    .map((file) => file.split(path.sep).join('/'))
    .sort()
}

/**
 * Split an ordered list into sequential batches of at most `size` entries.
 * Concatenating the batches returns the input, in order, exactly once.
 *
 * @param {string[]} files
 * @param {number} [size]
 * @returns {string[][]}
 */
export function planBatches(files, size = DEFAULT_BATCH_SIZE) {
  const batchSize = normalizeBatchSize(size)
  const batches = []
  for (let index = 0; index < files.length; index += batchSize) {
    batches.push(files.slice(index, index + batchSize))
  }
  return batches
}

/**
 * The whole plan for one run: the `npm test` file set and its batches.
 * @param {{ root?: string, size?: number }} [options]
 * @returns {{ files: string[], batches: string[][] }}
 */
export function planShards({ root = ROOT, size = DEFAULT_BATCH_SIZE } = {}) {
  const files = listOfflineTests(root)
  return { files, batches: planBatches(files, size) }
}

/**
 * Parse the runner's own arguments and split off the forwarded `node --test`
 * arguments at the first bare `--`. `--size=10` is accepted as well as
 * `--size 10` (npm users tend to write the former).
 *
 * @param {string[]} [argv] arguments after the script name
 * @returns {{ help: boolean, size: number, forwarded: string[] }}
 */
export function parseCli(argv = []) {
  const split = argv.indexOf('--')
  const own = (split === -1 ? argv : argv.slice(0, split)).flatMap((arg) =>
    arg.startsWith('--size=') ? ['--size', arg.slice('--size='.length)] : [arg],
  )
  const parsed = parseArgs(own, {
    flags: { '--help': 'help' },
    values: { '--size': { key: 'size', parse: normalizeBatchSize } },
  })
  return {
    help: parsed.help === true,
    size: parsed.size ?? DEFAULT_BATCH_SIZE,
    forwarded: split === -1 ? [] : argv.slice(split + 1),
  }
}

/**
 * Run one batch through `node --test`, streaming its output to this terminal.
 * The child gets the same flags `npm test` would get (Node's default per-file
 * concurrency), only the file list is smaller.
 *
 * @param {string[]} files
 * @param {string[]} [forwarded]
 * @param {{ root?: string }} [options]
 * @returns {Promise<{ code: number|null, signal: string|null, ms: number }>}
 */
export function runNodeTest(files, forwarded = [], options = {}) {
  const started = Date.now()
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, ['--test', ...forwarded, ...files], {
        cwd: options.root ?? ROOT,
        stdio: 'inherit',
      })
    } catch (error) {
      resolve({ code: 1, signal: null, ms: Date.now() - started, error })
      return
    }
    child.on('error', (error) => resolve({ code: 1, signal: null, ms: Date.now() - started, error }))
    child.on('close', (code, signal) => resolve({ code: code ?? 1, signal, ms: Date.now() - started }))
  })
}

/**
 * Run every batch in order, never stopping after a failure.
 *
 * @param {{ files?: string[], batches: string[][] }} plan
 * @param {{
 *   runBatch?: (files: string[], index: number) => Promise<{ code?: number|null, signal?: string|null, ms?: number }>,
 *   log?: (line: string) => void,
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   exitCode: number,
 *   batches: { index: number, files: string[], code: number, signal: string|null, ms: number, ok: boolean }[],
 *   failed: { index: number, files: string[], code: number, signal: string|null, ms: number, ok: boolean }[],
 *   total: { files: number, batches: number, failed: number },
 * }>}
 */
export async function runShards(plan, options = {}) {
  const log = options.log ?? ((line) => console.log(line))
  const runBatch = options.runBatch ?? ((files) => runNodeTest(files))
  const files = Array.isArray(plan.files)
    ? plan.files.length
    : plan.batches.reduce((sum, batch) => sum + batch.length, 0)
  const results = []
  for (let index = 0; index < plan.batches.length; index += 1) {
    const batchFiles = plan.batches[index]
    log(`test-shards: batch ${index + 1}/${plan.batches.length} (${batchFiles.length} files)`)
    const started = Date.now()
    const outcome = await runBatch(batchFiles, index + 1)
    const code = typeof outcome?.code === 'number' ? outcome.code : 1
    const ms = Number.isFinite(outcome?.ms) ? outcome.ms : Date.now() - started
    const result = { index: index + 1, files: batchFiles, code, signal: outcome?.signal ?? null, ms, ok: code === 0 }
    results.push(result)
    log(`test-shards: batch ${result.index}/${plan.batches.length} ${result.ok ? 'passed' : 'FAILED'} in ${ms}ms`)
  }
  const failed = results.filter((result) => !result.ok)
  log(
    `test-shards: ${results.length} batch(es), ${files} file(s), ${failed.length} failed` +
      (failed.length > 0 ? `: batch ${failed.map((result) => `${result.index} (exit ${result.code})`).join(', ')}` : ''),
  )
  return {
    ok: failed.length === 0,
    exitCode: failed.length === 0 ? 0 : 1,
    batches: results,
    failed,
    total: { files, batches: results.length, failed: failed.length },
  }
}

/**
 * CLI entry: parse, plan, run, return the process exit code.
 *
 * @param {string[]} [argv] arguments after the script name
 * @param {{
 *   root?: string,
 *   log?: (line: string) => void,
 *   runShards?: typeof runShards,
 *   runBatch?: (files: string[], index: number) => Promise<{ code?: number|null, ms?: number }>,
 * }} [deps] test seams; production omits them
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const root = deps.root ?? ROOT
  const parsed = parseCli(argv)
  if (parsed.help) {
    console.log(USAGE)
    return 0
  }
  const plan = planShards({ root, size: parsed.size })
  if (plan.files.length === 0) {
    console.error(`test-shards: no ${OFFLINE_TEST_GLOB} files under ${root}`)
    return 1
  }
  const log = deps.log ?? ((line) => console.log(line))
  log(
    `test-shards: ${plan.files.length} files in ${plan.batches.length} sequential batch(es) of at most ${parsed.size}`,
  )
  const run = deps.runShards ?? runShards
  const result = await run(plan, {
    log,
    runBatch:
      deps.runBatch ?? ((batchFiles) => runNodeTest(batchFiles, parsed.forwarded, { root })),
  })
  return result.exitCode
}

runMain(import.meta.url, () => main(process.argv.slice(2)), {
  errorPrefix: 'test-shards',
  usage: USAGE,
})
