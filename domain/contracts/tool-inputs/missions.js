// tower_plan / tower_mission / tower_status / tower_complete / tower_review /
// tower_preflight input contracts. Pure TypeBox only; no I/O.
//
// #163: no schema advertises `repoRoot`; the runtime resolves the calling
// session's repository. Alias fields stay accepted through the tool
// definitions' `aliases` maps but are no longer advertised.
import {
  MERGE_VERDICTS,
  MISSION_KINDS,
  MISSION_STATUSES,
  PAUSE_CAUSES,
  REVIEW_POLICIES,
  STATUS_FORMATS,
} from '../../vocabulary.js'
import { Type, enumOf } from './shared.js'

export const PlanInput = Type.Object({
  missions: Type.Array(
    Type.Object({
      title: Type.String({ description: 'Printable Unicode mission title, NFC-normalized, at most 120 characters; used as the mission label.' }),
      key: Type.Optional(Type.String({ description: 'Plan-local handle (trimmed, at most 64 characters; not M<number>-shaped) that this plan\'s other missions may name in deps. Resolved to the assigned mission id at creation; never persisted.' })),
      scope: Type.Optional(Type.Array(Type.String(), { description: 'Relative file globs this mission may touch; empty only for survey. Each entry must match a tracked file (or name an existing directory); pass allowMissingScope to accept a path this mission will create.' })),
      allowMissingScope: Type.Optional(Type.Boolean({ description: 'Accept scope entries that match no tracked file yet, for paths this mission will create; recorded as a scope.unverified activity entry. The same opt-in works for a later planned edit or widen.' })),
      tasks: Type.Optional(Type.Array(Type.String(), { description: 'Verifiable task items the worker ticks off.' })),
      deps: Type.Optional(Type.Array(Type.String(), { description: 'Mission ids that must be satisfied before this one: merged for a build, completed for a survey. A dep may also name an existing mission id, a key defined by this plan, or a would-be id this plan assigns.' })),
      kind: Type.Optional(enumOf(MISSION_KINDS, { description: 'build = writes code behind a review gate; survey = read-only investigation that reserves no scope; artifact = writes deliverables (declared via artifacts) that a human accepts at the committed tip instead of a review.' })),
      artifacts: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: 'Artifact only: the concrete deliverable paths (no globs) the mission must land. Each path must be inside the mission scope and committed at the branch tip before tower_complete admits completion; the merge gate additionally needs a human acceptance of the whole tip.' })),
      context: Type.Optional(Type.String({ description: "The user's own key sentences, verbatim (max 4096 chars)." })),
      references: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: 'Read-only pointers/files the worker should read (max 20); copied into the briefing.' })),
      reviewPolicy: Type.Optional(enumOf(REVIEW_POLICIES, { description: 'required-clean (mission default) means a clean review is required when review.mode is required; none needs reviewExemptionReason, and with the review gate on it also needs gates.allowReviewExemption.' })),
      reviewExemptionReason: Type.Optional(Type.String({ description: 'Non-empty justification when reviewPolicy is "none".' })),
    }, { additionalProperties: false }),
    { description: 'Missions to create, in intended order.' },
  ),
  dry_run: Type.Optional(Type.Boolean({ description: 'Preview the plan without creating missions, writing state, or bumping the revision: returns per-mission wouldBeId, resolved deps, overlaps, and every problem found. A real failed plan reports the same complete problem set.' })),
}, { additionalProperties: false })

// The per-mission fields shared by the single form and a bulk item. A bulk item
// additionally requires `id`. Human acceptance (`accept`/`accept_note`) stays a
// single-mission action: it goes through the DSH approval channel once.
const missionFields = {
  status: Type.Optional(enumOf(MISSION_STATUSES, { description: 'New lifecycle status.' })),
  note: Type.Optional(Type.String({ description: 'Append a decision-log note.' })),
  blocker: Type.Optional(Type.String({ description: 'Report a blocker (also sets status to blocked).' })),
  clear_blockers: Type.Optional(Type.Boolean({ description: 'Clear all recorded blockers.' })),
  task_done: Type.Optional(Type.String({ description: 'Mark the first open task containing this text as done.' })),
  task_drop: Type.Optional(Type.String({ description: 'Mark the first open task containing this text as dropped.' })),
  task_drop_reason: Type.Optional(Type.String({ description: 'Required with task_drop: why the task is dropped.' })),
  task_add: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 20, description: 'Append 1–20 non-empty task strings (max 200 characters) at the task-list tail as open tasks; refused on completed, merged, or abandoned missions.' })),
  scope: Type.Optional(Type.Array(Type.String(), { description: 'Tower only: replacement scope globs. A planned mission edits its fence and keeps planned-edit order; an active or completed one widens and starts; bumps scopeGeneration.' })),
  allowMissingScope: Type.Optional(Type.Boolean({ description: 'With scope: accept entries matching no tracked file yet, for paths this mission will create; recorded as one scope.unverified activity entry, not stored on the mission.' })),
  deferred: Type.Optional(Type.Boolean({ description: 'Tower only: step a planned or active mission that owns paths (build or artifact) out of the overlap check; pass false to rejoin. It never blocks another mission from widening.' })),
  widen: Type.Optional(Type.Object({
    mode: Type.Optional(Type.String({ description: 'refuse (default) names every conflicting neighbour with its status and kind and changes nothing; defer-conflicts defers the planned ones in the same call.' })),
    restoreDeferrals: Type.Optional(Type.Boolean({ description: 'Clear exactly the deferred flags an earlier widen deferred on this mission\'s behalf; a human-set flag stays.' })),
    keepStatus: Type.Optional(Type.Boolean({ description: 'With scope: keep the receiver\'s status instead of returning a completed mission to active, so a reviewer can spawn straight away.' })),
  }, { additionalProperties: false, description: 'Tower only, single form: how one call treats a widen\'s conflicting neighbours. Without scope it must set restoreDeferrals.' })),
  pause_cause: Type.Optional(enumOf(PAUSE_CAUSES, { description: 'With status=paused: why the mission was paused (default user).' })),
  authorization: Type.Optional(Type.String({ description: 'Authorization reference recorded when resuming a user-paused mission.' })),
}

const acceptanceFields = {
  accept: Type.Optional(Type.Boolean({ description: "Artifact only: record the human acceptance of the mission's committed tip through the DSH approval channel; never auto-recorded." })),
  accept_note: Type.Optional(Type.String({ description: 'Optional note stored on the acceptance record (max 4000 chars).' })),
}

export const MissionInput = Type.Object({
  id: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: missionId). Pass exactly one of id, missions, or ids.' })),
  ...missionFields,
  ...acceptanceFields,
  missions: Type.Optional(Type.Array(
    Type.Object({ id: Type.String({ description: 'Mission id, e.g. M1.' }), ...missionFields }, { additionalProperties: false }),
    { minItems: 1, description: 'Bulk form: update several missions in one call, each item carrying an id plus the same per-mission fields as the single form. Mutually exclusive with id and ids.' },
  )),
  ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: 'Bulk shorthand for a pure lifecycle update: apply the lifecycle fields on this call (status, note, blocker, clear_blockers, deferred, pause_cause, authorization) to every listed mission. Mutually exclusive with id and missions; use missions for scope or task edits.' })),
  atomic: Type.Optional(Type.Boolean({ description: 'Bulk only: true (default) applies the batch all-or-nothing; false applies items in order and reports each result, continuing after a failure.' })),
}, { additionalProperties: false })

export const StatusInput = Type.Object({
  missionId: Type.Optional(Type.String({ description: 'Return full detail for one mission instead of the dashboard list.' })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Mission list offset (default 0).' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Mission list page size (default 20).' })),
  includeGate: Type.Optional(Type.Boolean({ description: 'Compute gate digests for missions on this page.' })),
  includeArchived: Type.Optional(Type.Boolean({ description: 'Append archived terminal missions (compact summaries, marked archived:true) after the active page. The default dashboard and board list active missions only.' })),
  format: Type.Optional(enumOf(STATUS_FORMATS, { description: 'markdown returns the MISSIONS.md board text.' })),
}, { additionalProperties: false })

export const CompleteInput = Type.Object({
  missionId: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: id).' })),
  report: Type.String({ description: 'Full completion report for the tower and the next review round.' }),
  result: Type.Optional(
    Type.Object({
      paths: Type.Optional(Type.Array(Type.String(), { maxItems: 200, description: 'Survey only: paths the read touched or found relevant.' })),
      symbols: Type.Optional(Type.Array(Type.String(), { maxItems: 200, description: 'Survey only: symbols the read identified.' })),
      plan: Type.Optional(Type.Array(Type.String(), { maxItems: 200, description: 'Survey only: the ordered plan or next steps the read recommends.' })),
      notes: Type.Optional(Type.String({ description: 'Survey only: short free-form evidence (max 4000 chars).' })),
    }, { additionalProperties: false, description: 'Survey evidence; a build completion may not carry one.' }),
  ),
  checks: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String({ description: 'What was checked.' }),
        command: Type.Optional(Type.String({ description: 'Command or method used.' })),
        exitCode: Type.Optional(Type.Integer({ description: 'Observed exit code.' })),
        evidence: Type.Optional(Type.String({ description: 'Short evidence line/log reference.' })),
        runId: Type.Optional(Type.String({ description: 'Id of a recorded test run (an entry in testRuns, e.g. run-3) returned by tower_test or tower_verify.' })),
      }, { additionalProperties: false }),
      { description: 'Optional evidence ledger entries: {name, command?, exitCode?, evidence?}.' },
    ),
  ),
}, { additionalProperties: false })

export const ReviewInput = Type.Object({
  missionId: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: id).' })),
  status: Type.String({ description: 'Verdict: "clean", or "p1-Nitems" / "p2-Nitems" with the number of findings at that priority.' }),
  merge: enumOf(MERGE_VERDICTS, { description: 'Merge recommendation for the tower.' }),
  findings: Type.String({ description: 'Full findings text (markdown); write "none" when clean.' }),
  checks: Type.Optional(Type.Array(Type.String(), { description: 'Checklist items you verified.' })),
  decision: Type.String({ description: 'The reasoning behind your verdict.' }),
  breakGlassReason: Type.Optional(Type.String({ description: 'Tower-only exceptional self-review: why no independent reviewer was used.' })),
}, { additionalProperties: false })

export const PreflightInput = Type.Object({
  missionId: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: id).' })),
}, { additionalProperties: false })
