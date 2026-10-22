// Store port (#69). Implementation: adapters/store-fs.js.
//
// App use cases depend on this contract, not on lib/store.js: they receive the
// implementation through the composition root and never import the adapter.
import { assertPort, definePort } from './contract.js'

/**
 * @typedef {object} StorePort
 * @property {(commonDir: string) => { dir: string, state: string, lock: string, gitLock: string, activity: string }} pathsFor
 * @property {(file: string) => Promise<boolean>} exists
 * @property {(dir: string) => Promise<void>} ensureDir
 * @property {(file: string) => Promise<any>} readJson
 * @property {(file: string, value: unknown) => Promise<void>} writeJsonAtomic
 * @property {(file: string, value: unknown) => Promise<void>} appendJsonl
 * @property {(paths: object, fn: (paths: object) => Promise<any>, options?: object) => Promise<any>} withLock
 * @property {(paths: object, fn: (paths: object) => Promise<any>, options?: object) => Promise<any>} withGitLock
 * @property {(file: string, limit?: number) => Promise<any[]>} readActivityTail
 */

export const STORE_PORT = definePort('StorePort', [
  'pathsFor',
  'exists',
  'ensureDir',
  'readJson',
  'writeJsonAtomic',
  'appendJsonl',
  'withLock',
  'withGitLock',
  'readActivityTail',
])

/** @param {unknown} impl */
export function assertStorePort(impl) {
  return /** @type {StorePort} */ (assertPort(impl, STORE_PORT, 'store'))
}
