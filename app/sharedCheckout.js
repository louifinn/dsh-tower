// Shared-checkout helpers for the survey shape (#148).
//
// A survey reads one commit in the shared checkout. The fingerprint recorded at
// plan time is the set of *tracked* changed paths; untracked files (node_modules,
// tmp output) are intentionally ignored so a read-only survey is not blocked by
// build artefacts it never touched.
// @ts-check

import { TowerToolError } from '../domain/errors.js'

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
  // A survey reads the shared checkout as it stands, so the checkout must be at
  // the base it records. Otherwise every later completion check would compare
  // against a commit the worker never saw (or block it for the wrong reason).
  const head = await tower.revParse(tower.root, 'HEAD')
  if (head !== commit) {
    throw new TowerToolError(
      'invalid-argument',
      `the shared checkout is not at ${ref}: HEAD is ${head.slice(0, 12)} but ${ref} reads ${commit.slice(0, 12)}`,
      { nextAction: `check out ${ref} in the shared checkout and plan the survey again` },
    )
  }
  const porcelain = await tower.git(tower.root, ['status', '--porcelain'])
  return { commit, dirty: trackedFingerprint(porcelain) }
}

/**
 * Load-time resolver for a legacy survey that recorded no base at all (#149).
 * A 2.6.0 survey planned but never provisioned is a valid document with no
 * `baseCommit` and no worktree; the v3 -> v4 migration must anchor it at the
 * state's base ref as that ref resolves *now*, together with the tracked-status
 * fingerprint at the same moment (never a fabricated empty set).
 *
 * HEAD is deliberately not compared with the base here: a migration must load
 * even when the shared checkout is parked on another branch. The plan-time
 * guard in `readFacts` is what enforces HEAD === the recorded commit for a new
 * survey.
 *
 * Returns null when the document records no base ref at all; the migration then
 * fails with its own clear message instead of inventing a commit.
 * @param {{ revParse(cwd: string, ref: string): Promise<string>, git(cwd: string, args: string[]): Promise<string>, root: string }} tower
 * @param {Record<string, any>} rawState
 * @returns {Promise<{ readCommit: string, readDirty: string[] } | null>}
 */
export async function resolveLegacySurveyRead(tower, rawState) {
  const base = rawState?.base
  if (typeof base !== 'string' || base.length === 0) return null
  let readCommit
  try {
    readCommit = await tower.revParse(tower.root, base)
  } catch (error) {
    throw new TowerToolError(
      'state-migration-failed',
      `cannot anchor a planned-but-never-provisioned legacy survey: the state base "${base}" does not resolve (${String(error?.message ?? error)})`,
      {
        cause: error,
        nextAction: `restore or check out the base ref "${base}" in the shared checkout, then load tower again; state.json was not modified`,
      },
    )
  }
  const porcelain = await tower.git(tower.root, ['status', '--porcelain'])
  return { readCommit, readDirty: trackedFingerprint(porcelain) }
}
