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
//
// #190: the supported host build has one source of truth, `scripts/support.json`.
// The inventory is enumerated from one complete published owner build
// (DENY_OWNER_PACKAGE_BUILD), and the relationship between that build and the
// supported pin is machine-checked by evaluateDenyInventoryBuild() — called by
// scripts/generate-deny-surface.mjs (deny:check) and by the test suite. A
// supported pin newer than the inventory is only allowed when *every* owner
// package is named in DENY_OWNER_BUILD_EXCEPTIONS with its own reason; an
// undocumented disagreement, a pin that does not match its exception, or a stale
// generated file fails with a message naming both builds and
// `npm run deny:generate`. A pin bump therefore cannot leave the inventory
// behind, and an exception cannot linger after its owner is republished.
//
// The exception exists for a real install constraint: 0.2.2-rc.3 republishes the
// six tool-* owners but not `dsh-experimental-tool-agent-team`, and that
// package's last build imports `dsh-subagent/internal`, which rc.3 removed.
// Mixed owner pins cannot be installed, so the whole set is held at the complete
// rc.1 build instead of dropping the agent-team tools from the deny surface.
//
// This module is pure: no fs, no adapters, no top-level mutable state.
import { DENY_OWNER_TOOLS } from './generated/deny-surface.js'

/**
 * The complete published owner build the deny inventory is enumerated from.
 * Every foreign-orchestration owner package is pinned to exactly this version
 * in devDependencies; tests assert the pins and the generated inventory agree.
 *
 * @type {string}
 */
export const DENY_OWNER_PACKAGE_BUILD = '0.2.2-rc.1'

/**
 * The supported host pin this module's inventory relationship was last reviewed
 * against. `scripts/support.json` remains the single source of truth for the
 * supported host; this is the recorded review point, and `deny:check` fails when
 * the two disagree so a support bump cannot leave it behind.
 *
 * @type {string}
 */
export const DENY_INVENTORY_REVIEWED_PIN = '0.2.2-rc.3'

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

/**
 * Per-owner exception to "every owner is pinned to the supported host build"
 * (#190). Every owner package whose devDependency pin differs from the
 * supported host pin must appear here with the build it is held at and the
 * reason. The evaluator rejects an undocumented disagreement, a pin that does
 * not match its recorded build, a stale exception for a package that is now
 * published at the supported pin, and an exception entry for a non-owner.
 * When the agent-team package is republished, delete these rows, bump every
 * owner pin and DENY_OWNER_PACKAGE_BUILD together, then run
 * `npm run deny:generate`.
 *
 * @type {ReadonlyArray<{ package: string, build: string, reason: string }>}
 */
export const DENY_OWNER_BUILD_EXCEPTIONS = Object.freeze([
  Object.freeze({
    package: '@deepseek-ai/dsh-experimental-tool-agent-team',
    build: '0.2.2-rc.1',
    reason:
      'not republished after 0.2.2-rc.1; its last build imports dsh-subagent/internal, which 0.2.2-rc.3 removed',
  }),
  Object.freeze({
    package: '@deepseek-ai/dsh-tool-goal',
    build: '0.2.2-rc.1',
    reason: 'held at the complete rc.1 owner set: mixed owner pins cannot be installed while the agent-team package trails',
  }),
  Object.freeze({
    package: '@deepseek-ai/dsh-tool-todo',
    build: '0.2.2-rc.1',
    reason: 'held at the complete rc.1 owner set: mixed owner pins cannot be installed while the agent-team package trails',
  }),
  Object.freeze({
    package: '@deepseek-ai/dsh-tool-subagent',
    build: '0.2.2-rc.1',
    reason: 'held at the complete rc.1 owner set: mixed owner pins cannot be installed while the agent-team package trails',
  }),
  Object.freeze({
    package: '@deepseek-ai/dsh-tool-subagent-control',
    build: '0.2.2-rc.1',
    reason: 'held at the complete rc.1 owner set: mixed owner pins cannot be installed while the agent-team package trails',
  }),
  Object.freeze({
    package: '@deepseek-ai/dsh-tool-ralph',
    build: '0.2.2-rc.1',
    reason: 'held at the complete rc.1 owner set: mixed owner pins cannot be installed while the agent-team package trails',
  }),
  Object.freeze({
    package: '@deepseek-ai/dsh-tool-workflow',
    build: '0.2.2-rc.1',
    reason: 'held at the complete rc.1 owner set: mixed owner pins cannot be installed while the agent-team package trails',
  }),
])

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const GENERATE_HINT = '`npm run deny:generate`'

/**
 * The documented exception for one owner package, or null.
 *
 * @param {string} packageName
 * @param {ReadonlyArray<{ package: string, build: string, reason: string }>} [exceptions]
 */
export function denyOwnerBuildException(packageName, exceptions = DENY_OWNER_BUILD_EXCEPTIONS) {
  return exceptions.find((entry) => entry.package === packageName) ?? null
}

/**
 * Check the relationship between the supported host pin, the recorded inventory
 * build, the per-owner exception table and the actual devDependency pins (#190).
 * Pure: the caller supplies the support pin and the manifest's devDependencies,
 * so `deny:check` and the test suite read the same real values.
 *
 * @param {{
 *   supportedBuild?: string,
 *   devDependencies?: Record<string, string>,
 *   inventoryBuild?: string,
 *   reviewedPin?: string,
 *   exceptions?: ReadonlyArray<{ package: string, build: string, reason: string }>,
 *   owners?: ReadonlyArray<{ id: string, package: string }>,
 * }} [input]
 * @returns {{ ok: boolean, problems: string[], facts: {
 *   supportedBuild: string,
 *   inventoryBuild: string,
 *   reviewedPin: string,
 *   owners: Array<{ package: string, pin: string | null, expectedBuild: string, exception: boolean }>,
 * } }}
 */
export function evaluateDenyInventoryBuild(input = {}) {
  const supportedBuild = String(input.supportedBuild ?? DENY_INVENTORY_REVIEWED_PIN)
  const devDependencies = input.devDependencies ?? {}
  const inventoryBuild = String(input.inventoryBuild ?? DENY_OWNER_PACKAGE_BUILD)
  const reviewedPin = String(input.reviewedPin ?? DENY_INVENTORY_REVIEWED_PIN)
  const exceptions = input.exceptions ?? DENY_OWNER_BUILD_EXCEPTIONS
  const owners = input.owners ?? FOREIGN_ORCHESTRATION_OWNERS
  const problems = []

  if (!EXACT_VERSION.test(supportedBuild)) {
    problems.push(`supported host pin ${JSON.stringify(supportedBuild)} is not one exact version`)
  }
  if (!EXACT_VERSION.test(inventoryBuild)) {
    problems.push(`the deny inventory build ${JSON.stringify(inventoryBuild)} is not one exact version`)
  }
  if (supportedBuild !== reviewedPin) {
    problems.push(
      `supported host pin ${supportedBuild} (scripts/support.json) moved past the reviewed pin ${reviewedPin} while the inventory is enumerated at ${inventoryBuild}; update DENY_INVENTORY_REVIEWED_PIN in domain/deny-owners.js, review every per-owner exception, then run ${GENERATE_HINT}`,
    )
  }

  const ownerPackages = [...new Set(owners.map((owner) => owner.package))]
  const known = new Set(ownerPackages)
  const seen = new Set()
  for (const exception of exceptions) {
    if (seen.has(exception.package)) {
      problems.push(`${exception.package}: duplicate deny build exception; keep exactly one row per owner package`)
    }
    seen.add(exception.package)
    if (!known.has(exception.package)) {
      problems.push(
        `${exception.package}: deny build exception names a package that is not a foreign-orchestration owner`,
      )
    }
    if (!String(exception.reason ?? '').trim()) {
      problems.push(`${exception.package}: deny build exception must state a reason`)
    }
    if (!EXACT_VERSION.test(String(exception.build))) {
      problems.push(`${exception.package}: deny build exception build ${JSON.stringify(exception.build)} is not one exact version`)
    }
  }

  /** @type {{ supportedBuild: string, inventoryBuild: string, reviewedPin: string, owners: Array<{ package: string, pin: string | null, expectedBuild: string, exception: boolean }> }} */
  const facts = {
    supportedBuild,
    inventoryBuild,
    reviewedPin,
    owners: [],
  }
  for (const packageName of ownerPackages) {
    const exception = denyOwnerBuildException(packageName, exceptions)
    const pin = devDependencies[packageName] ?? null
    const expectedBuild = exception ? exception.build : supportedBuild
    facts.owners.push({ package: packageName, pin, expectedBuild, exception: Boolean(exception) })
    if (exception && exception.build !== inventoryBuild) {
      problems.push(
        `${packageName}: its deny build exception holds ${exception.build}, which is not the inventory build ${inventoryBuild}; keep every owner on the one build the inventory is enumerated from and run ${GENERATE_HINT}`,
      )
      continue
    }
    if (pin !== expectedBuild) {
      problems.push(
        exception
          ? `${packageName} is pinned to ${pin ?? 'no version'} but its deny build exception holds ${exception.build} (inventory build ${inventoryBuild}, supported host pin ${supportedBuild}); repin the package and run ${GENERATE_HINT}`
          : `${packageName} is pinned to ${pin ?? 'no version'} but the supported host pin is ${supportedBuild} (inventory build ${inventoryBuild}); document a per-owner exception in domain/deny-owners.js or repin every owner and run ${GENERATE_HINT}`,
      )
      continue
    }
    if (exception && exception.build === supportedBuild) {
      problems.push(
        `${packageName}: its deny build exception is stale because the package is published at the supported pin ${supportedBuild}; remove the exception from domain/deny-owners.js and run ${GENERATE_HINT}`,
      )
    }
  }

  return { ok: problems.length === 0, problems, facts }
}

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
