// Stable tool error codes.
//
// Everything a Tower tool throws reaches the model as
//   [tower:<code>] <original message>
// so callers (and tests) can branch on the code instead of matching prose.
// The catalog is documented in docs/reference/errors.md; scripts/check-docs.mjs
// keeps the two in sync.

/** Neutral error type shared by the git adapter and the domain classifier. */
export class GitError extends Error {
  constructor(args, detail, code, meta = {}) {
    super(`git ${args.join(' ')} failed: ${detail}`)
    this.name = 'GitError'
    this.code = code
    this.timedOut = meta.timedOut === true
    this.bufferOverflow = meta.bufferOverflow === true
    this.stdout = meta.stdout ?? ''
  }
}

export const ERROR_CODES = {
  'invalid-argument': 'A tool argument is missing, malformed, or not allowed.',
  'repo-invalid': 'repoRoot is missing, relative, or not inside a Git repository.',
  'not-initialized': 'Tower is not initialized for this repository; run tower_init.',
  'mission-not-found': 'No mission with that id exists.',
  'finding-not-found': 'No finding with that id exists.',
  'invalid-transition': 'The requested state transition is not allowed.',
  'stale-base': 'The repository state changed while the operation was being prepared; retry.',
  'state-locked': 'Another Tower writer holds the state lock.',
  'state-corrupt': 'The Tower state file is unreadable or invalid.',
  'config-invalid': 'Tower configuration is invalid.',
  'config-unknown-key': 'Tower configuration has an unknown top-level key.',
  'git-failed': 'A git command failed.',
  'git-timeout': 'A git command timed out or exceeded its output buffer.',
  'worktree-dirty': 'The mission worktree has uncommitted changes and cannot complete.',
  'spawn-unavailable': 'The subagents service is unavailable.',
  'provider-missing': 'No subagent provider is registered.',
  'provider-cooldown': 'The provider is throttled; spawn is in a short cooldown.',
  'preset-missing': 'The configured agent preset is not registered.',
  'reviewer-prerequisite': 'The reviewer spawn prerequisite is not met.',
  'not-authorized': 'The calling agent role may not perform this action.',
  'workspace-busy': 'Another Tower session owns this repository workspace lock.',
  'worker-limit': 'The repository reached spawn.maxLiveWorkers live workers.',
  'rate-limited': 'The tower_send per-minute rate limit was reached.',
  'takeover-refused': 'The mission already has a live worker that was not stopped first.',
  'reload-unavailable': 'The DSH HMR service is not available in this profile.',
  'reload-failed': 'The HMR reload failed; check the DSH log and restart if needed.',
  'tests-failed': 'Declared test discovery failed or did not meet its admission requirements.',
  'tests-timeout': 'Test discovery exceeded its time or output budget.',
  'lease-busy': 'Another holder owns the requested advisory lease.',
  'lease-token': 'The lease release token does not match the current holder.',
  'batch-invalid': 'The batch request or its close evidence is invalid.',
  'legacy-invalid': 'The legacy snapshot or mapping is invalid.',
  'tool-internal': 'An unexpected failure; read the message and the activity log.',
}

export const ERROR_CODE_VALUES = Object.freeze(Object.keys(ERROR_CODES))
export function isErrorCode(value) {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value)
}

const RETRYABLE_CODES = new Set(['state-locked', 'rate-limited', 'provider-cooldown', 'git-timeout', 'workspace-busy', 'merge-intent-pending', 'stale-base'])

export class TowerToolError extends Error {
  constructor(code, message, options = {}) {
    super(`[tower:${code}] ${message}`, options.cause ? { cause: options.cause } : undefined)
    this.name = 'TowerToolError'
    this.code = code
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code)
    this.nextAction = options.nextAction ?? null
    this.details = options.details ?? null
  }
}

function originalMessage(error) {
  return String(error?.message ?? error)
}

/** Wrap any thrown value into a TowerToolError with a stable code. */
export function classifyError(error) {
  if (error instanceof TowerToolError) return error
  if (error && typeof error.code === 'string' && ERROR_CODES[error.code]) {
    return new TowerToolError(error.code, originalMessage(error), {
      cause: error,
      retryable: error.retryable === true,
      nextAction: error.nextAction ?? null,
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
