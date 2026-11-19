// Read-only environment contract and health checks for a Tower repository.
import { execFile } from '../adapters/vcs-git.js'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fsp } from '../adapters/store-fs.js'
import { git } from '../adapters/git.js'
import { inspectActivityLog, readStateLock, readStateCommitLock, readGitLock, gitLockView } from '../adapters/store.js'
import { inspectArchive } from '../adapters/archive.js'
import { inspectStateVersion } from '../domain/state.js'
import { SCHEMA_VERSION } from '../domain/mission.js'
import { DEFAULT_MAX_REPORT_BYTES, completionReportBytes } from '../domain/missions/completion.js'
import { comparisonMode } from '../domain/scope.js'
import { isTerminal } from '../domain/shapes/index.js'
import { hasTestReceipts } from '../domain/evidence.js'
import { configSurface } from '../domain/config/schema.js'
import { reviewPolicyView, reviewRequired } from '../domain/integration/review.js'
import { parseBaseline, surfaceLine, SURFACE_BASELINE_FILE } from '../domain/surface.js'
import { assessHostVersion, diagnoseHostVersion, readCompatibility, resolveHostVersion } from './compatibility.js'
import { profileConfig } from './config.js'
import { readOwnership } from './ownership.js'
import { componentReport, componentSummary } from './capability-registry.js'
import { COMPONENT_ENABLE_HINTS, LEGACY_TOOL_REPLACEMENTS, isSubsystemRow } from './tool-profiles.js'
import {
  artifactAcceptanceCheck,
  commitLockFacts,
  foreignCapabilityCheck,
  loaderConflictCheck,
  orphanWorktreeCheck,
  readLoaderRows,
  stateLockFacts,
} from './doctor-acceptance.js'
import { ralphStanceDoctorFact } from './ralph-stance.js'

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

/** Terminality without the shape resolver's throw for an unknown kind. */
function isTerminalMission(mission) { try { return isTerminal(mission.kind, mission.status) } catch { return false } }

function check(id, status, detail, action) {
  return { id, status, detail, ...(action ? { action } : {}) }
}

/** #F69: name the preset row the reader sees, not the internal preset id. */
const presetLabel = (id) =>
  ({ 'tower-worker': 'Tower Worker preset', 'tower-reviewer': 'Tower Reviewer preset', 'tower-survey': 'Tower Survey preset', 'tower-survey-sandbox': 'Tower Survey Sandbox preset' }[id] ?? id)

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
      'restore a state.json this build can read, or initialize a new Tower repository',
    ),
  }
}

/** Run every read-only diagnostic; never writes state or takes the state lock. */
export async function runDoctor({ tower, ctx, agent, hostVersion, compatibilityFile, loaderRows, surface }) {
  const checks = []
  let reportsReport = null
  let stateLockReport = null
  let commitLockReport = null
  const version = await gitVersion()
  checks.push(version ? check('git', 'pass', version) : check('git', 'fail', 'git is not available', 'install Git and retry'))

  // #F65: an empty DSH_VERSION/DSH_HOST_VERSION is absent, not a version, and a
  // DSH_INSTALL_DIR inside app.asar is unreadable by ordinary fs. Resolve with
  // provenance, then let diagnoseHostVersion write the check and contract.
  const callerHostVersion = typeof hostVersion === 'string' && hostVersion.trim() ? hostVersion.trim() : null
  const hostReport = callerHostVersion
    ? { version: callerHostVersion, source: 'caller', authoritative: true, detail: `${callerHostVersion} was supplied to doctor by the caller`, probes: [], asar: null }
    : resolveHostVersion(ctx)
  const hostAssessment = assessHostVersion(hostReport.version, readCompatibility(compatibilityFile))
  const hostDiagnosis = diagnoseHostVersion(hostReport, hostAssessment)
  checks.push(check('host-version', hostDiagnosis.status, hostDiagnosis.detail, hostDiagnosis.action))

  const rows = Array.isArray(loaderRows)
    ? loaderRows
    : (() => {
        try {
          return readLoaderRows(ctx?.get?.('loader') ?? ctx?.loader)
        } catch {
          // loader inventory is optional
          return null
        }
      })()
  if (rows === null) {
    checks.push(check('loader-conflicts', 'warn', 'loader inventory unavailable; cannot detect co-installed Tower packages'))
  } else {
    checks.push(loaderConflictCheck(rows))
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
          'wait for the git mutation to finish; the Tower status report shows the same holder',
        )
      : check('git-lock', 'pass', 'free'),
  )
  const schemaInfo = await inspectStateSchema(tower.paths)
  let state = null
  /** @type {Awaited<ReturnType<typeof readOwnership>> | null} */
  let ownershipFacts = null
  /** @type {any} */
  let ownershipError = null
  try {
    state = await tower.load()
    checks.push(check('state', 'pass', `${tower.paths.state} revision ${state.revision}`))
    // One read of the same facts feeds both the tower-owner and workspace-lock
    // checks: doctor must describe the lock/roster a takeover would actually
    // see, and must not re-read either with a different rule.
    try {
      ownershipFacts = await readOwnership(tower, { caller: null, state })
    } catch (error) {
      ownershipError = error
    }
    if (!state.towerAgentId) {
      checks.push(check('tower-owner', 'warn', 'state has no towerAgentId; write tools will fail closed', 're-run repository initialization with the restored session to re-claim ownership'))
    } else if (!ownershipFacts) {
      checks.push(
        check(
          'tower-owner',
          'warn',
          `ownership facts could not be read: ${String(ownershipError?.message ?? ownershipError ?? 'unknown error')}`,
          'inspect the mode store and workspace lock files, then re-run the environment health check',
        ),
      )
    } else {
      const ownership = ownershipFacts.snapshot
      const corrupt = ownership.blockers.find((blocker) => blocker.code === 'mode-store-corrupt')
      const live = ownership.blockers.find((blocker) => blocker.code === 'owner-live')
      if (corrupt) {
        // A corrupt mode store makes every mode save fail and makes takeover
        // fail closed: report it as a failure, not as an inactive-looking owner.
        checks.push(check('tower-owner', 'fail', corrupt.detail, 'action' in corrupt ? corrupt.action : undefined))
      } else if (live) {
        checks.push(check('tower-owner', 'pass', `bound to ${ownership.owner}; Tower mode is active${ownership.ownerLock ? ' with a live workspace lock' : ''}`))
      } else {
        const busy = ownership.blockers.filter((blocker) => blocker.code === 'owner-busy').map((blocker) => blocker.detail)
        const workspaceLock = ownershipFacts.lock
        const detail = busy.length > 0
          ? `owner ${ownership.owner} appears inactive (Tower mode ${ownership.ownerMode}) but ${busy.join('; ')}`
          : `owner ${ownership.owner} appears inactive (Tower mode ${ownership.ownerMode}${workspaceLock?.held ? `, ${workspaceLock.stale ? 'stale' : 'live'} workspace lock` : ''})`
        checks.push(check(
          'tower-owner',
          'warn',
          detail,
          busy.length > 0
            ? 'stop the live roster agents or release the foreign workspace lock, then take over the repository (give a reason)'
            : 'in the new session, take over the repository (give a reason) to claim it without deleting its history',
        ))
      }
    }
  } catch (error) {
    checks.push(check('state', 'fail', String(error?.message ?? error), 'initialize the repository or restore the state file'))
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
          'initialize the repository on a writable checkout to probe and record the filesystem mode',
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
  // #M66: `review.mode` is the only review policy key now; the one-release
  // `review.requireReview` alias is removed and rejected at resolution. A
  // profile that names no mode relies on the default (optional), so say so
  // rather than letting a reader assume review is enforced.
  if (profile.review && profile.review.mode === undefined) {
    staleDefaults.push('review.mode defaults to optional')
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
      'optional: add the Tower config file under <git-common-dir>/dsh-tower/',
    ),
  )
  // #M76: the activity log is bounded by the store adapter. Report both the
  // policy and the live/rotated bytes so an unexpectedly large log has a
  // visible cause; a missing path is a fixture limitation, not a repo failure.
  const activityLog =
    typeof tower.paths.activity === 'string'
      ? await inspectActivityLog(tower.paths.activity, config.activity ?? {}).catch((error) => ({
          error: String(error?.message ?? error),
        }))
      : { error: 'activity log path is not available' }
  if ('error' in activityLog) {
    checks.push(check('activity-log', 'warn', `activity log could not be inspected: ${activityLog.error}`))
  } else {
    const segmentCount = activityLog.segments.length
    const rotation = activityLog.rotationEnabled
      ? `cap ${activityLog.maxBytes} B, retention ${activityLog.retention}`
      : 'rotation disabled (activity.maxBytes is 0)'
    checks.push(
      check(
        'activity-log',
        activityLog.rotationEnabled ? 'pass' : 'warn',
        `activity.jsonl ${activityLog.liveBytes} B live + ${segmentCount} rotated segment(s) ${activityLog.rotatedBytes} B (${rotation})`,
        activityLog.rotationEnabled
          ? undefined
          : 'raise the activity-log size cap above 0 in the profile or repository configuration to bound the log',
      ),
    )
  }
  // #M39: the resolved review mode is its own diagnostic fact. `off` is a
  // supported, intentional posture (not a degradation), so it is a pass whose
  // detail says exactly what is unavailable.
  const reviewPolicy = reviewPolicyView(config)
  checks.push(check('review', 'pass', reviewPolicy.detail))
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
  const reviewerRequired = reviewRequired(config)
  if (presets && typeof presets.list === 'function') {
    try {
      const available = (await presets.list()).map((entry) => String(entry.id))
      const worker = config.spawn?.workerPreset ?? 'tower-worker'
      const reviewer = config.spawn?.reviewerPreset ?? 'tower-reviewer'
      const required = reviewerRequired ? [worker, reviewer] : [worker]
      const missing = required.filter((id) => !available.includes(id))
      // #121/#M39: `preset-tower-reviewer` is a conditional component. Its off
      // state is supported while review is off or optional; with
      // `review.mode:required` it is a fail, because no independent review can
      // be dispatched.
      if (missing.length === 0) {
        const reviewerNote = available.includes(reviewer)
          ? `reviewer=${presetLabel(reviewer)}`
          : `reviewer=${presetLabel(reviewer)} (Tower Reviewer preset switched off in the plugin page)`
        checks.push(check('presets', 'pass', `worker=${presetLabel(worker)} ${reviewerNote}`))
      } else {
        const requiredNote =
          reviewerRequired && missing.includes(reviewer)
            ? ' (review before merging is required, so the Tower Reviewer preset may not be switched off)'
            : ''
        checks.push(
          check(
            'presets',
            'fail',
            `missing preset(s): ${missing.map(presetLabel).join(', ')}${requiredNote}`,
            'switch the missing preset row back on in the plugin page and restart DSH, or choose a registered preset on the plugin configuration form',
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
  // #163 Phase 5: a default-off subsystem is reported per row with the exact
  // enable step, so "off" never reads as "deleted". The same table is in
  // docs/reference/tools.md and docs/reference/component-surface.md.
  const subsystemRows = components.disabled
    .filter((entry) => isSubsystemRow(entry.id))
    .map((entry) => ({ id: entry.id, tool: COMPONENT_ENABLE_HINTS[entry.id]?.tool ?? null, enable: COMPONENT_ENABLE_HINTS[entry.id]?.enable ?? ('remove `disabled: true` from the ' + entry.id + ' row in cordis.patch.yml and restart DSH') }))
  checks.push(
    components.disabled.length > 0
      ? check(
          'components',
          'warn',
          componentSummary(components) + (subsystemRows.length > 0 ? '; ' + subsystemRows.map((entry) => entry.id + ' (' + (entry.tool ?? 'no tool') + ') is off, not deleted: ' + entry.enable).join('; ') : ''),
          'switch the row named in the detail back on in the plugin page (remove its disabled setting) and restart DSH',
        )
      : check('components', 'pass', componentSummary(components)),
  )

  // #163 Phase 5: an old tool name in mode.denyTools is not silently ignored.
  // The alias/deprecation path names the merged tool instead; a config that
  // still denies a removed name is reported here and by resolution warnings.
  const deniedTools = Array.isArray(config.mode?.denyTools) ? config.mode.denyTools.map(String) : []
  const legacyDenied = deniedTools.filter((name) => Object.hasOwn(LEGACY_TOOL_REPLACEMENTS, name))
  checks.push(
    legacyDenied.length > 0
      ? check(
          'deprecated-tool-names',
          'warn',
          'mode.denyTools names removed tools: ' + legacyDenied.map((name) => name + ' -> ' + LEGACY_TOOL_REPLACEMENTS[name]).join(', '),
          'replace each removed name with its merged tool in the config; the removed tool no longer exists, so the entry denies nothing',
        )
      : check('deprecated-tool-names', 'pass', 'mode.denyTools names no removed tool'),
  )

  // #131: `spawn.requireLease` is acquired through `tower_resource`, which belongs
  // to the tower-leases row. The runtime preconditions refuse this combination, so
  // the doctor reports it first and names both remedies instead of letting it
  // surface as a lease-busy from every spawn.
  const requiredLease = String(config.spawn?.requireLease ?? '').trim()
  if (requiredLease) {
    const leasesDisabled = components.disabled.some((entry) => entry.id === 'tower-leases')
    checks.push(
      leasesDisabled
        ? check(
            'spawn-lease',
            'fail',
            `A lease "${requiredLease}" is required before an execution agent starts, but Lease coordination is switched off in the plugin page, so no lease can be acquired`,
            'switch Lease coordination back on in the plugin page and restart DSH, or clear the lease requirement on the plugin configuration form',
          )
        : check('spawn-lease', 'pass', `A lease "${requiredLease}" is required and Lease coordination is on`),
    )
  }

  const subagents = ctx.get?.('subagents')
  checks.push(subagents ? check('subagents', 'pass', 'service mounted') : check('subagents', 'fail', 'subagents service is unavailable', 'enable the subagent bundle'))
  const hmr = ctx.get?.('hmr')
  checks.push(hmr ? check('hmr', 'pass', 'service mounted') : check('hmr', 'warn', 'HMR is not mounted; /tower reload is unavailable'))

  if (state) {
    const stateLock = stateLockFacts(await readStateLock(tower.paths))
    stateLockReport = stateLock.report
    checks.push(stateLock.check)
    // #F71: a leftover commit mutex makes every state write fail with
    // state-commit-busy; report it next to the state lock so the recovery
    // command is visible instead of requiring a manual file deletion.
    const commitLock = commitLockFacts(await readStateCommitLock(tower.paths))
    commitLockReport = commitLock.report
    checks.push(commitLock.check)
    const lockDir = path.join(tower.commonDir, 'dsh-tower', 'tower.lock')
    // Same ownership facts as the tower-owner check above: no second lock read
    // with a different rule, and no duplicated roster/mode logic.
    const workspaceLock = ownershipFacts?.lock ?? null
    if (!workspaceLock) {
      checks.push(
        check(
          'workspace-lock',
          'warn',
          `workspace lock ${lockDir} could not be inspected${ownershipError ? `: ${String(ownershipError?.message ?? ownershipError)}` : ''}`,
          'inspect the lock path and re-run the environment health check',
        ),
      )
    } else if (workspaceLock.corrupt) {
      checks.push(
        check(
          'workspace-lock',
          'warn',
          `workspace lock ${lockDir} is unreadable or corrupt; ownership cannot be proven from it`,
          'confirm no writer is running, then move the corrupt lock file aside',
        ),
      )
    } else if (!workspaceLock.held) {
      checks.push(check('workspace-lock', 'pass', 'free'))
    } else {
      const holder = workspaceLock.holder?.sessionId ?? workspaceLock.holder?.agentId ?? 'unknown session'
      checks.push(
        check(
          'workspace-lock',
          workspaceLock.stale ? 'warn' : 'pass',
          `held by ${holder}${workspaceLock.stale ? ' (stale)' : ''}`,
          workspaceLock.stale
            ? 'a live holder is never stolen automatically; confirm the owning session exited, then take over the repository (give a reason) to claim it and release the orphan lock'
            : undefined,
        ),
      )
    }

    const live = (state.roster ?? []).filter((entry) => !['retired', 'failed', 'interrupted', 'missing', 'stale', 'inactive'].includes(entry.state))
    checks.push(
      live.length > 0
        ? check('roster', 'pass', `${live.length} live roster entr${live.length === 1 ? 'y' : 'ies'}`)
        : check('roster', 'pass', 'no live workers'),
    )

    // #182: a terminal mission whose checkout is still on disk and whose agent
    // is gone is waiting for teardown. The roster approximation is deliberate:
    // doctor has no activity map, so any non-inactive roster row counts as live.
    const liveMissionIds = new Set(
      live.map((entry) => entry.missionId).filter((missionId) => typeof missionId === 'string'),
    )
    let missingWorktrees = 0, terminalMissingWorktrees = 0, dirtyWorktrees = 0, removedWorktrees = 0, awaitingTeardown = 0
    for (const mission of state.missions ?? []) {
      if (!mission.worktree) continue
      if (mission.worktreeRemovedAt) { removedWorktrees += 1; continue }
      // #F61: a terminal mission whose checkout is already gone is teardown's job,
      // not a repository fault; a non-terminal mission still fails.
      if (!(await exists(mission.worktree.path)) && isTerminalMission(mission)) { terminalMissingWorktrees += 1; continue }
      try {
        await tower.assertWorktree(mission.worktree)
        // Dirtiness and "waiting for teardown" are independent signals: a dirty
        // terminal checkout is still a finished mission whose disk usage the
        // operator should reclaim, so it is counted in both places.
        if ((await git(mission.worktree.path, ['status', '--porcelain'])).trim()) dirtyWorktrees += 1
        if (isTerminalMission(mission) && !liveMissionIds.has(mission.id)) awaitingTeardown += 1
      } catch { missingWorktrees += 1 }
    }
    const removedNote = removedWorktrees > 0 ? ` (${removedWorktrees} removed by teardown)` : ''
    const terminalSummary = `${terminalMissingWorktrees} terminal mission worktree(s) are no longer on disk; run the mission teardown step to record the removal`
    const awaitingSummary = `${awaitingTeardown} terminal mission worktree(s) awaiting teardown; run tower_teardown`
    const problems = [
      missingWorktrees > 0 ? `${missingWorktrees} mission worktree(s) are missing or invalid` : null,
      terminalMissingWorktrees > 0 ? terminalSummary : null,
      awaitingTeardown > 0 ? awaitingSummary : null,
      dirtyWorktrees > 0 ? `${dirtyWorktrees} worktree(s) have uncommitted changes` : null,
    ].filter((entry) => entry !== null)
    const problem = problems.length > 0 ? problems.join('; ') : null
    const action = missingWorktrees > 0 ? 'inspect the mission status, restore the worktree/branch, then re-run the environment health check' : terminalMissingWorktrees > 0 ? 'run the mission teardown step; a terminal mission whose checkout is already gone is repaired by recording the removal, and nothing is lost' : awaitingTeardown > 0 ? 'run the worktree teardown step for the finished mission; nothing is removed automatically' : undefined
    checks.push(check('worktrees', missingWorktrees > 0 ? 'fail' : problem ? 'warn' : 'pass', `${problem ?? 'all registered worktrees are valid'}${removedNote}`, action))

    // #187: the mission loop only sees recorded worktrees. A checkout created
    // outside Tower (an allowed `create_worktree` call), or one whose record was
    // lost, is listed here so it cannot stay invisible; the explicit orphan
    // sweep is the only thing that removes one, and doctor never does.
    checks.push(await orphanWorktreeCheck(tower, state))

    const testConfigured = state.missions?.some((mission) => hasTestReceipts(mission))
    // #136: the `tower-tests` component row is the only switch (there is no
    // tests.enabled), so this check reads the registry and nothing else.
    const testsDisabled = components.disabled.some((entry) => entry.id === 'tower-tests')
    checks.push(
      check(
        'tests',
        testsDisabled ? 'warn' : 'pass',
        testsDisabled
          ? 'test discovery disabled (disabled by component tower-tests; enable the tower-tests row and restart DSH)'
          : `admission=${config.tests?.admission ?? 'complete'} timeoutMs=${config.tests?.timeoutMs ?? 60000}${testConfigured ? '; receipts present' : ''}`,
      ),
    )

    checks.push(artifactAcceptanceCheck(state))
    checks.push(check('legacy', 'pass', `${state.legacySnapshots?.length ?? 0} legacy snapshot(s)`))
    checks.push(check('batches', 'pass', `${state.batches?.length ?? 0} batch(es)`))

    // #133: whether MISSIONS.md is written is the `tower-board` row, not a config
    // key, so name the component when it is off instead of a phantom key.
    const boardDisabled = components.disabled.some((entry) => entry.id === 'tower-board')
    const boardPath =
      config.docs?.boardLocation === 'repo'
        ? path.join(tower.root, 'MISSIONS.md')
        : path.join(tower.paths.dir, 'MISSIONS.md')
    checks.push(
      check(
        'board',
        boardDisabled ? 'warn' : 'pass',
        boardDisabled
          ? `MISSIONS.md is not written (disabled by component tower-board); expected at ${boardPath}`
          : `MISSIONS.md refreshes after mission changes at ${boardPath}`,
        boardDisabled
          ? 'switch the Mission board capability back on in the plugin page and restart DSH, or accept a stale board; every state tool and gate still works'
          : undefined,
      ),
    )

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
        corrupt ? 'inspect the lease ledger in the Tower state directory and repair or remove it' : undefined,
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
  // #135: archival is the `tower-archive` row. Name the component when it is off;
  // the documented consequence is that terminal missions stay hot.
  const archiveEnabled = !components.disabled.some((entry) => entry.id === 'tower-archive')
  const policyText = `afterDays=${archivePolicy.afterDays ?? 30} maxMissions=${archivePolicy.maxMissions ?? 100}${
    archiveEnabled ? '' : ' (disabled by component tower-archive: terminal missions stay hot and state.json keeps growing)'
  }`
  if (!archiveInventory.exists) {
    checks.push(check('archive', 'pass', `no archived missions; ${policyText}`))
  } else if (archiveInventory.unreadable.length > 0) {
    checks.push(
      check(
        'archive',
        'warn',
        `${archiveInventory.missions} archived mission(s), ${archiveInventory.bytes} bytes; unreadable: ${archiveInventory.unreadable[0]}`,
        'inspect the archive directory in the Tower state directory and repair or move the corrupt file; archiving is paused until it is readable',
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

  // #162 D5: a live Ralph loop is an environment fact — this repository has a
  // loop in progress, and Tower cannot co-own it. Rounds are matched to this
  // checkout by their parent session's cwd; workflow runs carry no cwd, so a
  // run without scoped rounds is reported as process-wide rather than hidden.
  const ralphStance = ralphStanceDoctorFact(tower.root)
  const ralphLoop = ralphStance.ralphLoop
  checks.push(check('ralph-stance', ralphStance.row.status, ralphStance.row.detail, ralphStance.row.action))

  // #188/#189: the stance inventory for non-Tower capabilities that can
  // orchestrate agents or land changes. It is a report, not a guard: Tower does
  // not deny what it does not replace, and a type it cannot detect is a warning.
  const foreign = foreignCapabilityCheck({ ctx, agent, rows })
  checks.push(foreign.check)

  const failed = checks.filter((item) => item.status === 'fail').length
  return {
    ok: failed === 0,
    checks,
    // The exact facts the owner/workspace-lock checks used, exposed so callers
    // can compare doctor with tower_status instead of re-deriving the rules.
    ownership: ownershipFacts?.snapshot ?? null,
    stateLock: stateLockReport,
    commitLock: commitLockReport,
    gitLock,
    stateSchema: schemaReport.stateSchema,
// reports (from #89) and archive (from #73) are both kept
    reports: reportsReport,
    surface: surfaceReport,
    activityLog,
    review: reviewPolicy,
    components,
    // #188/#189: each non-Tower capability, its stance and the cost of denying it.
    foreignCapabilities: foreign.report,
    // Every default-off subsystem, with the tool it owns and the exact enable
    // step, so a client can render "off, and here is how to turn it on".
    subsystems: Object.keys(COMPONENT_ENABLE_HINTS).map((id) => ({
      id,
      enabled: components.enabled.includes(id),
      tool: COMPONENT_ENABLE_HINTS[id].tool,
      enable: COMPONENT_ENABLE_HINTS[id].enable,
    })),
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
        enabled: archiveEnabled,
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
      ...hostDiagnosis.contract,
      hostCompatibility: hostAssessment.verdict,
      hostCompatibilityDetail: hostAssessment.detail,
      ralphLoop,
    },
    mode: agent ? 'ready' : 'unknown',
  }
}
