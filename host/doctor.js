// Read-only environment contract and health checks for a Tower repository.
import { execFile } from '../adapters/vcs-git.js'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fsp } from '../adapters/store-fs.js'
import { git } from '../adapters/git.js'
import { readStateLock, readGitLock, gitLockView } from '../adapters/store.js'
import { lockTiming } from '../adapters/persistence.js'
import { inspectArchive } from '../adapters/archive.js'
import { inspectStateVersion } from '../domain/state.js'
import { SCHEMA_VERSION } from '../domain/mission.js'
import { DEFAULT_MAX_REPORT_BYTES, completionReportBytes } from '../domain/missions/completion.js'
import { comparisonMode } from '../domain/scope.js'
import { configSurface } from '../domain/config/schema.js'
import { parseBaseline, surfaceLine, SURFACE_BASELINE_FILE } from '../domain/surface.js'
import { assessHostVersion, detectHostVersion, readCompatibility } from './compatibility.js'
import { profileConfig } from './config.js'
import { inspectWorkspaceLock } from '../adapters/workspaceLock.js'
import { componentReport, componentSummary } from './capability-registry.js'

const execFileAsync = promisify(execFile)
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Read the committed concept-budget baseline read-only; null when absent. */
async function readSurfaceBaseline() {
  try {
    return parseBaseline(await fsp.readFile(path.join(PACKAGE_ROOT, SURFACE_BASELINE_FILE), 'utf8'))
  } catch {
    return null
  }
}

async function exists(target) {
  try {
    await fsp.stat(target)
    return true
  } catch {
    return false
  }
}

async function gitVersion() {
  try {
    const { stdout } = await execFileAsync('git', ['--version'], { windowsHide: true })
    return String(stdout).trim()
  } catch {
    return null
  }
}

function check(id, status, detail, action) {
  return { id, status, detail, ...(action ? { action } : {}) }
}

/** Render a lock age the same way the state-lock checker does. */
function durationText(ms) {
  if (!Number.isFinite(ms)) return 'an unknown duration'
  return `${Math.max(0, Math.round(ms / 1000))} s`
}

/** Read the on-disk state version without loading, migrating, or locking. */
async function inspectStateSchema(paths) {
  try {
    const text = await fsp.readFile(paths.state, 'utf8')
    return inspectStateVersion(JSON.parse(text), paths.state)
  } catch (error) {
    return {
      status: 'invalid',
      currentVersion: null,
      supportedVersion: SCHEMA_VERSION,
      migrations: [],
      message: `tower state could not be inspected: ${String(error?.message ?? error)}`,
    }
  }
}

/**
 * Report the on-disk schema version and the migration that a write would apply.
 * Doctor never migrates: a read-only call must leave the file byte-identical.
 */
function stateSchemaReport(info) {
  const stateSchema = {
    currentVersion: info.currentVersion,
    supportedVersion: info.supportedVersion,
    migrations: info.migrations ?? [],
    status: info.status,
  }
  if (info.status === 'current') {
    return {
      stateSchema,
      check: check('state-schema', 'pass', `schemaVersion ${info.currentVersion} is current`),
    }
  }
  if (info.status === 'migratable') {
    return {
      stateSchema,
      check: check(
        'state-schema',
        'warn',
        `schemaVersion ${info.currentVersion} is older than ${info.supportedVersion}; the next locked write migrates it and keeps state.json.v${info.currentVersion}.bak`,
        'a write tool applies the migration; a read-only tool only migrates in memory',
      ),
    }
  }
  if (info.status === 'newer') {
    return {
      stateSchema,
      check: check(
        'state-schema',
        'fail',
        `schemaVersion ${info.currentVersion} is newer than this build supports (${info.supportedVersion}); state was written by a newer dsh-tower`,
        'upgrade dsh-tower; this build refuses to downgrade state.json',
      ),
    }
  }
  if (info.status === 'unmigratable') {
    return {
      stateSchema,
      check: check(
        'state-schema',
        'fail',
        `schemaVersion ${info.currentVersion} has no migration to ${info.supportedVersion}`,
        'restore a state.json written by a supported dsh-tower; this build will not guess at an unknown schema',
      ),
    }
  }
  return {
    stateSchema,
    check: check(
      'state-schema',
      'fail',
      info.message ?? 'state schemaVersion is unreadable',
      'restore a state.json this build can read, or run tower_init for a new repository',
    ),
  }
}

/** Run every read-only diagnostic; never writes state or takes the state lock. */
export async function runDoctor({ tower, ctx, agent, hostVersion, compatibilityFile, loaderRows, surface }) {
  const checks = []
  let reportsReport = null
  let stateLockReport = null
  const version = await gitVersion()
  checks.push(version ? check('git', 'pass', version) : check('git', 'fail', 'git is not available', 'install Git and retry'))

  const detectedHost = hostVersion ?? detectHostVersion(ctx)
  const compatibilityRows = readCompatibility(compatibilityFile)
  const hostAssessment = assessHostVersion(detectedHost, compatibilityRows)
  checks.push(
    check(
      'host-version',
      hostAssessment.verdict === 'verified' ? 'pass' : 'warn',
      detectedHost
        ? `${detectedHost}: ${hostAssessment.detail}`
        : `unknown host version; ${hostAssessment.detail}. Include host version + COMPATIBILITY.md row in bug reports.`,
      'see COMPATIBILITY.md for verified host builds',
    ),
  )

  const rows = Array.isArray(loaderRows)
    ? loaderRows
    : (() => {
        try {
          const loader = ctx?.get?.('loader') ?? ctx?.loader
          const source = loader?.entries ?? loader?.rows ?? loader?.store?.entries
          if (Array.isArray(source)) return source
          if (source && typeof source === 'object') return Object.values(source)
        } catch {
          // loader inventory is optional
        }
        return null
      })()
  if (rows === null) {
    checks.push(check('loader-conflicts', 'warn', 'loader inventory unavailable; cannot detect co-installed Tower packages'))
  } else {
    const towerRows = rows.filter((row) => row && row.name === 'dsh-tower')
    const foreign = towerRows.filter((row) => row.id !== 'tower')
    checks.push(
      towerRows.length > 1 || foreign.length > 0
        ? check(
            'loader-conflicts',
            'fail',
            `another loader row resolves to "dsh-tower" (${towerRows.map((row) => row.id ?? '?').join(', ')}); uninstall the conflicting dsh-plugins-tower row`,
            'see README "Known conflicts"',
          )
        : check('loader-conflicts', 'pass', 'no conflicting dsh-tower loader rows'),
    )
  }

  checks.push(check('repository', 'pass', `${tower.root} (common ${tower.commonDir})`))
  // The repo-scoped git mutex can legally be held for a whole merge (15 min by
  // default). Report the holder so a stalled tower has a visible cause (#93).
  const gitLock = gitLockView(await readGitLock(tower.paths))
  checks.push(
    gitLock.held
      ? check(
          'git-lock',
          'warn',
          `held by pid ${gitLock.pid ?? 'unknown'}${gitLock.phase ? ` (${gitLock.phase})` : ''} for ${durationText(gitLock.heldMs)}; the repo-scoped git mutex is busy`,
          'wait for the git mutation to finish; tower_status reports the same holder',
        )
      : check('git-lock', 'pass', 'free'),
  )
  const schemaInfo = await inspectStateSchema(tower.paths)
  let state = null
  try {
    state = await tower.load()
    checks.push(check('state', 'pass', `${tower.paths.state} revision ${state.revision}`))
    checks.push(
      state.towerAgentId
        ? check('tower-owner', 'pass', `bound to ${String(state.towerAgentId)}`)
        : check('tower-owner', 'warn', 'state has no towerAgentId; write tools will fail closed', 'run tower_init with the restored session to re-claim ownership'),
    )
  } catch (error) {
    checks.push(check('state', 'fail', String(error?.message ?? error), 'run tower_init or restore the state file'))
  }
  const schemaReport = stateSchemaReport(schemaInfo)
  checks.push(schemaReport.check)

  // Scope matching is only as good as the detected filesystem mode (#90).
  // Doctor never probes: a read-only call must not create files. A legacy state
  // that has not been re-initialized therefore reports the safe exact default.
  const caseInsensitive =
    state && (state.caseInsensitive === true || state.caseInsensitive === false) ? state.caseInsensitive : null
  const comparison = comparisonMode(caseInsensitive)
  checks.push(
    caseInsensitive === null
      ? check(
          'case-mode',
          'warn',
          `caseInsensitive: not detected; scope matching uses ${comparison} comparison`,
          'run tower_init on a writable checkout to probe and record the filesystem mode',
        )
      : check(
          'case-mode',
          'pass',
          `caseInsensitive: ${caseInsensitive}; scope matching uses ${comparison} comparison`,
        ),
  )

  const config = tower.config ?? {}
  const profile = profileConfig()
  const staleDefaults = []
  if (profile.review && profile.review.requireReview === undefined) {
    staleDefaults.push('review.requireReview now defaults to false (2.0.3)')
  }
  if (profile.mode && profile.mode.allowAgentControl === undefined) {
    staleDefaults.push('mode.allowAgentControl now defaults to true (2.0.4)')
  }
  checks.push(
    staleDefaults.length > 0
      ? check('default-reversals', 'warn', staleDefaults.join('; '), 'pin the key explicitly in the profile if the old posture is required')
      : check('default-reversals', 'pass', 'profile does not rely on a reversed default'),
  )
  checks.push(
    check(
      'config',
      config.configPath && config.repoConfigPresent ? 'pass' : 'warn',
      config.repoConfigPresent ? `repo config ${config.configPath}` : `repo config not present (${config.configPath ?? 'unknown'})`,
      'optional: add <git-common-dir>/dsh-tower/config.json',
    ),
  )
  // #84: report the concept-budget surface instead of implying it. The counts
  // are the live schema/tool surface; the date is the committed baseline, so a
  // reader sees both the number and the decision it was frozen at.
  const configCounts = configSurface()
  const baseline = await readSurfaceBaseline()
  const toolCount = Number.isInteger(surface?.tools) ? surface.tools : null
  const surfaceCounts = {
    configKeys: configCounts.count,
    sections: configCounts.sections.length,
    tools: toolCount,
  }
  const surfaceReport = {
    ...surfaceCounts,
    baselineDate: baseline?.date ?? null,
    line: surfaceLine(surfaceCounts),
  }
  checks.push(
    toolCount === null
      ? check('surface', 'warn', `${surfaceReport.line} (tool count unavailable; pass the registered surface)`)
      : check(
          'surface',
          'pass',
          `${surfaceReport.line}${baseline?.date ? ` (baseline ${baseline.date})` : ''}`,
          baseline?.date ? undefined : `commit ${SURFACE_BASELINE_FILE} so growth is compared against a decision`,
        ),
  )
  const presets = ctx.get?.('agentPresets')
  const reviewerRequired = config.review?.requireReview === true
  if (presets && typeof presets.list === 'function') {
    try {
      const available = (await presets.list()).map((entry) => String(entry.id))
      const worker = config.spawn?.workerPreset ?? 'tower-worker'
      const reviewer = config.spawn?.reviewerPreset ?? 'tower-reviewer'
      const required = reviewerRequired ? [worker, reviewer] : [worker]
      const missing = required.filter((id) => !available.includes(id))
      // #121: `preset-tower-reviewer` is a conditional component. Its off state
      // is supported while review.requireReview is false; with the gate on it is
      // a fail, because no independent review can be dispatched.
      if (missing.length === 0) {
        const reviewerNote = available.includes(reviewer)
          ? `reviewer=${reviewer}`
          : `reviewer=${reviewer} (disabled by component preset-tower-reviewer)`
        checks.push(check('presets', 'pass', `worker=${worker} ${reviewerNote}`))
      } else {
        checks.push(
          check(
            'presets',
            'fail',
            `missing preset(s): ${missing.join(', ')}${reviewerRequired && missing.includes(reviewer) ? ' (review.requireReview is true, so preset-tower-reviewer may not be off)' : ''}`,
            'enable the Tower preset component and retry',
          ),
        )
      }
    } catch (error) {
      checks.push(check('presets', 'warn', `preset registry unavailable: ${String(error?.message ?? error)}`))
    }
  } else {
    checks.push(check('presets', 'warn', 'agentPresets service is unavailable'))
  }

  // #121: the optional component rows are a diagnostic fact. A disabled row is
  // reported with the exact "disabled by component <id>" reason rather than
  // disappearing silently from the tool surface.
  const components = await componentReport(ctx)
  checks.push(
    components.disabled.length > 0
      ? check('components', 'warn', componentSummary(components), 'enable the reported row in the plugin page and restart DSH')
      : check('components', 'pass', componentSummary(components)),
  )

  const subagents = ctx.get?.('subagents')
  checks.push(subagents ? check('subagents', 'pass', 'service mounted') : check('subagents', 'fail', 'subagents service is unavailable', 'enable the subagent bundle'))
  const hmr = ctx.get?.('hmr')
  checks.push(hmr ? check('hmr', 'pass', 'service mounted') : check('hmr', 'warn', 'HMR is not mounted; /tower reload is unavailable'))

  if (state) {
    const lock = await readStateLock(tower.paths)
    const timing = lockTiming(lock.record)
    stateLockReport = {
      held: Boolean(lock.record),
      pid: lock.record?.pid ?? null,
      startedAt: lock.record?.startedAt ?? null,
      at: lock.record?.at ?? null,
      alive: lock.alive,
      ageMs: timing.ageMs,
      heartbeatAgeMs: timing.heartbeatAgeMs,
      staleAfterMs: timing.staleAfterMs,
      stale: timing.stale,
    }
    // The PID alone cannot distinguish a live writer from a recycled PID
    // (#92); report the heartbeat age so a stuck tower is diagnosable without
    // reading the file.
    const heartbeatText =
      timing.heartbeatAgeMs === null
        ? 'no heartbeat timestamp'
        : `last heartbeat ${timing.heartbeatAgeMs}ms ago (stale after ${timing.staleAfterMs}ms)`
    checks.push(
      !lock.record
        ? check('state-lock', 'pass', 'no state lock file')
        : lock.alive === false
          ? check(
              'state-lock',
              'warn',
              `stale state lock (pid ${lock.record.pid ?? 'unknown'} is gone; ${heartbeatText}); the next mutation reclaims it atomically`,
            )
          : timing.stale
            ? check(
                'state-lock',
                'warn',
                `state lock pid ${lock.record.pid ?? 'unknown'} is alive but silent (${heartbeatText}); the next mutation reclaims it after byte verification, or tower_recover clear-stale-lock force:true moves it to a backup`,
              )
            : check(
                'state-lock',
                'warn',
                `state lock held by pid ${lock.record.pid ?? 'unknown'}; ${heartbeatText}; retry after it finishes`,
              ),
    )
    const lockDir = path.join(tower.commonDir, 'dsh-tower', 'tower.lock')
    try {
      const lock = await inspectWorkspaceLock(tower.commonDir, {
        staleMs: Number(config.mode?.workspaceStaleMs) || 300000,
      })
      checks.push(lock.held ? check('workspace-lock', lock.stale ? 'warn' : 'pass', `held by ${lock.holder?.sessionId ?? 'unknown'}`) : check('workspace-lock', 'pass', 'free'))
    } catch {
      checks.push(check('workspace-lock', 'warn', `lock file ${lockDir} could not be inspected`))
    }

    const live = (state.roster ?? []).filter((entry) => !['retired', 'failed', 'interrupted', 'missing', 'stale', 'inactive'].includes(entry.state))
    checks.push(
      live.length > 0
        ? check('roster', 'pass', `${live.length} live roster entr${live.length === 1 ? 'y' : 'ies'}`)
        : check('roster', 'pass', 'no live workers'),
    )

    let missingWorktrees = 0
    let dirtyWorktrees = 0
    let removedWorktrees = 0
    for (const mission of state.missions ?? []) {
      if (!mission.worktree) continue
      if (mission.worktreeRemovedAt) {
        removedWorktrees += 1
        continue
      }
      try {
        await tower.assertWorktree(mission.worktree)
        if (await exists(mission.worktree.path)) {
          const dirty = (await git(mission.worktree.path, ['status', '--porcelain'])).trim()
          if (dirty) dirtyWorktrees += 1
        } else {
          missingWorktrees += 1
        }
      } catch {
        missingWorktrees += 1
      }
    }
    const removedNote = removedWorktrees > 0 ? ` (${removedWorktrees} removed by teardown)` : ''
    checks.push(
      missingWorktrees > 0
        ? check('worktrees', 'fail', `${missingWorktrees} mission worktree(s) are missing or invalid${removedNote}`, 'inspect tower_status, restore the worktree/branch, then re-run tower_doctor')
        : dirtyWorktrees > 0
          ? check('worktrees', 'warn', `${dirtyWorktrees} worktree(s) have uncommitted changes${removedNote}`)
          : check('worktrees', 'pass', `all registered worktrees are valid${removedNote}`),
    )

    const testConfigured = state.missions?.some((mission) => mission.testRuns !== undefined)
    const testsDisabled =
      config.tests?.enabled === false || components.disabled.some((entry) => entry.id === 'tower-tests')
    checks.push(
      check(
        'tests',
        testsDisabled ? 'warn' : 'pass',
        testsDisabled
          ? `test discovery disabled${config.tests?.enabled === false ? ' (tests.enabled:false)' : ' (disabled by component tower-tests)'}`
          : `admission=${config.tests?.admission ?? 'complete'} timeoutMs=${config.tests?.timeoutMs ?? 60000}${testConfigured ? '; receipts present' : ''}`,
      ),
    )
    checks.push(check('legacy', 'pass', `${state.legacySnapshots?.length ?? 0} legacy snapshot(s)`))
    checks.push(check('batches', 'pass', `${state.batches?.length ?? 0} batch(es)`))

    // Completion reports are the largest model-supplied strings in state.json;
    // report the biggest one so growth is visible before it becomes a problem.
    const reportSizes = (state.missions ?? [])
      .map((mission) => ({ missionId: mission.id, bytes: completionReportBytes(mission.completionReport) }))
      .filter((entry) => entry.bytes !== null)
    const largestReport = reportSizes.reduce(
      (best, entry) => (best === null || entry.bytes > best.bytes ? entry : best),
      null,
    )
    const reportCap = Number(tower.config?.gates?.maxReportBytes) || DEFAULT_MAX_REPORT_BYTES
    reportsReport = { count: reportSizes.length, largest: largestReport, capBytes: reportCap }
    checks.push(
      largestReport
        ? check(
            'reports',
            largestReport.bytes > reportCap ? 'warn' : 'pass',
            `${reportSizes.length} completion report(s); largest ${largestReport.bytes} B on ${largestReport.missionId} (cap ${reportCap} B)`,
            largestReport.bytes > reportCap
              ? 'existing reports predate the cap; reads are unchanged and no rewrite happens'
              : undefined,
          )
        : check('reports', 'pass', `no completion reports (cap ${reportCap} B)`),
    )
  }

  try {
    const { inspectLeases } = await import('../adapters/leases.js')
    const leases = await inspectLeases(tower.commonDir)
    checks.push(check('leases', leases.leases?.length ? 'warn' : 'pass', `${leases.leases?.length ?? 0} active lease(s)`))
  } catch (error) {
    const corrupt = error?.code === 'state-corrupt'
    checks.push(
      check(
        'leases',
        corrupt ? 'fail' : 'warn',
        corrupt ? `lease ledger is corrupt: ${String(error?.message ?? error)}` : 'lease module unavailable',
        corrupt ? 'inspect <git-common-dir>/dsh-tower/leases.json and repair or remove it' : undefined,
      ),
    )
  }

  try {
    const text = await fsp.readFile(path.join(tower.paths.dir, 'lock-holds.jsonl'), 'utf8')
    // These percentiles are about the state lock. Git-mutex holds are logged
    // too (kind: 'git' / the pre-#93 phase: 'git' form) and can legitimately
    // span a merge, so they must not be counted as slow state mutations.
    const samples = text
      .split('\n')
      .filter(Boolean)
      .slice(-200)
      .map((line) => JSON.parse(line))
      .filter((hold) => hold.kind !== 'git' && hold.phase !== 'git')
      .map((hold) => hold.ms)
      .filter((ms) => Number.isFinite(ms))
      .sort((a, b) => a - b)
    if (samples.length === 0) {
      checks.push(check('lock-holds', 'pass', 'no lock-hold samples yet'))
    } else {
      const p = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]
      const p50 = p(0.5)
      const p95 = p(0.95)
      checks.push(
        check(
          'lock-holds',
          p95 > 1000 ? 'warn' : 'pass',
          `${samples.length} sample(s): p50 ${p50}ms, p95 ${p95}ms`,
          p95 > 1000 ? 'a mutation is holding the state lock across slow work; inspect the activity/lock-holds log' : undefined,
        ),
      )
    }
  } catch {
    checks.push(check('lock-holds', 'pass', 'no lock-hold samples yet'))
  }

  // Archive inventory (#73): size, count and the configured trigger policy.
  // A missing directory is a healthy empty archive; a corrupt file is a warn.
  const archiveInventory = await inspectArchive(tower.paths)
  const stateBytes = await fsp.stat(tower.paths.state).then((stat) => stat.size).catch(() => null)
  const archivePolicy = config.archive ?? {}
  const policyText = `afterDays=${archivePolicy.afterDays ?? 30} maxMissions=${archivePolicy.maxMissions ?? 100}${archivePolicy.enabled === false ? ' disabled' : ''}`
  if (!archiveInventory.exists) {
    checks.push(check('archive', 'pass', `no archived missions; ${policyText}`))
  } else if (archiveInventory.unreadable.length > 0) {
    checks.push(
      check(
        'archive',
        'warn',
        `${archiveInventory.missions} archived mission(s), ${archiveInventory.bytes} bytes; unreadable: ${archiveInventory.unreadable[0]}`,
        'inspect <git-common-dir>/dsh-tower/archive/ and repair or move the corrupt file; archiving is paused until it is readable',
      ),
    )
  } else {
    checks.push(
      check(
        'archive',
        'pass',
        `${archiveInventory.missions} archived mission(s) in ${archiveInventory.years.length} year file(s), ${archiveInventory.bytes} bytes; ${policyText}`,
      ),
    )
  }

  const failed = checks.filter((item) => item.status === 'fail').length
  return {
    ok: failed === 0,
    checks,
    stateLock: stateLockReport,
    gitLock,
    stateSchema: schemaReport.stateSchema,
// reports (from #89) and archive (from #73) are both kept
    reports: reportsReport,
    surface: surfaceReport,
    components,
    archive: {
      missions: state ? state.missions.length : null,
      archivedMissions: archiveInventory.missions,
      stateBytes,
      archiveBytes: archiveInventory.bytes,
      dir: archiveInventory.dir,
      years: archiveInventory.years,
      files: archiveInventory.files.length,
      unreadable: archiveInventory.unreadable,
      policy: {
        enabled: archivePolicy.enabled !== false,
        afterDays: archivePolicy.afterDays ?? 30,
        maxMissions: archivePolicy.maxMissions ?? 100,
      },
    },
    environmentContract: {
      platform: process.platform,
      gitVersion: version,
      repoRoot: tower.root,
      commonDir: tower.commonDir,
      stateDir: tower.paths.dir,
      caseInsensitive,
      comparisonMode: comparison,
      gitTimeoutMs: Number(tower.config.git?.timeoutMs) || 15000,
      mergeTimeoutMs: Number(tower.config.merge?.timeoutMs) || 900000,
      testsAdmission: tower.config.tests?.admission ?? 'off',
      hostVersion: detectedHost,
      hostCompatibility: hostAssessment.verdict,
      hostCompatibilityDetail: hostAssessment.detail,
    },
    mode: agent ? 'ready' : 'unknown',
  }
}
