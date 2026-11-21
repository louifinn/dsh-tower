// Doctor report for worktree dependency links (#218/F100).
//
// A worktree may carry a recorded `node_modules` link. Report a link whose target
// vanished (dangling), a recorded link that is gone or is no longer a link, and a
// link at that path Tower never recorded. Teardown keeps rather than follows all
// of these, so the operator should see why a checkout stayed.
import path from 'node:path'
import { fsp } from '../adapters/store-fs.js'

/**
 * @param {string} missionId
 * @param {any} worktree
 * @returns {Promise<{ missionId: string, path: string, target?: string, reason: string } | null>}
 */
export async function worktreeLinkIssue(missionId, worktree) {
  const record = worktree?.nodeModulesLink
  const linkPath =
    typeof record?.path === 'string'
      ? record.path
      : typeof worktree?.path === 'string'
        ? path.join(worktree.path, 'node_modules')
        : null
  if (linkPath === null) return null
  if (record) {
    if (typeof record.target === 'string') {
      const target = await fsp.stat(record.target).catch(() => null)
      if (!target || (typeof target.isDirectory === 'function' && !target.isDirectory())) {
        return { missionId, path: linkPath, target: record.target, reason: 'dangling' }
      }
    }
    const linkStat = await fsp.lstat(linkPath).catch(() => null)
    if (!linkStat) return { missionId, path: linkPath, target: record.target, reason: 'missing' }
    if (typeof linkStat.isSymbolicLink === 'function' && !linkStat.isSymbolicLink()) {
      return { missionId, path: linkPath, target: record.target, reason: 'replaced' }
    }
    return null
  }
  const linkStat = await fsp.lstat(linkPath).catch(() => null)
  if (linkStat && typeof linkStat.isSymbolicLink === 'function' && linkStat.isSymbolicLink()) {
    return { missionId, path: linkPath, reason: 'unrecorded' }
  }
  return null
}

/**
 * @param {Array<{ path: string, target?: string, reason: string }>} linkIssues
 * @returns {{ id: string, status: string, detail: string, action?: string }}
 */
export function worktreeLinksCheck(linkIssues) {
  if (linkIssues.length === 0) {
    return { id: 'worktree-links', status: 'pass', detail: 'no dangling or unrecorded worktree links' }
  }
  const first = linkIssues[0]
  return {
    id: 'worktree-links',
    status: 'warn',
    detail: `${linkIssues.length} worktree node_modules link(s) need attention: ${first.path} (${first.reason}${first.target ? `; target ${first.target}` : ''})`,
    action:
      'run the worktree teardown step to unlink a recorded link without touching its target; remove an unrecorded or replaced link by hand (delete the link, never its target)',
  }
}
