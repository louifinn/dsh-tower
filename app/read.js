// Read-only dashboard/detail use cases.
import { TowerToolError } from '../domain/errors.js'
import { diffView, missionDetailView, statusView } from '../domain/read/views.js'
import { archiveView, archivedSummary } from './archive.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
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
  if (!mission.worktree) fail(`mission ${mission.id} has no worktree to diff`)
  await tower.assertWorktree(mission.worktree)
  const baseTip = await tower.revParse(tower.root, state.base)
  const branchTip = await tower.revParse(mission.worktree.path, 'HEAD')
  const mergeBase = (await tower.git(mission.worktree.path, ['merge-base', baseTip, branchTip])).trim()
  const files = (await tower.git(mission.worktree.path, ['diff', '--name-status', `${mergeBase}..${branchTip}`]))
    .split('\n')
    .filter(Boolean)
  const commits = (await tower.git(mission.worktree.path, ['log', '--oneline', `${mergeBase}..${branchTip}`]))
    .split('\n')
    .filter(Boolean)
  const fullPatch = await tower.git(mission.worktree.path, ['diff', `${mergeBase}..${branchTip}`])
  return diffView({
    mission,
    baseTip,
    branchTip,
    mergeBase,
    files,
    commits,
    fullPatch,
    maxBytes: input.maxBytes,
  })
}
