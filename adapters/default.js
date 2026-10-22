// Default composition root for Tower dependencies (#50).
import * as store from '../lib/store.js'
import * as vcs from '../lib/git.js'
import * as caseSensitivity from '../lib/caseSensitivity.js'

export const defaultDeps = {
  store,
  vcs,
  caseSensitivity,
  clock: { now: () => Date.now() },
  ids: { uuid: () => crypto.randomUUID() },
}
