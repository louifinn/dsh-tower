// tower_doctor: read-only health check.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { DoctorInput } from '../domain/contracts/tool-inputs/index.js'
import { DOCTOR_STATUS } from '../domain/vocabulary.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, createTower: any, resolveRepo: any, runtimeConfig: any, runDoctor: any }} deps
 */
export function registerDoctorTool(ctx, deps) {
  const { define, createTower, resolveRepo, runtimeConfig, runDoctor } = deps
  define(ctx, {
    name: 'tower_doctor',
    description:
'Read-only\ environment\ and\ repository\ health\ check:\ git,\ state\ schema,\ case-sensitivity\ detection\ \(caseInsensitive\ and\ the\ active\ scope\ comparison\ mode\),\ config,\ presets/subagents/HMR,\ the\ state\ lock\ age/heartbeat\ freshness,\ the\ repo-scoped\ git\ lock\ holder\ \(gitLock:\ \{held,pid,phase,heldMs\}\),\ workspace\ lock,\ roster\ staleness,\ worktree\ ownership,\ test\ discovery,\ leases,\ and\ the\ terminal-mission\ archive\ \(count,\ bytes,\ years,\ unreadable\ diagnostics\ and\ the\ configured\ afterDays/maxMissions\ policy\)\.\ Returns\ checks\ with\ pass/warn/fail,\ state-lock\ and\ git-lock\ reports\ and\ an\ environment\ contract\.\ Never\ writes\ state\ and\ never\ probes\ the\ filesystem\.',
    parameters: DoctorInput,
    output: output(SCHEMAS.doctor),
    async execute(args, exec) {
      let tower
      let configError = null
      try {
        tower = await deps.openTower(args.repoRoot)
      } catch (error) {
        const message = String(error?.message ?? error)
        if (error?.code !== 'config-invalid' && error?.code !== 'config-unknown-key') throw error
        configError = message
        const repo = await resolveRepo(args.repoRoot)
        tower = deps.createTower(repo, { ...runtimeConfig(), configPath: null, repoConfigPresent: true })
      }
      const report = await runDoctor(/** @type {any} */ ({ tower, ctx, agent: exec.agent }))
      if (!configError) return report
      return {
        ...report,
        ok: false,
        checks: [
          {
            id: 'config',
            status: DOCTOR_STATUS.fail,
            detail: configError,
            fix: 'repair <git-common-dir>/dsh-tower/config.json and re-run tower_doctor',
          },
          ...(report.checks ?? []),
        ],
      }
    },
  })
}
