// Cross-cutting tool observers (W5-A): the read-only views a tool handler needs
// but does not own. Ownership snapshots, roster activity observation, test
// discovery, batch receipt verification and the interrupt helper live here so
// the registration aggregator stays a table of register calls.
import path from 'node:path'
import crypto from 'node:crypto'
import { TowerToolError } from '../domain/errors.js'
import {
  PARENT_STATUS_OK,
  ROSTER_ACTIVITY,
  isRunningActivity,
} from '../domain/vocabulary.js'
import { readOwnership } from './ownership.js'
import { readDiscoveryConfig, normalizeDiscovery, runDiscovery } from '../adapters/tests.js'
import { fsp } from '../adapters/store-fs.js'
import { componentEnabled, disabledReason } from './capability-registry.js'

export async function verifyBatchReceiptFiles(root, batch, args) {
  const problems = []
  const frozen = new Set(batch.receiptPaths ?? [])
  const declared = new Map()
  for (const [rawPath, rawHash] of Object.entries(args.receiptHashes ?? {})) {
    declared.set(String(rawPath), String(rawHash).trim().toLowerCase())
  }
  for (const entry of args.receipts ?? []) {
    if (entry && typeof entry.path === 'string' && typeof entry.hash === 'string') {
      declared.set(entry.path, entry.hash.trim().toLowerCase())
    }
  }
  for (const [rel, reported] of declared) {
    if (frozen.size > 0 && !frozen.has(rel)) continue
    let actual
    try {
      const abs = path.resolve(root, rel)
      const relative = path.relative(root, abs)
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new TowerToolError('invalid-argument', 'path escapes the repository')
      actual = crypto.createHash('sha256').update(await fsp.readFile(abs)).digest('hex')
    } catch (error) {
      problems.push({ code: 'batch-invalid', detail: `receipt "${rel}" cannot be read: ${String(error?.message ?? error)}` })
      continue
    }
    if (reported && reported !== actual) {
      problems.push({ code: 'batch-invalid', detail: `receipt "${rel}" hash ${reported.slice(0, 12)} does not match the file (${actual.slice(0, 12)})` })
    }
  }
  return problems
}

export async function interruptRosterAgent(ctx, tower, exec, input) {
  const subagents = ctx.get('subagents')
  if (!subagents || typeof subagents.interrupt !== 'function') {
    throw new TowerToolError('spawn-unavailable', 'subagents service is unavailable; cannot interrupt')
  }
  const view = await tower.rosterView()
  const entry = view.roster.find(
    (row) =>
      (input.agentId !== undefined && row.agentId === String(input.agentId)) ||
      (input.to !== undefined && row.name === input.to),
  )
  if (!entry) throw new TowerToolError('invalid-argument', `unknown roster agent "${input.to ?? input.agentId}"`)
  const { activity } = await observeActivity(ctx, tower)
  const previousActivity = activity[entry.agentId] ?? ROSTER_ACTIVITY.unknown
  if (!isRunningActivity(previousActivity)) {
    return { interrupted: false, reason: `agent is ${previousActivity}, not running`, entry }
  }
  subagents.interrupt(entry.agentId, { kind: 'ancestor', agent: exec.agent })
  const updated = await tower.recordInterrupt({
    agentId: entry.agentId,
    name: entry.name,
    reason: input.reason ?? 'interrupted by tower',
  })
  return { interrupted: true, previousActivity, entry: updated }
}

/** Read `package.json tower.testDiscovery` and run it for one mission worktree.
 * Returns `{configured:false}` when the repository has no discovery block. */
export async function runMissionDiscovery(tower, mission) {
  // #121: test discovery is the tower-tests component. With the row off there is
  // no tower_test tool and no receipt; never execute repository code silently
  // because a config key still says admission complete/spawn.
  if (!componentEnabled('tower-tests')) {
    return { configured: false, disabledBy: 'tower-tests', reason: disabledReason('tower-tests') }
  }
  const testsConfig = tower.config.tests ?? {}
  // #136: there is no second switch. The `tower-tests` row decided above; the
  // only remaining reason to skip discovery is an explicit opt-out of repository
  // package discovery.
  if (testsConfig.allowPackageDiscovery === false) {
    return { configured: false, error: 'test discovery is disabled by tests.allowPackageDiscovery:false' }
  }
  const worktreePath = mission?.worktree?.path
  if (!worktreePath) return { configured: false, error: 'mission has no worktree' }
  let packageText
  try {
    packageText = await fsp.readFile(path.join(worktreePath, 'package.json'), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { configured: false }
    throw error
  }
  const read = readDiscoveryConfig(packageText)
  if (!read.configured) {
    if (read.error) throw new TowerToolError('invalid-argument', `package.json test discovery is invalid: ${read.error}`)
    return { configured: false, error: null }
  }
  const normalized = normalizeDiscovery(read.config)
  if (!normalized.ok) {
    throw new TowerToolError('invalid-argument', `invalid tower.testDiscovery: ${normalized.error}`)
  }
  const receipt = await runDiscovery({
    worktreePath,
    config: read.config,
    timeoutMs: Number(testsConfig.timeoutMs) || 60000,
    maxBytes: Number(testsConfig.maxBytes) || 16 * 1024 * 1024,
    missionId: mission.id,
    diagnosticsDir: path.join(tower.paths.dir, 'test-runs', `${mission.id}-${Date.now()}`),
  })
  const stored = await tower.recordTestRun({ missionId: mission.id, receipt })
  // #149 W4: the recorded receipt is the only evidence shape. Consumers read it
  // through domain/evidence.js; there is no separate `check` projection.
  return { configured: true, receipt: stored }
}

export async function ownershipView(_ctx, tower, exec) {
  const agentId = exec?.agent?.id !== undefined ? String(exec.agent.id) : null
  if (!agentId) return null
  try {
    const facts = await readOwnership(tower, { caller: agentId })
    return facts.snapshot
  } catch {
    return null
  }
}

/**
 * Observe catalog activity for every roster parent; read-only.
 * @param {any} ctx
 * @param {any} tower
 * @returns {Promise<{ activity: Record<string, string>, parentStatus: Record<string, string> }>}
 */
export async function observeActivity(ctx, tower) {
  const view = await tower.rosterView()
  const subagents = ctx.get('subagents')
  /** @type {Record<string, string>} */
  const activity = {}
  /** @type {Record<string, string>} */
  const parentStatus = {}
  if (!subagents) return { activity, parentStatus }
  const parents = [...new Set(view.roster.map((entry) => entry.parentSessionId).filter(Boolean))]
  for (const parent of parents) {
    try {
      const rows = await subagents.listDescendants(parent)
      for (const row of rows) activity[String(row.id)] = row.activity ?? ROSTER_ACTIVITY.unknown
      parentStatus[parent] = PARENT_STATUS_OK
    } catch (error) {
      parentStatus[parent] = `unavailable: ${String(error?.message ?? error)}`
    }
  }
  return { activity, parentStatus }
}
