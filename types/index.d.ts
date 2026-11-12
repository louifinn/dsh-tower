// Public type contract for the Tower bundle. This is a declaration-only file:
// the package remains zero-build and no .js is emitted.
//
// This is the single vocabulary shared by the published API and the pure
// domain modules under domain/, which are machine-checked against it by
// `tsc --noEmit` (checkJs). Keep this file free of value imports so consumers
// can load it without `allowJs`.

// ---------------------------------------------------------------------------
// Generated vocabulary (#115): one declaration per runtime constant family.
// `npm run types:generate` rewrites the marked block from ERROR_CODES,
// MISSION_STATUSES, REVIEW_STATUSES, MERGE_VERDICTS, MISSION_KINDS,
// REVIEW_POLICIES, FINDING_*, ROLES and PAUSE_CAUSES; the generated-types gate
// (`npm run docs:check:generated:types`) fails when the block drifts. Do not
// edit the block by hand.
// generated:vocabulary:start
export type MissionStatus = 'planned' | 'active' | 'completed' | 'blocked' | 'paused' | 'merged' | 'abandoned'
export type MissionKind = 'build' | 'survey' | 'artifact'
export type ReviewStatus =
  | 'clean'
  | 'p1-1items'
  | 'p1-2items'
  | 'p1-3items'
  | 'p1-4items'
  | 'p1-5items'
  | 'p2-1items'
  | 'p2-2items'
  | 'p2-3items'
  | 'p2-4items'
  | 'p2-5items'
export type MergeVerdict = 'merge' | 'fix-then-merge' | 'hold'
export type ReviewPolicy = 'required-clean' | 'none'
export type FindingType = 'bug' | 'improve' | 'vuln' | 'idea'
export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical'
export type FindingStatus = 'open' | 'triaged' | 'fixed' | 'wontfix'
export type Role = 'worker' | 'reviewer'
export type PauseCause = 'user' | 'failure' | 'resource' | 'dependency'
export type ErrorCode =
  | 'invalid-argument'
  | 'repo-invalid'
  | 'not-initialized'
  | 'mission-not-found'
  | 'finding-not-found'
  | 'invalid-transition'
  | 'stale-base'
  | 'state-locked'
  | 'state-corrupt'
  | 'state-version-unsupported'
  | 'state-migration-failed'
  | 'config-invalid'
  | 'config-unknown-key'
  | 'git-failed'
  | 'git-timeout'
  | 'worktree-dirty'
  | 'spawn-unavailable'
  | 'provider-missing'
  | 'provider-cooldown'
  | 'preset-missing'
  | 'reviewer-prerequisite'
  | 'review-disabled'
  | 'not-authorized'
  | 'workspace-busy'
  | 'mode-store-corrupt'
  | 'mode-persist-failed'
  | 'owner-live'
  | 'owner-busy'
  | 'approval-unavailable'
  | 'acceptance-human-only'
  | 'worker-limit'
  | 'rate-limited'
  | 'takeover-refused'
  | 'reload-unavailable'
  | 'reload-failed'
  | 'tests-failed'
  | 'tests-timeout'
  | 'lease-busy'
  | 'lease-token'
  | 'batch-invalid'
  | 'legacy-invalid'
  | 'tool-internal'
// generated:vocabulary:end

/**
 * Review policy mode (#M39/#M66): `off` (review intentionally unavailable),
 * `optional` (available, never required; default) or `required` (a clean review
 * bound to the branch tip is a merge blocker). `review.requireReview` was the
 * one-release boolean alias (true -> required, false -> optional); it was
 * removed in 2.8.0 and is rejected as an unknown key, so this is the only
 * review policy shape.
 */
export type ReviewMode = 'off' | 'optional' | 'required'

/** One machine-readable gate/completion blocker: a stable code plus a detail. */
export interface Blocker {
  code: string
  detail: string
}

/** Snapshot inputs for the merge/preflight review, roster and test gates. */
export interface MergeGateOptions {
  mission: Mission
  roster?: RosterEntry[]
  branch?: string | null
  branchTip?: string | null
  review?: Review | null
  config?: TowerConfig
  activity?: Record<string, string | undefined>
  parentStatus?: Record<string, string | null> | null
  inactiveStates?: Iterable<string>
  rebaseWaived?: boolean
}

export interface MissionTask {
  text: string
  status: 'open' | 'done' | 'dropped'
  note?: string
}

export interface MissionWorktree {
  path: string
  branch: string
  baseCommit: string
}

export interface CompletionCheck {
  name?: string
  command?: string
  exitCode?: number
  evidence?: string
  [key: string]: unknown
}

export interface CompletionReport {
  report?: string
  /** UTF-8 byte length of `report`; absent on documents written before #89. */
  reportBytes?: number
  by?: string
  at?: number
  checks?: CompletionCheck[]
}

/** One recorded test-discovery receipt (adapters/tests.js). */
export interface TestRun {
  version?: number
  ok?: boolean
  treeTip?: string | null
  treeTipAfter?: string | null
  [key: string]: unknown
}

/** Record of the last successful rebase of a mission branch. */
export interface RebaseRecord {
  at: number
  oldTip: string
  newTip?: string
  baseTip?: string
}

/** Evidence a survey may record when it completes (optional). */
export interface SurveyResult {
  paths?: string[]
  symbols?: string[]
  /** Ordered plan / next steps the read recommends (bounded array of strings). */
  plan?: string[]
  notes?: string
  [key: string]: unknown
}

/**
 * The human acceptance of an artifact mission's committed tip (#159). `by` is
 * always `human` — no tool argument can record an agent acceptance — and the
 * record binds exactly one tip: any new commit or rebase makes it stale at the
 * merge gate (`acceptance-stale`). The listed artifacts are disclosure; the
 * acceptance covers the whole tip.
 */
export interface MissionAcceptance {
  at: number
  by: 'human'
  tip: string
  artifacts: string[]
  note?: string
}

/**
 * Fields every mission carries regardless of shape. The per-shape arms below
 * declare which document dimensions a kind owns; the state schema v4 union and
 * `domain/state/semantics.js` enforce the same split at runtime.
 */
export interface MissionBase {
  id: string
  title: string
  status: MissionStatus
  scope: string[]
  deps: string[]
  /**
   * Optional because the pure domain helpers tolerate partial/legacy mission
   * snapshots (`mission.tasks ?? []`); a mission loaded through validateState
   * always has an array.
   */
  tasks?: MissionTask[]
  blockers?: string[]
  reviewPolicy?: ReviewPolicy
  reviewExemptionReason?: string | null
  owner?: string | null
  notes?: string[]
  completionReport?: CompletionReport | null
  testRuns?: TestRun[]
  rebase?: RebaseRecord | null
  scopeGeneration?: number
  ownerGeneration?: number
  pauseCause?: string | null
  updatedAt?: number
  references?: string[]
  authorizationRef?: string | null
  /**
   * Survey evidence; the completion transition refuses a result on a shape that
   * does not accept one, so the type stays permissive for the shared draft.
   */
  result?: SurveyResult | null
}

/** A build mission owns a private branch/worktree and lands by merging. */
export interface BuildMission extends MissionBase {
  kind: 'build'
  worktree?: MissionWorktree | null
  mergedCommit?: string | null
  mergedAt?: number | null
  readCommit?: never
  readDirty?: never
  sandbox?: never
  artifacts?: never
  acceptance?: never
}

/** A survey reads one commit in the shared checkout; it never merges. */
export interface SurveyMission extends MissionBase {
  kind: 'survey'
  readCommit: string
  readDirty?: string[]
  result?: SurveyResult | null
  /**
   * #148 W2: the disposable detached sandbox path when `survey.sandbox` is
   * `detached`. It has no branch and is removed on completion/abandon; a
   * cleanup failure keeps the path plus `sandboxCleanupError` so the record and
   * the filesystem do not silently disagree.
   */
  sandbox?: string
  sandboxCleanupError?: string
  sandboxRemovedAt?: number
  worktree?: never
  branch?: never
  baseCommit?: never
  mergedCommit?: never
  mergedAt?: never
  artifacts?: never
  acceptance?: never
}

/**
 * An artifact mission writes deliverables a code review cannot judge (#159).
 * It owns a branch/worktree like a build, declares its deliverables, and lands
 * on a human acceptance of the whole committed tip instead of a review.
 */
export interface ArtifactMission extends MissionBase {
  kind: 'artifact'
  worktree?: MissionWorktree | null
  mergedCommit?: string | null
  mergedAt?: number | null
  /** Declared deliverables: concrete paths inside the scope, committed at the tip. */
  artifacts: string[]
  /** The human acceptance record; absent until a human accepts the committed tip. */
  acceptance?: MissionAcceptance | null
  readCommit?: never
  readDirty?: never
  sandbox?: never
}

export type Mission = BuildMission | SurveyMission | ArtifactMission

/**
 * Compact archived-mission entry (`archive/index.json`). It keeps enough of the
 * mission for ordering, dependency lookups and id allocation without loading the
 * full year file, and it is what `tower_status includeArchived` pages from (#73).
 */
export interface ArchiveIndexEntry {
  id: string
  title: string
  status: MissionStatus
  kind?: MissionKind
  scope?: string[]
  deps?: string[]
  owner?: string | null
  branch?: string | null
  mergedCommit?: string | null
  mergedAt?: number | null
  updatedAt?: number | null
  archivedAt: number
  archivedYear: number
}

/** Full archived record (`archive/<year>.json`): mission + linked history. */
export interface ArchivedMissionRecord extends ArchiveIndexEntry {
  mission: Mission
  reviews: Review[]
  findings: Finding[]
}

export interface Review {
  id?: string
  seq?: number
  missionId: string
  branch: string
  round: number
  status: string
  mergeVerdict: MergeVerdict
  reviewedCommit: string
  at: number
  findings?: string
  checks?: string[]
  decision?: string
  reviewer?: string
  reviewerRole?: string
  breakGlassReason?: string
}

export interface Finding {
  id: string
  type: FindingType
  title: string
  seq?: number | null
  severity?: FindingSeverity | null
  status?: FindingStatus | null
  missionId?: string | null
  branch?: string | null
  reportedBy?: string | null
  at?: number | null
  updatedAt?: number | null
  closedAt?: number | null
  summary?: string
  details?: string
  suggestedFix?: string
  location?: string
}

export interface RosterEntry {
  name: string
  role: Role
  state: string
  /** Reserved rows may exist before an agent id is known. */
  agentId?: string | null
  missionId?: string | null
  parentSessionId?: string | null
  spawnTip?: string | null
  /** The commit a reviewer's verdict is stamped with (#149 W3). */
  reviewCommit?: string | null
  /** The disposable detached checkout the reviewer reads, when recorded. */
  reviewCheckout?: string | null
  stale?: boolean
  [key: string]: unknown
}

/**
 * Public state contract. This stays hand-written rather than derived from
 * `Static<typeof StateSchema>` because the validator schema is deliberately
 * tolerant of legacy rows (`additionalProperties`, optional collections) and
 * checks status vocabularies/worktree records semantically after the shape
 * pass. `tests/type-contracts.ts` pins the schema/public-type overlap.
 */
export interface TowerState {
  schemaVersion: number
  revision: number
  base: string
  missions: Mission[]
  repoRoot?: string
  commonDir?: string
  createdAt?: number
  updatedAt?: number
  dirtyBase?: boolean
  /** Detected once at tower_init; null means "not detected yet" (#90). */
  caseInsensitive?: boolean | null
  towerAgentId?: string | null
  snapshotCommit?: string | null
  snapshotRef?: string | null
  roster?: RosterEntry[]
  reviews?: Review[]
  findings?: Finding[]
  messages?: Array<Record<string, unknown>>
  batches?: Array<Record<string, unknown>>
  legacySnapshots?: Array<Record<string, unknown>>
  legacyMaps?: Array<Record<string, unknown>>
  deliveries?: Array<Record<string, unknown>>
  mergeIntent?: Record<string, unknown> | null
  rebaseIntent?: Record<string, unknown> | null
  messageSeq?: number
  reviewSeq?: number
  findingSeq?: number
  batchSeq?: number
  deliverySeq?: number
}

export type TowerConfig = import('@deepseek-ai/schemastery').TypeS<typeof import('../domain/config/schema.js').Config>

/** Counts rendered by mission summaries and the board. */
export interface TaskCounts {
  total: number
  done: number
  open: number
  dropped: number
}

/** Compact mission view returned by tower_plan/tower_status. */
export interface MissionSummary {
  id: string
  title: string
  kind: MissionKind
  status: MissionStatus
  scope: string[]
  deps: string[]
  owner: string | null
  worktree: MissionWorktree | null
  blockers: string[]
  tasks: TaskCounts
  scopeGeneration: number
  ownerGeneration: number
  pauseCause: string | null
  reviewPolicy: ReviewPolicy
  mergedCommit: string | null
  mergedAt: number | null
  /** Survey projection: the commit the survey read (null for a build). */
  readCommit?: string | null
  /** Survey projection: the tracked-status fingerprint captured at plan time. */
  readDirty?: string[]
  /** Survey projection: the disposable detached sandbox path (null otherwise). */
  sandbox?: string | null
  /** Artifact projection: the declared deliverable paths (empty otherwise). */
  artifacts?: string[]
  /** Artifact projection: the human acceptance record (null until accepted). */
  acceptance?: MissionAcceptance | null
  /** Size of the completion report without loading its body; null when absent. */
  reportBytes: number | null
  updatedAt?: number
}

/** Full mission view returned by mission-scoped use cases. */
export interface MissionDetail extends Omit<MissionSummary, 'tasks'> {
  tasks: MissionTask[]
  notes: string[]
  completionReport: CompletionReport | null
  authorizationRef: string | null
  references: string[]
  reviewExemptionReason: string
  testRuns: TestRun[]
}

export interface FindingSummary {
  id: string
  seq: number | null
  type: FindingType
  title: string
  severity: FindingSeverity | null
  status: FindingStatus
  missionId: string | null
  branch: string | null
  reportedBy: string | null
  at: number | null
  updatedAt: number | null
  closedAt: number | null
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  execute(args: Record<string, unknown>, exec: { agent?: { id?: string } }): Promise<unknown>
}

/** Owned Tower mode state exposed as the `tower` Cordis service. */
export interface ModeStateService {
  has(key: string): boolean
  get(key: string): unknown
  set(key: string, value: unknown): this
  delete(key: string): boolean
  values(): IterableIterator<unknown>
  entries(): IterableIterator<[string, unknown]>
  replace(entries?: Iterable<[string, unknown]>): void
  clear(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tower?: ModeStateService
  }
}

import type { Static, TSchema } from '@sinclair/typebox'

export type DefineTool = <S extends TSchema>(
  ctx: any,
  definition: {
    name: string
    description: string
    parameters: S
    execute(args: Static<S>, exec: any): Promise<unknown>
    aliases?: any
    requiresMissionId?: any
    board?: any
    output?: any
  },
) => void
