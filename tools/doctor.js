// tower_doctor: read-only health check.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { DoctorInput } from '../domain/contracts/tool-inputs/index.js'
import { DOCTOR_STATUS } from '../domain/vocabulary.js'

/**
 * The config the degraded doctor runs against. The profile layer is used only
 * while it still resolves; a live `.volatile()` write can invalidate it after
 * `apply()`, and calling runtimeConfig() then would throw inside the fallback.
 * The repository layer is omitted because it is the layer that failed. Never
 * throws: the report must describe the broken config, not the repair.
 *
 * @param {() => any} runtimeConfig
 * @param {(raw: any) => any} resolveTowerConfig
 */
function diagnosticConfig(runtimeConfig, resolveTowerConfig) {
  let base
  try {
    base = runtimeConfig()
  } catch {
    base = resolveTowerConfig({})
  }
  return { ...base, configPath: null, repoConfigPresent: false }
}

/**
 * Replace the doctor's own `config` row with the resolution failure. The normal
 * row only reports whether a repo config file is present; when resolution
 * failed that is misleading, and two `config` rows would make the report
 * ambiguous.
 *
 * @param {any[]} checks
 * @param {string} detail
 */
function configFailureChecks(checks, detail) {
  const failure = {
    id: 'config',
    status: DOCTOR_STATUS.fail,
    detail,
    action: 'repair the config named in the detail (profile config or <git-common-dir>/dsh-tower/config.json), then re-run tower_doctor',
  }
  const list = Array.isArray(checks) ? checks.slice() : []
  const at = list.findIndex((entry) => entry?.id === 'config')
  if (at === -1) return [...list, failure]
  list[at] = failure
  return list
}

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, createTower: any, resolveRepo: any, runtimeConfig: () => any, resolveTowerConfig: (raw: any) => any, isConfigResolutionError: (error: any) => boolean, runDoctor: any, surface?: () => { tools?: number } }} deps
 */
export function registerDoctorTool(ctx, deps) {
  const { define, createTower, resolveRepo, runtimeConfig, resolveTowerConfig, isConfigResolutionError, runDoctor } = deps
  define(ctx, {
    name: 'tower_doctor',
    description:
'Read-only\ environment\ and\ repository\ health\ check:\ the\ concept-budget\ surface\ \(config\ keys/sections/tools\),\ git,\ state\ schema,\ case-sensitivity\ detection\ \(caseInsensitive\ and\ the\ active\ scope\ comparison\ mode\),\ config,\ presets/subagents/HMR,\ the\ state\ lock\ age/heartbeat\ freshness,\ the\ repo-scoped\ git\ lock\ holder\ \(gitLock:\ \{held,pid,phase,heldMs\}\),\ workspace\ lock,\ roster\ staleness,\ worktree\ ownership,\ test\ discovery,\ leases,\ and\ the\ terminal-mission\ archive\ \(count,\ bytes,\ years,\ unreadable\ diagnostics\ and\ the\ configured\ afterDays/maxMissions\ policy\)\.\ Returns\ checks\ with\ pass/warn/fail,\ state-lock\ and\ git-lock\ reports\ and\ an\ environment\ contract\.\ Never\ writes\ state\ and\ never\ probes\ the\ filesystem\.',
    parameters: DoctorInput,
    output: output(SCHEMAS.doctor),
    // F41: a config-resolution failure must not fail the call in the tool-registry
    // open path. The public row declares the config-diagnostic contract (see
    // host/authorization.js), so an unresolved profile/repo config reaches this
    // handler, which opens the repository read-only with code defaults and
    // reports the failure as a failed `config` check instead.
    async execute(args, exec) {
      let tower
      let configError = null
      try {
        tower = await deps.openTower(args.repoRoot)
      } catch (error) {
        if (!isConfigResolutionError(error)) throw error
        configError = String(error?.message ?? error)
        const repo = await resolveRepo(args.repoRoot)
        tower = createTower(repo, diagnosticConfig(runtimeConfig, resolveTowerConfig))
      }
      const report = await runDoctor(/** @type {any} */ ({ tower, ctx, agent: exec.agent, surface: deps.surface?.() }))
      if (!configError) return report
      return {
        ...report,
        ok: false,
        configError,
        checks: configFailureChecks(report.checks, configError),
      }
    },
  })
}
