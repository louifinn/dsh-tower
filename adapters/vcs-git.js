// The only module in the plugin that imports node:child_process (#50).
//
// Since #69 this is a real adapter, not a re-export shim: `createVcsPort()`
// returns a runtime implementation of VcsPort (ports/vcs.js) that the
// composition root injects into the app layer. The bounded-command
// implementation lives next door in adapters/git.js (#70).
import { execFile, spawn } from 'node:child_process'
import * as git from './git.js'

export { execFile, spawn }

/**
 * Build the Git vcs port (#69). The composition root assembles this once and
 * injects it; a scripted or in-memory vcs can replace it wholesale.
 */
export function createVcsPort() {
  return Object.freeze({ ...git })
}
