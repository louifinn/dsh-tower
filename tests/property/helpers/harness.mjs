// Shared harness for the property-based suite.
//
// Two tiers exist (issue #130):
//   * `pr`   — 100 runs per seed, three fixed seeds. Fast enough to run on every
//              pull request; deterministic, so a red build is reproducible.
//   * `long` — 2000 runs, one seed drawn from `node:crypto`. Run nightly. It
//              also prints `fc.statistics` so shrinking-vs-distribution problems
//              are visible in the log.
//
// Replay: `FC_SEED=<seed> FC_PATH=<path>` replays one recorded failure exactly
// (one run, stopping at the minimal counterexample). `FC_PATH` without
// `FC_SEED` is an error because a path is only meaningful for its seed.
//
// The only filesystem access in this module writes failure artifacts under
// `tests/property/.artifacts/` (gitignored). Properties themselves must stay
// pure.
import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import test from 'node:test'
import fc from 'fast-check'

/** Fixed seeds for the PR tier. Changing these invalidates recorded replays. */
export const PR_SEEDS = [131, 40_961, 978_217]

/** Runs per seed in the PR tier. */
export const PR_RUNS = 100

/** Runs for the single long-tier seed. */
export const LONG_RUNS = 2000

/** Runs used for the distribution report printed by the long tier. */
export const STATISTICS_RUNS = 200

/** Where failure artifacts are written. */
export const ARTIFACTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.artifacts')

/**
 * Resolve the active tier. `TOWER_PROPERTY_TIER` wins so a developer can force
 * the long tier locally without npm; otherwise the npm script name decides.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'pr' | 'long'}
 */
export function resolveTier(env = process.env) {
  if (env.TOWER_PROPERTY_TIER === 'long') return 'long'
  if (env.npm_lifecycle_event === 'test:property:long') return 'long'
  return 'pr'
}

/**
 * Parse `FC_SEED` into seeds. Accepts one value or a comma-separated list.
 * @param {string} raw
 * @returns {number[]}
 */
function parseSeeds(raw) {
  const seeds = raw.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    if (!/^\d+$/.test(part)) throw new Error(`FC_SEED must be an integer, got ${JSON.stringify(part)}`)
    const value = Number(part)
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new Error(`FC_SEED must be a 32-bit unsigned integer, got ${JSON.stringify(part)}`)
    }
    return value
  })
  if (seeds.length === 0) throw new Error('FC_SEED was set but contained no seed')
  return seeds
}

/**
 * Work out what this process should run.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{tier: 'pr' | 'long', seeds: number[], numRuns: number, replayPath: string | null, replaying: boolean}}
 */
export function resolvePlan(env = process.env) {
  const tier = resolveTier(env)
  const replayPath = env.FC_PATH ?? null
  const replaying = replayPath !== null

  if (replaying && (env.FC_SEED === undefined || env.FC_SEED === '')) {
    throw new Error('FC_PATH requires FC_SEED: a replay path is only meaningful for the seed it was recorded with')
  }

  const seeds = env.FC_SEED !== undefined && env.FC_SEED !== ''
    ? parseSeeds(env.FC_SEED)
    : tier === 'long'
      ? [randomInt(0, 2 ** 31 - 1)]
      : PR_SEEDS

  return {
    tier,
    seeds,
    // A replay stops at the recorded minimal counterexample; extra runs are waste.
    numRuns: replaying ? 1 : tier === 'long' ? LONG_RUNS : PR_RUNS,
    replayPath,
    replaying,
  }
}

/**
 * JSON replacer that cannot throw on fast-check values (bigint/undefined/
 * function/symbol are rendered through `util.inspect`).
 * @param {string} _key
 * @param {unknown} value
 * @returns {unknown}
 */
function toJsonSafe(_key, value) {
  if (typeof value === 'bigint') return `${value}n`
  if (value === undefined) return '<undefined>'
  if (typeof value === 'function') return `<function ${value.name || 'anonymous'}>`
  if (typeof value === 'symbol') return value.toString()
  return value
}

/**
 * Write one failure artifact. This is the harness's only side effect beyond
 * console output; it is confined to `tests/property/.artifacts/`.
 * @param {{name: string, tier: string, seed: number, counterexamplePath: string, numRuns: number, error: unknown, counterexample: unknown}} failure
 * @returns {string} absolute artifact path
 */
function writeArtifact({ name, tier, seed, counterexamplePath, numRuns, error, counterexample }) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true })
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'property'
  const file = path.join(ARTIFACTS_DIR, `${Date.now()}-${slug}-seed${seed}.json`)
  const payload = {
    test: name,
    tier,
    seed,
    path: counterexamplePath,
    numRuns,
    counterexample,
    counterexampleInspect: inspect(counterexample, { depth: 8, colors: false }),
    error: error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: 'NonError', message: inspect(error) },
    replay: { FC_SEED: String(seed), FC_PATH: counterexamplePath },
    recordedAt: new Date().toISOString(),
  }
  fs.writeFileSync(file, `${JSON.stringify(payload, toJsonSafe, 2)}\n`, 'utf8')
  return file
}

/**
 * Describe a failure the way a developer needs to reproduce it.
 * @param {{name: string, seed: number, counterexamplePath: string, counterexample: unknown, artifact: string, error: unknown}} failure
 * @returns {string}
 */
function failureMessage({ name, seed, counterexamplePath, counterexample, artifact, error }) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : inspect(error)
  return [
    `property failed: ${name}`,
    `  seed: ${seed}`,
    `  path: ${counterexamplePath}`,
    `  counterexample: ${inspect(counterexample, { depth: 6 })}`,
    `  error: ${detail}`,
    `  artifact: ${artifact}`,
    '  replay: FC_SEED=<seed> FC_PATH=<path> npm run test:property    # POSIX',
    '  replay: $env:FC_SEED="<seed>"; $env:FC_PATH="<path>"; npm run test:property    # PowerShell',
  ].join('\n')
}

/**
 * Register one property as a `node:test` test case.
 *
 * The property runs once per seed. In the long tier each seed also prints a
 * distribution report for `classify`, which grows the corpus of shapes the
 * suite has observed without changing what is asserted.
 *
 * @param {object} options
 * @param {string} options.name human-readable property name
 * @param {import('fast-check').Arbitrary<unknown>} options.arbitrary generator under test
 * @param {(value: any) => void} options.predicate pure assertion body
 * @param {unknown[]} [options.examples] extra hand-written inputs
 * @param {(value: any) => string} [options.classify] long-tier distribution classifier
 * @param {number} [options.numRuns] override the tier's run count (smoke/dev only)
 * @param {NodeJS.ProcessEnv} [options.env] override the environment (tests of the harness itself)
 * @returns {void}
 */
export function runProperty({ name, arbitrary, predicate, examples, classify, numRuns, env = process.env }) {
  const plan = resolvePlan(env)
  const runs = numRuns ?? plan.numRuns

  test(`${name} [${plan.tier} tier]`, () => {
    console.log(
      `# [property] ${name}: tier=${plan.tier} seeds=${plan.seeds.join(',')} runs=${runs}`
      + `${plan.replaying ? ` replay=${plan.replayPath}` : ''}`,
    )

    for (const seed of plan.seeds) {
      const parameters = {
        seed,
        numRuns: runs,
        verbose: false,
        examples,
        ...(plan.replayPath === null ? {} : { path: plan.replayPath, endOnFailure: true }),
      }
      const details = fc.check(fc.property(arbitrary, predicate), parameters)
      if (details.failed) {
        const artifact = writeArtifact({
          name,
          tier: plan.tier,
          seed,
          counterexamplePath: details.counterexamplePath ?? '',
          numRuns: details.numRuns,
          error: details.errorInstance,
          counterexample: details.counterexample,
        })
        assert.fail(failureMessage({
          name,
          seed,
          counterexamplePath: details.counterexamplePath ?? '',
          counterexample: details.counterexample,
          artifact,
          error: details.errorInstance,
        }))
      }

      if (plan.tier === 'long' && !plan.replaying && classify) {
        fc.statistics(arbitrary, classify, { numRuns: STATISTICS_RUNS, seed, logger: console.log })
      }
    }
  })
}
