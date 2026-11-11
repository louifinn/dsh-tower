// Merge delegation support (W5-A).
//
// The merge use case receives these four helpers from the Tower facade, so it
// stays a pure app-layer function and the app layer keeps importing no adapter.
// Values, defaults and error text are unchanged from app/tower.js.
import { TowerToolError } from '../domain/errors.js'
import { DEFAULT_MERGE_TIMEOUT_MS } from '../domain/lockBudget.js'

export const MERGE_MAX_BUFFER = 64 * 1024 * 1024

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

export function mergeTimeoutMs(value, config) {
  if (value === undefined || value === null) {
    const configured = (config ?? {}).merge?.timeoutMs
    return Number.isInteger(configured) && configured >= 1000 ? configured : DEFAULT_MERGE_TIMEOUT_MS
  }
  const ms = Number(value)
  if (!Number.isInteger(ms) || ms < 1000) fail('timeoutMs must be an integer of at least 1000 milliseconds')
  return ms
}

export async function commitParents(tower, cwd, sha) {
  const line = await tower.deps.vcs.tryGit(cwd, ['rev-list', '--parents', '-n', '1', sha])
  return line ? line.trim().split(/\s+/).slice(1) : []
}

export function describeGitFailure(error) {
  const prefix = error?.timedOut ? 'timed out: ' : error?.bufferOverflow ? 'output buffer overflow: ' : ''
  return `${prefix}${String(error?.message ?? error)}`
}
