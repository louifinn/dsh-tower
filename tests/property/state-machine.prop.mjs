// Model-based property for the mission state machine (M25, #130).
//
// WHAT THIS FILE CHECKS
// ---------------------
// `tests/property/model/` carries an **independent reference model** of the
// mission state machine. It imports nothing from `domain/`: it has its own
// hand-written tables (`tables.mjs`) for mission statuses, status edges, finding
// edges, review verdicts, merge verdicts, pause causes and the ten commands, and
// it predicts every command outcome from those tables. That is what makes it
// possible for the model to disagree with the implementation.
//
// This file drives the *real* pure domain functions against a cloned generated
// state and compares the observable result with the model on every command of a
// `fc.commands` walk over the ten modelled commands:
//
//   plan · activate · complete · review · merge · abandon · rebase · pause ·
//   resume · findings.transition
//
// The command → domain entry point mapping (never a git, fs, subprocess or
// network call — the state is a plain in-memory document):
//
//   plan                normalizeMissionInput → newMission → applyPlan
//   activate/pause/…    applyMissionUpdate            (domain/missions/lifecycle.js)
//   complete            assertCompletionRequest → completionReport → applyCompletion
//   review              normalizeReviewVerdict → reviewAdmission → reviewRound →
//                       reviewOutcome → reviewRecord (+ applyReviewOutcome)
//   merge               mergeGateBlockers (precondition) → applyMergeSuccess
//   rebase              rebaseSuccessResult/rebaseSuccessNote + the state half of
//                       app/rebase.js:260-288 (record mission.rebase, blocked →
//                       active, note) and the caller's single revision bump
//   findings.transition applyFindingUpdate            (domain/missions/findings.js)
//
// PROPERTY 1 — a rejected command is a no-op
// ------------------------------------------
// If the domain throws, the *committed* state is untouched: the state object is
// the same reference, the revision is unchanged, and `JSON.stringify(state)` is
// byte-identical. The command works on a clone (`structuredClone`), exactly like
// the app routes mutate a cached snapshot and persist only on success.
//
// PROPERTY 2 — an accepted command is atomic
// ------------------------------------------
// If the domain accepts, then: `validateState(state)` succeeds on the result,
// the revision moved by exactly one (the single `state.revision += 1` every app
// route performs once per accepted mutation), and the model and the real state
// agree on mission status, open-task counts, blocker counts, finding statuses and
// the review count (`assertModelAgrees`).
//
// The walk asserts both properties on every command; two focused properties
// repeat them over rejection-only and acceptance-only command sets so a failure
// names the property that broke. Every rejection the walk observes is recorded
// and matched against the frozen edge matrix below.
//
// FROZEN COUNTEREXAMPLES
// ----------------------
// No property-tier run (PR seeds 131 / 40961 / 978217, nor the long tier) has
// produced a shrunk counterexample for this model. The permanent record is the
// frozen edge matrix: the exhaustive set of (command, from, to) edges the model
// *rejects*, derived from the model's literal tables and replayed deterministically
// below (plus the resume-authorization edge, which is a rejected edge over a
// legal transition). If a future run exposes a new edge, the watch test fails
// with its key, and the edge must be frozen here in the same commit.
//
// REACHABILITY GUARD
// ------------------
// fast-check drops a command whose `check` returns false instead of retrying it,
// so a command that stopped becoming applicable would silently shrink the walk.
// The final test asserts every one of the ten modelled commands both reached the
// domain and was accepted at least once across the PR tier (skipped while
// replaying a single counterexample via `FC_PATH`).
//
// REPLAY (fast-check, per file)
// -----------------------------
// The harness forwards `FC_SEED` to every property in the file and `FC_PATH` to
// every `fc.check` call, so a failing run prints its seed and shrink path:
//
//   FC_SEED=131 FC_PATH=0:4:0:2 npm run test:property
//   PowerShell: $env:FC_SEED='131'; $env:FC_PATH='0:4:0:2'; npm run test:property
//
// `FC_PATH` applies to every property in this file (the tuple element order is
// `[state, commands]`, so replaying keeps the generated base state and then
// walks the recorded command path). The harness also writes the counterexample
// to `tests/property/.artifacts/` (gitignored).
import assert from 'node:assert/strict'
import test from 'node:test'
import fc from 'fast-check'

import { stateArb } from './arbitraries/index.mjs'
import { runProperty } from './helpers/harness.mjs'
import { TowerToolError } from '../../domain/errors.js'
import { validateState } from '../../domain/state.js'
import { mergeGateBlockers, rebaseWaived } from '../../domain/gate.js'
import { DEFAULT_MAX_REPORT_BYTES, applyCompletion, assertCompletionRequest, completionReport } from '../../domain/missions/completion.js'
import { applyFindingUpdate } from '../../domain/missions/findings.js'
import { applyMissionUpdate } from '../../domain/missions/lifecycle.js'
import { applyPlan, newMission, normalizeMissionInput } from '../../domain/missions/plan.js'
import {
  applyReviewOutcome,
  normalizeReviewVerdict,
  reviewAdmission,
  reviewOutcome,
  reviewRecord,
  reviewRound,
} from '../../domain/missions/review.js'
import { applyMergeSuccess } from '../../domain/integration/merge.js'
import { latestReview, reviewsForBranch } from '../../domain/integration/review.js'
import { rebaseSuccessNote, rebaseSuccessResult } from '../../domain/integration/rebase.js'
import {
  MODEL_COMMANDS,
  MODEL_COMMAND_NAMES,
  MODEL_CONFIG,
  MODEL_FINDING_STATUSES,
  MODEL_MERGE_VERDICTS,
  MODEL_PAUSE_CAUSES,
  MODEL_REJECTION_CODES,
  MODEL_REVIEW_STATUSES,
  MODEL_STATUSES,
  modelCanTransition,
  modelCanTransitionFinding,
} from './model/tables.mjs'
import {
  assertModelAgrees,
  createModel,
  modelCanComplete,
  modelCanMerge,
  modelCanReview,
  modelComplete,
  modelFindingOutcome,
  modelLatestReview,
  modelMerge,
  modelMergeBlockers,
  modelMission,
  modelNextMissionNumber,
  modelNextReviewRound,
  modelPlan,
  modelRebase,
  modelRecordReview,
  modelSetFinding,
  modelSetOwner,
  modelSetStatus,
  modelStatusOutcome,
} from './model/state-machine-model.mjs'

// ---------------------------------------------------------------------------
// Deterministic fixtures. The property never reads the repo config or the clock:
// a fixed config snapshot and a fixed timestamp keep runs reproducible.
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000
const NEW_TIP = 'f'.repeat(40)
const REVIEWER = 'prop-reviewer'
const AUTHORIZATION = 'authorized-by-property'
const REPORT = 'model-based property completion report'
const NOTE = 'model-based property note'
const WORKER_PREFIX = 'prop-worker-'
const PLAN_SCOPE = ['tests/property/**']
const PLAN_TASKS = ['frozen task alpha', 'frozen task beta', 'frozen task gamma']

// ---------------------------------------------------------------------------
// Rejection ledger. Every rejected command the property observes is recorded
// here, keyed `command|from|to|code`, and checked against the frozen matrix in
// the last tests of this file.
// ---------------------------------------------------------------------------

/** @type {Map<string, { command: string, from: string, to: string, code: string }>} */
const OBSERVED_REJECTIONS = new Map()

/**
 * @param {{ command: string, from: string, to: string, code: string }} edge
 * @returns {string}
 */
function edgeKey(edge) {
  return `${edge.command}|${edge.from}|${edge.to}|${edge.code}`
}

/** @param {{ command: string, from: string, to: string, code: string }} edge */
function noteObservedRejection(edge) {
  OBSERVED_REJECTIONS.set(edgeKey(edge), edge)
}

// ---------------------------------------------------------------------------
// State preparation and the shared "attempt" helper.
// ---------------------------------------------------------------------------

/**
 * @param {string} id
 * @returns {number}
 */
function idNumber(id) {
  const match = /(\d+)$/.exec(String(id))
  return match ? Number(match[1]) : 0
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareIds(left, right) {
  const delta = idNumber(left) - idNumber(right)
  if (delta !== 0) return delta
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Clone a generated state into something the domain accepts, then repair the two
 * facts the arbitraries generate independently:
 *
 * - every collection the commands push into must exist (schema-wise the arrays
 *   are optional),
 * - `reviewSeq` / `findingSeq` are generated independently of the review /
 *   finding ids, so they are raised above the highest existing numeric id. A new
 *   record therefore gets a fresh `R<n>` / `F<n>`; `validateState` requires ids
 *   to be unique, and reusing a generated id would make every accepted command
 *   fail validation for a reason the model does not own.
 *
 * @param {Record<string, any>} state
 * @returns {Record<string, any>}
 */
function prepareBaseState(state) {
  const base = structuredClone(state)
  base.schemaVersion = 3
  for (const key of ['missions', 'roster', 'reviews', 'findings', 'messages', 'batches']) {
    if (!Array.isArray(base[key])) base[key] = []
  }
  base.revision = Number.isInteger(base.revision) && base.revision >= 0 ? base.revision : 0
  const highestReviewId = base.reviews.reduce((max, review) => Math.max(max, idNumber(review.id)), 0)
  const highestFindingId = base.findings.reduce((max, finding) => Math.max(max, idNumber(finding.id)), 0)
  base.reviewSeq = Math.max(Number.isInteger(base.reviewSeq) ? base.reviewSeq : 0, highestReviewId)
  base.findingSeq = Math.max(Number.isInteger(base.findingSeq) ? base.findingSeq : 0, highestFindingId)
  return base
}

/** @type {Set<string>} */
const EXECUTED_COMMANDS = new Set()
/** @type {Set<string>} */
const ACCEPTED_COMMANDS = new Set()

/**
 * Execute one command against a clone of the committed state and assert the
 * property that matches the model's prediction.
 *
 * @param {{
 *   model: Record<string, any>,
 *   real: { state: Record<string, any>, tally: { accepted: number, rejected: number } },
 *   expectation: { accept: boolean, code?: string, command: string, label: string },
 *   apply: (draft: Record<string, any>) => void,
 *   onAccept?: () => void,
 * }} params
 * @returns {{ status: 'accepted' } | { status: 'rejected', code: string }}
 */
function executeAttempt({ model, real, expectation, apply, onAccept = () => {} }) {
  const label = expectation.label
  assert.ok(MODEL_COMMANDS[expectation.command], `${label}: "${expectation.command}" is not a modelled command`)
  EXECUTED_COMMANDS.add(expectation.command)
  const beforeState = real.state
  const beforeJson = JSON.stringify(beforeState)
  const beforeRevision = beforeState.revision
  const draft = structuredClone(beforeState)
  /** @type {unknown} */
  let failure = null
  try {
    apply(draft)
  } catch (error) {
    failure = error
  }

  if (failure !== null) {
    // The model said the command is accepted: a throw is a model/domain
    // disagreement, not a tolerable rejection.
    if (expectation.accept) throw failure
    if (!(failure instanceof TowerToolError)) throw failure
    if (expectation.code !== undefined) {
      assert.equal(failure.code, expectation.code, `${label}: unexpected rejection code (${failure.message})`)
    }
    assert.equal(real.state, beforeState, `${label}: a rejected command replaced the committed state`)
    assert.equal(real.state.revision, beforeRevision, `${label}: a rejected command changed the revision`)
    assert.equal(JSON.stringify(real.state), beforeJson, `${label}: a rejected command mutated the committed state`)
    real.tally.rejected += 1
    return { status: 'rejected', code: failure.code }
  }

  if (!expectation.accept) {
    assert.fail(`${label}: the reference model predicted a rejection but the domain accepted the command`)
  }
  validateState(draft, `after ${label}`)
  assert.equal(
    draft.revision,
    beforeRevision + 1,
    `${label}: an accepted command must bump the revision exactly once`,
  )
  real.state = draft
  onAccept()
  assertModelAgrees(model, real.state)
  real.tally.accepted += 1
  ACCEPTED_COMMANDS.add(expectation.command)
  return { status: 'accepted' }
}

/**
 * @param {Record<string, any>} model
 * @param {(mission: Record<string, any>) => boolean} [predicate]
 * @returns {string[]}
 */
function missionIds(model, predicate = () => true) {
  return [...model.missions.keys()]
    .filter((id) => predicate(modelMission(model, id)))
    .sort(compareIds)
}

/**
 * @param {string[]} ids
 * @param {number} index
 * @returns {string | null}
 */
function pickId(ids, index) {
  if (ids.length === 0) return null
  return ids[index % ids.length]
}

// ---------------------------------------------------------------------------
// The ten commands. Each class is stateless: the payload lives in the
// constructor, `check(model)` decides applicability (a `false` command is
// dropped by fast-check, so generation bias comes from the weighted arbitraries
// below), and `run(model, real)` re-resolves its target deterministically.
// ---------------------------------------------------------------------------

class PlanCommand {
  /**
   * @param {number} index
   * @param {number} taskCount
   */
  constructor(index, taskCount) {
    this.index = index
    this.taskCount = taskCount
  }

  get name() {
    return 'plan'
  }

  check() {
    return true
  }

  /** @param {Record<string, any>} model */
  outcome(model) {
    const id = `M${modelNextMissionNumber(model)}`
    return { accept: true, command: this.name, label: `plan ${id}`, missionId: id }
  }

  /**
   * @param {Record<string, any>} model
   * @param {{ state: Record<string, any>, tally: { accepted: number, rejected: number } }} real
   */
  run(model, real) {
    const plan = this.outcome(model)
    const prepared = normalizeMissionInput(
      {
        title: `planned property mission ${this.index}`,
        kind: 'build',
        scope: PLAN_SCOPE,
        tasks: PLAN_TASKS.slice(0, this.taskCount),
      },
      this.index,
    )
    const created = newMission(plan.missionId, prepared, NOW)
    executeAttempt({
      model,
      real,
      expectation: plan,
      apply: (draft) => {
        applyPlan(draft, [created])
        draft.revision += 1
        draft.updatedAt = NOW
      },
      onAccept: () => {
        modelPlan(model, created)
      },
    })
  }

  toString() {
    return `plan(index=${this.index}, tasks=${this.taskCount})`
  }
}

class StatusCommand {
  /**
   * @param {{
   *   name: string,
   *   target: string,
   *   variant: 'apply' | 'illegal-edge' | 'resume-without-authorization',
   *   index: number,
   *   pauseCause?: string,
   * }} payload
   */
  constructor(payload) {
    this.payload = payload
  }

  get name() {
    return this.payload.name
  }

  /**
   * @param {Record<string, any>} model
   * @returns {{ accept: boolean, code?: string, command: string, label: string, missionId: string, from: string, to: string } | null}
   */
  outcome(model) {
    const { target, variant, index } = this.payload
    const id = pickId(missionIds(model), index)
    if (id === null) return null
    const mission = modelMission(model, id)
    const from = mission.status
    const base = { command: this.name, missionId: id, from, to: target }

    if (variant === 'illegal-edge') {
      // Only an edge the model's literal table refuses: a legal edge that fails
      // for another reason (missing resume authorization) is a separate probe.
      if (modelCanTransition(from, target)) return null
      const predicted = modelStatusOutcome(model, id, target, { authorization: false })
      assert.equal(predicted.accept, false, `${this.name} ${id} -> ${target}: model predicted acceptance`)
      return { ...base, accept: false, code: predicted.code, label: `${this.name} ${id} ${from} -> ${target} (illegal edge)` }
    }

    if (variant === 'resume-without-authorization') {
      if (from !== 'paused' || target !== 'active') return null
      const predicted = modelStatusOutcome(model, id, target, { authorization: false })
      if (predicted.accept) return null
      return { ...base, accept: false, code: predicted.code, label: `${this.name} ${id} (missing authorization)` }
    }

    const predicted = modelStatusOutcome(model, id, target, { authorization: true })
    if (!predicted.accept) return null
    return { ...base, accept: true, label: `${this.name} ${id} ${from} -> ${target}` }
  }

  /** @param {Record<string, any>} model */
  check(model) {
    return this.outcome(model) !== null
  }

  /**
   * @param {Record<string, any>} model
   * @param {{ state: Record<string, any>, tally: { accepted: number, rejected: number } }} real
   */
  run(model, real) {
    const plan = this.outcome(model)
    assert.ok(plan !== null, `${this.name}: run() without an applicable target`)
    const missionIndex = real.state.missions.findIndex((mission) => mission.id === plan.missionId)
    assert.ok(missionIndex >= 0, `${this.name} ${plan.missionId}: the real state lost the mission`)
    /** @type {Record<string, any>} */
    const input = { status: plan.to, note: NOTE }
    if (plan.to === 'paused') input.pause_cause = this.payload.pauseCause
    if (this.payload.variant === 'apply') input.authorization = AUTHORIZATION

    const result = executeAttempt({
      model,
      real,
      expectation: plan,
      apply: (draft) => {
        applyMissionUpdate({
          mission: draft.missions[missionIndex],
          state: draft,
          input,
          config: MODEL_CONFIG,
        })
        draft.revision += 1
        draft.updatedAt = NOW
      },
      onAccept: () => {
        modelSetStatus(model, plan.missionId, plan.to, { pauseCause: this.payload.pauseCause })
      },
    })
    if (result.status === 'rejected') {
      noteObservedRejection({ command: plan.command, from: plan.from, to: plan.to, code: result.code })
    }
  }

  toString() {
    return `${this.name}(index=${this.payload.index}, variant=${this.payload.variant}, to=${this.payload.target})`
  }
}

class CompleteCommand {
  /** @param {number} index */
  constructor(index) {
    this.index = index
  }

  get name() {
    return 'complete'
  }

  /** @param {Record<string, any>} model */
  outcome(model) {
    const id = pickId(missionIds(model, (mission) => modelCanComplete(mission)), this.index)
    if (id === null) return null
    return { accept: true, command: this.name, label: `complete ${id}`, missionId: id }
  }

  /** @param {Record<string, any>} model */
  check(model) {
    return this.outcome(model) !== null
  }

  /**
   * @param {Record<string, any>} model
   * @param {{ state: Record<string, any>, tally: { accepted: number, rejected: number } }} real
   */
  run(model, real) {
    const plan = this.outcome(model)
    assert.ok(plan !== null, 'complete: run() without an applicable target')
    const missionIndex = real.state.missions.findIndex((mission) => mission.id === plan.missionId)
    assert.ok(missionIndex >= 0, `complete ${plan.missionId}: the real state lost the mission`)
    // The completion admission resolves the reporting worker from its agent id and
    // requires it to own the mission. The roster arbitrary never links a worker to
    // a mission id, so the command synthesizes the reporting worker on the draft
    // (like a real `tower_spawn` would). Reusing the row keeps roster names unique
    // when the mission is completed again after a non-clean review.
    const workerName = `${WORKER_PREFIX}${plan.missionId}`
    const workerAgentId = `agent-${workerName}`

    executeAttempt({
      model,
      real,
      expectation: plan,
      apply: (draft) => {
        const mission = draft.missions[missionIndex]
        mission.owner = workerName
        const existing = draft.roster.find((row) => row.agentId === workerAgentId)
        if (existing) {
          existing.missionId = mission.id
          existing.state = 'running'
        } else {
          draft.roster.push({
            name: workerName,
            role: 'worker',
            state: 'running',
            missionId: mission.id,
            parentSessionId: `parent-${workerName}`,
            agentId: workerAgentId,
          })
        }
        const worker = assertCompletionRequest({
          mission,
          roster: draft.roster,
          input: { agentId: workerAgentId, report: REPORT },
          maxReportBytes: DEFAULT_MAX_REPORT_BYTES,
        })
        const report = completionReport({
          report: REPORT,
          worker,
          checks: [],
          now: NOW,
          maxReportBytes: DEFAULT_MAX_REPORT_BYTES,
        })
        applyCompletion({ mission, report, now: NOW })
        draft.revision += 1
        draft.updatedAt = NOW
      },
      onAccept: () => {
        modelSetOwner(model, plan.missionId, workerName)
        modelComplete(model, plan.missionId)
      },
    })
  }

  toString() {
    return `complete(index=${this.index})`
  }
}

class ReviewCommand {
  /**
   * @param {string} status
   * @param {string} merge
   * @param {number} index
   */
  constructor(status, merge, index) {
    this.status = status
    this.merge = merge
    this.index = index
  }

  get name() {
    return 'review'
  }

  /** @param {Record<string, any>} model */
  outcome(model) {
    const id = pickId(missionIds(model, (mission) => modelCanReview(model, mission, REVIEWER)), this.index)
    if (id === null) return null
    return {
      accept: true,
      command: this.name,
      label: `review ${id} ${this.status}/${this.merge}`,
      missionId: id,
    }
  }

  /** @param {Record<string, any>} model */
  check(model) {
    return this.outcome(model) !== null
  }

  /**
   * @param {Record<string, any>} model
   * @param {{ state: Record<string, any>, tally: { accepted: number, rejected: number } }} real
   */
  run(model, real) {
    const plan = this.outcome(model)
    assert.ok(plan !== null, 'review: run() without an applicable target')
    const missionIndex = real.state.missions.findIndex((mission) => mission.id === plan.missionId)
    assert.ok(missionIndex >= 0, `review ${plan.missionId}: the real state lost the mission`)
    const verdict = normalizeReviewVerdict({
      status: this.status,
      merge: this.merge,
      findings: this.status === 'clean' ? 'none' : 'p1: one model-based finding',
      decision: 'model-based property verdict',
      checks: [],
    })
    /** @type {Record<string, any> | null} */
    let recorded = null

    executeAttempt({
      model,
      real,
      expectation: plan,
      apply: (draft) => {
        const mission = draft.missions[missionIndex]
        const branch = mission.worktree.branch
        const tip = mission.worktree.baseCommit
        const admission = reviewAdmission({ mission, reviews: draft.reviews, branch, tip })
        const { round } = reviewRound({
          reviews: draft.reviews,
          branch,
          reviewerName: REVIEWER,
          maxRoundsPerReviewer: MODEL_CONFIG.review.maxRoundsPerReviewer,
          round: admission.round,
        })
        // The model owns the round rule too; comparing it here catches a change
        // in the accounting before it reaches the merge gate.
        assert.equal(round, modelNextReviewRound(model, branch), `review ${plan.missionId}: model round prediction`)
        const outcome = reviewOutcome({
          status: verdict.status,
          merge: verdict.merge,
          round,
          reviewerName: REVIEWER,
          appended: admission.appended,
        })
        const seq = (draft.reviewSeq ?? 0) + 1
        draft.reviewSeq = seq
        recorded = reviewRecord({
          seq,
          missionId: mission.id,
          branch,
          tip,
          verdict,
          reviewerName: REVIEWER,
          reviewerRole: 'reviewer',
          round,
          now: NOW,
        })
        draft.reviews.push(recorded)
        applyReviewOutcome({ mission, outcome, now: NOW })
        draft.revision += 1
        draft.updatedAt = NOW
      },
      onAccept: () => {
        assert.ok(recorded !== null)
        modelRecordReview(model, {
          id: String(recorded.id),
          missionId: String(recorded.missionId),
          branch: typeof recorded.branch === 'string' ? recorded.branch : null,
          round: Number(recorded.round),
          status: recorded.status,
          merge: recorded.mergeVerdict,
          tip: typeof recorded.reviewedCommit === 'string' ? recorded.reviewedCommit : null,
          at: Number(recorded.at),
          reviewer: typeof recorded.reviewer === 'string' ? recorded.reviewer : null,
        })
      },
    })
  }

  toString() {
    return `review(${this.status}, ${this.merge}, index=${this.index})`
  }
}

class MergeCommand {
  /** @param {number} index */
  constructor(index) {
    this.index = index
  }

  get name() {
    return 'merge'
  }

  /** @param {Record<string, any>} model */
  outcome(model) {
    const id = pickId(missionIds(model, (mission) => modelCanMerge(model, mission)), this.index)
    if (id === null) return null
    return { accept: true, command: this.name, label: `merge ${id}`, missionId: id }
  }

  /** @param {Record<string, any>} model */
  check(model) {
    return this.outcome(model) !== null
  }

  /**
   * @param {Record<string, any>} model
   * @param {{ state: Record<string, any>, tally: { accepted: number, rejected: number } }} real
   */
  run(model, real) {
    const plan = this.outcome(model)
    assert.ok(plan !== null, 'merge: run() without an applicable target')
    const missionIndex = real.state.missions.findIndex((mission) => mission.id === plan.missionId)
    assert.ok(missionIndex >= 0, `merge ${plan.missionId}: the real state lost the mission`)
    const missionModelState = modelMission(model, plan.missionId)
    const branch = missionModelState.branch
    const branchTip = missionModelState.tip
    assert.ok(branch && branchTip, `merge ${plan.missionId}: the model has no worktree branch/tip`)
    const review = latestReview(reviewsForBranch(real.state.reviews, branch))
    // The model owns the "latest review" rule; the domain selector must agree
    // before the gate result is comparable.
    const modelReview = modelLatestReview(model, branch)
    assert.equal(
      review?.id ?? null,
      modelReview?.id ?? null,
      `merge ${plan.missionId}: model and domain disagree on the latest review of ${branch}`,
    )

    executeAttempt({
      model,
      real,
      expectation: plan,
      apply: (draft) => {
        const mission = draft.missions[missionIndex]
        // The app evaluates the waiver only when a review row exists
        // (app/gate.js:104 `latest ? tower.rebaseWaived(...) : false`); a
        // review-exempt mission can reach the gate without one.
        const waived = review ? rebaseWaived(mission, review) : false
        const blockers = mergeGateBlockers({
          mission,
          roster: [],
          branch,
          branchTip,
          review,
          config: MODEL_CONFIG,
          activity: {},
          parentStatus: null,
          inactiveStates: [],
          rebaseWaived: waived,
        })
        assert.deepEqual(
          blockers.map((blocker) => blocker.code),
          [],
          `merge ${plan.missionId}: the merge gate blocked a merge the model considers reachable`,
        )
        applyMergeSuccess({ mission, branchTip, base: draft.base, newTip: NEW_TIP, now: NOW })
        draft.revision += 1
        draft.updatedAt = NOW
      },
      onAccept: () => {
        modelMerge(model, plan.missionId)
      },
    })
  }

  toString() {
    return `merge(index=${this.index})`
  }
}

class RebaseCommand {
  /** @param {number} index */
  constructor(index) {
    this.index = index
  }

  get name() {
    return 'rebase'
  }

  /** @param {Record<string, any>} model */
  outcome(model) {
    const id = pickId(
      missionIds(model, (mission) => mission.hasWorktree === true && Boolean(mission.branch) && Boolean(mission.tip)),
      this.index,
    )
    if (id === null) return null
    return { accept: true, command: this.name, label: `rebase ${id}`, missionId: id }
  }

  /** @param {Record<string, any>} model */
  check(model) {
    return this.outcome(model) !== null
  }

  /**
   * Mirror the state half of the app route (app/rebase.js:260-288) without git:
   * record the reviewed-tip waiver on `mission.rebase`, return a blocked mission
   * to active, append the success note, then bump the revision exactly once.
   * @param {Record<string, any>} model
   * @param {{ state: Record<string, any>, tally: { accepted: number, rejected: number } }} real
   */
  run(model, real) {
    const plan = this.outcome(model)
    assert.ok(plan !== null, 'rebase: run() without an applicable target')
    const missionModelState = modelMission(model, plan.missionId)
    const oldTip = missionModelState.tip
    assert.ok(oldTip, `rebase ${plan.missionId}: the model has no tip`)

    executeAttempt({
      model,
      real,
      expectation: plan,
      apply: (draft) => {
        const outcome = rebaseSuccessResult({ oldTip, newTip: NEW_TIP, baseTip: NEW_TIP })
        assert.equal(outcome.ok, true, `rebase ${plan.missionId}: the pure success helper refused a conflict-free rebase`)
        assert.equal(outcome.reviewWaived, true, `rebase ${plan.missionId}: a conflict-free rebase must waive re-review`)
        const mission = draft.missions.find((entry) => entry.id === plan.missionId)
        assert.ok(mission, `rebase ${plan.missionId}: the real state lost the mission`)
        mission.rebase = { at: NOW, oldTip, newTip: NEW_TIP, baseTip: NEW_TIP }
        if (mission.status === 'blocked') mission.status = 'active'
        mission.notes = mission.notes ?? []
        mission.notes.push(rebaseSuccessNote({ oldTip, newTip: NEW_TIP, baseTip: NEW_TIP }))
        mission.updatedAt = NOW
        draft.revision += 1
        draft.updatedAt = NOW
      },
      onAccept: () => {
        modelRebase(model, plan.missionId, { at: NOW, oldTip, newTip: NEW_TIP })
      },
    })
  }

  toString() {
    return `rebase(index=${this.index})`
  }
}

class FindingsTransitionCommand {
  /**
   * @param {string} target
   * @param {number} index
   * @param {'apply' | 'illegal-edge'} variant
   */
  constructor(target, index, variant) {
    this.target = target
    this.index = index
    this.variant = variant
  }

  get name() {
    return 'findings.transition'
  }

  /** @param {Record<string, any>} model */
  outcome(model) {
    const ids = [...model.findings.keys()].sort(compareIds)
    const id = pickId(ids, this.index)
    if (id === null) return null
    const from = model.findings.get(id)
    if (this.variant === 'illegal-edge' && modelCanTransitionFinding(from, this.target)) return null
    if (this.variant === 'apply' && !modelCanTransitionFinding(from, this.target)) return null
    const predicted = modelFindingOutcome(model, id, this.target)
    if (this.variant === 'apply' && !predicted.accept) return null
    if (this.variant === 'illegal-edge' && predicted.accept) return null
    return {
      accept: predicted.accept,
      code: predicted.code,
      command: this.name,
      label: `findings.transition ${id} ${from} -> ${this.target}`,
      findingId: id,
      from,
      to: this.target,
    }
  }

  /** @param {Record<string, any>} model */
  check(model) {
    return this.outcome(model) !== null
  }

  /**
   * @param {Record<string, any>} model
   * @param {{ state: Record<string, any>, tally: { accepted: number, rejected: number } }} real
   */
  run(model, real) {
    const plan = this.outcome(model)
    assert.ok(plan !== null, 'findings.transition: run() without an applicable target')
    const findingIndex = real.state.findings.findIndex((finding) => finding.id === plan.findingId)
    assert.ok(findingIndex >= 0, `findings.transition ${plan.findingId}: the real state lost the finding`)
    const result = executeAttempt({
      model,
      real,
      expectation: plan,
      apply: (draft) => {
        applyFindingUpdate({
          finding: draft.findings[findingIndex],
          input: { status: plan.to, note: 'model-based property finding note' },
          actor: { name: 'tower', role: 'tower' },
          now: NOW,
        })
        draft.revision += 1
        draft.updatedAt = NOW
      },
      onAccept: () => {
        modelSetFinding(model, plan.findingId, plan.to)
      },
    })
    if (result.status === 'rejected') {
      noteObservedRejection({ command: plan.command, from: plan.from, to: plan.to, code: result.code })
    }
  }

  toString() {
    return `findings.transition(${this.target}, index=${this.index}, variant=${this.variant})`
  }
}

// ---------------------------------------------------------------------------
// Command arbitraries. Applicability is decided by `check(model)`; the weights
// below are what keeps long walks from spending their budget on dropped
// commands. Rejection probes are separate command instances so they can never be
// confused with the acceptance path.
// ---------------------------------------------------------------------------

const indexArb = fc.integer({ min: 0, max: 16 })
const planArb = fc
  .tuple(indexArb, fc.integer({ min: 0, max: PLAN_TASKS.length }))
  .map(([index, taskCount]) => new PlanCommand(index, taskCount))

/**
 * @param {string} name
 * @param {string} target
 * @param {'apply' | 'illegal-edge' | 'resume-without-authorization'} variant
 * @param {boolean} withPauseCause
 */
function statusCommandArb(name, target, variant, withPauseCause) {
  const causeArb = withPauseCause ? fc.constantFrom(...MODEL_PAUSE_CAUSES) : fc.constant(undefined)
  return fc
    .tuple(indexArb, causeArb)
    .map(([index, pauseCause]) => new StatusCommand({ name, target, variant, index, pauseCause }))
}

const activateArb = statusCommandArb('activate', 'active', 'apply', false)
const pauseArb = statusCommandArb('pause', 'paused', 'apply', true)
const resumeArb = statusCommandArb('resume', 'active', 'apply', false)
const abandonArb = statusCommandArb('abandon', 'abandoned', 'apply', false)
const completeArb = indexArb.map((index) => new CompleteCommand(index))
const reviewArb = fc
  .tuple(fc.constantFrom(...MODEL_REVIEW_STATUSES), fc.constantFrom(...MODEL_MERGE_VERDICTS), indexArb)
  .map(([status, merge, index]) => new ReviewCommand(status, merge, index))
const mergeArb = indexArb.map((index) => new MergeCommand(index))
const rebaseArb = indexArb.map((index) => new RebaseCommand(index))
const findingApplyArb = fc
  .tuple(fc.constantFrom(...MODEL_FINDING_STATUSES), indexArb)
  .map(([target, index]) => new FindingsTransitionCommand(target, index, 'apply'))

const rejectionStatusArb = [
  statusCommandArb('activate', 'active', 'illegal-edge', false),
  statusCommandArb('pause', 'paused', 'illegal-edge', true),
  statusCommandArb('abandon', 'abandoned', 'illegal-edge', false),
  statusCommandArb('resume', 'active', 'resume-without-authorization', false),
]
const rejectionFindingArb = fc
  .tuple(fc.constantFrom(...MODEL_FINDING_STATUSES), indexArb)
  .map(([target, index]) => new FindingsTransitionCommand(target, index, 'illegal-edge'))

/** Every modelled command, weighted for a productive walk. */
const ALL_COMMAND_ARBITRARIES = [
  { weight: 1, arbitrary: planArb },
  { weight: 3, arbitrary: activateArb },
  { weight: 2, arbitrary: pauseArb },
  { weight: 2, arbitrary: resumeArb },
  { weight: 2, arbitrary: abandonArb },
  { weight: 3, arbitrary: completeArb },
  { weight: 3, arbitrary: reviewArb },
  { weight: 2, arbitrary: mergeArb },
  { weight: 1, arbitrary: rebaseArb },
  { weight: 3, arbitrary: findingApplyArb },
]

/** Only commands the model predicts to be rejected. */
const REJECTION_COMMAND_ARBITRARIES = [
  { weight: 4, arbitrary: rejectionStatusArb[0] },
  { weight: 3, arbitrary: rejectionStatusArb[1] },
  { weight: 2, arbitrary: rejectionStatusArb[2] },
  { weight: 2, arbitrary: rejectionStatusArb[3] },
  { weight: 6, arbitrary: rejectionFindingArb },
]

/** Only commands the model predicts to be accepted. */
const ACCEPTANCE_COMMAND_ARBITRARIES = [
  { weight: 1, arbitrary: planArb },
  { weight: 3, arbitrary: activateArb },
  { weight: 2, arbitrary: pauseArb },
  { weight: 2, arbitrary: resumeArb },
  { weight: 2, arbitrary: abandonArb },
  { weight: 3, arbitrary: completeArb },
  { weight: 3, arbitrary: reviewArb },
  { weight: 2, arbitrary: mergeArb },
  { weight: 1, arbitrary: rebaseArb },
  { weight: 3, arbitrary: findingApplyArb },
]

/** @param {unknown} value */
function commandCount(value) {
  return [...value].length
}

/**
 * Prepare the model and the committed real state for one generated base state.
 * @param {Record<string, any>} state
 */
function openSession(state) {
  /** @type {Record<string, any>} */
  const base = prepareBaseState(state)
  /** @type {{ state: Record<string, any>, tally: { accepted: number, rejected: number } }} */
  const real = { state: base, tally: { accepted: 0, rejected: 0 } }
  const model = createModel(base)
  return { model, real }
}

// ---------------------------------------------------------------------------
// Property: the full model-based walk (both properties on every command).
// ---------------------------------------------------------------------------

runProperty({
  name: 'state machine: the model predicts every command outcome and the revision moves at most once per command',
  arbitrary: fc.tuple(stateArb, fc.commands(ALL_COMMAND_ARBITRARIES, { maxCommands: 24 })),
  classify: (value) => `${commandCount(value[1])} commands`,
  predicate: (value) => {
    const [state, commands] = value
    const { model, real } = openSession(state)
    fc.modelRun(() => ({ model, real }), commands)
    validateState(real.state, 'after the model-based walk')
    assertModelAgrees(model, real.state)
  },
})

runProperty({
  name: 'state machine: a rejected command is a no-op (same state object, revision and bytes)',
  arbitrary: fc.tuple(stateArb, fc.commands(REJECTION_COMMAND_ARBITRARIES, { maxCommands: 6 })),
  predicate: (value) => {
    const [state, commands] = value
    const { model, real } = openSession(state)
    fc.modelRun(() => ({ model, real }), commands)
    fc.pre(real.tally.rejected > 0)
    assert.equal(real.tally.accepted, 0, 'the rejection-only command set accepted a command the model rejects')
    validateState(real.state, 'after the rejection-only walk')
  },
})

runProperty({
  name: 'state machine: an accepted command is atomic (revision +1, valid state, model agrees)',
  arbitrary: fc.tuple(stateArb, fc.commands(ACCEPTANCE_COMMAND_ARBITRARIES, { maxCommands: 6 })),
  predicate: (value) => {
    const [state, commands] = value
    const { model, real } = openSession(state)
    const beforeRevision = real.state.revision
    fc.modelRun(() => ({ model, real }), commands)
    fc.pre(real.tally.accepted > 0)
    assert.equal(real.tally.rejected, 0, 'the acceptance-only command set rejected a command the model accepts')
    assert.equal(
      real.state.revision,
      beforeRevision + real.tally.accepted,
      'an accepted command must bump the committed revision exactly once',
    )
    validateState(real.state, 'after the acceptance-only walk')
    assertModelAgrees(model, real.state)
  },
})

// ---------------------------------------------------------------------------
// Property: the merge gate. `mergeGateBlockers` is pure, so it can be compared
// directly with the model for every mission of a generated state. This is the
// part of the state machine the command walk reaches least often (a merge needs
// a completed mission with a clean, approving review for the current tip).
// ---------------------------------------------------------------------------

runProperty({
  name: 'merge gate: the model predicts every blocker the domain reports for every generated mission',
  arbitrary: stateArb,
  classify: (state) => `${(state.missions ?? []).length} missions`,
  predicate: (state) => {
    const base = prepareBaseState(state)
    const model = createModel(base)
    for (const mission of base.missions) {
      const missionModelState = modelMission(model, mission.id)
      const branch = missionModelState.branch
      const review = latestReview(reviewsForBranch(base.reviews, branch))
      const modelReview = modelLatestReview(model, branch)
      assert.equal(
        review?.id ?? null,
        modelReview?.id ?? null,
        `mission ${mission.id}: model and domain disagree on the latest review of ${String(branch)}`,
      )
      const actual = mergeGateBlockers({
        mission,
        roster: [],
        branch,
        branchTip: missionModelState.tip,
        review,
        config: MODEL_CONFIG,
        activity: {},
        parentStatus: null,
        inactiveStates: [],
        rebaseWaived: rebaseWaived(mission, review),
      }).map((blocker) => blocker.code)
      const expected = modelMergeBlockers(model, missionModelState)
      assert.deepEqual(
        [...actual].sort(),
        [...expected].sort(),
        `mission ${mission.id}: domain merge blockers disagree with the reference model`,
      )
    }
  },
})

// ---------------------------------------------------------------------------
// Deterministic example tests.
// ---------------------------------------------------------------------------

/**
 * A minimal in-memory state for the frozen replays. No file, no repository: the
 * domain functions under test are pure.
 * @param {{ status?: string, pauseCause?: string | null, findingStatus?: string }} [options]
 * @returns {Record<string, any>}
 */
function frozenState(options = {}) {
  const status = options.status ?? 'planned'
  const findingStatus = options.findingStatus ?? 'open'
  /** @type {Record<string, any>} */
  const mission = {
    id: 'M1',
    title: 'frozen edge mission',
    kind: 'build',
    scope: ['tests/property/**'],
    tasks: [{ text: 'frozen edge task', status: 'done' }],
    deps: [],
    context: '',
    references: [],
    reviewPolicy: 'required-clean',
    status,
    owner: null,
    blockers: [],
    notes: [],
    scopeGeneration: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }
  if (options.pauseCause !== undefined && options.pauseCause !== null) mission.pauseCause = options.pauseCause
  return {
    schemaVersion: 3,
    revision: 7,
    base: 'main',
    repoRoot: '/tmp/tower-property',
    commonDir: '/tmp/tower-property/.git',
    createdAt: NOW,
    updatedAt: NOW,
    dirtyBase: false,
    caseInsensitive: false,
    towerAgentId: 'tower-frozen',
    snapshotCommit: null,
    snapshotRef: null,
    missions: [mission],
    roster: [],
    reviews: [],
    findings: [
      {
        id: 'F1',
        type: 'bug',
        title: 'frozen edge finding',
        severity: 'low',
        status: findingStatus,
        summary: 'summary',
        details: 'details',
        suggestedFix: 'fix',
        at: NOW,
        updatedAt: NOW,
      },
    ],
    messages: [],
    batches: [],
    messageSeq: 0,
    reviewSeq: 0,
    findingSeq: 1,
    batchSeq: 0,
    deliverySeq: 0,
    mergeIntent: null,
    rebaseIntent: null,
  }
}

/**
 * Apply one status patch/status command attempt to a clone and return the
 * rejection code (or `null` when the domain accepted).
 * @param {Record<string, any>} state
 * @param {string} target
 * @param {{ authorization?: boolean, pauseCause?: string }} [options]
 * @returns {string | null}
 */
function attemptStatus(state, target, options = {}) {
  const draft = structuredClone(state)
  /** @type {Record<string, any>} */
  const input = { status: target, note: NOTE }
  if (target === 'paused') input.pause_cause = options.pauseCause ?? 'user'
  if (options.authorization !== false) input.authorization = AUTHORIZATION
  try {
    applyMissionUpdate({ mission: draft.missions[0], state: draft, input, config: MODEL_CONFIG })
  } catch (error) {
    assert.ok(error instanceof TowerToolError, `status ${target}: expected a domain rejection, got ${String(error)}`)
    return error.code
  }
  validateState(draft, `status ${target}`)
  assert.equal(draft.revision, state.revision, 'the helper does not bump the revision itself')
  return null
}

/**
 * @param {Record<string, any>} state
 * @param {string} target
 * @returns {string | null}
 */
function attemptFinding(state, target) {
  const draft = structuredClone(state)
  try {
    applyFindingUpdate({
      finding: draft.findings[0],
      input: { status: target },
      actor: { name: 'tower', role: 'tower' },
      now: NOW,
    })
  } catch (error) {
    assert.ok(error instanceof TowerToolError, `finding ${target}: expected a domain rejection, got ${String(error)}`)
    return error.code
  }
  assert.equal(draft.findings[0].status, target)
  return null
}

/**
 * The literal frozen matrix: every edge the model refuses, plus the
 * resume-authorization edge over a legal transition. Replayed one by one below.
 * @type {ReadonlyArray<readonly [string, string, string]>}
 */
const FROZEN_STATUS_EDGES = Object.freeze([
  ['activate', 'active', 'active'],
  ['activate', 'merged', 'active'],
  ['activate', 'abandoned', 'active'],
  ['pause', 'planned', 'paused'],
  ['pause', 'completed', 'paused'],
  ['pause', 'paused', 'paused'],
  ['pause', 'merged', 'paused'],
  ['pause', 'abandoned', 'paused'],
  ['abandon', 'merged', 'abandoned'],
  ['abandon', 'abandoned', 'abandoned'],
  ['resume', 'paused', 'active'],
])

/** @type {ReadonlyArray<readonly [string, string]>} */
const FROZEN_FINDING_EDGES = Object.freeze([
  ['open', 'open'],
  ['triaged', 'triaged'],
  ['fixed', 'triaged'],
  ['fixed', 'fixed'],
  ['fixed', 'wontfix'],
  ['wontfix', 'triaged'],
  ['wontfix', 'fixed'],
  ['wontfix', 'wontfix'],
])

test('frozen edge matrix: it is the complete set of edges the model tables refuse', () => {
  /** @type {Set<string>} */
  const expectedStatus = new Set()
  for (const [target] of [
    ['active'],
    ['paused'],
    ['abandoned'],
  ]) {
    for (const from of MODEL_STATUSES) {
      if (!modelCanTransition(from, target)) expectedStatus.add(`${from}|${target}`)
    }
  }
  // `resume` is the authorization edge: the transition is legal, the missing
  // authorization reference rejects it.
  expectedStatus.add('paused|active')
  const frozenStatus = new Set(FROZEN_STATUS_EDGES.map(([, from, to]) => `${from}|${to}`))
  assert.deepEqual(
    [...frozenStatus].sort(),
    [...expectedStatus].sort(),
    'the frozen status matrix must cover every status edge the model refuses',
  )

  /** @type {Set<string>} */
  const expectedFinding = new Set()
  for (const from of MODEL_FINDING_STATUSES) {
    for (const to of MODEL_FINDING_STATUSES) {
      if (!modelCanTransitionFinding(from, to)) expectedFinding.add(`${from}|${to}`)
    }
  }
  const frozenFinding = new Set(FROZEN_FINDING_EDGES.map(([from, to]) => `${from}|${to}`))
  assert.deepEqual(
    [...frozenFinding].sort(),
    [...expectedFinding].sort(),
    'the frozen finding matrix must cover every finding edge the model refuses',
  )
})

test('frozen status matrix: every refused edge rejects and leaves the state byte-identical (seed 131)', () => {
  for (const [command, from, to] of FROZEN_STATUS_EDGES) {
    const state = frozenState({ status: from, pauseCause: from === 'paused' ? 'user' : null })
    const before = JSON.stringify(state)
    const authorization = command === 'resume' ? false : true
    const code = attemptStatus(state, to, { authorization, pauseCause: to === 'paused' ? 'user' : undefined })
    assert.equal(
      code,
      command === 'resume' ? MODEL_REJECTION_CODES.authorization : MODEL_REJECTION_CODES.status,
      `${command}: ${from} -> ${to}`,
    )
    assert.equal(JSON.stringify(state), before, `${command}: a rejected command mutated the committed state`)
    noteObservedRejection({ command, from, to, code: String(code) })
  }
})

test('frozen finding matrix: every refused edge rejects and leaves the state byte-identical (seed 131)', () => {
  for (const [from, to] of FROZEN_FINDING_EDGES) {
    const state = frozenState({ findingStatus: from })
    const before = JSON.stringify(state)
    const code = attemptFinding(state, to)
    assert.equal(code, MODEL_REJECTION_CODES.finding, `findings.transition: ${from} -> ${to}`)
    assert.equal(JSON.stringify(state), before, 'a rejected finding transition mutated the committed state')
    noteObservedRejection({ command: 'findings.transition', from, to, code: String(code) })
  }
})

test('frozen status table: all 49 status pairs agree with the model', () => {
  for (const from of MODEL_STATUSES) {
    for (const to of MODEL_STATUSES) {
      const state = frozenState({ status: from })
      const before = JSON.stringify(state)
      const code = attemptStatus(state, to)
      const expected = modelCanTransition(from, to)
      assert.equal(code === null, expected, `${from} -> ${to}: the model and the domain disagree`)
      if (!expected) {
        assert.equal(code, MODEL_REJECTION_CODES.status, `${from} -> ${to}: rejection code`)
        assert.equal(JSON.stringify(state), before, `${from} -> ${to}: a rejected command mutated the state`)
        noteObservedRejection({ command: 'status', from, to, code: MODEL_REJECTION_CODES.status })
      }
    }
  }
})

test('frozen finding table: all 16 finding pairs agree with the model', () => {
  for (const from of MODEL_FINDING_STATUSES) {
    for (const to of MODEL_FINDING_STATUSES) {
      const state = frozenState({ findingStatus: from })
      const before = JSON.stringify(state)
      const code = attemptFinding(state, to)
      const expected = modelCanTransitionFinding(from, to)
      assert.equal(code === null, expected, `${from} -> ${to}: the model and the domain disagree`)
      if (!expected) {
        assert.equal(code, MODEL_REJECTION_CODES.finding, `${from} -> ${to}: rejection code`)
        assert.equal(JSON.stringify(state), before, `${from} -> ${to}: a rejected transition mutated the state`)
      }
    }
  }
})

test('frozen completion edge: completion admission refuses a mission without an owned, running worker', () => {
  const state = frozenState({ status: 'active' })
  const draft = structuredClone(state)
  const mission = draft.missions[0]
  mission.tasks = [{ text: 'done task', status: 'done' }]
  assert.equal(mission.status, 'active')
  assert.equal(mission.worktree ?? null, null, 'the frozen state deliberately has no worktree')
  let failure = null
  try {
    assertCompletionRequest({ mission, roster: [], input: { agentId: 'agent-missing', report: REPORT } })
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof TowerToolError, 'a missing worktree/worker must be refused')
  assert.equal(failure.code, MODEL_REJECTION_CODES.completion)
  assert.equal(JSON.stringify(state), JSON.stringify(frozenState({ status: 'active' })), 'the frozen base state is immutable')
})

test('observed rejections: every edge the property walked is in the frozen matrix', () => {
  /** @type {Set<string>} */
  const frozen = new Set()
  for (const [command, from, to] of FROZEN_STATUS_EDGES) {
    const code = command === 'resume' ? MODEL_REJECTION_CODES.authorization : MODEL_REJECTION_CODES.status
    frozen.add(edgeKey({ command, from, to, code }))
  }
  for (const [from, to] of FROZEN_FINDING_EDGES) {
    frozen.add(edgeKey({ command: 'findings.transition', from, to, code: MODEL_REJECTION_CODES.finding }))
  }
  // The status table test replays the same edges under the generic "status"
  // command label; that label is a table-wide replay, not a modelled command.
  for (const [key, edge] of OBSERVED_REJECTIONS) {
    if (edge.command === 'status') continue
    assert.ok(
      frozen.has(key),
      `observed rejection ${key} is not in the frozen edge matrix: add it to FROZEN_STATUS_EDGES/FROZEN_FINDING_EDGES (${JSON.stringify(edge)})`,
    )
  }
})

test('command registry: the property drives exactly the ten modelled commands', () => {
  assert.deepEqual([...MODEL_COMMAND_NAMES], [
    'plan',
    'activate',
    'complete',
    'review',
    'merge',
    'abandon',
    'rebase',
    'pause',
    'resume',
    'findings.transition',
  ])
  for (const name of MODEL_COMMAND_NAMES) assert.ok(MODEL_COMMANDS[name].kind, `${name}: missing command kind`)
})

// A model-based property is vacuous when a command never becomes applicable:
// fast-check silently drops commands whose `check` is false, so a reachability
// regression would hide behind a green suite. This guard runs after every
// property above and fails if any modelled command never reached the domain
// during the PR tier. Replaying a single counterexample (FC_PATH) skips most
// commands on purpose, so the guard is skipped while replaying.
test('coverage: every modelled command reached the domain at least once', () => {
  if (process.env.FC_PATH) return
  const missing = [...MODEL_COMMAND_NAMES].filter((name) => !EXECUTED_COMMANDS.has(name))
  assert.deepEqual(missing, [], `commands never executed by any property: ${missing.join(', ')}`)
  const unknown = [...EXECUTED_COMMANDS].filter((name) => !MODEL_COMMANDS[name])
  assert.deepEqual(unknown, [], `commands executed but not modelled: ${unknown.join(', ')}`)
  const neverAccepted = [...MODEL_COMMAND_NAMES].filter((name) => !ACCEPTED_COMMANDS.has(name))
  assert.deepEqual(neverAccepted, [], `commands never accepted by any property: ${neverAccepted.join(', ')}`)
})
