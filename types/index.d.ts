// Public type contract for the Tower bundle. This is a declaration-only file:
// the package remains zero-build and no .js is emitted.
export type MissionStatus = 'planned' | 'active' | 'completed' | 'blocked' | 'paused' | 'merged' | 'abandoned'
export type ReviewStatus = 'clean' | 'p1-1items' | 'p1-2items' | 'p1-3items' | 'p1-4items' | 'p1-5items' | 'p2-1items' | 'p2-2items' | 'p2-3items' | 'p2-4items' | 'p2-5items'
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

export interface MissionTask {
  text: string
  status: 'open' | 'done' | 'dropped'
  note?: string
}

export interface Mission {
  id: string
  title: string
  status: MissionStatus
  kind: 'build' | 'survey'
  scope: string[]
  tasks: MissionTask[]
  deps: string[]
  blockers: string[]
  reviewPolicy: 'required' | 'none'
  reviewExemptionReason?: string | null
  worktree?: { path: string; branch: string; baseCommit: string } | null
}

export interface Review {
  missionId: string
  branch: string
  round: number
  status: string
  mergeVerdict: 'merge' | 'fix-then-merge' | 'hold'
  reviewedCommit: string
}

export interface Finding {
  id: string
  type: FindingType
  severity: FindingSeverity
  status: FindingStatus
  title: string
}

export interface TowerState {
  schemaVersion: number
  revision: number
  base: string
  missions: Mission[]
  roster: Array<Record<string, unknown>>
  reviews: Review[]
  findings: Finding[]
  messages: Array<Record<string, unknown>>
}

export interface TowerConfig {
  review?: { requireReview?: boolean }
  mode?: { allowAgentControl?: boolean; workspaceLock?: boolean; requireHumanAckOnFirstEntry?: boolean }
  gates?: { requireChecks?: boolean; requireTests?: boolean; allowReviewExemption?: boolean }
  tools?: { exposeOperational?: boolean }
  [section: string]: unknown
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  execute(args: Record<string, unknown>, exec: { agent?: { id?: string } }): Promise<unknown>
}
