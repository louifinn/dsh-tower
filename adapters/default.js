// Default composition root for the Tower ports (#50, #69).
//
// This module is the one place where the concrete adapters (node:fs,
// node:child_process) are turned into the plain deps object the app layer
// takes. `createDefaultDeps()` is called once by the host entry (index.js); the
// app never imports an adapter. Tests and embedders use the memoised
// `defaultDeps` (or host/tower.js) so the process has exactly one adapter set.
import crypto from 'node:crypto'
import * as archive from './archive.js'
import * as caseSensitivity from './caseSensitivity.js'
import * as config from '../host/config.js'
import { loadStateFile } from './stateFile.js'
import * as ownership from './worktreeOwnership.js'
import { createStorePort } from './store-fs.js'
import { createVcsPort } from './vcs-git.js'

/**
 * Assemble a dependency object implementing every port in ports/.
 * @param {Partial<Record<'store'|'vcs'|'config'|'state'|'archive'|'ownership'|'caseSensitivity'|'clock'|'ids', any>>} [overrides]
 * @returns {Record<string, any>}
 */
export function createDefaultDeps(overrides = {}) {
  const store = createStorePort()
  return {
    store,
    vcs: createVcsPort(),
    config: {
      runtimeConfig: config.runtimeConfig,
      resolveRepoConfig: config.resolveRepoConfig,
    },
    state: { loadStateFile },
    archive: {
      readIndex: archive.readArchiveIndex,
      readEntry: archive.readArchivedEntry,
      writeEntries: archive.writeArchiveEntries,
    },
    ownership: {
      assertOwnership: ownership.assertOwnership,
      canonicalPath: ownership.canonicalPath,
    },
    caseSensitivity: { detect: caseSensitivity.detectCaseSensitivity },
    clock: { now: () => Date.now() },
    ids: { uuid: () => crypto.randomUUID(), shortHash: store.shortHash },
    ...overrides,
  }
}

/** The single process-wide default adapter set. */
export const defaultDeps = createDefaultDeps()
