// Tower reviewer preset declaration (#121): the read-only preset's own label.
//
// This is the reviewer half of the pair documented in `host/preset-worker.js`.
// The row used to mount `@deepseek-ai/dsh-agent-preset`, so DSH resolved that
// shared module's locale and both preset rows rendered the same title; the
// conditional reviewer switch was therefore indistinguishable from the
// mandatory worker dependency. A Tower-owned module gives each row its own
// `<specifier>/locale/<lang>.json` resource without importing the agent-preset
// package (which is not resolvable from this package anyway).
//
// The module forwards the unchanged row config to the injected `agentPresets`
// service and returns its disposer, so `register`/unregister lifecycle, the
// definition's `plugins` mount and the activation diagnostic all stay registry
// owned. It imports nothing and renders nothing.
export const name = 'dsh-tower/preset-reviewer'

export const inject = ['agentPresets']

/**
 * Register the reviewer preset with the profile's preset registry.
 * @param {{ agentPresets: { register: (config: any) => Promise<() => Promise<void> | void> } }} ctx
 * @param {any} config the `cordis.patch.yml` row config (id/name/description/order/plugins)
 * @returns {Promise<() => Promise<void> | void>} the registry's unregister disposer
 */
export async function apply(ctx, config) {
  return ctx.agentPresets.register(config)
}
