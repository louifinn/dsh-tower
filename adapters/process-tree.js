// Kill a spawned process **and its descendants** (F104, F105, F107).
//
// Two adapters spawn an orchestrator and must be able to end everything it
// started: `adapters/verify.js` (`node --test` on the reviewer's whitelist) and
// `adapters/tests.js` (the repository's own discovery commands). Both used to
// carry their own copy of the win32 ordering, and both copies killed the child
// before asking `taskkill` to walk the tree — which is exactly backwards, because
// `taskkill /T` can only enumerate descendants while the pid is still openable.
// This module is the single implementation; neither adapter keeps a local copy.
//
// The POSIX branch carried the same ordering mistake in a different shape
// (F107): `kill(-pid, 'SIGKILL')` signals only the child's own process group,
// and a descendant spawned with `detached: true` calls setsid(2), which puts it
// in a new session **and** a new process group. The group kill then reports
// success while that descendant keeps running. The fix is the win32 discipline
// applied to POSIX: enumerate descendants *before* killing (a self-detached
// grandchild is still a child of its parent at enumeration time), then signal
// the group (which covers the root) and every collected pid.
//
// `scripts/architecture.mjs:567-568` confines `node:child_process` to
// `adapters/**`, and this file is inside `adapters/`, so the gate stays satisfied.
import { spawn } from './vcs-git.js'

// A tree kill must finish quickly: the receipt is written right after it, and a
// fixpoint that waits on taskkill forever would turn a timeout into a hang.
export const TREE_KILL_BOUND_MS = 2000

/** The default descendant enumeration command: POSIX, portable to Linux and macOS. */
const PS_TABLE_ARGS = ['-A', '-o', 'pid=,ppid=']

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
 * Parse `ps -A -o pid=,ppid=` output into a `pid -> children[]` map.
 *
 * `ps` right-aligns both columns, so only whitespace splitting is needed. A
 * line that is not exactly two integers is ignored rather than trusted: this
 * runs on both Linux and macOS, and a half-parsed table must never be the
 * reason a wrong pid is signalled. Returns `null` when nothing parseable came
 * back, which the caller treats like a `ps` that could not run.
 */
export function parsePsTable(text) {
  const children = new Map()
  let rows = 0
  for (const line of String(text ?? '').split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 2) continue
    const pid = Number(fields[0])
    const ppid = Number(fields[1])
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0) continue
    rows += 1
    const siblings = children.get(ppid)
    if (siblings) siblings.push(pid)
    else children.set(ppid, [pid])
  }
  return rows > 0 ? children : null
}

/**
 * Collect the transitive descendants of `rootPid` from a `pid -> children[]` map.
 *
 * This runs while the tree is still alive, which is the whole trick: a
 * descendant that called setsid already has its own process group, but it is
 * still a *child of its parent in this table*, so the walk finds it. The root
 * itself is excluded (the group signal covers it), and the visited set makes a
 * cyclic or pathological table terminate.
 */
export function collectDescendants(rootPid, children) {
  const found = []
  const seen = new Set([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const current = queue.shift()
    const kids = children.get(current) ?? []
    for (const kid of kids) {
      if (seen.has(kid)) continue
      seen.add(kid)
      found.push(kid)
      queue.push(kid)
    }
  }
  return found
}

/**
 * Read the process table with the injected spawn seam.
 *
 * Resolves the raw stdout text, or `null` when `ps` could not run, exited
 * non-zero, errored, or blew `boundMs`. Never rejects.
 */
function readPsTable({ spawn: spawnFn, boundMs }) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    let output = ''
    const finish = (text) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(text)
    }
    let reader
    try {
      reader = spawnFn('ps', PS_TABLE_ARGS, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      finish(null)
      return
    }
    timer = setTimeout(() => finish(null), boundMs)
    timer.unref?.()
    reader.on('error', () => finish(null))
    reader.stdout?.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    reader.on('close', (code) => finish(code === 0 ? output : null))
  })
}

/**
 * POSIX tree kill: enumerate first, then the group kill (cheap, and it covers
 * the ordinary case plus the root itself), then a sweep over the collected
 * descendants, with the direct kill kept as the group-kill fallback.
 *
 * The enumeration must happen *before* any signal: after the first kill the
 * parent links are gone and a surviving descendant would be reparented to init,
 * out of reach of the walk. Signals to a pid that has already died are expected
 * (`ESRCH`) and swallowed, because the sweep deliberately over-includes.
 */
async function killTreePosix(child, { spawn: spawnFn, kill: killFn, boundMs }) {
  // 1. Enumeration first, while the tree is still intact.
  const tableText = await readPsTable({ spawn: spawnFn, boundMs })
  const children = parsePsTable(tableText)
  const descendants = children ? collectDescendants(child.pid, children) : null

  // 2. The group kill. It is the only move that can catch a descendant which
  //    was spawned between the enumeration and here, and it covers ordinary
  //    trees without any of the sweep's bookkeeping. A missing group is the
  //    documented fallback case: it means the child does not lead one (or has
  //    already exited), so the root gets the direct kill below instead.
  let groupKilled = false
  try {
    killFn(-child.pid, 'SIGKILL')
    groupKilled = true
  } catch {
    groupKilled = false
  }

  // 3. The descendant sweep. This is the F107 fix: a setsid'd grandchild is
  //    unreachable from the group kill, but it is in the table above. Its pids
  //    are already known, so it does not matter that the group signal may have
  //    reparented them a moment ago.
  for (const pid of descendants ?? []) {
    try {
      killFn(pid, 'SIGKILL')
    } catch {
      // already gone; the sweep is deliberately exhaustive
    }
  }

  // 4. The `false → direct()` contract: only a group signal that could not run
  //    leaves the root untouched, and then (and only then) the direct kill is
  //    the fallback.
  if (!groupKilled) {
    try {
      killFn(child.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
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
 * move.
 *
 * On POSIX the child was spawned detached, so it leads its own process group
 * and the group kill covers ordinary descendants. It cannot cover one that
 * called setsid: that descendant is in a new session and group, and the group
 * signal reports success while it keeps running (F107). So the descendants are
 * enumerated with `ps` before anything is signalled, then the group is killed
 * (which reaches the root as well), then every enumerated descendant. The root
 * gets an explicit direct kill only when the group signal could not run. A `ps`
 * that cannot run, exits non-zero, prints garbage, or overruns the bound
 * degrades to the group kill plus the direct kill — the same contract as before.
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
  const boundMs = options.boundMs ?? TREE_KILL_BOUND_MS
  const direct = () => {
    try {
      killFn(child.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  if (platform === 'win32') {
    const killed = await killTreeWin32(child.pid, { spawn: spawnFn, boundMs })
    if (!killed) direct()
    return
  }
  await killTreePosix(child, { spawn: spawnFn, kill: killFn, boundMs })
}
