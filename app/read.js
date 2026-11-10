// Read-only dashboard/detail use cases.
import { TowerToolError } from '../domain/errors.js'
import { isReviewerRole } from '../domain/roles.js'
import { assertActionSupported } from '../domain/shapes/index.js'
import { diffView, missionDetailView, statusView } from '../domain/read/views.js'
import { archiveView, archivedSummary } from './archive.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

/**
 * #149 W3: a reviewer diffs the commit recorded on its roster row — the same
 * commit its verdict is stamped with — never the worker's live worktree HEAD.
 * The checkout is only trusted while its HEAD still equals that commit.
 * @returns {Promise<{ commit: string, cwd: string } | null>}
 */
async function reviewerBinding(tower, state, mission, actor) {
  if (!actor || !isReviewerRole(actor.role) || !actor.agentId) return null
  const row = (state.roster ?? []).find((entry) => entry.agentId === actor.agentId)
  if (!row || typeof row.reviewCommit !== 'string' || row.reviewCommit.length === 0) {
    fail(
      `reviewer ${row?.name ?? actor.name} has no recorded review commit; spawn reviewers through tower_spawn so a verdict is bound to a commit`,
    )
  }
  if (typeof row.reviewCheckout === 'string' && row.reviewCheckout.length > 0) {
    const head = await tower.revParse(row.reviewCheckout, 'HEAD').catch(() => null)
    if (head !== row.reviewCommit) {
      const where = head ? head.slice(0, 12) : 'a missing checkout'
      fail(
        `reviewer ${row.name}'s checkout is at ${where} instead of the recorded review commit ${row.reviewCommit.slice(0, 12)}; spawn a fresh reviewer`,
      )
    }
    return { commit: row.reviewCommit, cwd: row.reviewCheckout }
  }
  return { commit: row.reviewCommit, cwd: mission.worktree.path }
}

/**
 * Full detail for one mission. A mission that was archived is reconstructed
 * from its year file, including the reviews, findings and activity that left
 * state.json with it. An unreadable archive is a diagnostic, never a throw:
 * `tower_status` must keep rendering the hot state.
 */
export async function missionDetail(tower, missionId) {
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === missionId)
  const activity = await tower.deps.store.readActivityTail(tower.paths.activity, 200)
  if (mission) return missionDetailView({ state, mission, activity })

  const archived = await tower.archivedMission(missionId)
  if (archived.ok && archived.entry) {
    const entry = archived.entry
    const hotFindings = (state.findings ?? []).filter((finding) => finding.missionId === missionId)
    const byId = new Map()
    for (const finding of [...(entry.findings ?? []), ...hotFindings]) {
      if (finding && typeof finding.id === 'string') byId.set(finding.id, finding)
    }
    return {
      ...missionDetailView({
        state: /** @type {any} */ ({ reviews: entry.reviews ?? [], findings: [...byId.values()] }),
        mission: /** @type {any} */ (entry.mission),
        activity,
      }),
      archived: true,
      archivedAt: entry.archivedAt,
      archivedYear: entry.archivedYear,
      branch: entry.branch ?? null,
    }
  }
  if (archived.unreadable) {
    return {
      archived: true,
      archivedAt: null,
      branch: null,
      mission: null,
      reviews: [],
      findings: [],
      activity: [],
      error: archived.error ?? `tower archive is unreadable; mission ${missionId} cannot be loaded`,
    }
  }
  return fail(`unknown mission "${missionId}"`, 'mission-not-found')
}

export async function status(tower, input = {}) {
  const state = await tower.load()
  const activity = await tower.deps.store.readActivityTail(tower.paths.activity, 12)
  // The repo-scoped git mutex can be held for a whole merge; expose the
  // holder so "the tower is stuck" has a visible cause (#93).
  const gitLock = tower.deps.store.gitLockView(await tower.deps.store.readGitLock(tower.paths))
  const index = await tower.archiveIndex()
  const activeIds = new Set(state.missions.map((mission) => mission.id))
  const wanted = Array.isArray(input.missionIds) ? new Set(input.missionIds) : null
  // An explicit missionId lookup includes its archived summary; the dashboard
  // includes them only on demand. Archived summaries never carry report bodies.
  const includeArchived = input.includeArchived === true || wanted !== null
  const missions = await tower.enrichedMissions(state, input.missionIds)
  if (includeArchived && index.ok) {
    for (const entry of index.missions) {
      if (activeIds.has(entry.id)) continue
      if (wanted !== null && !wanted.has(entry.id)) continue
      missions.push(archivedSummary(entry))
    }
  }
  return statusView({
    state,
    statePath: tower.paths.state,
    activity,
    unreadTower: tower.unreadFor(state, 'tower').length,
    config: tower.config,
    missions,
    archivedMissions: index.ok ? index.missions.length : null,
    archive: archiveView(index),
    gitLock,
  })
}

export async function diff(tower, input = {}) {
  const state = await tower.load()
  const mission = state.missions.find((entry) => entry.id === input.missionId)
  if (!mission) fail(`unknown mission "${input.missionId}"`, 'mission-not-found')
  assertActionSupported(mission, 'diff')
  if (!mission.worktree) fail(`mission ${mission.id} has no worktree to diff`)
  await tower.assertWorktree(mission.worktree)
  const binding = await reviewerBinding(tower, state, mission, input.actor)
  const cwd = binding?.cwd ?? mission.worktree.path
  const baseTip = await tower.revParse(tower.root, state.base)
  const branchTip = binding?.commit ?? (await tower.branchTip(mission))
  const mergeBase = (await tower.git(cwd, ['merge-base', baseTip, branchTip])).trim()
  const files = (await tower.git(cwd, ['diff', '--name-status', `${mergeBase}..${branchTip}`]))
    .split('\n')
    .filter(Boolean)
  const commits = (await tower.git(cwd, ['log', '--oneline', `${mergeBase}..${branchTip}`]))
    .split('\n')
    .filter(Boolean)
  const fullPatch = await tower.git(cwd, ['diff', `${mergeBase}..${branchTip}`])
  return diffView({
    mission,
    baseTip,
    branchTip,
    reviewedCommit: binding?.commit ?? null,
    mergeBase,
    files,
    commits,
    fullPatch,
    maxBytes: input.maxBytes,
  })
}
