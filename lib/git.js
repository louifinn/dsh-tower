import { TowerToolError } from '../domain/errors.js'
// Minimal git port: array arguments only, bounded output, no shell.
import { execFile } from '../adapters/vcs-git.js'
import path from 'node:path'

const GIT_TIMEOUT_MS = 15000
const MAX_BUFFER = 16 * 1024 * 1024
let configuredTimeoutMs = GIT_TIMEOUT_MS

/** @typedef {{ timeoutMs?: number, maxBuffer?: number }} GitOptions */
/** @typedef {{ path: string, branch?: string, head?: string }} WorktreeEntry */

/** Override the default Git timeout from resolved Tower config. */
export function setGitTimeout(ms) {
  const value = Number(ms)
  if (Number.isFinite(value) && value >= 1000) configuredTimeoutMs = value
}

/** Process default retained for manual adapter use; Tower instances pass their own. */
export function configuredGitTimeout() {
  return configuredTimeoutMs
}

const BLOCKED_GIT_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_QUARANTINE_PATH',
])

/**
 * Git must not inherit a repository redirect from the DSH process environment.
 * @param {NodeJS.ProcessEnv} [source]
 * @returns {NodeJS.ProcessEnv}
 */
export function gitEnv(source = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (BLOCKED_GIT_ENV.has(key)) continue
    env[key] = value
  }
  return env
}

import { GitError } from '../domain/errors.js'
export { GitError }

/**
 * Run one git command with bounded output and no shell.
 * @param {string} cwd
 * @param {string[]} args
 * @param {GitOptions} [options]
 * @returns {Promise<string>}
 */
export function git(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: options.timeoutMs ?? configuredTimeoutMs,
        maxBuffer: options.maxBuffer ?? MAX_BUFFER,
        windowsHide: true,
        env: gitEnv(),
      },
      (error, stdout, stderr) => {
        if (error) {
          const timedOut = error.killed === true || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT'
          const bufferOverflow = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          reject(
            new GitError(
              args,
              String(stderr || error.message || '').trim(),
              typeof error.code === 'number' ? error.code : undefined,
              { timedOut, bufferOverflow, stdout: String(stdout ?? '').slice(0, 64 * 1024) },
            ),
          )
          return
        }
        resolve(String(stdout).replace(/\r\n/g, '\n').trimEnd())
      },
    )
  })
}

/**
 * Run git when its failure is not an error (existence probes).
 * @param {string} cwd
 * @param {string[]} args
 * @param {GitOptions} [options]
 * @returns {Promise<string | null>}
 */
export async function tryGit(cwd, args, options) {
  try {
    return await git(cwd, args, options)
  } catch {
    return null
  }
}

/**
 * Resolve an absolute caller path to the repository root, its common git dir
 * (shared by all worktrees), and the current branch of that checkout.
 * @param {string} repoRoot
 * @returns {Promise<{ root: string, commonDir: string, branch: string | null }>}
 */
export async function resolveRepo(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.trim().length === 0) {
    throw new TowerToolError('repo-invalid', 'repoRoot is required')
  }
  if (!path.isAbsolute(repoRoot)) {
    throw new TowerToolError('repo-invalid', `repoRoot must be an absolute path: ${repoRoot}`)
  }
  let top
  try {
    top = await git(repoRoot, ['rev-parse', '--show-toplevel'])
  } catch (error) {
    throw new TowerToolError('repo-invalid', `not a git repository: ${repoRoot}`, { cause: error })
  }
  const root = path.resolve(top)
  let commonRaw
  try {
    commonRaw = await git(root, ['rev-parse', '--git-common-dir'])
  } catch (error) {
    throw new TowerToolError('repo-invalid', `not a git repository: ${root}`, { cause: error })
  }
  const commonDir = path.isAbsolute(commonRaw)
    ? path.resolve(commonRaw)
    : path.resolve(root, commonRaw)
  const branch = await tryGit(root, ['symbolic-ref', '--short', '-q', 'HEAD'])
  return {
    root,
    commonDir,
    branch: branch && branch.trim() ? branch.trim() : null,
  }
}

/** @param {string} root @returns {Promise<boolean>} */
export async function hasAnyCommit(root) {
  const out = await tryGit(root, ['rev-list', '-n', '1', '--all'])
  return Boolean(out && out.trim())
}

/** @param {string} root @param {string} branch @returns {Promise<boolean>} */
export async function localBranchExists(root, branch) {
  const out = await tryGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  return out !== null
}

/** @param {string} cwd @param {string} ref @returns {Promise<string>} */
export async function revParse(cwd, ref) {
  const out = await git(cwd, ['rev-parse', ref])
  return out.trim()
}

/** @param {string} cwd @param {string} branch @returns {Promise<boolean>} */
export async function branchExists(cwd, branch) {
  return (await localBranchExists(cwd, branch)) === true
}

/** @param {string} cwd @returns {Promise<string | null>} */
export async function currentBranch(cwd) {
  const out = await tryGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])
  return out && out.trim() ? out.trim() : null
}

export async function addWorktree(cwd, { path: worktreePath, branch, commit }) {
  await git(cwd, ['worktree', 'add', '-b', branch, worktreePath, commit])
  return worktreePath
}

/** @param {string} cwd @returns {Promise<WorktreeEntry[]>} */
export async function listWorktrees(cwd) {
  const out = await git(cwd, ['worktree', 'list', '--porcelain'])
  /** @type {WorktreeEntry[]} */
  const entries = []
  /** @type {WorktreeEntry | null} */
  let current = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { path: line.slice('worktree '.length) }
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    }
  }
  if (current) entries.push(current)
  return entries
}

/** @param {string} cwd @returns {Promise<boolean>} */
export async function isClean(cwd) {
  const out = await git(cwd, ['status', '--porcelain'])
  return out.trim().length === 0
}

/** @param {string} cwd @returns {Promise<string | null>} */
export async function currentCommonDir(cwd) {
  const raw = await tryGit(cwd, ['rev-parse', '--git-common-dir'])
  if (raw === null) return null
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw)
}

/** @param {string} cwd @param {string} fromRef @returns {Promise<number>} */
export async function countCommits(cwd, fromRef) {
  const out = await git(cwd, ['rev-list', '--count', `${fromRef}..HEAD`])
  return Number(out.trim() || 0)
}

/** @param {string} cwd @param {string} ancestor @param {string} descendant @returns {Promise<boolean>} */
export async function isAncestor(cwd, ancestor, descendant) {
  const out = await tryGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
  return out !== null
}
