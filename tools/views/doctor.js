// tower_inspect view: doctor — read-only health check.
import { SCHEMAS, output } from '../../domain/contracts/outputs.js'
import { DoctorInput } from '../../domain/contracts/tool-inputs/index.js'
import { DOCTOR_STATUS } from '../../domain/vocabulary.js'
import { doctorProjection } from '../../domain/read/views.js'
import { summarizeOpenReviewNotes } from '../../domain/missions/review.js'

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
    action: 'repair the config named in the detail (profile config or <git-common-dir>/dsh-tower/config.json), then re-run tower_inspect with view: "doctor"',
  }
  const list = Array.isArray(checks) ? checks.slice() : []
  const at = list.findIndex((entry) => entry?.id === 'config')
  if (at === -1) return [...list, failure]
  list[at] = failure
  return list
}

/**
 * #221: open review notes are release-prep work, never a gate. The row warns
 * while a note is open and passes when every review row is note-free; it never
 * reports `fail`, so `ok` can never depend on a note. Aggregation is pure and
 * bounded (domain/missions/review.js), and an unreadable state simply omits the
 * row: the existing `state` check already reports that failure.
 *
 * @param {any} report
 * @param {any} tower
 */
async function withReviewNotes(report, tower) {
  let state
  try {
    state = await tower.load()
  } catch {
    return report
  }
  const { total, missions, sample } = summarizeOpenReviewNotes(state?.reviews)
  const row =
    total === 0
      ? { id: 'review-notes', status: DOCTOR_STATUS.pass, detail: 'no open review notes' }
      : {
          id: 'review-notes',
          status: DOCTOR_STATUS.warn,
          detail: `${total} open review note${total === 1 ? '' : 's'} on ${missions.join(', ')} (${sample}); notes never block a merge`,
          action: 'fold them at release prep with tower_mission fold_notes:true (single-mission form), or address them in a later round',
        }
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const at = checks.findIndex((entry) => entry?.id === 'state')
  return { ...report, checks: at === -1 ? [...checks, row] : [...checks.slice(0, at + 1), row, ...checks.slice(at + 1)] }
}

/**
 * @param {any} ctx
 * @param {{ define: import('../../types/index.js').DefineTool, openTower: any, createTower: any, resolveRepo: any, runtimeConfig: () => any, resolveTowerConfig: (raw: any) => any, isConfigResolutionError: (error: any) => boolean, runDoctor: any, surface?: () => { tools?: number } }} deps
 */
export async function runDoctorView(ctx, args, exec, deps) {
  const { createTower, resolveRepo, runtimeConfig, resolveTowerConfig, isConfigResolutionError, runDoctor } = deps
  {
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
      const noted = await withReviewNotes(report, tower)
      const merged = configError
        ? {
            ...noted,
            ok: false,
            configError,
            checks: configFailureChecks(noted.checks, configError),
          }
        : noted
      // #211: projections are opt-in; the default report is byte-for-byte the
      // full diagnostic.
      return doctorProjection(merged, { checks: args.checks === true, compact: args.compact === true })
  }
}
