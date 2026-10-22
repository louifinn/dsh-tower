// tower_plan / tower_mission / tower_status / tower_complete / tower_review /
// tower_preflight input contracts. Pure TypeBox only; no I/O.
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
  repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
  missions: Type.Array(
    Type.Object({
      title: Type.String({ description: 'Printable Unicode mission title, NFC-normalized, at most 120 characters; used as the mission label.' }),
      scope: Type.Optional(Type.Array(Type.String(), { description: 'Relative file globs this mission may touch; empty only for survey.' })),
      tasks: Type.Optional(Type.Array(Type.String(), { description: 'Verifiable task items the worker ticks off.' })),
      deps: Type.Optional(Type.Array(Type.String(), { description: 'Mission ids that must merge before this one.' })),
      kind: Type.Optional(enumOf(MISSION_KINDS, { description: 'survey = read-only investigation that reserves no scope.' })),
      context: Type.Optional(Type.String({ description: "The user's own key sentences, verbatim (max 4096 chars)." })),
      references: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: 'Read-only pointers/files the worker should read (max 20); copied into the briefing.' })),
      reviewPolicy: Type.Optional(enumOf(REVIEW_POLICIES, { description: 'required-clean (mission default) means a clean review is required when review.requireReview is on; none needs reviewExemptionReason, and with the review gate on it also needs gates.allowReviewExemption.' })),
      reviewExemptionReason: Type.Optional(Type.String({ description: 'Non-empty justification when reviewPolicy is "none".' })),
    }, { additionalProperties: false }),
    { description: 'Missions to create, in intended order.' },
  ),
}, { additionalProperties: false })

export const MissionInput = Type.Object({
  repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
  id: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: missionId).' })),
  missionId: Type.Optional(Type.String({ description: 'Alias for id; both are accepted.' })),
  status: Type.Optional(enumOf(MISSION_STATUSES, { description: 'New lifecycle status.' })),
  note: Type.Optional(Type.String({ description: 'Append a decision-log note.' })),
  blocker: Type.Optional(Type.String({ description: 'Report a blocker (also sets status to blocked).' })),
  clear_blockers: Type.Optional(Type.Boolean({ description: 'Clear all recorded blockers.' })),
  clearBlockers: Type.Optional(Type.Boolean({ description: 'Alias for clear_blockers.' })),
  task_done: Type.Optional(Type.String({ description: 'Mark the first open task containing this text as done.' })),
  taskDone: Type.Optional(Type.String({ description: 'Alias for task_done.' })),
  task_drop: Type.Optional(Type.String({ description: 'Mark the first open task containing this text as dropped.' })),
  taskDrop: Type.Optional(Type.String({ description: 'Alias for task_drop.' })),
  task_drop_reason: Type.Optional(Type.String({ description: 'Required with task_drop: why the task is legitimately descoped.' })),
  taskDropReason: Type.Optional(Type.String({ description: 'Alias for task_drop_reason.' })),
  scope: Type.Optional(Type.Array(Type.String(), { description: 'Tower only: replacement scope globs; bumps scopeGeneration.' })),
  pause_cause: Type.Optional(enumOf(PAUSE_CAUSES, { description: 'With status=paused: why the mission was paused (default user).' })),
  authorization: Type.Optional(Type.String({ description: 'Authorization reference recorded when resuming a user-paused mission.' })),
}, { additionalProperties: false })

export const StatusInput = Type.Object({
  repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
  missionId: Type.Optional(Type.String({ description: 'Return full detail for one mission instead of the dashboard list.' })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Mission list offset (default 0).' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Mission list page size (default 20).' })),
  includeGate: Type.Optional(Type.Boolean({ description: 'Compute tower_preflight-style gate digests for missions on this page.' })),
  format: Type.Optional(enumOf(STATUS_FORMATS, { description: 'markdown returns the MISSIONS.md board text.' })),
}, { additionalProperties: false })

export const CompleteInput = Type.Object({
  repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
  missionId: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: id).' })),
  id: Type.Optional(Type.String({ description: 'Alias for missionId; both are accepted.' })),
  report: Type.String({ description: 'Full completion report for the tower and the next review round.' }),
  checks: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String({ description: 'What was checked.' }),
        command: Type.Optional(Type.String({ description: 'Command or method used.' })),
        exitCode: Type.Optional(Type.Integer({ description: 'Observed exit code.' })),
        evidence: Type.Optional(Type.String({ description: 'Short evidence line/log reference.' })),
      }, { additionalProperties: false }),
      { description: 'Optional evidence ledger entries: {name, command?, exitCode?, evidence?}.' },
    ),
  ),
}, { additionalProperties: false })

export const ReviewInput = Type.Object({
  repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
  missionId: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: id).' })),
  id: Type.Optional(Type.String({ description: 'Alias for missionId; both are accepted.' })),
  status: Type.String({ description: 'Verdict: "clean", or "p1-Nitems" / "p2-Nitems" with the number of findings at that priority.' }),
  merge: enumOf(MERGE_VERDICTS, { description: 'Merge recommendation for the tower.' }),
  findings: Type.String({ description: 'Full findings text (markdown); write "none" when clean.' }),
  checks: Type.Optional(Type.Array(Type.String(), { description: 'Checklist items you verified.' })),
  decision: Type.String({ description: 'The reasoning behind your verdict.' }),
  breakGlassReason: Type.Optional(Type.String({ description: 'Tower-only exceptional self-review: why no independent reviewer was used.' })),
}, { additionalProperties: false })

export const PreflightInput = Type.Object({
  repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
  missionId: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: id).' })),
  id: Type.Optional(Type.String({ description: 'Alias for missionId; both are accepted.' })),
}, { additionalProperties: false })
