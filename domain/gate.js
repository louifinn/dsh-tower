// Pure completion gate checks (#49). No repository I/O.
// @ts-check
import { shapeFor } from './shapes/index.js'
import { blocker as blockerRecord } from './shapes/blockers.js'
import { passingDiscovery } from './evidence.js'
import { dependencySatisfied } from './integration/gate.js'
import { isReviewExempt, reviewExemptionInvalid, reviewRequired } from './integration/review.js'

/** @typedef {import('../types/index.js').Blocker} Blocker */
/** @typedef {import('../types/index.js').MergeGateOptions} MergeGateOptions */
/** @typedef {import('../types/index.js').Mission} Mission */
/** @typedef {import('../types/index.js').Review} Review */
/** @typedef {import('../types/index.js').TowerConfig} TowerConfig */

/**
 * Pre-merge completion blockers. The shape owns the vocabulary: a survey is
 * terminal when completed and is never merged, so it has no
 * "closed mission owns a branch" blocker.
 * @param {Mission} mission
 * @param {TowerConfig} [config]
 * @returns {Blocker[]}
 */
export function completionBlockers(mission, config = {}) {
  return shapeFor(mission.kind).completionBlockers(mission, config)
}

/**
 * Review, roster, and test-evidence blockers; all inputs are snapshots.
 * `testsComponent` is the optional `tower-tests` row state (#140). It is passed
 * through the options bag rather than declared on `MergeGateOptions` because the
 * domain may not read the component registry itself: the composition root
 * publishes the probe on the port bag and `app/gate.js` forwards the snapshot.
 * @param {MergeGateOptions & { testsComponent?: ({ enabled?: boolean, reason?: string } | null) }} options
 * @returns {Blocker[]}
 */
export function mergeGateBlockers({
  mission,
  roster = [],
  branch = null,
  branchTip = null,
  review = null,
  config = {},
  activity = {},
  parentStatus = null,
  inactiveStates = [],
  rebaseWaived = false,
  testsComponent = null,
}) {
  /** @type {Blocker[]} */
  const blockers = []
  /** @type {(code: string, detail: string) => void} */
  const push = (code, detail) => {
    blockers.push(blockerRecord(code, detail))
  }
  const inactive = new Set(inactiveStates)
  const shape = shapeFor(mission.kind)
  // #M39: only `review.mode:required` produces review blockers. `optional`
  // records reviews without gating, and `off` disables review entirely (no
  // tower_review, no reviewer spawn), so both skip this whole block.
  const requireReview = reviewRequired(config)
  const exempt = isReviewExempt(mission, config)
  // #159 D4: the review contract does not apply to a shape whose gate is a
  // human acceptance. The exemption is structural — the shape owns the
  // acceptance dimension — so `review.mode:required` cannot force an artifact
  // mission through a reviewer that cannot judge its deliverables. No review
  // blocker is produced for it; the tip-bound acceptance record takes the
  // review's place and any new commit makes it stale.
  if (shape.fields.acceptance) {
    const acceptance = /** @type {{ acceptance?: { tip?: string } | null }} */ (/** @type {any} */ (mission)).acceptance
    if (!acceptance) {
      push('acceptance-missing', `mission ${mission.id} has no human acceptance; only a human can accept the whole committed tip (tower_mission accept)`)
    } else if (branchTip && acceptance.tip !== branchTip) {
      push(
        'acceptance-stale',
        `accepted ${String(acceptance.tip ?? '').slice(0, 7)} but tip is ${branchTip.slice(0, 7)}; the acceptance binds one tip — new commits or a rebase need a fresh human acceptance`,
      )
    }
  } else {
    if (reviewExemptionInvalid(mission, config)) {
      push('review-exemption-invalid', `mission ${mission.id} requests no review but gates.allowReviewExemption is disabled`)
    }
    if (requireReview && !exempt && !review) {
      push('no-review', `branch ${branch ?? '(none)'} has no review; assign a reviewer first (or set review.mode:optional)`)
    } else if (requireReview && !exempt) {
      const latest = /** @type {Review} */ (review)
      if (latest.missionId !== mission.id) push('review-mission-mismatch', `latest review belongs to mission ${latest.missionId}`)
      if (latest.status !== 'clean') push('not-clean', `latest review round ${latest.round} is "${latest.status}"`)
      if (latest.mergeVerdict === 'hold') {
        push('review-hold', 'latest review recommends hold — a later clean review must supersede it')
      } else if (latest.status === 'clean' && latest.mergeVerdict !== 'merge') {
        push('review-not-approved', `latest clean review recommends "${latest.mergeVerdict}" — only "merge" approves`)
      }
      if (branchTip && latest.reviewedCommit !== branchTip && !rebaseWaived) {
        push('tip-moved', `reviewed ${latest.reviewedCommit.slice(0, 7)} but tip is ${branchTip.slice(0, 7)}; re-review required`)
      }
    }
  }
  for (const entry of (roster ?? []).filter((row) => row.missionId === mission.id && !inactive.has(row.state))) {
    // Reserved rows can lack an agent id; indexing with undefined is a miss.
    const agentId = /** @type {string} */ (entry.agentId)
    if (activity[agentId] === 'running') push('worker-busy', `agent ${entry.name} is still running`)
    else if (parentStatus && entry.parentSessionId && parentStatus[entry.parentSessionId] !== 'ok') {
      push('worker-status-unknown', `cannot prove agent ${entry.name} is stopped: its parent catalog is unavailable`)
    }
  }
  const staleWorkers = (roster ?? []).filter(
    (row) => row.missionId === mission.id && (row.state === 'stale' || (row.stale === true && !inactive.has(row.state))),
  )
  if (staleWorkers.length > 0) {
    push('worker-stale', `stale worker(s) for ${mission.id}: ${staleWorkers.map((row) => row.name).join(', ')}; adopt or interrupt before merge`)
  }
  if (config.gates?.requireTests === true) {
    // #149 W4: the receipt question is answered by the one evidence reader, not
    // by a second filter here. The shape decides whether a receipt appertains;
    // a receipt is evidence only for the tip it ran on.
    const receipt = passingDiscovery(shapeFor(mission.kind).evidence, mission, branchTip)
    if (!receipt) {
      // #140: name the component cause when the row is off. Without this the
      // blocker reads as a repository mistake ("no passing discovery") when the
      // real cause is a disabled row and no tower_test tool exists to produce a
      // receipt. The component state is a snapshot on the options bag.
      const tip = branchTip ? branchTip.slice(0, 7) : '(none)'
      const cause =
        testsComponent && testsComponent.enabled !== true
          ? `; ${testsComponent.reason ?? 'disabled by component tower-tests'} so no receipt can exist: ` +
            're-enable the tower-tests component (or set gates.requireTests:false) and re-record discovery'
          : ''
      push('tests-missing', `mission ${mission.id} has no passing test discovery for tip ${tip}${cause}`)
    }
  }
  return blockers
}

/**
 * A conflict-free rebase after the reviewed tip waives the stale-tip blocker.
 * @param {Mission} mission
 * @param {Review} review
 * @returns {boolean}
 */
export function rebaseWaived(mission, review) {
  const rebase = mission.rebase
  if (!rebase) return false
  return review.at <= rebase.at && review.reviewedCommit === rebase.oldTip
}

// #208: the ordered diagnosis a preflight result carries. These are action
// names, not blocker codes: one blocker can need more than one step (a
// dependency blocker names the whole unsatisfied chain before itself), and the
// order across blockers is the answer. Nothing here executes a step.
export const RESOLUTION_ACTION = Object.freeze({
  mergeDependency: 'merge-dependency',
  rebase: 'rebase',
  breakDependencyCycle: 'break-dependency-cycle',
  assignReviewer: 'assign-reviewer',
  requestCleanReview: 'request-clean-review',
  reReview: 're-review',
  waitForWorker: 'wait-for-worker',
  verifyWorkerStopped: 'verify-worker-stopped',
  adoptOrInterruptWorker: 'adopt-or-interrupt-worker',
  recordTests: 'record-tests',
  recordChecks: 'record-checks',
  humanAcceptance: 'human-acceptance',
  completeMission: 'complete-mission',
  finishTasks: 'finish-tasks',
  clearMissionBlockers: 'clear-mission-blockers',
  provisionWorktree: 'provision-worktree',
  fixScope: 'fix-scope',
  cleanBase: 'clean-base',
  refreshSurvey: 'refresh-survey',
  checkoutBase: 'checkout-base',
  replanMission: 'replan-mission',
  fixTests: 'fix-tests',
  enableReviewExemption: 'enable-review-exemption',
  reconcileMerge: 'reconcile-merge',
  resolveConflict: 'resolve-conflict',
  retryMerge: 'retry-merge',
  inspectMerge: 'inspect-merge',
  fixBatch: 'fix-batch',
  cleanWorktree: 'clean-worktree',
  checkMissionId: 'check-mission-id',
  resolveBlocker: 'resolve-blocker',
})

/** @typedef {{ step: number, action: string, missionId?: string, missionIds?: string[] }} ResolutionStep */
/** @typedef {{ code: string, missionIds: string[], detail: string }} DependencyCycle */
/** @typedef {Blocker & { resolution: ResolutionStep[] }} ResolvedBlocker */

// Keep the cycle classification out of a `code: '…'` literal so the static
// blocker-emission scan does not mistake a conclusion label for a new blocker
// code (blocker codes are a closed registry owned by domain/shapes/blockers.js).
const DEPENDENCY_CYCLE_CODE = 'dependency-cycle'

/** @type {Readonly<Record<string, string>>} */
const BLOCKER_ACTION = Object.freeze({
  'mission-missing': RESOLUTION_ACTION.checkMissionId,
  'mission-not-completed': RESOLUTION_ACTION.completeMission,
  'tasks-open': RESOLUTION_ACTION.finishTasks,
  'blockers-present': RESOLUTION_ACTION.clearMissionBlockers,
  'no-check-evidence': RESOLUTION_ACTION.recordChecks,
  'branch-missing': RESOLUTION_ACTION.provisionWorktree,
  'stale-base': RESOLUTION_ACTION.rebase,
  'out-of-scope': RESOLUTION_ACTION.fixScope,
  'base-dirty': RESOLUTION_ACTION.cleanBase,
  'broad-scope': RESOLUTION_ACTION.fixScope,
  'survey-stale': RESOLUTION_ACTION.refreshSurvey,
  'no-review': RESOLUTION_ACTION.assignReviewer,
  'review-mission-mismatch': RESOLUTION_ACTION.requestCleanReview,
  'not-clean': RESOLUTION_ACTION.requestCleanReview,
  'review-hold': RESOLUTION_ACTION.requestCleanReview,
  'review-not-approved': RESOLUTION_ACTION.requestCleanReview,
  'tip-moved': RESOLUTION_ACTION.reReview,
  'acceptance-missing': RESOLUTION_ACTION.humanAcceptance,
  'acceptance-stale': RESOLUTION_ACTION.humanAcceptance,
  'worker-busy': RESOLUTION_ACTION.waitForWorker,
  'worker-status-unknown': RESOLUTION_ACTION.verifyWorkerStopped,
  'worker-stale': RESOLUTION_ACTION.adoptOrInterruptWorker,
  'base-wrong-branch': RESOLUTION_ACTION.checkoutBase,
  'branch-owned-by-closed-missions': RESOLUTION_ACTION.replanMission,
  'tests-missing': RESOLUTION_ACTION.recordTests,
  'tests-failed': RESOLUTION_ACTION.fixTests,
  'review-exemption-invalid': RESOLUTION_ACTION.enableReviewExemption,
  'merge-intent-pending': RESOLUTION_ACTION.reconcileMerge,
  'merge-conflict': RESOLUTION_ACTION.resolveConflict,
  'merge-hook-failed': RESOLUTION_ACTION.retryMerge,
  'merge-shape': RESOLUTION_ACTION.inspectMerge,
  'batch-invalid': RESOLUTION_ACTION.fixBatch,
  'review-stale': RESOLUTION_ACTION.reReview,
  'worktree-dirty': RESOLUTION_ACTION.cleanWorktree,
  'rebase-conflict': RESOLUTION_ACTION.resolveConflict,
})

/**
 * The dependency id a `deps-unmerged` blocker names. The integration gate owns
 * the message shape (`"M2 is completed"`); a blocker whose detail does not parse
 * still gets the generic fallback step instead of losing its resolution.
 * @param {Blocker} blocker
 * @returns {string | null}
 */
function dependencyIdOf(blocker) {
  if (!blocker || blocker.code !== 'deps-unmerged') return null
  const match = /^(\S+) is /.exec(String(blocker.detail ?? ''))
  return match ? match[1] : null
}

/**
 * Merge state missions with archived summaries for the dependency walk. Live
 * missions win: the walk reads the current status, and an archived copy of the
 * same id is stale by definition.
 * @param {Mission[]} missions
 * @param {Map<string, any> | any[]} archived
 * @returns {Map<string, any>}
 */
function missionIndex(missions = [], archived = []) {
  /** @type {Map<string, any>} */
  const index = new Map()
  const archivedEntries = archived instanceof Map ? archived.values() : Array.isArray(archived) ? archived : []
  for (const mission of archivedEntries) {
    if (mission && typeof mission.id === 'string') index.set(mission.id, mission)
  }
  for (const mission of missions) {
    if (mission && typeof mission.id === 'string') index.set(mission.id, mission)
  }
  return index
}

/**
 * Post-order walk of the unsatisfied dependency graph: nested dependencies come
 * before the mission that depends on them (#208). A cycle is reported by the
 * first repeated id on the DFS stack; members of a cycle get no merge step
 * because merging cannot break it, while a `break-dependency-cycle` step names
 * them. The walk is bounded by `done`, so a cycle never recurses forever.
 * @param {{ roots: string[], currentId: string, index: Map<string, any> }} options
 * @returns {{ steps: Array<Omit<ResolutionStep, 'step'>>, cycleIds: string[], cyclePath: string }}
 */
function dependencyWalk({ roots, currentId, index }) {
  /** @type {Array<Omit<ResolutionStep, 'step'>>} */
  const steps = []
  /** @type {string[]} */
  const stack = [currentId]
  const onStack = new Set([currentId])
  const done = new Set()
  const emitted = new Set()
  /** @type {string[]} */
  const cycleIds = []
  let cyclePath = ''
  /** @param {string} id */
  const recordCycle = (id) => {
    if (cycleIds.length > 0) return
    const at = stack.indexOf(id)
    if (at < 0) return
    const members = stack.slice(at)
    cycleIds.push(...members)
    cyclePath = [...members, id].join(' -> ')
  }
  /** @param {string} id */
  const visit = (id) => {
    if (onStack.has(id)) {
      recordCycle(id)
      return
    }
    if (done.has(id)) return
    const dependency = index.get(id)
    if (dependency && dependencySatisfied(dependency)) {
      done.add(id)
      return
    }
    stack.push(id)
    onStack.add(id)
    const deps = Array.isArray(dependency?.deps) ? dependency.deps : []
    for (const child of deps) visit(String(child))
    stack.pop()
    onStack.delete(id)
    done.add(id)
    // The current mission is never a step to merge itself; it can only reappear
    // through a cycle, where it is named by the cycle step instead.
    if (id !== currentId && !emitted.has(id)) {
      emitted.add(id)
      steps.push({ action: RESOLUTION_ACTION.mergeDependency, missionId: id })
    }
  }
  for (const root of roots) visit(String(root))
  const members = new Set(cycleIds)
  const filtered = steps.filter((step) => !members.has(String(step.missionId)))
  if (cycleIds.length > 0) {
    filtered.unshift({ action: RESOLUTION_ACTION.breakDependencyCycle, missionIds: [...cycleIds] })
  }
  return { steps: filtered, cycleIds, cyclePath }
}

/** @param {Array<Omit<ResolutionStep, 'step'>>} steps @returns {ResolutionStep[]} */
function renumber(steps) {
  return steps.map((step, index) => ({ step: index + 1, ...step }))
}

/** @param {Omit<ResolutionStep, 'step'>} step */
function stepKey(step) {
  return `${step.action}|${step.missionId ?? ''}|${(step.missionIds ?? []).join(',')}`
}

/**
 * Give every preflight blocker an ordered `resolution` and give the whole result
 * a deduplicated cross-blocker `order` (#208). Dependency merges always come
 * first, earliest ancestor first; a stale base is rebased only after those
 * merges; the remaining blockers follow in the order the gate produced them.
 * A cycle is a conclusion (`cycle`) plus a diagnostic step, never an execution
 * plan. Pure: it reads only the blocker snapshot and mission records.
 * @param {{ blockers?: Blocker[], mission?: any, missions?: Mission[], archived?: Map<string, any> | any[] }} [options]
 * @returns {{ blockers: ResolvedBlocker[], order: ResolutionStep[], cycle: DependencyCycle | null }}
 */
export function resolutionPlan({ blockers = [], mission = null, missions = [], archived = [] } = {}) {
  const list = Array.isArray(blockers) ? blockers : []
  const current = mission && typeof mission === 'object' ? mission : { id: '', deps: [] }
  const currentId = typeof current.id === 'string' ? current.id : ''
  const index = missionIndex(missions, archived)

  // Roots are the mission's declared deps plus any dependency a blocker names
  // (a stale blocker snapshot must still diagnose, not crash).
  /** @type {string[]} */
  const roots = []
  for (const dep of Array.isArray(current.deps) ? current.deps : []) {
    const id = String(dep)
    if (!roots.includes(id)) roots.push(id)
  }
  for (const blocker of list) {
    const id = dependencyIdOf(blocker)
    if (id && !roots.includes(id)) roots.push(id)
  }

  const closure = dependencyWalk({ roots, currentId, index })
  const cycle =
    closure.cycleIds.length > 0
      ? {
          code: DEPENDENCY_CYCLE_CODE,
          missionIds: [...closure.cycleIds],
          detail: `dependency cycle: ${closure.cyclePath}; break one dependency edge before resolving`,
        }
      : null

  /** @type {Array<Omit<ResolutionStep, 'step'>>} */
  const order = [...closure.steps]
  const seen = new Set(order.map(stepKey))
  /** @param {Omit<ResolutionStep, 'step'>} step */
  const pushOrder = (step) => {
    const key = stepKey(step)
    if (seen.has(key)) return
    seen.add(key)
    order.push(step)
  }

  const resolved = list.map((blocker) => {
    const depId = dependencyIdOf(blocker)
    let steps
    if (depId) {
      const walk = dependencyWalk({ roots: [depId], currentId, index })
      steps = walk.steps
      if (steps.length === 0) steps = [{ action: RESOLUTION_ACTION.mergeDependency, missionId: depId }]
    } else if (blocker.code === 'stale-base') {
      steps = [{ action: RESOLUTION_ACTION.rebase }]
    } else {
      steps = [{ action: BLOCKER_ACTION[blocker.code] ?? RESOLUTION_ACTION.resolveBlocker }]
    }
    return { ...blocker, resolution: renumber(steps) }
  })

  // Rebase is a consequence of the dependency order, never a competing first
  // step: every dependency merge is ordered before it even when the integration
  // gate pushed stale-base first.
  if (list.some((blocker) => blocker.code === 'stale-base')) {
    pushOrder({ action: RESOLUTION_ACTION.rebase })
  }
  for (const blocker of list) {
    if (blocker.code === 'deps-unmerged' || blocker.code === 'stale-base') continue
    pushOrder({ action: BLOCKER_ACTION[blocker.code] ?? RESOLUTION_ACTION.resolveBlocker })
  }

  return { blockers: resolved, order: renumber(order), cycle }
}
