// tower_verify: reviewer-only, whitelist-only read execution with recorded
// evidence (#202).
//
// A reviewer preset has no shell, so a review could only trust the worker's
// prose. This tool gives the reviewer exactly three read-only things it may run
// in the mission worktree — node --test on tests/*.test.mjs files, tsc --noEmit,
// and one batch of the shard plan — and records every result in
// mission.testRuns, where tower_complete and tower_review checks can cite the
// runId. There is no command string and no shell: tools/verify.js validates the
// closed shape before adapters/verify.js spawns an argument array.
import path from 'node:path'

import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import {
  VERIFY_DEFAULT_TIMEOUT_MS,
  VERIFY_MAX_CHECKS,
  VERIFY_MAX_FILES,
  VERIFY_MAX_TIMEOUT_MS,
  VERIFY_MIN_TIMEOUT_MS,
  VerifyInput,
} from '../domain/contracts/tool-inputs/verify.js'

const WHITELIST =
  'tower_verify only runs the fixed read-only whitelist: {kind:"tests", files:["tests/<name>.test.mjs"]}, {kind:"tsc"}, or {kind:"shards", batch:1}'
const TEST_FILE = /^tests\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.test\.mjs$/

function refuse(message) {
  throw new TowerToolError('invalid-argument', `${message}; ${WHITELIST}`)
}

/** Validate one `tests` file reference and prove it stays inside the worktree. */
function testFile(file, worktreePath) {
  if (typeof file !== 'string' || file !== file.trim() || file.length === 0) refuse('every tests file must be a non-empty relative path')
  if (!TEST_FILE.test(file)) refuse(`"${file}" is not a tests/*.test.mjs path (relative, forward slashes, no shell text)`)
  const segments = file.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) refuse(`"${file}" contains a traversal segment`)
  if (path.posix.normalize(file) !== file) refuse(`"${file}" is not a normalized relative path`)
  const resolved = path.resolve(worktreePath, file)
  if (!resolved.startsWith(worktreePath + path.sep)) refuse(`"${file}" escapes the mission worktree`)
  return file
}

/** Validate the closed check union; returns the normalized check the adapter runs. */
function normalizeCheck(raw, index, worktreePath) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse(`checks[${index}] must be an object`)
  const kind = raw.kind
  if (kind === 'tests') {
    if (raw.batch !== undefined) refuse(`checks[${index}]: batch belongs to kind "shards", not "tests"`)
    if (!Array.isArray(raw.files) || raw.files.length === 0) refuse(`checks[${index}]: kind "tests" needs files`)
    if (raw.files.length > VERIFY_MAX_FILES) refuse(`checks[${index}]: at most ${VERIFY_MAX_FILES} test files`)
    const files = raw.files.map((file) => testFile(file, worktreePath))
    if (new Set(files).size !== files.length) refuse(`checks[${index}]: duplicate test file`)
    return { kind, files, label: files.length === 1 ? `tests ${files[0]}` : `tests ${files.length} files` }
  }
  if (kind === 'tsc') {
    if (raw.files !== undefined || raw.batch !== undefined) refuse(`checks[${index}]: kind "tsc" takes no files or batch`)
    return { kind, label: 'tsc' }
  }
  if (kind === 'shards') {
    if (raw.files !== undefined) refuse(`checks[${index}]: kind "shards" takes no files`)
    const batch = raw.batch ?? 1
    if (!Number.isInteger(batch) || batch < 1 || batch > 100) refuse(`checks[${index}]: batch must be an integer 1-100`)
    return { kind, batch, label: `shards batch ${batch}` }
  }
  refuse(`checks[${index}]: unknown kind ${JSON.stringify(kind)}`)
}

function timeoutOf(raw) {
  if (raw === undefined) return VERIFY_DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(raw) || raw < VERIFY_MIN_TIMEOUT_MS || raw > VERIFY_MAX_TIMEOUT_MS) {
    refuse(`timeoutMs must be an integer between ${VERIFY_MIN_TIMEOUT_MS} and ${VERIFY_MAX_TIMEOUT_MS}`)
  }
  return raw
}

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, actorFor: any, requireKnownActor: any, runVerification: any }} deps
 */
export function registerVerifyTool(ctx, deps) {
  const { define, actorFor, requireKnownActor, runVerification } = deps
  define(ctx, {
    name: 'tower_verify',
    description:
      'Run the fixed read-only verification whitelist in the mission worktree and record each result as a test-run receipt. Reviewer-only: node --test on tests/*.test.mjs files, tsc --noEmit, or one shard batch. No shell and no arbitrary command; reports a runId for each check.',
    parameters: VerifyInput,
    aliases: { missionId: ['id'] },
    requiresMissionId: true,
    roles: ['reviewer'],
    output: output(SCHEMAS.verify),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireKnownActor(actor, 'tower_verify')
      const timeoutMs = timeoutOf(args.timeoutMs)
      if (!Array.isArray(args.checks) || args.checks.length === 0) refuse('checks must contain at least one check')
      if (args.checks.length > VERIFY_MAX_CHECKS) refuse(`at most ${VERIFY_MAX_CHECKS} checks per call`)
      const context = await tower.missionContext(args.missionId)
      const worktree = context.mission.worktree
      if (!worktree) throw new TowerToolError('invalid-transition', `mission ${args.missionId} has no worktree`)
      // Validate the whole request before anything executes: one bad path must
      // reject the call, not run the other checks first.
      const checks = args.checks.map((raw, index) => normalizeCheck(raw, index, worktree.path))
      await tower.assertWorktree(worktree)
      const results = await runVerification({ worktreePath: worktree.path, checks, timeoutMs })
      const checksOut = []
      for (const result of results) {
        const stored = await tower.recordTestRun({
          missionId: args.missionId,
          receipt: {
            ok: result.status === 'passed',
            status: result.status,
            name: result.check,
            kind: result.kind,
            command: result.command,
            exitCode: result.exitCode ?? null,
            durationMs: result.durationMs,
            summary: result.summary,
            truncated: result.truncated,
            tests: [],
            ...(result.files ? { files: result.files } : {}),
            ...(result.kind === 'shards' ? { batch: result.batch ?? 1 } : {}),
            ...(result.status === 'passed' ? {} : { error: result.summary }),
          },
        })
        checksOut.push({
          check: result.check,
          kind: result.kind,
          command: result.command,
          status: result.status,
          exitCode: result.exitCode ?? null,
          durationMs: result.durationMs,
          summary: result.summary,
          truncated: result.truncated,
          runId: stored.id,
        })
      }
      return {
        ok: checksOut.every((entry) => entry.status === 'passed'),
        missionId: args.missionId,
        treeTip: null,
        checks: checksOut,
      }
    },
  })
}
