// tower_init view: adopt — reconcile the roster with the subagent catalog.
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
