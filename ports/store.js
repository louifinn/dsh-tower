// Store port (#69). Implementation: adapters/store-fs.js.
//
// App use cases depend on this contract, not on adapters/store.js: they receive the
// implementation through the composition root and never import the adapter.
// The contract lists every method app/** and tools/** call, so an implementation
// that is missing one fails `assertPorts` at construction instead of mid-mission.
import { assertPort, definePort } from './contract.js'

/**
 * @typedef {object} StorePort
 * @property {(commonDir: string) => { dir: string, state: string, lock: string, gitLock: string, activity: string }} pathsFor
 * @property {(file: string) => Promise<boolean>} exists
 * @property {(dir: string) => Promise<void>} ensureDir
 * @property {(file: string) => Promise<any>} readJson
 * @property {(file: string, value: unknown) => Promise<void>} writeJsonAtomic
 * @property {(file: string, value: unknown, options?: { maxBytes?: number, retention?: number }) => Promise<void>} appendJsonl
 * @property {(paths: object, fn: (paths: object) => Promise<any>, options?: object) => Promise<any>} withLock
 * @property {(paths: object, fn: (paths: object) => Promise<any>, options?: object) => Promise<any>} withGitLock
 * @property {(file: string, limit?: number) => Promise<any[]>} readActivityTail  // reads rotated segments oldest-first, then the live file
 * @property {(file: string) => Promise<string>} readText
 * @property {(file: string, text: string, encoding?: string) => Promise<void>} writeText
 * @property {(file: string, text: string, encoding?: string) => Promise<void>} appendText
 * @property {(from: string, to: string) => Promise<void>} rename
 * @property {(from: string, to: string) => Promise<void>} renameWithRetry
 * @property {(from: string, to: string) => Promise<void>} copyFileExclusive
 * @property {(file: string) => Promise<{ mtimeMs: number }>} stat
 * @property {(file: string) => Promise<void>} unlink
 * @property {(paths: object, options?: object) => Promise<{ record: any, raw: string | null }>} readGitLock
 * @property {(lock: { record: any } | null, options?: object) => { held: boolean, pid?: number | null, phase?: string | null, heldMs?: number }} gitLockView
 */

// `rename` and `renameWithRetry` are both declared because they are not
// interchangeable: `renameWithRetry` has temp-file semantics and on a terminal
// failure it unlinks its source, which is right for a disposable temp file but
// would delete the bytes `tower_recover` must keep auditable. The audit rename
// therefore uses the plain `rename` primitive (see tools/recover.js).
//
// `copyFileExclusive` is an optional filesystem capability rather than a
// required method: an in-memory implementation has no filesystem and need not
// provide it. It is declared here because the only caller,
// `removeStaleGitLocks` in app/tower.js, must never fall back to the
// overwriting `rename` when the capability is absent — it keeps the quarantined
// lock as evidence instead. The filesystem implementation in
// adapters/store-fs.js always provides it; its EEXIST outcome is the CAS that
// prevents a third Git writer's freshly created lock from being replaced.
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
  'readText',
  'writeText',
  'appendText',
  'rename',
  'renameWithRetry',
  'stat',
  'unlink',
  'readGitLock',
  'gitLockView',
])

/** @param {unknown} impl */
export function assertStorePort(impl) {
  return /** @type {StorePort} */ (assertPort(impl, STORE_PORT, 'store'))
}
