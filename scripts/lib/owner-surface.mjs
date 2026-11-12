// Enumerate the tools each foreign-orchestration owner registers (#161).
//
// Shared by scripts/generate-deny-surface.mjs (writes the generated inventory
// the runtime reads) and tests/deny-surface.test.mjs (asserts the inventory
// still covers reality at test time). It imports the pinned upstream owner
// packages from devDependencies and applies each one against a minimal mock
// context — the same contract as tests/tool-names.test.mjs: the real surface,
// never a remembered copy of it.
//
// The mock context is deliberately small: it answers only the service calls
// the owner plugins make while *registering* (agents/agentTeams for the
// per-agent Team scope, subagents providers for the lazy subagent mount,
// sessionProjections for the todo projection). No execute path ever runs.
import { FOREIGN_ORCHESTRATION_OWNERS } from '../../domain/deny-owners.js'

/** One registration-capture context per apply(); names deduplicated by caller. */
function captureContext() {
  const names = []
  const scopedNames = []
  const disposers = []
  const events = []
  const section = () => () => {}
  const systemPrompt = {
    section,
    context: section,
    tools: () => () => {},
    getSectionOrder: () => 1,
    getContextOrder: () => 1,
  }
  // The exact Agent scope Agent Teams installs its tools in: a member agent
  // with its own scoped context whose registrations land in scopedNames.
  const teamAgent = {
    id: 'owner-enumeration-agent',
    ctx: {
      tools: {
        register(definition) {
          scopedNames.push(definition.name)
          return () => {}
        },
      },
      systemPrompt,
    },
  }
  const ctx = {
    tools: {
      register(definition) {
        names.push(definition.name)
        return () => {}
      },
      guard: () => () => {},
      get: () => undefined,
    },
    systemPrompt,
    effect(fn) {
      const dispose = fn()
      disposers.push(typeof dispose === 'function' ? dispose : () => {})
      return () => {}
    },
    on(event, handler) {
      events.push({ event, handler })
      return () => {}
    },
    emit() {},
    get: () => undefined,
    logger: { info() {}, warn() {}, error() {} },
    agents: { list: () => [teamAgent] },
    // The Lead membership makes tool-agent-team install its full surface for
    // the agent above; interrupt defaults on, so the roster tool is included.
    agentTeams: { tryMembership: () => ({ role: 'lead' }) },
    // A present provider makes dsh-tool-subagent mount immediately instead of
    // waiting for subagent/provider-added.
    subagents: {
      getProvider: () => ({ name: 'spawn', capabilities: {} }),
      resolveMaxDepth: () => undefined,
    },
    sessionProjections: { register: async () => ({}) },
  }
  return { ctx, names, scopedNames, events, disposers }
}

/**
 * Apply one owner package and collect every tool name it registers.
 *
 * @param {{ id: string, package: string, config: Record<string, any> }} owner
 * @returns {Promise<string[]>} sorted unique tool names
 */
async function enumerateOwner(owner) {
  const mod = await import(owner.package)
  if (typeof mod.apply !== 'function') {
    throw new Error(`${owner.id}: ${owner.package} exports no apply()`)
  }
  // Resolve the row config through the package's own loader schema, so a
  // default we do not restate (for example workflow's toolName) still applies.
  const config = typeof mod.Config === 'function' ? mod.Config(owner.config ?? {}) : (owner.config ?? {})
  const kit = captureContext()
  await mod.apply(kit.ctx, config)
  for (const dispose of kit.disposers) dispose()
  const all = [...new Set([...kit.names, ...kit.scopedNames])]
  if (all.length === 0) {
    throw new Error(`${owner.id}: ${owner.package} registered no tools; the enumeration mock is stale`)
  }
  return all.sort()
}

/**
 * The live per-owner inventory, keyed by component row id.
 *
 * @returns {Promise<Record<string, string[]>>}
 */
export async function enumerateDenyOwnerTools() {
  const out = {}
  for (const owner of FOREIGN_ORCHESTRATION_OWNERS) {
    out[owner.id] = await enumerateOwner(owner)
  }
  return out
}
