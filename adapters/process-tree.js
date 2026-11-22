// Kill a spawned process **and its descendants** (F104, F105).
//
// Two adapters spawn an orchestrator and must be able to end everything it
// started: `adapters/verify.js` (`node --test` on the reviewer's whitelist) and
// `adapters/tests.js` (the repository's own discovery commands). Both used to
// carry their own copy of the win32 ordering, and both copies killed the child
// before asking `taskkill` to walk the tree — which is exactly backwards, because
// `taskkill /T` can only enumerate descendants while the pid is still openable.
// This module is the single implementation; neither adapter keeps a local copy.
//
// `scripts/architecture.mjs:567-568` confines `node:child_process` to
// `adapters/**`, and this file is inside `adapters/`, so the gate stays satisfied.
import { spawn } from './vcs-git.js'

// A tree kill must finish quickly: the receipt is written right after it, and a
// fixpoint that waits on taskkill forever would turn a timeout into a hang.
export const TREE_KILL_BOUND_MS = 2000

/**
 * Ask `taskkill /T` to end the process and every descendant it can enumerate.
 *
 * Resolves `true` when taskkill exited 0 (the tree is gone), `false` when it
 * could not run, errored, or blew `boundMs`. It never rejects: the caller turns
 * `false` into the direct-kill fallback.
 */
export function killTreeWin32(pid, { spawn: spawnFn, boundMs }) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (ok) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(ok)
    }
    let killer
    try {
      killer = spawnFn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      finish(false)
      return
    }
    timer = setTimeout(() => finish(false), boundMs)
    timer.unref?.()
    killer.on('error', () => finish(false))
    killer.on('close', (code) => finish(code === 0))
  })
}

/**
 * Kill a spawned process **and its descendants**.
 *
 * On win32 the ordering is the whole fix: `taskkill /T` is the only call that
 * walks the tree, and it must run while the child pid is still openable. Killing
 * the child first makes taskkill exit 128 ("The process ... not found") without
 * touching the descendants, so a detached grandchild keeps running in the
 * worktree while the receipt already claims `status: "timeout"`. The direct kill
 * is therefore a fallback for when taskkill cannot run at all, never the first
 * move. On POSIX the child was spawned detached, so it leads its own process
 * group and the group kill is a single signal; a direct kill covers the case
 * where the group is already gone.
 *
 * `platform`, `spawn`, and `kill` are injectable so the ordering is testable
 * without spawning anything. Resolves when the attempt is over, not when the
 * process is confirmed dead; both callers still settle on the child's "close".
 */
export async function killProcessTree(child, options = {}) {
  if (!child || !child.pid) return
  const platform = options.platform ?? process.platform
  const spawnFn = options.spawn ?? spawn
  const killFn = options.kill ?? ((pid, signal) => process.kill(pid, signal))
  const direct = () => {
    try {
      killFn(child.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  if (platform === 'win32') {
    const killed = await killTreeWin32(child.pid, {
      spawn: spawnFn,
      boundMs: options.boundMs ?? TREE_KILL_BOUND_MS,
    })
    if (!killed) direct()
    return
  }
  try {
    killFn(-child.pid, 'SIGKILL')
  } catch {
    direct()
  }
}
