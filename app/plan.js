// Mission planning use case.
import { TowerToolError } from '../domain/errors.js'
import { validateTitle, normalizeScope } from '../domain/scope.js'
import { nextMissionNumber, addAutoDeps, assertAcyclic } from '../domain/planning.js'
import { validateState } from '../domain/state.js'
import { fullMission } from '../domain/summary.js'
import { withLock, writeJsonAtomic, appendJsonl } from '../lib/store.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeMissionInput(input, index) {
  if (!isPlainObject(input)) fail(`missions[${index}] must be an object`)
  const title = validateTitle(input.title)
  const kind = input.kind === 'survey' ? 'survey' : 'build'
  const scope = normalizeScope(input.scope ?? [], { allowEmpty: kind === 'survey' })
  const tasks = []
  if (input.tasks !== undefined) {
    if (!Array.isArray(input.tasks)) fail(`missions[${index}].tasks must be an array of strings`)
    for (const task of input.tasks) {
      if (typeof task !== 'string' || task.trim().length === 0) {
        fail(`missions[${index}].tasks entries must be non-empty strings`)
      }
      tasks.push({ text: task.trim(), status: 'open' })
    }
  }
  const deps = []
  if (input.deps !== undefined) {
    if (!Array.isArray(input.deps)) fail(`missions[${index}].deps must be an array of mission ids`)
    for (const dep of input.deps) {
      if (typeof dep !== 'string' || dep.trim().length === 0) {
        fail(`missions[${index}].deps entries must be non-empty mission ids`)
      }
      if (!deps.includes(dep.trim())) deps.push(dep.trim())
    }
  }
  const context = typeof input.context === 'string' ? input.context.slice(0, 4096) : ''
  const references = []
  if (input.references !== undefined) {
    if (!Array.isArray(input.references)) fail(`missions[${index}].references must be an array of pointers`)
    if (input.references.length > 20) fail(`missions[${index}].references supports at most 20 pointers`)
    for (const reference of input.references) {
      if (typeof reference !== 'string' || reference.trim().length === 0) {
        fail(`missions[${index}].references entries must be non-empty strings`)
      }
      if (!references.includes(reference.trim())) references.push(reference.trim())
    }
  }
  const reviewPolicy = input.reviewPolicy === undefined ? 'required-clean' : input.reviewPolicy
  if (!['required-clean', 'none'].includes(reviewPolicy)) {
    fail(`missions[${index}].reviewPolicy must be "required-clean" or "none"`)
  }
  const reviewExemptionReason = typeof input.reviewExemptionReason === 'string' ? input.reviewExemptionReason.trim() : ''
  if (reviewPolicy === 'none' && reviewExemptionReason.length === 0) {
    fail(`missions[${index}].reviewPolicy "none" requires a non-empty reviewExemptionReason`)
  }
  return { title, kind, scope, tasks, deps, context, references, reviewPolicy, reviewExemptionReason }
}

function newMission(id, input, now) {
  return {
    id,
    title: input.title,
    kind: input.kind,
    scope: input.scope,
    tasks: input.tasks,
    deps: input.deps,
    context: input.context,
    references: input.references ?? [],
    reviewPolicy: input.reviewPolicy ?? 'required-clean',
    reviewExemptionReason: input.reviewExemptionReason ?? '',
    status: 'planned',
    owner: null,
    blockers: [],
    notes: [],
    reviews: [],
    scopeGeneration: 1,
    createdAt: now,
    updatedAt: now,
  }
}

export async function plan(tower, input = {}) {
  if (!Array.isArray(input.missions) || input.missions.length === 0) {
    fail('tower_plan needs at least one mission')
  }
  const prepared = input.missions.map((mission, index) => normalizeMissionInput(mission, index))
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    const now = Date.now()
    const start = nextMissionNumber(state.missions)
    const assigned = prepared.map((mission, index) => ({ ...mission, id: `M${start + index}` }))

    const known = new Set([...state.missions.map((mission) => mission.id), ...assigned.map((mission) => mission.id)])
    for (const mission of assigned) {
      for (const dep of mission.deps) {
        if (!known.has(dep)) fail(`mission ${mission.id} depends on unknown mission "${dep}"`)
      }
    }

    addAutoDeps(assigned, state.missions)
    assertAcyclic([...state.missions, ...assigned])

    const created = assigned.map((mission) => newMission(mission.id, mission, now))
    state.missions.push(...created)
    state.revision += 1
    state.updatedAt = now

    validateState(state, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, state)
    await appendJsonl(tower.paths.activity, {
      at: now,
      type: 'plan',
      text: `created ${created.map((mission) => mission.id).join(', ')}`,
    })
    return {
      revision: state.revision,
      missions: created.map((mission) => fullMission(mission)),
    }
  })
}
