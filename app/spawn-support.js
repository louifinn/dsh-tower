// tower_spawn support (#56 P3c): briefing assembly, agent options, and the
// wait/result settling path. Split out of tools/spawn.js; no I/O of its own.
import { shapeFor } from '../domain/shapes/index.js'
import { roleBriefingKind, rolePlacement } from '../domain/roles.js'
import { workerBriefing, reviewerBriefing } from './briefing.js'

/**
 * Resolve where a spawn runs (#149 W3). A worker gets the shape's provisioning
 * (branch worktree, shared checkout, or detached survey sandbox); a reviewer
 * gets a disposable detached checkout at the recorded branch tip, so the
 * verdict is stamped with a commit instead of a live worktree HEAD.
 * @param {any} tower
 * @param {{ role: string, context: any, missionId: string, name: string, worktreeRoot?: string, includeDirtyBase?: boolean, instructions?: string }} input
 */
export async function provisionSpawnPlacement(tower, { role, context, missionId, name, worktreeRoot, includeDirtyBase, instructions }) {
  // #149 W4: the role contract decides the placement; the shape supplies the
  // mission provisioning facts it does not own.
  const reviewCheckout = rolePlacement(role) === 'review-checkout'
  const shape = shapeFor(context.mission.kind)
  const provisioned = reviewCheckout
    ? null
    : await tower.provision({ missionId, worktreeRoot, includeDirtyBase: includeDirtyBase !== false })
  const review = reviewCheckout
    ? await tower.provisionReviewCheckout({ missionId, name, worktreeRoot })
    : null
  const mission = review ? review.mission : provisioned.mission
  const worktree = review ? mission.worktree : provisioned.worktree
  const cwd = review ? review.path : (provisioned.cwd ?? worktree.path)
  const branch = worktree?.branch ?? null
  // The briefing must describe the checkout that actually exists: a detached
  // sandbox is recorded only after provision, so use the provisioned mission.
  const briefing = buildSpawnBriefing({
    role,
    towerRoot: tower.root,
    context: /** @type {any} */ ({ ...context, mission }),
    worktree,
    review,
    instructions,
  })
  return {
    mission,
    worktree,
    cwd,
    branch,
    review,
    briefing,
    provisioning: review ? 'review-checkout' : (provisioned.provisioning ?? shape.provisioning),
    created: review ? true : provisioned.created,
    sandbox: provisioned?.sandbox ?? null,
  }
}

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
 * @param {{ role: string, towerRoot: string, context: any, worktree: any, review?: any, instructions: string | undefined }} input
 */
export function buildSpawnBriefing({ role, towerRoot, context, worktree, review = null, instructions }) {
  // Only a shape that owns a worktree gets the git checkout projection; a survey
  // reads the shared checkout and must not see a worktree record it does not own.
  const shape = shapeFor(context.mission.kind)
  const mission = shape.fields.worktree
    ? { ...context.mission, worktree: { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit } }
    : { ...context.mission }
  const briefing = {
    repoRoot: towerRoot,
    base: context.base,
    mission,
    deps: context.deps,
    worktree: worktree ?? null,
    review,
    instructions,
    reviews: context.reviews,
    findings: context.findings,
    completionReport: context.completionReport,
  }
  return roleBriefingKind(role) === 'reviewer' ? reviewerBriefing(briefing) : workerBriefing(briefing)
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
