// Default composition root for Tower dependencies (#50).
import * as store from '../lib/store.js'
import * as vcs from '../lib/git.js'

export const defaultDeps = {
  store,
  vcs,
  clock: { now: () => Date.now() },
  ids: { uuid: () => crypto.randomUUID() },
}
