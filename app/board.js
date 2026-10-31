// Mission board (MISSIONS.md) writing use cases.
import path from 'node:path'
import { archiveView } from './archive.js'

export function boardFile(tower) {
  return tower.config.docs?.boardLocation === 'repo'
    ? path.join(tower.root, 'MISSIONS.md')
    : path.join(tower.paths.dir, 'MISSIONS.md')
}

/**
 * #133: the board is the `tower-board` component row, not a config switch. The
 * probe is supplied by the composition root. A Tower built without a component
 * probe (unit fixtures, direct adapter use) keeps writing the board: an absent
 * probe means "not composed", not "row disabled".
 *
 * @param {any} tower
 * @returns {boolean}
 */
export function boardEnabled(tower) {
  const components = tower.deps?.components
  if (!components || typeof components.enabled !== 'function') return true
  return components.enabled('tower-board') === true
}

export async function writeBoard(tower) {
  if (!boardEnabled(tower)) return null
  try {
    const state = await tower.load()
    const index = await tower.archiveIndex()
    const file = boardFile(tower)
    await tower.ensureExcluded(file)
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    await tower.deps.store.writeText(tmp, tower.boardMarkdown(state, archiveView(index)), 'utf8')
    await tower.deps.store.renameWithRetry(tmp, file)
    return file
  } catch {
    return null
  }
}
