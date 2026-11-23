// tower_inspect (#163 Phase 3): one read-only tool with five views.
// Each view keeps its own module and pure projection; this module only routes.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { InspectInput } from '../domain/contracts/tool-inputs/index.js'
import { INSPECT_VIEW, INSPECT_VIEWS } from '../domain/vocabulary.js'
import { runDiffView } from './views/diff.js'
import { runDoctorView } from './views/doctor.js'
import { runPreflightView } from './views/preflight.js'
import { runRosterView } from './views/roster.js'
import { runStatusView } from './views/status.js'

// #163: the description budget is 300 characters. The long form lives in
// docs/reference/tools.md; this string only has to make the choice possible.
// #207: status and roster also take `agent`/`tail` for one agent's bounded
// activity, so the advertised line names that mode without the whole table.
export const INSPECT_DESCRIPTION =
  'Read-only Tower views: status (dashboard, one mission, or one agent plus activity), roster (live agent activity, or one agent history with agent/tail), diff (mission branch patch), preflight (merge gate blockers/warnings), doctor (health). Never writes state or git.'

const AGENT_VIEWS = /** @type {Set<string>} */ (new Set([INSPECT_VIEW.status, INSPECT_VIEW.roster]))
const MISSION_VIEWS = /** @type {Set<string>} */ (new Set([INSPECT_VIEW.diff, INSPECT_VIEW.preflight]))

/**
 * @param {any} ctx
 * @param {{
 *   define: import('../types/index.js').DefineTool,
 *   openTower: any,
 *   workspaceHook: any,
 *   spawnBackoffView: any,
 *   observeActivity: any,
 *   componentReport: any,
 *   ownershipView: any,
 *   createTower: any,
 *   resolveRepo: any,
 *   runtimeConfig: () => any,
 *   resolveTowerConfig: (raw: any) => any,
 *   isConfigResolutionError: (error: any) => boolean,
 *   runDoctor: any,
 *   surface?: () => { tools?: number },
 * }} deps
 */
export function registerInspectTool(ctx, deps) {
  const { define } = deps
  define(ctx, {
    name: 'tower_inspect',
    description: INSPECT_DESCRIPTION,
    parameters: InspectInput,
    aliases: {
      missionId: ['id', 'mission_id'],
      includeGate: ['include_gate'],
      includeArchived: ['include_archived'],
      maxBytes: ['max_bytes'],
      sinceRevision: ['since_revision'],
    },
    output: output(SCHEMAS.inspect),
    validateArgs(args) {
      if (!INSPECT_VIEWS.includes(args.view)) {
        throw new TowerToolError('invalid-argument', `tower_inspect view must be one of ${INSPECT_VIEWS.join(', ')}`)
      }
      if (MISSION_VIEWS.has(args.view) && !(typeof args.missionId === 'string' && args.missionId.trim())) {
        throw new TowerToolError('invalid-argument', `tower_inspect view "${args.view}" requires missionId (alias: id)`)
      }
      // #207: `agent`/`tail` select one agent's bounded activity. They are
      // deliberately limited to status and roster so no other view silently
      // ignores them; a mission target and an agent target are exclusive.
      if (args.agent !== undefined && !AGENT_VIEWS.has(args.view)) {
        throw new TowerToolError('invalid-argument', `tower_inspect agent is available with view "status" or "roster"`)
      }
      if (args.agent !== undefined && args.missionId !== undefined) {
        throw new TowerToolError('invalid-argument', 'tower_inspect takes missionId or agent, not both')
      }
      // `tail` bounds one agent's activity (status/roster with `agent`) or the
      // newest roster rows (roster without `agent`). `status` without `agent`
      // renders the dashboard, which has no tail to bound, so reject the
      // combination instead of silently dropping the argument.
      if (args.tail !== undefined && args.view === INSPECT_VIEW.status && args.agent === undefined) {
        throw new TowerToolError(
          'invalid-argument',
          'tower_inspect view "status" takes tail only with agent; pass agent, use the roster view, or omit tail',
        )
      }
      if (args.tail !== undefined && !AGENT_VIEWS.has(args.view)) {
        throw new TowerToolError('invalid-argument', `tower_inspect tail is available with view "status" or "roster"`)
      }
      if (args.tail !== undefined && (!Number.isInteger(args.tail) || args.tail < 1 || args.tail > 50)) {
        throw new TowerToolError('invalid-argument', 'tower_inspect tail must be an integer between 1 and 50')
      }
    },
    async execute(args, exec, actor) {
      const view = args.view
      let value
      if (view === INSPECT_VIEW.status) value = await runStatusView(ctx, args, exec, deps)
      else if (view === INSPECT_VIEW.roster) value = await runRosterView(ctx, args, exec, deps)
      else if (view === INSPECT_VIEW.diff) value = await runDiffView(args, exec, actor, deps)
      else if (view === INSPECT_VIEW.preflight) value = await runPreflightView(ctx, args, exec, deps)
      else value = await runDoctorView(ctx, args, exec, deps)
      return { ...(value && typeof value === 'object' ? value : {}), view }
    },
  })
}
