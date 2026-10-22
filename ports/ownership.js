// Worktree-ownership port (#69). The default implementation verifies a stored
// worktree against the real filesystem and Git; an in-memory composition can
// substitute a verifier that matches its own virtual paths.
import { assertPort, definePort } from './contract.js'

/**
 * @typedef {object} OwnershipPort
 * @property {(input: { storedPath: string, storedRealPath?: string, branch: string, commonDir: string, missionId?: string }) => Promise<{ path: string, realPath: string }>} assertOwnership
 * @property {(target: string) => Promise<string>} canonicalPath
 */

export const OWNERSHIP_PORT = definePort('OwnershipPort', ['assertOwnership', 'canonicalPath'])

/** @param {unknown} impl */
export function assertOwnershipPort(impl) {
  return /** @type {OwnershipPort} */ (assertPort(impl, OWNERSHIP_PORT, 'ownership'))
}
