// Tower worker preset declaration (#121): one row, one Plugins-page label.
//
// DSH labels a row from `readPluginMeta(row.moduleName)`, which resolves
// `<specifier>/locale/en.json` and every sibling `<lang>.json` there. Both
// preset rows used to mount `@deepseek-ai/dsh-agent-preset`, so both shared that
// module's single label and the page could not tell the worker from the
// reviewer. That package is also not resolvable from this package, so Tower
// cannot add per-row locale files to it.
//
// This module is the tiny Tower-owned twin: it keeps the row config in
// `cordis.patch.yml` and forwards it to the injected `agentPresets` service. The
// service owns preset semantics — it mounts the definition's `plugins` list
// itself and returns the disposer that unmounts it — so this module stays
// renderer-free and imports nothing. Its specifier carries the worker label
// (`dsh-tower/preset-worker/locale/<lang>.json`).
//
// Shape: a plain object plugin (named exports) whose async `apply` returns the
// registry's disposer. Cordis collects the resolved function as the plugin's
// disposer, so disabling the row (or an HMR unload) unregisters the preset.
export const name = 'dsh-tower/preset-worker'

export const inject = ['agentPresets']

/**
 * Register the worker preset with the profile's preset registry.
 * @param {{ agentPresets: { register: (config: any) => Promise<() => Promise<void> | void> } }} ctx
 * @param {any} config the `cordis.patch.yml` row config (id/name/description/order/plugins)
 * @returns {Promise<() => Promise<void> | void>} the registry's unregister disposer
 */
export async function apply(ctx, config) {
  return ctx.agentPresets.register(config)
}
