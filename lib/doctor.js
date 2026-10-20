// Read-only environment contract and health checks for a Tower repository.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { git } from './git.js'
import { readStateLock } from './store.js'
import { inspectWorkspaceLock } from './workspaceLock.js'

const execFileAsync = promisify(execFile)

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

/** Run every read-only diagnostic; never writes state or takes the state lock. */
export async function runDoctor({ tower, ctx, agent }) {
  const checks = []
  const version = await gitVersion()
  checks.push(version ? check('git', 'pass', version) : check('git', 'fail', 'git is not available', 'install Git and retry'))

  checks.push(check('repository', 'pass', `${tower.root} (common ${tower.commonDir})`))
  let state = null
  try {
    state = await tower.load()
    checks.push(check('state', 'pass', `${tower.paths.state} revision ${state.revision}`))
  } catch (error) {
    checks.push(check('state', 'fail', String(error?.message ?? error), 'run tower_init or restore the state file'))
  }

  const config = tower.config ?? {}
  checks.push(
    check(
      'config',
      config.configPath && config.repoConfigPresent ? 'pass' : 'warn',
      config.repoConfigPresent ? `repo config ${config.configPath}` : `repo config not present (${config.configPath ?? 'unknown'})`,
      'optional: add <git-common-dir>/dsh-tower/config.json',
    ),
  )
  const presets = ctx.get?.('agentPresets')
  if (presets && typeof presets.list === 'function') {
    try {
      const available = (await presets.list()).map((entry) => String(entry.id))
      const missing = [config.spawn?.workerPreset ?? 'tower-worker', config.spawn?.reviewerPreset ?? 'tower-reviewer']
        .filter((id) => !available.includes(id))
      checks.push(
        missing.length === 0
          ? check('presets', 'pass', `worker=${config.spawn?.workerPreset ?? 'tower-worker'} reviewer=${config.spawn?.reviewerPreset ?? 'tower-reviewer'}`)
          : check('presets', 'fail', `missing preset(s): ${missing.join(', ')}`, 'enable the Tower preset bundle and retry'),
      )
    } catch (error) {
      checks.push(check('presets', 'warn', `preset registry unavailable: ${String(error?.message ?? error)}`))
    }
  } else {
    checks.push(check('presets', 'warn', 'agentPresets service is unavailable'))
  }

  const subagents = ctx.get?.('subagents')
  checks.push(subagents ? check('subagents', 'pass', 'service mounted') : check('subagents', 'fail', 'subagents service is unavailable', 'enable the subagent bundle'))
  const hmr = ctx.get?.('hmr')
  checks.push(hmr ? check('hmr', 'pass', 'service mounted') : check('hmr', 'warn', 'HMR is not mounted; /tower reload is unavailable'))

  if (state) {
    const lock = await readStateLock(tower.paths)
    checks.push(
      !lock.record
        ? check('state-lock', 'pass', 'no state lock file')
        : lock.alive === false
          ? check('state-lock', 'warn', `stale state lock (pid ${lock.record.pid ?? 'unknown'} is gone); the next mutation reclaims it atomically`)
          : check('state-lock', 'warn', `state lock held by pid ${lock.record.pid ?? 'unknown'}; retry after it finishes`),
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
    checks.push(live.length > 0 ? check('roster', 'warn', `${live.length} live roster entr${live.length === 1 ? 'y' : 'ies'}`) : check('roster', 'pass', 'no live workers'))

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
    checks.push(
      check(
        'tests',
        config.tests?.enabled === false ? 'warn' : 'pass',
        config.tests?.enabled === false ? 'test discovery disabled' : `admission=${config.tests?.admission ?? 'complete'} timeoutMs=${config.tests?.timeoutMs ?? 60000}${testConfigured ? '; receipts present' : ''}`,
      ),
    )
    checks.push(check('legacy', 'pass', `${state.legacySnapshots?.length ?? 0} legacy snapshot(s)`))
    checks.push(check('batches', 'pass', `${state.batches?.length ?? 0} batch(es)`))
  }

  try {
    const { inspectLeases } = await import('./leases.js')
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

  const failed = checks.filter((item) => item.status === 'fail').length
  return {
    ok: failed === 0,
    checks,
    environmentContract: {
      platform: process.platform,
      gitVersion: version,
      repoRoot: tower.root,
      commonDir: tower.commonDir,
      stateDir: tower.paths.dir,
      gitTimeoutMs: Number(tower.config.git?.timeoutMs) || 15000,
      mergeTimeoutMs: Number(tower.config.merge?.timeoutMs) || 900000,
      testsAdmission: tower.config.tests?.admission ?? 'off',
    },
    mode: agent ? 'ready' : 'unknown',
  }
}
