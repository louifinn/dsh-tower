// Case-sensitivity probe port (#69). tower_init probes the checkout filesystem
// once; a composition without a real filesystem injects its own answer.
import { assertPort, definePort } from './contract.js'

/**
 * @typedef {object} CaseSensitivityPort
 * @property {(root: string) => Promise<boolean | null>} detect
 */

export const CASE_SENSITIVITY_PORT = definePort('CaseSensitivityPort', ['detect'])

/** @param {unknown} impl */
export function assertCaseSensitivityPort(impl) {
  return /** @type {CaseSensitivityPort} */ (assertPort(impl, CASE_SENSITIVITY_PORT, 'caseSensitivity'))
}
