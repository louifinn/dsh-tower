// tower_verify input contract (#202). Pure TypeBox only; no I/O.
//
// The three whitelisted check kinds are a closed set, and each schema says what
// the tool accepts rather than what a shell could run: there is no command
// string, no interpolation, and no free-form argument list. `files` is the only
// path-bearing field, and tools/verify.js applies the `tests/*.test.mjs` rule
// before anything executes.
import { Type, enumOf } from './shared.js'

export const VERIFY_KINDS = ['tests', 'tsc', 'shards']
export const VERIFY_DEFAULT_TIMEOUT_MS = 120000
export const VERIFY_MIN_TIMEOUT_MS = 5000
export const VERIFY_MAX_TIMEOUT_MS = 600000
export const VERIFY_MAX_CHECKS = 10
export const VERIFY_MAX_FILES = 30

export const VerifyInput = Type.Object({
  missionId: Type.String({ description: 'Mission id, e.g. M1 (alias: id). The worktree is the mission worktree, whatever the agent current directory.' }),
  checks: Type.Array(
    Type.Object({
      kind: enumOf(VERIFY_KINDS, {
        description:
          'Whitelisted read-only check: "tests" runs node --test on the listed files, "tsc" runs the worktree TypeScript compiler with --noEmit, "shards" runs one batch of the tests/*.test.mjs shard plan.',
      }),
      files: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          maxItems: VERIFY_MAX_FILES,
          description:
            'tests only: 1-30 repository-relative paths under tests/ ending in .test.mjs. No absolute path, no ".." segment, and no shell text: a path that does not match the rule is rejected before anything runs.',
        }),
      ),
      batch: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: 'shards only: 1-based batch of the default 25-file shard plan (default 1). It runs that batch only, never the whole suite.',
        }),
      ),
    }, { additionalProperties: false }),
    { minItems: 1, maxItems: VERIFY_MAX_CHECKS, description: '1-10 checks, run sequentially in the mission worktree; a failing check never stops the next one.' },
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: VERIFY_MIN_TIMEOUT_MS,
      maximum: VERIFY_MAX_TIMEOUT_MS,
      description: 'Per-check wall-clock limit in milliseconds (default 120000, minimum 5000, maximum 600000). On timeout the whole process tree is killed and the run records status "timeout".',
    }),
  ),
}, { additionalProperties: false })
