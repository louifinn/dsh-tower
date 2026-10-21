// Mission board (MISSIONS.md) writing use cases.
import path from 'node:path'
import { fsp } from '../adapters/store-fs.js'
import { renameWithRetry } from '../lib/store.js'

export function boardFile(tower) {
  return tower.config.docs?.boardLocation === 'repo'
    ? path.join(tower.root, 'MISSIONS.md')
    : path.join(tower.paths.dir, 'MISSIONS.md')
}

export async function writeBoard(tower) {
  if (tower.config.docs?.board === false) return null
  try {
    const state = await tower.load()
    const file = boardFile(tower)
    await tower.ensureExcluded(file)
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    await fsp.writeFile(tmp, tower.boardMarkdown(state), 'utf8')
    await renameWithRetry(tmp, file)
    return file
  } catch {
    return null
  }
}
