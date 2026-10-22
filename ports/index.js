// Explicit ports consumed by app use cases (#69).
//
// `assertPorts` is the injection check the app layer runs on the dependency
// object it receives: a composition root that forgets a port fails at
// construction, not in the middle of a mission.
import { assertPort } from './contract.js'
import { STORE_PORT, assertStorePort } from './store.js'
import { VCS_PORT, assertVcsPort } from './vcs.js'
import { CLOCK_PORT, assertClockPort } from './clock.js'
import { IDS_PORT, assertIdsPort } from './ids.js'
import { CONFIG_PORT, assertConfigPort } from './config.js'
import { STATE_PORT, assertStatePort } from './state.js'
import { OWNERSHIP_PORT, assertOwnershipPort } from './ownership.js'
import { CASE_SENSITIVITY_PORT, assertCaseSensitivityPort } from './caseSensitivity.js'
import { ARCHIVE_PORT, assertArchivePort } from './archive.js'

/** Every port the Tower app layer depends on, keyed by deps member. */
export const PORTS = Object.freeze({
  store: { contract: STORE_PORT, assert: assertStorePort },
  vcs: { contract: VCS_PORT, assert: assertVcsPort },
  clock: { contract: CLOCK_PORT, assert: assertClockPort },
  ids: { contract: IDS_PORT, assert: assertIdsPort },
  config: { contract: CONFIG_PORT, assert: assertConfigPort },
  state: { contract: STATE_PORT, assert: assertStatePort },
  ownership: { contract: OWNERSHIP_PORT, assert: assertOwnershipPort },
  caseSensitivity: { contract: CASE_SENSITIVITY_PORT, assert: assertCaseSensitivityPort },
  archive: { contract: ARCHIVE_PORT, assert: assertArchivePort },
})

/** @param {unknown} deps */
export function assertPorts(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('Tower requires an injected deps object assembled by the composition root (see adapters/default.js)')
  }
  for (const [name, port] of Object.entries(PORTS)) {
    if (typeof port.assert === 'function') port.assert(deps[name])
    else assertPort(deps[name], port.contract, name)
  }
  return deps
}

export { STORE_PORT, assertStorePort } from './store.js'
export { VCS_PORT, assertVcsPort } from './vcs.js'
export { CLOCK_PORT, assertClockPort } from './clock.js'
export { IDS_PORT, assertIdsPort } from './ids.js'
export { CONFIG_PORT, assertConfigPort } from './config.js'
export { STATE_PORT, assertStatePort } from './state.js'
export { OWNERSHIP_PORT, assertOwnershipPort } from './ownership.js'
export { CASE_SENSITIVITY_PORT, assertCaseSensitivityPort } from './caseSensitivity.js'
export { ARCHIVE_PORT, assertArchivePort } from './archive.js'
export { definePort, assertPort, implementsPort } from './contract.js'
