// Config port (#69).
//
// App use cases read the effective Tower config through this port. They do not
// import host/config.js, so the process-level config store stays a property of
// the composition root rather than a module-global dependency of the app.
import { assertPort, definePort } from './contract.js'

/**
 * @typedef {object} ConfigPort
 * @property {() => import('../types/index.js').TowerConfig} runtimeConfig
 * @property {(repo: { root: string, commonDir: string, branch?: string|null }) => Promise<import('../types/index.js').TowerConfig>} resolveRepoConfig
 */

export const CONFIG_PORT = definePort('ConfigPort', ['runtimeConfig', 'resolveRepoConfig'])

/** @param {unknown} impl */
export function assertConfigPort(impl) {
  return /** @type {ConfigPort} */ (assertPort(impl, CONFIG_PORT, 'config'))
}
