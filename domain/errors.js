// Stable tool error codes.
//
// Everything a Tower tool throws reaches the model as
//   [tower:<code>] <original message>
// so callers (and tests) can branch on the code instead of matching prose.
// The catalog also carries the recovery metadata the model can act on:
//
//   - `retryable`   — the same input may succeed later without a change;
//   - `nextAction`  — the concrete recovery step, rendered once as a trailing
//                     ` — next: …` segment (plus ` (retryable)` when retryable);
//   - `trigger`     — the typical condition, documented in errors.md.
//
// Why the message suffix rather than a structured error payload: the DSH tool
// contract declares output schemas for successful values only, and a thrown
// error reaches the model as its rendered message. There is no separate
// structured error channel to return `{ code, retryable, nextAction }` through,
// so the suffix is the model-visible channel; the error object still carries
// `code`, `retryable`, `nextAction` and `details` for programmatic callers.
// Codes without a recovery step render byte-identically to the pre-#74 form.
//
// The catalog is documented in docs/reference/errors.md; scripts/check-docs.mjs
// and scripts/generate-error-reference.mjs keep the two in sync.
// @ts-check

/** Neutral error type shared by the git adapter and the domain classifier. */
export class GitError extends Error {
  /**
   * @param {string[]} args
   * @param {string} detail
   * @param {number | undefined} code the child-process errno, not a Tower code
   * @param {{ timedOut?: boolean, bufferOverflow?: boolean, stdout?: string }} [meta]
   */
  constructor(args, detail, code, meta = {}) {
    super(`git ${args.join(' ')} failed: ${detail}`)
    this.name = 'GitError'
    this.code = code
    this.timedOut = meta.timedOut === true
    this.bufferOverflow = meta.bufferOverflow === true
    this.stdout = meta.stdout ?? ''
  }
}

/**
 * @typedef {object} ErrorCodeEntry
 * @property {string} description
 * @property {string} trigger
 * @property {boolean} retryable
 * @property {string | null} nextAction
 */

/**
 * One stable entry per failure family. `description` and `trigger` are the
 * documented meaning; `retryable`/`nextAction` are the recovery contract the
 * tool boundary renders.
 * @type {Record<string, ErrorCodeEntry>}
 */
export const ERROR_CODES = {
  'invalid-argument': {
    description: 'A tool argument is missing, malformed, or not allowed.',
    trigger: '`missionId`/`id` omitted; unknown status; empty report; bad scope glob; `timeoutMs < 1000`; `status: "all"` on an update.',
    retryable: false,
    nextAction: null,
  },
  'repo-invalid': {
    description: 'repoRoot is missing, relative, or not inside a Git repository.',
    trigger: 'passing a path in a directory that is not a repo',
    retryable: false,
    nextAction: 'pass an absolute path to a directory inside a Git repository',
  },
  'not-initialized': {
    description: 'Tower is not initialized for this repository; run tower_init.',
    trigger: 'a read tool before `tower_init`',
    retryable: false,
    nextAction: 'run tower_init for this repository',
  },
  'mission-not-found': {
    description: 'No mission with that id exists.',
    trigger: 'a stale or mistyped `M9`',
    retryable: false,
    nextAction: 'list missions with tower_status',
  },
  'finding-not-found': {
    description: 'No finding with that id exists.',
    trigger: '`tower_findings({id:"F99"})`',
    retryable: false,
    nextAction: 'list findings with tower_findings',
  },
  'invalid-transition': {
    description: 'The requested state transition is not allowed.',
    trigger: 'a blocked→merged attempt; a finding transition not in the graph; a reviewer mutating findings; completing a mission with open tasks, blockers, no commits, or unread inbox messages.',
    retryable: false,
    nextAction: null,
  },
  'stale-base': {
    description: 'The repository state changed while the operation was being prepared; retry.',
    trigger: 'two-phase mutation revalidation',
    retryable: true,
    nextAction: 'retry the tool; if it keeps failing, run tower_preflight and inspect tower_status',
  },
  'state-locked': {
    description: 'Another Tower writer holds the state lock.',
    trigger: 'concurrent mutation after the lock timeout',
    retryable: true,
    nextAction: 'wait for the other Tower writer to finish, then retry',
  },
  'state-corrupt': {
    description: 'The Tower state file is unreadable or invalid.',
    trigger: 'hand-edited `state.json`; invalid JSON; no usable `schemaVersion`',
    retryable: false,
    nextAction: 'restore state.json from a backup, or re-initialize after filing the corruption',
  },
  'state-version-unsupported': {
    description: 'The Tower state file uses a schema version this build cannot read or downgrade.',
    trigger: 'opening a repository written by a newer plugin; an unknown older version; this build refuses to downgrade',
    retryable: false,
    nextAction: 'upgrade dsh-tower to a release that supports this state schemaVersion',
  },
  'state-migration-failed': {
    description: 'A Tower state migration failed; the original state file was not modified.',
    trigger: 'a bug in a migration step; see the pre-migration `state.json.v<N>.bak`',
    retryable: false,
    nextAction: 'restore the pre-migration backup state.json.v<N>.bak and report the migration bug',
  },
  'config-invalid': {
    description: 'Tower configuration is invalid.',
    trigger: 'malformed repo `config.json`, a value that violates the schema',
    retryable: false,
    nextAction: 'fix the repository config file, then retry',
  },
  'config-unknown-key': {
    description: 'Tower configuration has an unknown top-level key.',
    trigger: 'a typo such as `allowAgentToggle`',
    retryable: false,
    nextAction: 'remove the unknown key from the repository config file, then retry',
  },
  'git-failed': {
    description: 'A git command failed.',
    trigger: 'a rejected merge command, invalid ref',
    retryable: false,
    nextAction: null,
  },
  'git-timeout': {
    description: 'A git command timed out or exceeded its output buffer.',
    trigger: 'slow pre-merge hook, huge diff',
    retryable: true,
    nextAction: 'retry; if it persists, raise git.timeoutMs or merge.timeoutMs',
  },
  'worktree-dirty': {
    description: 'The mission worktree has uncommitted changes and cannot complete.',
    trigger: 'staged, modified, or untracked files left behind before `tower_complete`',
    retryable: false,
    nextAction: 'commit or remove the worktree changes, then retry tower_complete',
  },
  'spawn-unavailable': {
    description: 'The subagents service is unavailable.',
    trigger: 'a Host without `subagents`',
    retryable: false,
    nextAction: 'enable the DSH subagents service, then retry',
  },
  'provider-missing': {
    description: 'No subagent provider is registered.',
    trigger: 'an empty provider list',
    retryable: false,
    nextAction: 'register a subagent provider in the DSH profile, then retry',
  },
  'provider-cooldown': {
    description: 'The provider is throttled; spawn is in a short cooldown.',
    trigger: 'repeated retryable provider failures; wait for `blockedUntil`',
    retryable: true,
    nextAction: 'wait for the cooldown to expire, then retry',
  },
  'preset-missing': {
    description: 'The configured agent preset is not registered.',
    trigger: 'missing `tower-worker`/`tower-reviewer` preset rows, DSH not restarted',
    retryable: false,
    nextAction: 'install the tower-worker and tower-reviewer agent presets and restart DSH',
  },
  'reviewer-prerequisite': {
    description: 'The reviewer spawn prerequisite is not met.',
    trigger: 'reviewer spawned before the mission is `completed`, or before a worktree exists',
    retryable: false,
    nextAction: 'complete the mission first, then spawn the reviewer',
  },
  'review-disabled': {
    description: 'Review is disabled by `review.mode:off`; no reviewer, verdict, or review blocker exists in this configuration.',
    trigger: '`tower_spawn` with `role:"reviewer"`, or a review submission, while `review.mode` is `off`',
    retryable: false,
    nextAction: 'set review.mode to optional or required in the Tower config, then retry',
  },
  'not-authorized': {
    description: 'The calling agent role may not perform this action.',
    trigger: 'a worker calling a tower-only tool or changing mission status/scope; a reviewer mutating findings',
    retryable: false,
    nextAction: 'call the tool as the tower, or as the worker/reviewer it is assigned to',
  },
  'workspace-busy': {
    description: 'Another Tower session owns this repository workspace lock.',
    trigger: '`mode.workspaceLock:true` and a second session calls a repo-scoped tool',
    retryable: true,
    nextAction: 'run /tower off in the other session or wait for its lock to become stale',
  },
  'worker-limit': {
    description: 'The repository reached spawn.maxLiveWorkers live workers.',
    trigger: 'spawning a fifth worker with the default limit',
    retryable: false,
    nextAction: 'wait for a live worker to finish or raise spawn.maxLiveWorkers',
  },
  'rate-limited': {
    description: 'The tower_send per-minute rate limit was reached.',
    trigger: '`send.maxPerMinute` exceeded',
    retryable: true,
    nextAction: 'wait for the next per-minute window or raise send.maxPerMinute',
  },
  'takeover-refused': {
    description: 'The mission already has a live worker that was not stopped first.',
    trigger: '`tower_spawn({takeover:true})` before `tower_interrupt`',
    retryable: false,
    nextAction: 'run tower_interrupt for the live worker, then retry the takeover',
  },
  'reload-unavailable': {
    description: 'The DSH HMR service is not available in this profile.',
    trigger: '`tower_reload` / `/tower reload` on a profile without HMR',
    retryable: false,
    nextAction: 'restart DSH instead of reloading',
  },
  'reload-failed': {
    description: 'The HMR reload failed; check the DSH log and restart if needed.',
    trigger: '`reconcileProfile` threw',
    retryable: false,
    nextAction: 'check the DSH log and restart DSH',
  },
  'tests-failed': {
    description: 'Declared test discovery failed or did not meet its admission requirements.',
    trigger: 'nonzero command, malformed output, minCount/required shortfall',
    retryable: false,
    nextAction: 'fix the failing tests, then retry tower_complete',
  },
  'tests-timeout': {
    description: 'Test discovery exceeded its time or output budget.',
    trigger: '`tests.timeoutMs`, or stdout over `tests.maxBytes`',
    retryable: false,
    nextAction: 'raise tests.timeoutMs or tests.maxBytes (or speed up the suite), then retry',
  },
  'lease-busy': {
    description: 'Another holder owns the requested advisory lease.',
    trigger: '`tower_resource acquire` while `heavy-ci` is held',
    retryable: false,
    nextAction: 'release the lease or wait for it to expire, then retry',
  },
  'lease-token': {
    description: 'The lease release token does not match the current holder.',
    trigger: 'releasing with another session\'s token',
    retryable: false,
    nextAction: 'use the token returned when the lease was acquired',
  },
  'batch-invalid': {
    description: 'The batch request or its close evidence is invalid.',
    trigger: 'unknown member, duplicate id, unsafe receipt path, missing receipt hash',
    retryable: false,
    nextAction: 'fix the batch request or the receipt hashes, then retry',
  },
  'legacy-invalid': {
    description: 'The legacy snapshot or mapping is invalid.',
    trigger: 'unknown schema, source inside the Tower state dir, mapping rewrite',
    retryable: false,
    nextAction: 'check the legacy snapshot path, schema and mapping, then retry',
  },
  'tool-internal': {
    description: 'An unexpected failure; read the message and the activity log.',
    trigger: 'a bug; read the message and the activity log',
    retryable: false,
    nextAction: null,
  },
}

export const ERROR_CODE_VALUES = Object.freeze(Object.keys(ERROR_CODES))

/** @param {unknown} value */
export function isErrorCode(value) {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value)
}

/** @param {string} code */
export function errorEntry(code) {
  return isErrorCode(code) ? ERROR_CODES[code] : null
}

/** @param {string} code */
export function errorDescription(code) {
  return errorEntry(code)?.description ?? ''
}

/** @param {string} code */
export function errorRetryable(code) {
  return errorEntry(code)?.retryable === true
}

/** @param {string} code */
export function errorNextAction(code) {
  return errorEntry(code)?.nextAction ?? null
}

/**
 * The model-visible message. Exactly one trailing ` — next: …` segment is
 * appended when there is a recovery step; a retryable code marks the same
 * segment with ` (retryable)`. A message that already carries the action is
 * never suffixed twice.
 * @param {string} code
 * @param {string} message
 * @param {{ nextAction?: string | null, retryable?: boolean }} [options]
 * @returns {string}
 */
export function renderErrorMessage(code, message, options = {}) {
  const text = String(message)
  const base = `[tower:${code}] ${text}`
  const nextAction = options.nextAction ?? errorNextAction(code)
  if (nextAction === null || nextAction === undefined) return base
  if (text.includes(nextAction) || text.includes('— next:')) return base
  const retryable = options.retryable ?? errorRetryable(code)
  return `${base} — next: ${nextAction}${retryable ? ' (retryable)' : ''}`
}

export class TowerToolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ cause?: unknown, retryable?: boolean, nextAction?: string | null, details?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    const entry = errorEntry(code)
    const retryable = options.retryable ?? entry?.retryable === true
    const nextAction = options.nextAction ?? entry?.nextAction ?? null
    super(renderErrorMessage(code, message, { nextAction, retryable }), options.cause ? { cause: options.cause } : undefined)
    this.name = 'TowerToolError'
    this.code = code
    this.retryable = retryable
    this.nextAction = nextAction
    this.details = options.details ?? null
  }
}

/** @param {any} error */
function originalMessage(error) {
  return String(error?.message ?? error)
}

/**
 * Wrap any thrown value into a TowerToolError with a stable code.
 * @param {any} error
 */
export function classifyError(error) {
  if (error instanceof TowerToolError) return error
  if (error && typeof error.code === 'string' && ERROR_CODES[error.code]) {
    return new TowerToolError(error.code, originalMessage(error), {
      cause: error,
      // Let the catalog supply a default when the thrown object does not
      // explicitly override the recovery metadata.
      retryable: typeof error.retryable === 'boolean' ? error.retryable : undefined,
      nextAction: error.nextAction ?? undefined,
      details: error.details ?? null,
    })
  }
  if (error instanceof GitError || error?.name === 'GitError') {
    const message = originalMessage(error)
    const code = error?.timedOut === true || error?.bufferOverflow === true ? 'git-timeout' : 'git-failed'
    return new TowerToolError(code, message, { cause: error })
  }
  return new TowerToolError('tool-internal', originalMessage(error), { cause: error })
}
