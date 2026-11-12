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
export const INSPECT_DESCRIPTION =
  'Read-only Tower views: status (dashboard or one mission), roster (live agent activity), diff (mission branch patch), preflight (merge gate blockers and warnings), doctor (environment health). missionId selects a mission for diff/preflight. Never writes state or git.'

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
    },
    output: output(SCHEMAS.inspect),
    validateArgs(args) {
      if (!INSPECT_VIEWS.includes(args.view)) {
        throw new TowerToolError('invalid-argument', `tower_inspect view must be one of ${INSPECT_VIEWS.join(', ')}`)
      }
      if (MISSION_VIEWS.has(args.view) && !(typeof args.missionId === 'string' && args.missionId.trim())) {
        throw new TowerToolError('invalid-argument', `tower_inspect view "${args.view}" requires missionId (alias: id)`)
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
