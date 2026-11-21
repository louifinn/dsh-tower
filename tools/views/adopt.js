// tower_init view: adopt — reconcile the roster with the subagent catalog.
import path from 'node:path'
import { TowerToolError } from '../../domain/errors.js'
import { reapStalledReservations } from '../../app/roster.js'
import { PARENT_STATUS_OK, ROSTER_ACTIVITY, ROSTER_STATE } from '../../domain/vocabulary.js'

/**
 * Parent-catalog status for a non-empty answer: only then may an absent roster
 * row be counted as an absence. An empty answer is absence of evidence, not
 * evidence of absence (#F83): the same rule the watchdog applies to its
 * `parentAuthoritative` bit (#F73), because a just-spawned child or a catalog
 * race legitimately yields `[]`.
 */
const PARENT_STATUS_EMPTY = 'empty: the catalog returned no descendants'

/** Why a row without a parent session was left unjudged: nothing was probed. */
const PARENT_STATUS_NO_PARENT = 'no-parent: the row names no parent session'

/**
 * Parse `git status --porcelain` into destination paths, the fallback when the
 * vcs port has no structured change reader.
 * @param {string} raw
 * @returns {string[]}
 */
function parsePorcelainPaths(raw) {
  /** @type {string[]} */
  const paths = []
  for (const line of String(raw).split('\n')) {
    if (line.length < 4) continue
    let value = line.slice(3).trim()
    if (value.includes(' -> ')) value = value.slice(value.lastIndexOf(' -> ') + 4)
    if (value) paths.push(value.replace(/^"(.*)"$/, '$1'))
  }
  return paths
}

/**
 * Read-only residue report for one recorded mission worktree (#204). Adopt
 * never repairs anything: it classifies what is left behind and suggests the
 * next action. `countCommits` is the authoritative probe for unmerged work, so
 * a failing vcs degrades the whole entry to `unknown` instead of claiming the
 * checkout is clean.
 * @param {any} tower
 * @param {any} mission
 * @returns {Promise<any>}
 */
async function missionResidue(tower, mission) {
  const worktree = mission.worktree
  const worktreePath = worktree.path
  const lastActivityAt = Number(mission.updatedAt ?? mission.startedAt ?? Date.now())
  const branch = worktree.branch ?? null
  const dirty = { files: 0, paths: [], sample: [] }
  try {
    const entries = await tower.deps.vcs.listWorktrees(tower.root)
    const resolved = path.resolve(worktreePath)
    const registered = entries.some((entry) => typeof entry?.path === 'string' && path.resolve(entry.path) === resolved)
    const exists = await tower.deps.store.exists(worktreePath)
    if (!exists) {
      return {
        id: mission.id,
        status: mission.status,
        branch,
        tip: null,
        lastCommit: null,
        worktreePath,
        dirty,
        lastActivityAt,
        class: 'missing',
        suggestedAction: 're-provision the mission worktree, or abandon the mission if its work is gone',
      }
    }
    if (!registered) {
      return {
        id: mission.id,
        status: mission.status,
        branch,
        tip: null,
        lastCommit: null,
        worktreePath,
        dirty,
        lastActivityAt,
        class: 'external',
        suggestedAction: 'a directory exists at the recorded worktree path but is not registered with git; remove it or re-provision the mission',
      }
    }
    // `worktreeChanges` is an optional VcsPort capability: read it through a
    // fully optional chain, then fall back to the porcelain parser when the
    // adapter does not provide it.
    const readChanges = tower.deps?.vcs?.worktreeChanges
    const changes = typeof readChanges === 'function'
      ? await readChanges(worktreePath)
      : parsePorcelainPaths(await tower.git(worktreePath, ['status', '--porcelain']))
    /** @type {string[]} */
    const paths = []
    for (const change of Array.isArray(changes) ? changes : []) {
      const value = typeof change?.path === 'string' ? change.path : ''
      if (value && !paths.includes(value)) paths.push(value)
    }
    const tip = await tower.revParse(worktreePath, 'HEAD')
    const base = worktree.baseCommit ?? mission.baseCommit ?? null
    const commits = base ? await tower.deps.vcs.countCommits(worktreePath, base) : 0
    const residue = { files: paths.length, paths: paths.slice(0, 20), sample: paths.slice(0, 5) }
    if (paths.length > 0) {
      return {
        id: mission.id,
        status: mission.status,
        branch,
        tip,
        lastCommit: { sha: tip, at: lastActivityAt },
        worktreePath,
        dirty: residue,
        lastActivityAt,
        class: 'dirty',
        suggestedAction: 'commit or discard the uncommitted changes in the mission worktree, then re-run adopt',
      }
    }
    if (commits > 0) {
      return {
        id: mission.id,
        status: mission.status,
        branch,
        tip,
        lastCommit: { sha: tip, at: lastActivityAt },
        worktreePath,
        dirty: residue,
        lastActivityAt,
        class: 'unmerged',
        suggestedAction: 'review the branch and run tower_merge for this mission',
      }
    }
    return {
      id: mission.id,
      status: mission.status,
      branch,
      tip,
      lastCommit: { sha: tip, at: lastActivityAt },
      worktreePath,
      dirty: residue,
      lastActivityAt,
      class: 'clean',
      suggestedAction: 'none',
    }
  } catch (error) {
    return {
      id: mission.id,
      status: mission.status,
      branch,
      tip: null,
      lastCommit: null,
      worktreePath,
      dirty,
      lastActivityAt,
      class: 'unknown',
      suggestedAction: `worktree probe failed: ${String(error?.message ?? error)}; inspect the checkout manually`,
    }
  }
}

/**
 * Every non-terminal mission with a recorded worktree, classified by the
 * residue it left behind. Missing/external entries are reported without a
 * probe; the rest are inspected once, in state order.
 * @param {any} tower
 * @returns {Promise<any[]>}
 */
async function missionResidues(tower) {
  const state = await tower.load()
  const pending = (Array.isArray(state.missions) ? state.missions : [])
    .filter((mission) => mission?.worktree?.path && mission.status !== 'merged' && mission.status !== 'abandoned')
  /** @type {any[]} */
  const missions = []
  for (const mission of pending) missions.push(await missionResidue(tower, mission))
  return missions
}

/**
 * Post-authorization body of `tower_init({ op: 'adopt' })`.
 *
 * Adopt reaps stalled reservations first (#F57): a row that never received an
 * agent id has nothing the catalog could observe, and the catalog is keyed by
 * child id, so it cannot be reconciled like a started worker. The body then
 * reports, instead of throwing, any remaining row that has no agent id: the
 * observation counters are keyed by agent id, so a shared `null` key would retire
 * rows the catalog never saw, and the retirement write used to fail validation
 * and abort the whole adopt. `reaped` names the discarded reservations and
 * `unresolvable` names the id-less rows left for a manual fix. A stalled
 * reservation whose disposable review checkout could not be removed is kept and
 * reported in `unreaped` with the checkout path, so the leak is actionable
 * instead of silent.
 *
 * Only a parent catalog that answered with at least one descendant is
 * authoritative (#F83). An empty answer or a thrown error cannot prove a row is
 * gone, so those rows are neither present nor absent: they are reported in
 * `unjudged` with the reason, and `retire_missing` never sees them. Without that
 * rule two consecutive adopts against a momentarily empty catalog would retire a
 * live worker, whose later `tower_complete` would then be refused as retired.
 *
 * @param {any} ctx
 * @param {any} args
 * @param {any} exec
 * @param {{ openTower: any, actorFor: any, requireTowerActor: any }} deps
 */
export async function runAdoptView(ctx, args, exec, deps) {
  const tower = await deps.openTower(args.repoRoot)
  const actor = await deps.actorFor(tower, exec)
  deps.requireTowerActor(actor, 'adopt the roster')
  const subagents = ctx.get('subagents')
  if (!subagents) throw new TowerToolError('spawn-unavailable', 'subagents service is unavailable; cannot adopt')

  const { reaped, unreaped } = await reapStalledReservations(tower)
  const view = await tower.rosterView()

  const parents = [...new Set(view.roster.map((entry) => entry.parentSessionId).filter(Boolean))]
  const activity = new Map()
  const parentStatus = {}
  for (const parent of parents) {
    try {
      const rows = await subagents.listDescendants(parent)
      for (const row of rows) activity.set(String(row.id), row.activity ?? ROSTER_ACTIVITY.unknown)
      // #F83: only a non-empty answer proves the catalog looked at this
      // parent's children. An empty answer gets its own status so a reader can
      // tell "nothing was there" apart from "the catalog could not answer".
      parentStatus[parent] = rows.length > 0 ? PARENT_STATUS_OK : PARENT_STATUS_EMPTY
    } catch (error) {
      parentStatus[parent] = `unavailable: ${String(error?.message ?? error)}`
    }
  }

  const retiredCandidates = []
  const presentIds = []
  const absentIds = []
  const unresolvable = []
  const unjudged = []
  for (const entry of view.roster) {
    if (entry.state === ROSTER_STATE.retired) continue
    if (typeof entry.agentId !== 'string') {
      unresolvable.push({ name: entry.name, missionId: entry.missionId ?? null, state: entry.state ?? null })
      continue
    }
    const parent = entry.parentSessionId
    const status = parent ? parentStatus[parent] : undefined
    if (status !== PARENT_STATUS_OK) {
      // A non-authoritative catalog must not turn "I could not look" into
      // "it is gone": leave the row's observation counters untouched.
      unjudged.push({
        name: entry.name,
        missionId: entry.missionId ?? null,
        agentId: entry.agentId,
        reason: status ?? PARENT_STATUS_NO_PARENT,
      })
      continue
    }
    if (activity.has(entry.agentId)) {
      presentIds.push(entry.agentId)
    } else {
      absentIds.push(entry.agentId)
    }
  }
  const observations = await tower.recordRosterObservations({ present: presentIds, absent: absentIds, confirmations: 2 })
  retiredCandidates.push(...observations.candidates)
  const retireMissing = args.retire_missing !== false
  const { retired } = retireMissing ? await tower.markRetired(retiredCandidates) : { retired: [] }
  const { missing } = retireMissing ? { missing: [] } : await tower.markMissing(retiredCandidates)
  const after = await tower.rosterView()
  return {
    retired,
    missing,
    missions: await missionResidues(tower),
    reaped: reaped.map((entry) => entry.name),
    unreaped: unreaped.map((entry) => ({
      name: entry.name,
      missionId: entry.missionId,
      checkout: entry.checkout,
      error: entry.error,
      attempts: entry.attempts,
    })),
    unresolvable,
    unjudged,
    unconfirmed: absentIds.filter((agentId) => !retiredCandidates.includes(agentId)),
    skippedUnknownParents: Object.entries(parentStatus)
      .filter(([, status]) => status !== PARENT_STATUS_OK)
      .map(([parent]) => parent),
    roster: after.roster,
    parentStatus,
  }
}
