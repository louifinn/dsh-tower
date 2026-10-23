// Git-mutex budget policy (#93), shared by the app layer and the store
// infrastructure (#69).
//
// The waiter behind the repo-scoped git mutex must outlast a merge that is
// entitled to `mergeTimeoutMs`: a merge legally holds the mutex for its whole
// plan.timeoutMs and then runs a few cheap evidence/cleanup git calls before
// releasing it (#93). The budget is pure policy over the resolved Tower config,
// so it lives in the domain rather than in an adapter; app/tower.js and
// adapters/store.js both compute it from here.
export const GIT_LOCK_MARGIN_MS = 60000

/** The default merge timeout when a caller passes a config without `merge`. */
export const DEFAULT_MERGE_TIMEOUT_MS = 900000

/**
 * @param {{ merge?: { timeoutMs?: number } } | null | undefined} config
 * @param {number} [mergeTimeoutMs] the caller's resolved merge timeout
 * @returns {number}
 */
export function gitLockTimeoutMs(config, mergeTimeoutMs) {
  const explicit = Number(mergeTimeoutMs)
  const configured = Number(config?.merge?.timeoutMs)
  const base =
    Number.isInteger(explicit) && explicit > 0
      ? explicit
      : Number.isInteger(configured) && configured > 0
        ? configured
        : DEFAULT_MERGE_TIMEOUT_MS
  return base + GIT_LOCK_MARGIN_MS
}
