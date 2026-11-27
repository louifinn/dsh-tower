// Landed-mission observation (#248): one read-only answer to "is this branch's
// work already in the base?", shared by the three callers that need it —
// `tower_init` reanchor, `tower_merge` and `tower_teardown`.
//
// Two shapes count as landed:
//   merged   the branch tip is an ancestor of the base tip (a --no-ff merge, a
//            fast-forward or a rebase all end here).
//   equivalent  every commit in base..branch has a patch-equivalent commit in
//            the base (`git cherry` marks each one `-`). That is the
//            cherry-pick landing: the content shipped, the tip never merged.
//
// Nothing is written here and no state is touched: a caller that wants to act on
// the answer does so through its own locked write.
// @ts-check

/**
 * @typedef {object} Landing
 * @property {boolean} landed
 * @property {'merged' | 'equivalent' | null} [basis]
 * @property {string | null} [baseTip]
 * @property {string | null} [branchTip]
 */

/** @type {Landing} */
const NOT_LANDED = { landed: false }

/**
 * @param {any} tower
 * @param {string} base           the base ref the question is asked against
 * @param {any} mission
 * @returns {Promise<Landing>}
 */
export async function observeMissionLanding(tower, base, mission) {
  const branch = mission?.worktree?.branch
  if (!branch || typeof branch !== 'string') return NOT_LANDED
  let baseTip
  let branchTip
  try {
    baseTip = await tower.revParse(tower.root, base)
    branchTip = await tower.branchTip(mission)
  } catch {
    // An unresolvable base or branch is not evidence of landing. The caller
    // reports its ordinary base/branch error instead of guessing.
    return NOT_LANDED
  }
  if (!baseTip || !branchTip) return NOT_LANDED
  // A branch that never received a commit of its own sits exactly on the base
  // tip, which is trivially an ancestor. That is "nothing to land", not
  // "landed": treating it as landed would let an active mission be retired.
  // It also keeps `git cherry base branch` from answering for an empty range.
  if (branchTip === baseTip) return NOT_LANDED

  if (await tower.isAncestor(tower.root, branchTip, baseTip)) {
    return { landed: true, basis: 'merged', baseTip, branchTip }
  }

  // `git rev-list base..branch` counts the commits the base does not have;
  // `git cherry base branch` lists the same set and prefixes `-` to each commit
  // whose patch is already upstream. Equal counts with every line marked `-`
  // means the content landed even though the tip did not merge.
  const listed = await tower.tryGit(tower.root, ['rev-list', base === 'HEAD' ? 'HEAD' : `${base}..${branchTip}`])
  if (listed === null) return NOT_LANDED
  const commits = listed.split('\n').map((line) => line.trim()).filter(Boolean)
  if (commits.length === 0) return NOT_LANDED

  const cherry = await tower.tryGit(tower.root, ['cherry', base, branch])
  if (cherry === null) return NOT_LANDED
  const rows = cherry.split('\n').map((line) => line.trim()).filter(Boolean)
  if (rows.length !== commits.length) return NOT_LANDED
  if (!rows.every((row) => row.startsWith('-'))) return NOT_LANDED
  return { landed: true, basis: 'equivalent', baseTip, branchTip }
}

/**
 * Ids of the missions whose branch content is already in `base`. Used where a
 * decision is made for a whole state (reanchor, teardown): one read per mission
 * that could possibly matter, and only for missions that still carry a worktree.
 * @param {any} tower
 * @param {any} state
 * @param {string} base
 * @param {(mission: any) => boolean} [wanted]
 * @returns {Promise<Set<string>>}
 */
export async function landedMissionIds(tower, state, base, wanted) {
  const landed = new Set()
  for (const mission of state.missions ?? []) {
    if (!mission?.worktree?.branch) continue
    if (wanted && !wanted(mission)) continue
    const observed = await observeMissionLanding(tower, base, mission)
    if (observed.landed && typeof mission.id === 'string') landed.add(mission.id)
  }
  return landed
}
