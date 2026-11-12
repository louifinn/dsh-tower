// `/tasks` command registration (#160): the read-only live-roster panel.
//
// The plugin claims the generic host name only when the profile has no other
// `tasks` command (checked through `commands.list()` at inject time); when the
// host owns the name, the same panel stays reachable as the `/tower tasks`
// subcommand, and both command descriptions name which surface is active (D1).
//
// The handler answers "which agents are live, what did they last do, how long
// have they been silent" without a model turn and without a single write: it
// reads the roster projection, the subagent catalog and the activity tail, and
// never touches state.json or the mode store (D2/D3).
import { openTowerFor } from './mode-state.js'
import { observeActivity } from './tool-observers.js'
import { tasksPanelText } from '../domain/read/tasksView.js'

/** How many activity-log entries feed the "last recorded event" column. */
const TASKS_PANEL_ACTIVITY_TAIL = 200

/**
 * Run the read-only panel for one agent's session repository.
 * @param {object} ctx Cordis context (for the `subagents` service)
 * @param {unknown} agent the calling agent (carries the session working directory)
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>}
 */
export async function runTasksCommand(ctx, agent) {
  try {
    const tower = await openTowerFor(agent)
    const view = await tower.rosterView()
    const { activity, parentStatus } = await observeActivity(ctx, tower)
    const activityLog = await tower.deps.store.readActivityTail(tower.paths.activity, TASKS_PANEL_ACTIVITY_TAIL)
    return {
      kind: 'success',
      text: tasksPanelText({
        roster: view.roster,
        activity,
        parentStatus,
        activityLog,
        staleMs: Number(tower.config.spawn?.staleMs) || 0,
        now: Date.now(),
      }),
    }
  } catch (error) {
    const code = error?.code ? `[tower:${error.code}] ` : ''
    return { kind: 'error', text: `${code}${String(error?.message ?? error)}` }
  }
}

/**
 * True when the host profile already carries a `tasks` command, in which case
 * the plugin must not shadow it (D1). A commands service without `list()`
 * (older hosts, test harnesses) is treated as a free name.
 * @param {{ list?: (filter?: unknown) => unknown }} commands
 * @returns {boolean}
 */
function hostOwnsTasksName(commands) {
  if (typeof commands?.list !== 'function') return false
  let rows
  try {
    rows = commands.list(undefined)
  } catch {
    return false
  }
  return Array.isArray(rows) && rows.some((row) => row && row.name === 'tasks')
}

/**
 * Register the `/tasks` command unless the host owns the name.
 * @param {object} ctx Cordis context
 */
export function registerTasksCommand(ctx) {
  ctx.inject(['commands'], (commandCtx) => {
    if (hostOwnsTasksName(commandCtx.commands)) return
    commandCtx.commands.register({
      name: 'tasks',
      description:
        'Read-only Tower live-roster panel: one line per agent with its state, silence since its last recorded event, and that event. No model turn, no writes. Registered as /tasks because this profile defines no other tasks command; when the host owns the name, the same panel is the /tower tasks subcommand.',
      input: { hint: '' },
      handler: ({ agent }) => runTasksCommand(ctx, agent),
    })
  })
}
