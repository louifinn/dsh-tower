// tower_spawn support (#56 P3c): briefing assembly, agent options, and the
// wait/result settling path. Split out of tools/spawn.js; no I/O of its own.
import { workerBriefing, reviewerBriefing } from './briefing.js'

/**
 * @param {any} model
 */
export function buildAgentOptions(model) {
  const agentOptions = {}
  for (const key of ['provider', 'model', 'reasoningEffort', 'maxTokens']) {
    if (model && model[key] !== undefined && model[key] !== null && model[key] !== '') agentOptions[key] = model[key]
  }
  return agentOptions
}

/**
 * @param {{ role: string, towerRoot: string, context: any, worktree: any, instructions: string | undefined }} input
 */
export function buildSpawnBriefing({ role, towerRoot, context, worktree, instructions }) {
  const mission = {
    ...context.mission,
    worktree: { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit },
  }
  const briefing = {
    repoRoot: towerRoot,
    base: context.base,
    mission,
    deps: context.deps,
    worktree,
    instructions,
    reviews: context.reviews,
    findings: context.findings,
    completionReport: context.completionReport,
  }
  return role === 'worker' ? workerBriefing(briefing) : reviewerBriefing(briefing)
}

/**
 * Wait for the activation result when wait=true, or forward the eventual
 * outcome when wait=false.
 * @param {{
 *   activation: any,
 *   report: any,
 *   recordOutcome: (state: string, detail: any) => Promise<any>,
 *   maxWaitMs: number | undefined,
 *   requestedWaitMs: number | undefined,
 *   textOf: any,
 * }} input
 */
export async function waitForSpawnResult({ activation, report, recordOutcome, maxWaitMs, requestedWaitMs, textOf }) {
  const waitMs = Math.max(1000, Math.min(maxWaitMs ?? 90000, requestedWaitMs ?? 180000))
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), waitMs)
  })
  let result
  try {
    result = await Promise.race([activation.result, timeout])
  } catch (error) {
    report.stopReason = 'failed'
    report.diagnostic = String(error?.message ?? error)
    await recordOutcome('failed', report.diagnostic)
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (result && result.__timeout) {
    report.timedOut = true
    recordOutcome('unknown', 'spawn wait timed out; check tower_roster')
  } else {
    report.stopReason = result?.stopReason ?? null
    report.output = textOf(result?.output)
    report.diagnostic = result?.diagnostic ?? null
    const state = report.stopReason === 'completed' ? 'inactive' : 'failed'
    if (state === 'failed') report.diagnostic = report.diagnostic ?? report.stopReason
    await recordOutcome(state, report.diagnostic ?? null)
  }
  return report
}
