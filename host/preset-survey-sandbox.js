// Tower detached-survey preset declaration (#148 W2): the sandbox preset's own
// Plugins-page label. This is the writable twin of `host/preset-survey.js`: the
// row config stays in `cordis.patch.yml` and this module forwards it to the
// injected `agentPresets` service, which owns mount/unmount. A Tower-owned
// specifier gives the row a distinct locale
// (`dsh-tower/preset-survey-sandbox/locale/<lang>.json`).
export const name = 'dsh-tower/preset-survey-sandbox'

export const inject = ['agentPresets']

/**
 * Register the detached-survey preset with the profile's preset registry.
 * @param {{ agentPresets: { register: (config: any) => Promise<() => Promise<void> | void> } }} ctx
 * @param {any} config the `cordis.patch.yml` row config (id/name/description/order/plugins)
 * @returns {Promise<() => Promise<void> | void>} the registry's unregister disposer
 */
export async function apply(ctx, config) {
  return ctx.agentPresets.register(config)
}
