// Mission planning use case.
//
// #217: `tower_plan` can preview a plan (`dry_run: true`) and missions may use
// plan-local `key` values that their siblings reference from `deps`. The preview
// runs the same validation as a real plan — capability gate, entry validation,
// scope expansion/presence, key/dependency resolution, auto-deps, cycles — but
// writes no state, bumps no revision, and records no activity. A real plan that
// fails reports the complete problem set instead of stopping at the first entry.
import { TowerToolError } from '../domain/errors.js'
import { blocker } from '../domain/shapes/blockers.js'
import { nextMissionNumber, addAutoDeps, assertAcyclic } from '../domain/planning.js'
import {
  normalizeMissionInput,
  newMission,
  applyPlan,
} from '../domain/missions/plan.js'
import { scopesOverlap } from '../domain/scope.js'
import { shapeFor } from '../domain/shapes/index.js'
import { validateState } from '../domain/state.js'
import { fullMission } from '../domain/summary.js'
import { sweepArchive } from './archive.js'
import { surveyStaleWarnings } from './freshness.js'
import { readFacts } from './sharedCheckout.js'

/** @typedef {{ kind: string, index?: number, message: string, nextAction?: string, entry?: string, closestPrefix?: string, candidates?: string[] }} PlanProblem */

/**
 * A problem carries the plain message, not the rendered `[tower:code] — next:`
 * wrapper a thrown error shows: the aggregate owns the code, the next action,
 * and the rendering.
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text
    .replace(/^\[tower:[^\]]+\]\s*/, '')
    .replace(/\s+—\s+next:[\s\S]*$/, '')
}

/**
 * #F80: planning a shape whose optional component is off must fail with an
 * actionable message, not silently plan work nothing can execute. This variant
 * collects instead of throwing so a preview (or one aggregated real failure) can
 * report every entry.
 * @param {any} tower
 * @param {any[]} missions
 * @param {Set<number>} broken indexes whose kind is unusable
 * @returns {Promise<PlanProblem[]>}
 */
async function componentProblems(tower, missions, broken) {
  const components = tower.deps?.components
  /** @type {PlanProblem[]} */
  const problems = []
  if (!components) return problems
  for (let index = 0; index < missions.length; index += 1) {
    const mission = missions[index]
    let shape
    try {
      shape = shapeFor(mission?.kind)
    } catch (error) {
      broken.add(index)
      problems.push({ kind: 'mission', index, message: errorMessage(error) })
      continue
    }
    const required = shape.requiredComponent
    if (!required) continue
    let available
    if (typeof components.available === 'function') {
      // null means "cannot tell" (no agent-presets service): let the plan pass,
      // exactly as a host without the component port did before shapes existed.
      available = await components.available(required)
    } else {
      available = components.enabled(required) === true
    }
    if (available !== false) continue
    // #F80: the required component is a capability row id. Name the capability,
    // not the row: the plugin page shows titles, and the gate that checks copy
    // for internal identifiers has no business accepting this one just because
    // the sentence is built here rather than in a copy table.
    problems.push({
      kind: 'component',
      index,
      message: `the capability this mission kind needs is turned off: ${shape.kind} missions cannot be planned; the other kinds still can`,
      nextAction: `turn that capability back on in the plugin page, then plan the ${shape.kind} mission again`,
    })
  }
  return problems
}

/**
 * #200/#217: the one legacy `invalid-argument` for rejected scope entries. The
 * wording is shared with `failScopeEntries` in app/tower.js (the widening path);
 * keep the two in sync. A plan whose only problems are scope entries must keep
 * this exact shape: callers pin the plural and `details.problems`.
 * @param {PlanProblem[]} problems
 * @returns {never}
 */
function failScopePlan(problems) {
  const first = problems[0]
  const closestPrefix = first.closestPrefix ?? ''
  const candidates = first.candidates ?? []
  const parts = [`no tracked file matches "${first.entry}"`]
  if (closestPrefix.length > 0) parts.push(`nearest existing prefix "${closestPrefix}"`)
  if (candidates.length > 0) parts.push(`tracked files there: ${candidates.join(', ')}`)
  if (problems.length > 1) {
    const more = problems.length - 1
    parts.push(`${more} more scope ${more === 1 ? 'entry matches' : 'entries match'} no tracked file`)
  }
  throw new TowerToolError('invalid-argument', parts.join('; '), {
    nextAction: scopePlanNextAction(first),
    details: { operation: 'plan', problems },
  })
}

/**
 * @param {PlanProblem} first
 * @returns {string}
 */
function scopePlanNextAction(first) {
  const candidates = Array.isArray(first.candidates) ? first.candidates : []
  const closestPrefix = typeof first.closestPrefix === 'string' ? first.closestPrefix : ''
  const tracked =
    candidates.length > 0
      ? `a tracked path such as "${candidates[0]}"`
      : `a tracked path${closestPrefix.length > 0 ? ` under "${closestPrefix}"` : ''}`
  return `use ${tracked}, or pass allowMissingScope: true to accept a path a mission will create`
}

/**
 * #217: one error that carries every problem the plan found. A single problem
 * keeps its historical message exactly; a pure scope rejection keeps the
 * historical scope wording above.
 * @param {PlanProblem[]} problems
 * @returns {never}
 */
function failPlanProblems(problems) {
  if (problems.every((problem) => problem.kind === 'scope')) failScopePlan(problems)
  if (problems.length === 1) {
    const [problem] = problems
    throw new TowerToolError('invalid-argument', problem.message, {
      ...(problem.nextAction ? { nextAction: problem.nextAction } : {}),
      details: { operation: 'plan', problems },
    })
  }
  const first = problems[0]
  const more = problems.length - 1
  throw new TowerToolError(
    'invalid-argument',
    `${first.message}; ${more} more plan problem${more === 1 ? '' : 's'}`,
    {
      nextAction: 'fix every reported problem together, then run tower_plan again',
      details: { operation: 'plan', problems },
    },
  )
}

/**
 * #217: validate the plan-local keys without touching ids. A key is a short
 * human handle: trimmed, unique inside the plan, never id-shaped (so `deps` can
 * tell a would-be id from a key), and never an existing/archived mission id.
 * @param {any[]} missions
 * @param {Set<number>} eligible indexes normalized successfully
 * @param {Set<string>} knownIds
 * @param {Map<string, number>} byKey
 * @returns {PlanProblem[]}
 */
function keyProblems(missions, eligible, knownIds, byKey) {
  /** @type {PlanProblem[]} */
  const problems = []
  for (let index = 0; index < missions.length; index += 1) {
    if (!eligible.has(index)) continue
    const raw = missions[index]?.key
    if (raw === undefined) continue
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      problems.push({ kind: 'key', index, message: `missions[${index}].key must be a non-empty string` })
      continue
    }
    const key = raw.trim()
    if (key.length > 64) {
      problems.push({ kind: 'key', index, message: `missions[${index}].key supports at most 64 characters` })
      continue
    }
    if (/^M\d+$/i.test(key)) {
      problems.push({ kind: 'key', index, message: `missions[${index}].key must not look like a mission id ("${key}")` })
      continue
    }
    if (knownIds.has(key)) {
      problems.push({ kind: 'key', index, message: `missions[${index}].key "${key}" is already a mission id` })
      continue
    }
    if (byKey.has(key)) {
      problems.push({ kind: 'key', index, message: `missions[${index}].key "${key}" duplicates missions[${byKey.get(key)}].key` })
      continue
    }
    byKey.set(key, index)
  }
  return problems
}

/**
 * #217: resolve explicit `deps` in this order: an existing/archived mission id,
 * a key defined by this plan, then a would-be id this plan is about to assign.
 * Unknown entries keep the historical message.
 * @param {Map<number, any>} prepared
 * @param {Map<number, string>} wouldBe
 * @param {Set<string>} knownIds
 * @param {Map<string, number>} byKey
 * @returns {PlanProblem[]}
 */
function dependencyProblems(prepared, wouldBe, knownIds, byKey) {
  /** @type {PlanProblem[]} */
  const problems = []
  for (const [index, mission] of prepared) {
    /** @type {string[]} */
    const resolved = []
    for (const dep of mission.deps) {
      let id
      if (knownIds.has(dep)) {
        id = dep
      } else {
        const viaKey = byKey.get(dep)
        if (viaKey !== undefined) id = wouldBe.get(viaKey)
        if (id === undefined && [...wouldBe.values()].includes(dep)) id = dep
      }
      if (id === undefined) {
        problems.push({
          kind: 'deps',
          index,
          message: `mission ${wouldBe.get(index)} depends on unknown mission "${dep}"`,
        })
        continue
      }
      if (!resolved.includes(id)) resolved.push(id)
    }
    mission.deps = resolved
  }
  return problems
}

/**
 * #217: the open missions a new mission can overlap. Terminal work is history,
 * and a deferred mission is out of the overlap check by definition, so neither
 * belongs in the preview.
 * @param {any[]} known
 * @param {any[]} assigned
 * @returns {Map<string, string[]>}
 */
function planOverlaps(known, assigned) {
  const open = known.filter((mission) => {
    const shape = shapeFor(mission.kind)
    if (!shape.reach.ownsPaths) return false
    if (shape.isTerminal(mission.status)) return false
    return mission.deferred !== true
  })
  /** @type {Map<string, string[]>} */
  const overlaps = new Map()
  for (const mission of assigned) {
    const ids = []
    for (const other of [...assigned, ...open]) {
      if (other.id === mission.id) continue
      if (!shapeFor(other.kind).reach.ownsPaths) continue
      if (scopesOverlap(mission.scope, other.scope)) ids.push(other.id)
    }
    overlaps.set(mission.id, [...new Set(ids)].sort())
  }
  return overlaps
}

/**
 * #205: a mission that claims the whole repository (`**`) fences every later
 * planned edit and widening. When other owning missions are still in flight,
 * the plan is legal but the ordering trap is worth naming: the broad mission is
 * usually release preparation, and it belongs last, not in front of live work.
 * The warning never blocks the plan.
 * @param {import('../types/index.js').Mission[]} created
 * @param {import('../types/index.js').Mission[]} existing
 * @returns {Array<{ code: string, missionId: string, missionIds: string[], message: string }>}
 */
function broadScopeWarnings(created, existing) {
  // applyPlan has already appended `created` to `existing` (state.missions) by
  // the time this runs, so the same mission can arrive in both lists. Dedupe by
  // id and keep the first occurrence: one mission must be named once, not once
  // per copy (F98).
  /** @type {Map<string, import('../types/index.js').Mission>} */
  const byId = new Map()
  for (const mission of [...existing, ...created]) {
    if (!byId.has(mission.id)) byId.set(mission.id, mission)
  }
  const inFlight = [...byId.values()].filter((mission) => {
    const shape = shapeFor(mission.kind)
    if (!shape.reach.ownsPaths) return false
    if (!['planned', 'active'].includes(mission.status)) return false
    return mission.deferred !== true
  })
  /** @type {Array<{ code: string, missionId: string, missionIds: string[], message: string }>} */
  const warnings = []
  for (const mission of created) {
    if (!shapeFor(mission.kind).reach.ownsPaths || !mission.scope.includes('**')) continue
    const others = inFlight.filter((entry) => entry.id !== mission.id)
    if (others.length === 0) continue
    const ids = others.map((entry) => entry.id).join(', ')
    const message = `mission ${mission.id} claims the whole repository ("**") while ${ids} ${others.length === 1 ? 'is' : 'are'} still planned or active; it will fence any later planned edit or widening — plan the release-preparation mission last, or mark it deferred or pause it before another mission widens`
    warnings.push({
      code: blocker('broad-scope', message).code,
      missionId: mission.id,
      missionIds: others.map((entry) => entry.id),
      message,
    })
  }
  return warnings
}

/**
 * #217: whether any entry needs the checkout facts a survey records.
 * @param {any[]} missions
 * @returns {boolean}
 */
function planNeedsRead(missions) {
  return missions.some((mission) => {
    try {
      return shapeFor(mission?.kind).fields.readCommit
    } catch {
      return false
    }
  })
}

/**
 * @param {any} tower
 * @param {any} input already expanded by `inspectPlanInput` in app/tower.js
 * @param {{ dryRun?: boolean, scopeProblems?: Array<Record<string, any>> }} [options]
 * @returns {Promise<any>}
 */
export async function plan(tower, input = {}, options = {}) {
  const dryRun = options.dryRun === true
  return tower.withStateLock(async (_paths, held) => {
    const state = await tower.load()
    const now = Date.now()
    if (!Array.isArray(input?.missions) || input.missions.length === 0) {
      throw new TowerToolError('invalid-argument', 'tower_plan needs at least one mission')
    }
    /** @type {PlanProblem[]} */
    const problems = []
    // Scope entries were validated before expansion in app/tower.js; carry the
    // reported problems into one place so a mixed failure can name them all.
    for (const problem of options.scopeProblems ?? []) {
      problems.push({ kind: 'scope', message: `no tracked file matches "${problem.entry}"`, ...problem })
    }
    /** @type {Set<number>} */
    const broken = new Set()
    problems.push(...(await componentProblems(tower, input.missions, broken)))
    // A survey records the commit it reads and the tracked-status fingerprint at
    // plan time; a build plan reads nothing extra.
    const read = planNeedsRead(input.missions) ? await readFacts(tower, state.base) : {}

    /** @type {Map<number, any>} */
    const prepared = new Map()
    for (let index = 0; index < input.missions.length; index += 1) {
      if (broken.has(index)) continue
      try {
        prepared.set(index, normalizeMissionInput(input.missions[index], index, read))
      } catch (error) {
        problems.push({ kind: 'mission', index, message: errorMessage(error), ...(error instanceof TowerToolError && error.nextAction ? { nextAction: error.nextAction } : {}) })
      }
    }

    // Archived ids stay in the known set: a new mission must not reuse an id
    // and a merged dependency may live in the archive index (#73).
    const archive = await tower.archiveIndex()
    const known = [...state.missions, ...(archive.ok ? archive.missions : [])]
    const knownIds = new Set(known.map((mission) => mission.id))
    const start = nextMissionNumber(known)
    /** @type {Map<number, string>} */
    const wouldBe = new Map()
    /** @type {Map<string, number>} */
    const byKey = new Map()
    for (const index of prepared.keys()) wouldBe.set(index, `M${start + wouldBe.size}`)
    problems.push(...keyProblems(input.missions, new Set(prepared.keys()), knownIds, byKey))
    problems.push(...dependencyProblems(prepared, wouldBe, knownIds, byKey))

    // The analysis copy carries the would-be ids and resolved deps so auto-deps,
    // cycle detection, and the overlap report see the plan a real creation would
    // write. A dry run never projects it into the state document.
    const assigned = [...prepared.entries()].map(([index, mission]) => ({
      ...mission,
      id: wouldBe.get(index),
      deps: [...mission.deps],
    }))
    addAutoDeps(assigned, known, { caseInsensitive: state.caseInsensitive === true })
    try {
      assertAcyclic([...known, ...assigned])
    } catch (error) {
      if (!(error instanceof TowerToolError) || error.code !== 'invalid-argument') throw error
      problems.push({ kind: 'cycle', message: error.message })
    }
    const overlaps = planOverlaps(known, assigned)
    /** @type {Map<string, string[]>} */
    const depsById = new Map(assigned.map((mission) => [mission.id, [...mission.deps]]))
    const report = [...prepared.entries()].map(([index, mission]) => {
      const id = wouldBe.get(index) ?? ''
      const key = typeof input.missions[index]?.key === 'string' ? input.missions[index].key.trim() : undefined
      return {
        index,
        ...(key ? { key } : {}),
        wouldBeId: id,
        title: mission.title,
        kind: mission.kind,
        scope: mission.scope,
        deps: depsById.get(id) ?? [],
        overlaps: overlaps.get(id) ?? [],
      }
    })

    if (problems.length > 0) {
      if (!dryRun) failPlanProblems(problems)
      return {
        dry_run: true,
        ok: false,
        revision: state.revision,
        missions: report,
        problems,
      }
    }
    if (dryRun) {
      return {
        dry_run: true,
        ok: true,
        revision: state.revision,
        missions: report,
        problems: [],
      }
    }

    const created = assigned.map((mission) => newMission(mission.id, mission, now))
    const applied = applyPlan(state, created)
    // #148 W2: report survey evidence freshness at plan time. New builds have no
    // provisioned base yet, so the warning compares against the state base; it
    // is advisory here and never blocks the plan. Archived survey dependencies
    // keep their read commit on the archive index, so they are checked too.
    const archivedMissions = new Map(
      (archive.ok ? archive.missions : []).map((entry) => [entry.id, entry]),
    )
    const warnings = []
    for (const mission of created) {
      warnings.push(
        ...(await surveyStaleWarnings(tower, {
          mission,
          state,
          missions: state.missions,
          archived: archivedMissions,
        })),
      )
    }
    warnings.push(...broadScopeWarnings(created, state.missions))
    const swept = await sweepArchive(tower, state, { now })
    state.revision += 1
    state.updatedAt = now

    validateState(state, tower.paths.state)
    await tower.writeState(state, held)
    await tower.appendActivity({
      at: now,
      type: 'plan',
      text: `created ${created.map((mission) => mission.id).join(', ')}`,
    })
    // Persist first, then describe: the event carries the revision the caller
    // can read back from state.json (#75).
    tower.emitEvents(applied.events, { revision: state.revision, at: now })
    return {
      revision: state.revision,
      missions: created.map((mission) => fullMission(mission)),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(swept.archived.length > 0 ? { archived: swept.archived } : {}),
      ...(swept.error ? { archiveError: swept.error } : {}),
    }
  })
}
