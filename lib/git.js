// Minimal git port: array arguments only, bounded output, no shell.
import { execFile } from 'node:child_process'
import path from 'node:path'

const GIT_TIMEOUT_MS = 15000
const MAX_BUFFER = 16 * 1024 * 1024
let configuredTimeoutMs = GIT_TIMEOUT_MS

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

/** Git must not inherit a repository redirect from the DSH process environment. */
export function gitEnv(source = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (BLOCKED_GIT_ENV.has(key)) continue
    env[key] = value
  }
  return env
}

import { GitError } from './errors.js'
export { GitError }

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
 */
export async function resolveRepo(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.trim().length === 0) {
    throw new Error('repoRoot is required')
  }
  if (!path.isAbsolute(repoRoot)) {
    throw new Error(`repoRoot must be an absolute path: ${repoRoot}`)
  }
  const top = await git(repoRoot, ['rev-parse', '--show-toplevel'])
  const root = path.resolve(top)
  const commonRaw = await git(root, ['rev-parse', '--git-common-dir'])
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

export async function hasAnyCommit(root) {
  const out = await tryGit(root, ['rev-list', '-n', '1', '--all'])
  return Boolean(out && out.trim())
}

export async function localBranchExists(root, branch) {
  const out = await tryGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  return out !== null
}

export async function revParse(cwd, ref) {
  const out = await git(cwd, ['rev-parse', ref])
  return out.trim()
}

export async function branchExists(cwd, branch) {
  return (await localBranchExists(cwd, branch)) === true
}

export async function currentBranch(cwd) {
  const out = await tryGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])
  return out && out.trim() ? out.trim() : null
}

export async function addWorktree(cwd, { path: worktreePath, branch, commit }) {
  await git(cwd, ['worktree', 'add', '-b', branch, worktreePath, commit])
  return worktreePath
}

export async function listWorktrees(cwd) {
  const out = await git(cwd, ['worktree', 'list', '--porcelain'])
  const entries = []
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

export async function isClean(cwd) {
  const out = await git(cwd, ['status', '--porcelain'])
  return out.trim().length === 0
}

export async function currentCommonDir(cwd) {
  const raw = await tryGit(cwd, ['rev-parse', '--git-common-dir'])
  if (raw === null) return null
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw)
}

export async function countCommits(cwd, fromRef) {
  const out = await git(cwd, ['rev-list', '--count', `${fromRef}..HEAD`])
  return Number(out.trim() || 0)
}

export async function isAncestor(cwd, ancestor, descendant) {
  const out = await tryGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
  return out !== null
}
