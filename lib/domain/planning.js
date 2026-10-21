// Pure mission planning helpers.
import { TowerToolError } from '../errors.js'
import { scopesOverlap } from './scope.js'
import { isTerminal } from './mission.js'

function fail(message) {
  throw new TowerToolError('invalid-argument', message)
}

function nextMissionNumber(missions) {
  let max = 0
  for (const mission of missions) {
    const match = /^M(\d+)$/.exec(mission.id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

function addDependency(mission, dep) {
  if (mission.id === dep) return
  if (!mission.deps.includes(dep)) mission.deps.push(dep)
}

function hasDependencyPath(missionsById, fromId, toId) {
  const seen = new Set()
  const stack = [fromId]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === toId) return true
    if (seen.has(current)) continue
    seen.add(current)
    const mission = missionsById.get(current)
    if (!mission) continue
    for (const dep of mission.deps) stack.push(dep)
  }
  return false
}

function assertAcyclic(missions) {
  const byId = new Map(missions.map((mission) => [mission.id, mission]))
  const state = new Map()
  const visit = (id, trail) => {
    const mark = state.get(id)
    if (mark === 'done') return
    if (mark === 'visiting') fail(`mission dependencies have a cycle: ${[...trail, id].join(' -> ')}`)
    state.set(id, 'visiting')
    const mission = byId.get(id)
    if (mission) for (const dep of mission.deps) visit(dep, [...trail, id])
    state.set(id, 'done')
  }
  for (const mission of missions) visit(mission.id, [])
}

/**
 * Kimi-style heuristic: overlapping build scopes are serialized by an
 * auto-added dependency. It is conservative, not a proof of disjointness.
 */
function addAutoDeps(newMissions, existingMissions) {
  const openExisting = existingMissions.filter((mission) => !isTerminal(mission.status))
  const all = [...existingMissions, ...newMissions]
  const byId = new Map(all.map((mission) => [mission.id, mission]))

  for (let i = 0; i < newMissions.length; i += 1) {
    for (let j = i + 1; j < newMissions.length; j += 1) {
      const earlier = newMissions[i]
      const later = newMissions[j]
      if (earlier.kind === 'survey' || later.kind === 'survey') continue
      if (!scopesOverlap(earlier.scope, later.scope)) continue
      if (hasDependencyPath(byId, later.id, earlier.id)) continue
      addDependency(later, earlier.id)
    }
    const mission = newMissions[i]
    if (mission.kind === 'survey') continue
    for (const other of openExisting) {
      if (other.kind === 'survey') continue
      if (!scopesOverlap(mission.scope, other.scope)) continue
      if (hasDependencyPath(byId, mission.id, other.id)) continue
      addDependency(mission, other.id)
    }
  }
}

export { nextMissionNumber, addDependency, hasDependencyPath, assertAcyclic, addAutoDeps }
