// Mission board (MISSIONS.md) writing use cases.
import path from 'node:path'
import { archiveView } from './archive.js'

export function boardFile(tower) {
  return tower.config.docs?.boardLocation === 'repo'
    ? path.join(tower.root, 'MISSIONS.md')
    : path.join(tower.paths.dir, 'MISSIONS.md')
}

export async function writeBoard(tower) {
  if (tower.config.docs?.board === false) return null
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
