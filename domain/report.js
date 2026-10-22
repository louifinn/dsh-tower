// Pure human-readable mission board.
// @ts-check
import { MISSION_STATUSES } from './mission.js'
import { taskCounts } from './summary.js'

/** @typedef {import('../types/index.js').TowerState} TowerState */

/**
 * @param {TowerState} state
 * @param {{ count?: number, unreadable?: boolean, message?: string } | null} [archive]
 * @returns {string}
 */
export function boardMarkdown(state, archive = null) {
  const lines = []
  lines.push(`# Tower missions — ${state.repoRoot}`)
  lines.push('')
  lines.push(`Base: \`${state.base}\` · revision ${state.revision} · updated ${new Date(state.updatedAt ?? Date.now()).toISOString()}`)
  /** @type {Record<string, number>} */
  const counts = {}
  for (const status of MISSION_STATUSES) counts[status] = 0
  for (const mission of state.missions) counts[mission.status] += 1
  lines.push('')
  lines.push(
    `Missions: ${state.missions.length} · ` +
      MISSION_STATUSES.map((status) => `${status} ${counts[status]}`).join(' · '),
  )
  if (archive) {
    lines.push(
      archive.unreadable === true
        ? `Archived: unreadable (${archive.message ?? 'archive index could not be read'})`
        : `Archived: ${archive.count ?? 0} terminal mission(s) in archive/ (not listed; use tower_status includeArchived)`,
    )
  }
  const openFindings = (state.findings ?? []).filter((finding) => !['fixed', 'wontfix'].includes(finding.status ?? 'open'))
  lines.push(`Findings: ${openFindings.length} open of ${(state.findings ?? []).length}`)
  lines.push('')
  lines.push('| Mission | Status | Kind | Title | Owner | Tasks (done/open/dropped) | Latest review | Merged |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const mission of state.missions) {
    const tasks = taskCounts(mission.tasks ?? [])
    const branch = mission.worktree ? mission.worktree.branch : null
    const reviews = branch ? (state.reviews ?? []).filter((review) => review.branch === branch) : []
    const latest = reviews.length > 0 ? reviews.reduce((a, b) => (a.round >= b.round ? a : b)) : null
    const reviewText = latest ? `R${latest.round} ${latest.status}/${latest.mergeVerdict}` : '—'
    lines.push(
      `| ${mission.id} | ${mission.status} | ${mission.kind} | ${String(mission.title).replaceAll('|', '\\|')} | ${
        mission.owner ?? '—'
      } | ${tasks.done}/${tasks.open}/${tasks.dropped} | ${reviewText} | ${
        mission.mergedCommit ? mission.mergedCommit.slice(0, 8) : '—'
      } |`,
    )
  }
  if ((state.roster ?? []).length > 0) {
    lines.push('')
    lines.push('## Roster')
    lines.push('')
    lines.push('| Name | Role | Mission | State | Agent |')
    lines.push('|---|---|---|---|---|')
    for (const entry of state.roster ?? []) {
      lines.push(
        `| ${entry.name} | ${entry.role} | ${entry.missionId} | ${entry.state} | \`${entry.agentId}\` |`,
      )
    }
  }
  lines.push('')
  return lines.join('\n')
}
