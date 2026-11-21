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
 * @property {(from: string, to: string) => Promise<void>} [copyFileExclusive]
 * @property {(dir: string) => Promise<string[]>} [readdir]  // direct child names; no order guarantee
 * @property {(dir: string) => Promise<void>} [rmdir]  // empty directories only; a non-empty directory throws ENOTEMPTY
 * @property {(file: string) => Promise<{ mtimeMs: number, size?: number, isDirectory(): boolean, isSymbolicLink(): boolean }>} [lstat]  // does not follow a link or junction
 * @property {(target: string, linkPath: string, type?: 'file' | 'dir' | 'junction') => Promise<void>} [symlink]  // creates a link; 'junction' is the Windows directory link that needs no privilege
 * @property {(file: string) => Promise<{ mtimeMs: number, size?: number, isDirectory(): boolean }>} stat
 * @property {(file: string) => Promise<void>} unlink
 * @property {(paths: object, options?: object) => Promise<{ record: any, raw: string | null }>} readGitLock
 * @property {(lock: { record: any } | null, options?: object) => { held: boolean, pid?: number | null, phase?: string | null, heldMs?: number }} gitLockView
 * @property {(paths: object, options?: { now?: number | (() => number) }) => Promise<{ path: string, record: any, raw: string | null, alive: boolean | null }>} [readStateCommitLock]
 * @property {(paths: object, options?: { force?: boolean, now?: number | (() => number), expectedRaw?: string }) => Promise<{ held: boolean, cleared: boolean, pid?: number | null, backup?: string | null, forced?: boolean }>} [clearStateCommitLock]
 */

// `rename` and `renameWithRetry` are both declared because they are not
// interchangeable: `renameWithRetry` has temp-file semantics and on a terminal
// failure it unlinks its source, which is right for a disposable temp file but
// would delete the bytes `tower_recover` must keep auditable. The audit rename
// therefore uses the plain `rename` primitive (see tools/recover.js).
//
// `copyFileExclusive` is an optional filesystem capability rather than a
// required method: an in-memory implementation has no filesystem and need not
// provide it, so it is listed in `STORE_OPTIONAL_METHODS` below like the
// commit-mutex repair methods. It is declared here because the only caller,
// `removeStaleGitLocks` in app/git-locks.js, must never fall back to the
// overwriting `rename` when the capability is absent — it keeps the quarantined
// lock as evidence instead. The filesystem implementation in
// adapters/store-fs.js always provides it; its EEXIST outcome is the CAS that
// prevents a third Git writer's freshly created lock from being replaced.
//
// `readdir` and `rmdir` are optional for the same reason: an in-memory double
// has no directories to enumerate. They exist for the empty review-checkout
// sweep (#214), which lists the direct children of the worktree root and deletes
// a shell only when it is empty. Callers must feature-detect both and report
// that the store does not expose the capability — never fall back to `node:fs`,
// which the architecture gate keeps inside adapters/**. `rmdir` answers
// ENOTEMPTY (or EEXIST on Windows) for a directory that is not empty; the sweep
// treats that as a "keep" signal, not as an error, so a directory that gained a
// file between the inspection and the removal is never deleted.
//
// `lstat` and `symlink` are optional for the same reason and exist for #218/F100:
// the spawn option `spawn.nodeModules: "link"` creates a Windows junction from a
// worktree's `node_modules` to the baseline checkout's installed modules, and
// teardown must be able to prove — with `lstat`, which does not follow the link
// — that the entry it removes is the link the tool created, never a directory
// with content. `lstat` must report `isSymbolicLink()` (true for both POSIX
// symlinks and Windows junctions) and `isDirectory()`; `symlink` receives the
// optional type so a Windows caller can request `'junction'` without holding the
// symlink privilege. Both are feature-detected: a store that cannot inspect
// links keeps any residual entry instead of guessing, and never falls back to
// `node:fs`.
//
// `stat`'s result shape is part of the contract (#F70). The planning probe in
// app/tower.js expands a bare scope entry only when a directory exists at that
// path, so the result must expose `isDirectory()`. That was previously duck
// typed while the port declared only `mtimeMs`; declaring the capability on the
// existing result keeps fs.Stats and the in-memory double conformant and avoids
// a second round trip. `size` stays optional because app/git-locks.js compares
// it only when the implementation exposes it.
//
// The state-commit mutex (`state.commit.lock`, see adapters/store.js) is an
// implementation detail of the durable store, not a lock every StorePort must
// be able to repair: an in-memory double has no second writer to fence.
// `tower_recover` feature-detects these two methods and reports no commit lock
// when the capability is absent, so they are declared optional here rather than
// widening the required contract (#F71).
export const STORE_OPTIONAL_METHODS = Object.freeze([
  'readStateCommitLock',
  'clearStateCommitLock',
  'copyFileExclusive',
  'readdir',
  'rmdir',
  'lstat',
  'symlink',
])
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
