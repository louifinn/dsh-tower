// The Host `subagents` Service contract differs between DSH 0.2.2-rc.1/rc.2 and
// rc.3. This is the single adapter both the spawn precheck and the spawn tool go
// through, so the capability check lives in one place instead of being repeated
// as a version string:
//
// - rc.1/rc.2: `list()` names the providers, and `startActivation` takes the
//   child request nested under `request`.
// - rc.3: `list()` is gone; `getProvider(name)` resolves one provider, and
//   `startActivation` takes the child request FLAT next to `provider`/`label`.
//   The host validates that `spec.parent` is the exact live parent Agent.
//
// Detection is behavioural (`typeof subagents.list === 'function'`), never a
// version comparison, so rc.3 and any later Service that keeps the flat shape
// work while an older host keeps the nested shape.
import { TowerToolError } from '../domain/errors.js'

/** @param {any} subagents */
export function usesNestedActivation(subagents) {
  return typeof subagents?.list === 'function'
}

/**
 * Resolve the provider name a spawn should use.
 *
 * Order: the explicit `spawn.provider` config, then a registered `spawn`
 * provider, then the old `list()` surface. The error names the config key and a
 * real remedy: it never points at a tool, because the provider registration is a
 * Host/bundle fact (#131).
 *
 * @param {any} subagents
 * @param {any} config
 * @returns {string}
 */
export function resolveSpawnProvider(subagents, config) {
  const configured = config?.spawn?.provider
  if (typeof configured === 'string' && configured.trim()) return configured.trim()

  if (typeof subagents?.getProvider === 'function') {
    let provider
    try {
      provider = subagents.getProvider('spawn')
    } catch {
      // A Service that throws for an absent name is treated like one that
      // returns undefined: fall through to the legacy list, then fail loud.
      provider = undefined
    }
    if (provider) return 'spawn'
  }

  if (usesNestedActivation(subagents)) {
    const providers = subagents.list()
    if (Array.isArray(providers) && providers.length > 0) {
      return providers.includes('spawn') ? 'spawn' : String(providers[0])
    }
  }

  throw new TowerToolError(
    'provider-missing',
    'no subagent provider is available: set spawn.provider to the provider name registered by your Host bundle (the default bundle registers "spawn"), then retry',
  )
}

/**
 * Build the `startActivation` input for the contract the live Service exposes.
 *
 * @param {any} subagents
 * @param {{ provider: string, label: string, name?: string, request: Record<string, any>, signal?: AbortSignal }} input
 */
export function buildActivationSpec(subagents, { provider, label, name, request, signal }) {
  if (!provider) {
    throw new TowerToolError(
      'provider-missing',
      'no subagent provider is available: set spawn.provider to the provider name registered by your Host bundle (the default bundle registers "spawn"), then retry',
    )
  }
  if (usesNestedActivation(subagents)) {
    // rc.1/rc.2: the request (cwd, agentPreset, prompt, parent, maxDepth,
    // agentOptions) is nested and the top level only carries routing/delivery.
    return { provider, label, request, signal, delivery: 'parent' }
  }
  // rc.3+: the request fields are siblings of provider/label. Keep signal and
  // delivery after the spread so a request field can never override them.
  return {
    provider,
    label,
    ...(name ? { name } : {}),
    ...request,
    signal,
    delivery: 'parent',
  }
}
