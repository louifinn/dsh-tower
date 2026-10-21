// Stable tool error codes.
//
// Everything a Tower tool throws reaches the model as
//   [tower:<code>] <original message>
// so callers (and tests) can branch on the code instead of matching prose.
// The catalog is documented in docs/reference/errors.md; scripts/check-docs.mjs
// keeps the two in sync.
import { GitError } from './git.js'

export const ERROR_CODES = {
  'invalid-argument': 'A tool argument is missing, malformed, or not allowed.',
  'repo-invalid': 'repoRoot is missing, relative, or not inside a Git repository.',
  'not-initialized': 'Tower is not initialized for this repository; run tower_init.',
  'mission-not-found': 'No mission with that id exists.',
  'finding-not-found': 'No finding with that id exists.',
  'invalid-transition': 'The requested state transition is not allowed.',
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

export class TowerToolError extends Error {
  constructor(code, message, options = {}) {
    super(`[tower:${code}] ${message}`, options.cause ? { cause: options.cause } : undefined)
    this.name = 'TowerToolError'
    this.code = code
    this.retryable = options.retryable === true
    this.nextAction = options.nextAction ?? null
    this.details = options.details ?? null
  }
}

// Ordered rules; the first match wins. Keep the specific patterns above the
// generic argument fallback so `no open task matching` never becomes internal.
const RULES = [
  ['not-initialized', /tower is not initialized/i],
  ['mission-not-found', /^unknown mission "/i],
  ['finding-not-found', /^unknown finding "/i],
  ['state-locked', /locked by another writer/i],
  [
    'state-corrupt',
    /corrupt tower state|^tower state |^unsupported tower state|^invalid (?:mission|roster|message|finding|review) entry|^mission entry without id|^duplicate (?:mission|roster|message|finding|review)|^mission .* (?:has unknown status|has no tasks array|has no deps array)|^message .* has no readBy array|^finding .* has unknown status|^review .* has unknown (?:status|merge verdict)/i,
  ],
  ['config-unknown-key', /unknown key|unknown top-level key/i],
  ['config-invalid', /config (?:is invalid|must be an object)|repo config/i],
  ['lease-busy', /lease .* (?:held|owned)|another holder owns/i],
  ['lease-token', /lease .*token|token does not match/i],
  ['tests-timeout', /test discovery .*(?:timed out|exceeded|too large)/i],
  ['tests-failed', /test discovery (?:failed|did not)|tests? (?:failed|missing|did not pass)/i],
  ['batch-invalid', /batch (?:is invalid|close|member|receipt)/i],
  ['legacy-invalid', /legacy (?:snapshot|map|source)|unsupported legacy/i],
  ['spawn-unavailable', /subagents service is unavailable/i],
  ['provider-missing', /no subagent provider/i],
  ['provider-cooldown', /provider cooldown active/i],
  ['preset-missing', /agent preset .*is not registered/i],
  ['reviewer-prerequisite', /reviewer needs an existing|reviewer requires a completed/i],
  ['repo-invalid', /repoRoot is required|repoRoot must be an absolute path/i],
  ['workspace-busy', /workspace .*lock|another tower session owns/i],
  ['worker-limit', /live worker limit|too many live workers|worker limit reached/i],
  ['rate-limited', /rate limit|too many tower messages/i],
  ['takeover-refused', /takeover refused|cannot take over/i],
  ['not-authorized', /only the tower|only an assigned reviewer|only the tower or a worker|does not own mission|not authorized|may not perform this action/i],
  [
    'invalid-transition',
    /cannot move from|cannot be completed from that state|is already completed|merged is recorded only|can only be widened|only a completed mission|reviewers may list and read|still has \d+ open task|has unresolved blockers|has no worktree|has no commits since|cannot complete with \d+ unread inbox|not assigned to mission|is a [a-z]+, not a worker|cannot reanchor base|worktree is missing|worktree .* is not a Git worktree|belongs to a different repository|is on .* expected|has \d+ live worker|already has a live worker|cannot reopen a terminal mission|stopped worker cannot report completion|can only be spawned|violates? (?:the )?mission (?:state|transition)/i,
  ],
  [
    'invalid-argument',
    /requires |is required|must be (?:a|an|one|an integer|non-empty|printable)|must not be|must be one of|no open task matching|unknown mission status|unknown finding severity|unknown finding type|not an array|is not an array|scope must|title must|checks must|role must|timeoutMs must|repoRoot is required|only a list filter|snapshotDirty was requested|refusing to send a message to yourself|mission has \d+ live worker|roster name already used|is already in the roster|depends on unknown mission/i,
  ],
]

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
    if (/not a git repository/i.test(message)) return new TowerToolError('repo-invalid', message, { cause: error })
    const code = error?.timedOut === true || error?.bufferOverflow === true ? 'git-timeout' : 'git-failed'
    return new TowerToolError(code, message, { cause: error })
  }
  const message = originalMessage(error)
  const RETRYABLE = new Set(['state-locked', 'rate-limited', 'provider-cooldown', 'git-timeout', 'workspace-busy', 'merge-intent-pending'])
  for (const [code, pattern] of RULES) {
    if (pattern.test(message)) {
      return new TowerToolError(code, message, { cause: error, retryable: RETRYABLE.has(code) })
    }
  }
  return new TowerToolError('tool-internal', message, { cause: error })
}
