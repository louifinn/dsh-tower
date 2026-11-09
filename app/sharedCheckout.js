// Shared-checkout helpers for the survey shape (#148).
//
// A survey reads one commit in the shared checkout. The fingerprint recorded at
// plan time is the set of *tracked* changed paths; untracked files (node_modules,
// tmp output) are intentionally ignored so a read-only survey is not blocked by
// build artefacts it never touched.
// @ts-check

/**
 * @param {string} porcelain `git status --porcelain` output
 * @returns {string[]} sorted tracked changed paths
 */
export function trackedFingerprint(porcelain) {
  /** @type {string[]} */
  const paths = []
  for (const line of String(porcelain ?? '').split(/\r?\n/)) {
    if (line.length < 4) continue
    const status = line.slice(0, 2)
    if (status === '??' || status === '!!') continue
    let path = line.slice(3)
    const rename = path.indexOf(' -> ')
    if (rename >= 0) path = path.slice(rename + 4)
    paths.push(path.replace(/^"|"$/g, ''))
  }
  return paths.sort()
}

/**
 * Resolve the commit a survey reads and fingerprint the tracked status at the
 * same moment.
 * @param {{ revParse(cwd: string, ref: string): Promise<string>, git(cwd: string, args: string[]): Promise<string>, root: string }} tower
 * @param {string} ref
 * @returns {Promise<{ commit: string, dirty: string[] }>}
 */
export async function readFacts(tower, ref) {
  const commit = await tower.revParse(tower.root, ref)
  const porcelain = await tower.git(tower.root, ['status', '--porcelain'])
  return { commit, dirty: trackedFingerprint(porcelain) }
}
