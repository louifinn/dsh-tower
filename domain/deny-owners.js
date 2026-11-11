// Foreign-orchestration owners and the Tower-mode deny surface (#161).
//
// Tower mode claims to be the only orchestrator in a session, so every tool
// owned by a foreign orchestration component is denied while the mode is
// active. Ownership — not a hand-written name list — is the source: the names
// live in ./generated/deny-surface.js, enumerated from the pinned upstream
// owner packages by scripts/generate-deny-surface.mjs, and
// tests/deny-surface.test.mjs re-enumerates them at test time so an upstream
// addition fails CI instead of leaking silently. The literal list this module
// replaced drifted in both directions (`team_task_reopen` no longer existed;
// `team_task_get`, `list_agents`, `send_message`, `interrupt_agent` were never
// noticed).
//
// Each row names the component exactly as the host profile composes it: the
// loader entry id plus the package specifier and the row config the shipped
// base profile passes (tool names are configurable in some owners, so the row
// config — not the package default — is what a deployment actually registers).
// The devDependency pins keep both honest; tests keep them equal to the
// mount-smoke host pin.
//
// This module is pure: no fs, no adapters, no top-level mutable state.
import { DENY_OWNER_TOOLS } from './generated/deny-surface.js'

/**
 * The foreign orchestration components whose tools Tower mode denies.
 *
 * @type {ReadonlyArray<{ id: string, package: string, config: Record<string, any>, note: string }>}
 */
export const FOREIGN_ORCHESTRATION_OWNERS = [
  {
    id: 'tool-agent-team',
    package: '@deepseek-ai/dsh-experimental-tool-agent-team',
    config: {},
    note: 'Agent Teams: shared task board plus scoped roster and messaging replacements',
  },
  {
    id: 'tool-goal',
    package: '@deepseek-ai/dsh-tool-goal',
    config: {},
    note: 'goal tracking (create/get/update) competes with Tower missions',
  },
  {
    id: 'tool-todo',
    package: '@deepseek-ai/dsh-tool-todo',
    config: { allowParallelInProgress: true },
    note: 'the session todo list competes with Tower mission tasks (base profile row config)',
  },
  {
    id: 'tool-subagent',
    package: '@deepseek-ai/dsh-tool-subagent',
    config: { provider: 'spawn', toolName: 'subagent' },
    note: 'direct delegation outside the Tower roster (base profile row config)',
  },
  {
    id: 'tool-subagent-fork',
    package: '@deepseek-ai/dsh-tool-subagent',
    config: { provider: 'fork', toolName: 'subagent_fork' },
    note: 'fork delegation outside the Tower roster (base profile row config)',
  },
  {
    id: 'tool-subagent-control',
    package: '@deepseek-ai/dsh-tool-subagent-control',
    config: {},
    note: 'addressing/stopping subagents without the Tower protocol',
  },
  {
    id: 'tool-ralph',
    package: '@deepseek-ai/dsh-tool-ralph',
    config: {},
    note: 'ralph loops are a second orchestrator',
  },
  {
    id: 'tool-workflow',
    package: '@deepseek-ai/dsh-tool-workflow',
    config: { toolName: 'workflow' },
    note: 'workflow scripts fan out subagents outside the Tower protocol',
  },
]

/** The generated per-owner tool inventory keyed by component row id. */
export function denyOwnerTools() {
  return DENY_OWNER_TOOLS
}

/** The deny-by-owner default: every tool every foreign owner registers. */
export function defaultDenyTools() {
  const names = new Set()
  for (const owner of FOREIGN_ORCHESTRATION_OWNERS) {
    for (const name of DENY_OWNER_TOOLS[owner.id] ?? []) names.add(name)
  }
  return [...names].sort()
}

export const DEFAULT_DENY_TOOLS = defaultDenyTools()

/**
 * Owner registrations a deny set does not cover (#161 D2). Shared by the
 * coverage test and its seeded failure so the contract is one function, not a
 * restated assertion: any uncovered `owner:tool` name means Tower mode would
 * let a foreign orchestration tool through.
 *
 * @param {Record<string, string[]>} ownerTools
 * @param {string[]} denyTools
 * @returns {string[]}
 */
export function uncoveredDenyTools(ownerTools, denyTools) {
  const deny = new Set(denyTools)
  const out = []
  for (const [owner, names] of Object.entries(ownerTools ?? {})) {
    for (const name of names ?? []) {
      if (!deny.has(name)) out.push(`${owner}:${name}`)
    }
  }
  return out.sort()
}
