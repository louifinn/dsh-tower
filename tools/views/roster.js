// tower_inspect view: roster — authoritative roster activity.
//
// #207: with `agent` the view returns that one agent's bounded recent activity
// (`{at, event, text}` rows) instead of the whole roster table. Without
// `agent` the output is unchanged.
import { TowerToolError } from '../../domain/errors.js'
import { rosterEntryStale } from '../../domain/collab/roster.js'
import { agentRowSummary, compactAgentSummary, selectAgentActivity, selectRosterRows } from '../../domain/read/views.js'
import { PARENT_STATUS_OK, ROSTER_ACTIVITY } from '../../domain/vocabulary.js'

/** The activity tail is read bounded so one agent view never walks the log. */
export const ROSTER_ACTIVITY_TAIL = 200
/** Default number of activity summaries returned for one agent. */
export const AGENT_ACTIVITY_TAIL_DEFAULT = 5

/**
 * @param {any} ctx
 * @param {{ define: import('../../types/index.js').DefineTool, openTower: any }} deps
 */
export async function runRosterView(ctx, args, exec, deps) {
  const tower = await deps.openTower(args.repoRoot)
  const view = await tower.rosterView()
  const agentRequested = typeof args.agent === 'string' && args.agent.length > 0
  // #211: `agent`/`tail` narrow the roster before the catalog is queried, so
  // a large roster costs one parent lookup instead of every parent's list. A
  // single-agent view takes the matching row whole; `tail` then counts activity
  // summaries, not roster rows (#207).
  const selected = selectRosterRows(view.roster, {
    agent: args.agent,
    tail: agentRequested ? undefined : args.tail,
  })
  const subagents = ctx.get('subagents')
  if (!subagents) throw new TowerToolError('spawn-unavailable', 'subagents service is unavailable; cannot observe roster')

  const parents = [...new Set(selected.map((entry) => entry.parentSessionId).filter(Boolean))]
  const activity = new Map()
  const parentStatus = {}
  for (const parent of parents) {
    try {
      const rows = await subagents.listDescendants(parent)
      for (const row of rows) activity.set(String(row.id), row.activity ?? ROSTER_ACTIVITY.unknown)
      parentStatus[parent] = PARENT_STATUS_OK
    } catch (error) {
      parentStatus[parent] = `unavailable: ${String(error?.message ?? error)}`
    }
  }

  const staleMs = Number(tower.config.spawn?.staleMs) || 0
  const now = Date.now()
  const roster = selected.map((entry) => {
    const observed = activity.get(entry.agentId)
    const known = parentStatus[entry.parentSessionId] === PARENT_STATUS_OK
    // #160: the one shared spawn.staleMs rule (domain/collab/roster.js);
    // the /tasks panel renders the same verdict.
    const stale = rosterEntryStale(entry, { observed, parentKnown: known, staleMs, now })
    const row = {
      ...entry,
      activity: observed ?? (known ? ROSTER_ACTIVITY.missing : ROSTER_ACTIVITY.unknown),
      observed: observed !== undefined,
      stale,
    }
    // #231: the residue a dead worker leaves behind is per-agent diagnostic
    // detail. The table (and the dashboard built from it) keeps exactly the
    // columns it had, so a long mission cannot grow the default page; the
    // single-agent read below adds the record back.
    delete row.residue
    delete row.predecessorResidue
    return row
  })

  if (agentRequested) {
    const target = roster[0]
    if (!target) {
      throw new TowerToolError(
        'invalid-argument',
        `unknown roster agent "${args.agent}"; omit agent to list every roster row`,
      )
    }
    const tail = Number.isInteger(Number(args.tail)) && Number(args.tail) > 0
      ? Number(args.tail)
      : AGENT_ACTIVITY_TAIL_DEFAULT
    const log = await tower.deps.store.readActivityTail(tower.paths.activity, ROSTER_ACTIVITY_TAIL)
    const summary = args.compact === true
      ? compactAgentSummary(target)
      : agentRowSummary(target, {
          activity: target.activity,
          observed: target.observed,
          stale: target.stale,
        })
    return {
      revision: view.revision,
      // #207: `compact` keeps the identity a caller needs to name the agent
      // (name/role/missionId/state) without the observation, stale or outcome
      // fields; the bounded activity tail stays separate.
      // #231: the residue a dead worker left behind is diagnostic detail, so it
      // rides only on this per-agent read — never on the roster array above, so
      // the default page and the dashboard do not grow.
      agent: selected[0]?.residue && args.compact !== true
        ? { ...summary, residue: selected[0].residue }
        : summary,
      activity: selectAgentActivity(log, target, tail),
      parentStatus,
    }
  }

  return { revision: view.revision, roster, parentStatus, missions: view.missions }
}
