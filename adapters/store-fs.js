// The only module in the plugin that imports node:fs (#50).
//
// Since #69 this is a real adapter, not a re-export shim: `createStorePort()`
// returns a runtime implementation of StorePort (ports/store.js) that the
// composition root injects into the app layer. The durable implementation still
// lives in lib/store.js + lib/persistence.js; #70 retires that layer by moving
// the code here. The raw `fs`/`fsp` exports remain for the infrastructure
// modules that are not behind the port yet.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import * as store from '../lib/store.js'

const { createWriteStream } = fs
export { fs, fsp, createWriteStream }

/**
 * Build the filesystem store port (#69).
 *
 * The object is assembled once by the composition root (index.js /
 * adapters/default.js) and injected into the app layer, so the app depends on
 * the port contract and an in-memory implementation can replace it wholesale.
 */
export function createStorePort() {
  return Object.freeze({
    ...store,
    stat: (file) => fsp.stat(file),
    unlink: (file) => fsp.unlink(file),
    readText: (file) => fsp.readFile(file, 'utf8'),
    writeText: (file, text) => fsp.writeFile(file, text, 'utf8'),
    appendText: (file, text) => fsp.appendFile(file, text, 'utf8'),
    rename: (from, to) => fsp.rename(from, to),
  })
}
