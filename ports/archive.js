// Terminal-mission archive port (#69). The readers/writers are store-agnostic:
// they take the store port and the Tower paths, so the same archive logic runs
// on the filesystem adapter and on an in-memory store.
import { assertPort, definePort } from './contract.js'

/**
 * @typedef {object} ArchivePort
 * @property {(store: unknown, paths: { dir: string }) => Promise<{ ok: boolean, file: string, missions: any[], error?: string, exists: boolean }>} readIndex
 * @property {(store: unknown, paths: { dir: string }, missionId: string) => Promise<any>} readEntry
 * @property {(store: unknown, paths: { dir: string }, input: { entries: any[], now?: number }) => Promise<any>} writeEntries
 */

export const ARCHIVE_PORT = definePort('ArchivePort', ['readIndex', 'readEntry', 'writeEntries'])

/** @param {unknown} impl */
export function assertArchivePort(impl) {
  return /** @type {ArchivePort} */ (assertPort(impl, ARCHIVE_PORT, 'archive'))
}
