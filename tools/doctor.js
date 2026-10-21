// tower_doctor: read-only health check.
import { Tower } from '../app/tower.js'
import { resolveRepo } from '../lib/git.js'
import { runtimeConfig } from '../lib/config.js'
import { runDoctor } from '../lib/doctor.js'
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { DoctorInput } from '../domain/contracts/tool-inputs/index.js'

/**
 * @param {any} ctx
 * @param {import('../types/index.js').DefineTool} define
 */
export function registerDoctorTool(ctx, define) {
  define(ctx, {
    name: 'tower_doctor',
    description:
      'Read-only environment and repository health check: git, state schema, config, presets/subagents/HMR, workspace lock, roster staleness, worktree ownership, test discovery, leases. Returns checks with pass/warn/fail and an environment contract. Never writes state.',
    parameters: DoctorInput,
    output: output(SCHEMAS.doctor),
    async execute(args, exec) {
      let tower
      let configError = null
      try {
        tower = await Tower.open(args.repoRoot)
      } catch (error) {
        const message = String(error?.message ?? error)
        if (error?.code !== 'config-invalid' && error?.code !== 'config-unknown-key') throw error
        configError = message
        const repo = await resolveRepo(args.repoRoot)
        tower = new Tower(repo, { ...runtimeConfig(), configPath: null, repoConfigPresent: true })
      }
      const report = await runDoctor(/** @type {any} */ ({ tower, ctx, agent: exec.agent }))
      if (!configError) return report
      return {
        ...report,
        ok: false,
        checks: [
          {
            id: 'config',
            status: 'fail',
            detail: configError,
            fix: 'repair <git-common-dir>/dsh-tower/config.json and re-run tower_doctor',
          },
          ...(report.checks ?? []),
        ],
      }
    },
  })
}
