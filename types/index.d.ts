// Public type contract for the Tower bundle. This is a declaration-only file:
// the package remains zero-build and no .js is emitted.
//
// This is the single vocabulary shared by the published API and the pure
// domain modules under lib/domain/, which are machine-checked against it by
// `tsc --noEmit` (checkJs). Keep this file free of value imports so consumers
// can load it without `allowJs`.

export type MissionStatus = 'planned' | 'active' | 'completed' | 'blocked' | 'paused' | 'merged' | 'abandoned'
export type MissionKind = 'build' | 'survey'
export type ReviewStatus = 'clean' | 'p1-1items' | 'p1-2items' | 'p1-3items' | 'p1-4items' | 'p1-5items' | 'p2-1items' | 'p2-2items' | 'p2-3items' | 'p2-4items' | 'p2-5items'
export type MergeVerdict = 'merge' | 'fix-then-merge' | 'hold'
export type ReviewPolicy = 'required-clean' | 'none'
export type FindingType = 'bug' | 'improve' | 'vuln' | 'idea'
export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical'
export type FindingStatus = 'open' | 'triaged' | 'fixed' | 'wontfix'
export type Role = 'worker' | 'reviewer'

export type ErrorCode =
  | 'invalid-argument'
  | 'repo-invalid'
  | 'not-initialized'
  | 'mission-not-found'
  | 'finding-not-found'
  | 'invalid-transition'
  | 'state-locked'
  | 'state-corrupt'
  | 'config-invalid'
  | 'config-unknown-key'
  | 'git-timeout'
  | 'merge-conflict'
  | 'merge-hook-failed'
  | 'merge-intent-pending'
  | 'base-dirty'
  | 'stale-base'
  | 'tip-moved'
  | 'out-of-scope'
  | 'worker-busy'
  | 'worker-stale'
  | 'spawn-unavailable'
  | 'provider-missing'
  | 'provider-cooldown'
  | 'preset-missing'
  | 'reviewer-prerequisite'
  | 'worktree-dirty'
  | 'workspace-busy'
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
  by?: string
  at?: number
  checks?: CompletionCheck[]
}

/** One recorded test-discovery receipt (lib/tests.js). */
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

export interface Mission {
  id: string
  title: string
  status: MissionStatus
  kind: MissionKind
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
  worktree?: MissionWorktree | null
  owner?: string | null
  notes?: string[]
  completionReport?: CompletionReport | null
  testRuns?: TestRun[]
  rebase?: RebaseRecord | null
  mergedCommit?: string | null
  mergedAt?: number | null
  scopeGeneration?: number
  ownerGeneration?: number
  pauseCause?: string | null
  updatedAt?: number
  references?: string[]
  authorizationRef?: string | null
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
  stale?: boolean
  [key: string]: unknown
}

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
  messageSeq?: number
  reviewSeq?: number
  findingSeq?: number
  batchSeq?: number
  deliverySeq?: number
}

export interface TowerConfig {
  review?: { requireReview?: boolean; maxRoundsPerReviewer?: number }
  mode?: { allowAgentControl?: boolean; workspaceLock?: boolean; requireHumanAckOnFirstEntry?: boolean }
  gates?: { requireChecks?: boolean; requireTests?: boolean; allowReviewExemption?: boolean }
  tools?: { exposeOperational?: boolean }
  git?: { timeoutMs?: number }
  [section: string]: unknown
}

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
