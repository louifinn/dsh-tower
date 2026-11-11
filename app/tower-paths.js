// Worktree path guards (W5-A).
//
// The Tower facade keeps `assertOutside`/`ensureExcluded` as methods; the
// implementation lives here so app/tower.js stays a thin class facade. The
// checks, return shapes and error text are unchanged.
import path from 'node:path'
import { TowerToolError } from '../domain/errors.js'

export function assertOutside(tower, target) {
  const resolved = path.resolve(target)
  const inside = (parent) => {
    const rel = path.relative(path.resolve(parent), resolved)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }
  if (resolved === path.resolve(tower.root) || inside(tower.root)) {
    throw new TowerToolError('invalid-argument', `worktree path must be outside the main checkout: ${resolved}`)
  }
  if (resolved === path.resolve(tower.commonDir) || inside(tower.commonDir)) {
    throw new TowerToolError('invalid-argument', `worktree path must be outside Git metadata: ${resolved}`)
  }
  return resolved
}

export async function ensureExcluded(tower, target) {
  if (tower.config.init?.autoExclude === false) return { inside: false, excluded: false }
  const absolute = path.resolve(String(target))
  const relative = path.relative(tower.root, absolute)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { inside: false, excluded: false }
  }
  const pattern = relative.split(path.sep).join('/')
  const file = path.join(tower.commonDir, 'info', 'exclude')
  await tower.deps.store.ensureDir(path.dirname(file))
  let text = ''
  try {
    text = await tower.deps.store.readText(file)
  } catch {
    text = ''
  }
  const lines = text.split(/\r?\n/)
  if (lines.includes(pattern) || lines.includes(`${pattern}/`)) return { inside: true, excluded: true, pattern }
  const suffix = text === '' || text.endsWith('\n') ? '' : '\n'
  await tower.deps.store.appendText(file, `${suffix}${pattern}\n`)
  return { inside: true, excluded: true, pattern }
}
