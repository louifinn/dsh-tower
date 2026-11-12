// Default-deny authorization kernel for the Tower tool surface (Debt W1-C).
//
// One place resolves the calling agent into an access class and one table says
// which access classes may call which tool. Before this module every tool
// carried its own decision, and two tools silently promoted an unknown caller
// to the tower. The kernel never guesses:
//
//   * a missing agent id, unreadable state, a state without an owner, or an
//     agent id that is not in the roster resolves to `unknown`;
//   * `unknown` is denied unless the matrix row is explicitly public (read-only
//     operator tools and the session tool) or the row is the bootstrap tool and
//     no owner exists yet;
//   * a tool name without a matrix row is denied: default deny is the default.
//
// `authorize(tool, actor, context)` runs before a handler executes, so a denied
// call cannot write state, acquire the workspace lock, or start a subagent.
// Every shipped tool has a row here, including the session tool the Host entry
// registers directly (tower_mode); together with the tools the component
// modules define that is the complete registered surface (#163 Phase 4).
import { TowerToolError } from '../domain/errors.js'
import { ROLE, isReviewerRole, isTowerRole, isUnknownRole, isWorkerRole } from '../domain/vocabulary.js'
import { rosterProjection } from '../domain/collab/spawn.js'
import { shapeFor } from '../domain/shapes/index.js'
import { isRepositoryOptionalTool } from './tool-profiles.js'

/**
 * Access classes the kernel understands. `survey` is not a roster role: it is
 * a worker whose mission shape has no branch, so its tool access matches a
 * read-only survey instead of a writing worker.
 */
export const ACTOR_ACCESS = Object.freeze({
  tower: 'tower',
  worker: 'worker',
  reviewer: 'reviewer',
  survey: 'survey',
  unknown: 'unknown',
})

const A = ACTOR_ACCESS
const KNOWN = Object.freeze([A.tower, A.worker, A.reviewer, A.survey])
const EVERYONE = Object.freeze([A.tower, A.worker, A.reviewer, A.survey, A.unknown])

/** A tool only the tower may call. */
function towerOnly(action) {
  return Object.freeze({ allow: Object.freeze([A.tower]), action })
}

/** The single actor x tool matrix. A missing entry is a denial. */
export const AUTHORIZATION_MATRIX = Object.freeze({
  // Bootstrap: an unknown caller may claim ownership only while the repository
  // has no owner. Once towerAgentId is recorded only the owner (or a takeover)
  // can initialize state again.
  tower_init: Object.freeze({ allow: Object.freeze([A.tower]), bootstrap: true, action: 'initialize Tower state' }),
  tower_plan: towerOnly('plan missions'),
  // The worker updates tasks, notes and blockers; the domain lifecycle still
  // limits a worker to its own mission and rejects reviewer mutations.
  tower_mission: Object.freeze({
    allow: Object.freeze([A.tower, A.worker, A.survey]),
    denial: (actor) => `only the tower or the mission's worker may update a mission; ${actor.name} is a ${actor.role}`,
  }),
  // Read-only operator surfaces are deliberately public so a broken repository
  // (no state, no owner) can still be diagnosed by an unidentified operator.
  // #163 Phase 3: the five read-only views share one row. Public by default so
  // status/preflight/doctor can diagnose a broken repository; the check narrows
  // the participant-bound views and the doctor config-diagnostic contract applies
  // to the tool that now serves it.
  tower_inspect: Object.freeze({ allow: EVERYONE, configDiagnostic: true, check: inspectViewAccess }),
  tower_spawn: towerOnly('spawn tower agents'),
  tower_interrupt: towerOnly('interrupt tower agents'),
  tower_send: Object.freeze({ allow: KNOWN }),
  tower_inbox: Object.freeze({ allow: KNOWN }),
  // Completion stays worker-owned; a reviewer reaches the app layer and is
  // refused there with "not a worker", preserving the ownership contract.
  tower_complete: Object.freeze({ allow: KNOWN }),
  // #163 Phase 4: report, list and update are one resource and one row.
  tower_finding: Object.freeze({ allow: KNOWN }),
  tower_review: Object.freeze({
    allow: Object.freeze([A.tower, A.reviewer]),
    denial: (actor) =>
      actor.access === A.unknown || actor.role === ROLE.unknown
        ? `tower_review requires a registered roster agent or the tower${ownerRemedy(actor)}`
        : `only an assigned reviewer or the tower may review; ${actor.name} is ${actor.role}`,
  }),
  tower_merge: towerOnly('merge missions'),
  tower_rebase: towerOnly('rebase missions'),
  tower_teardown: towerOnly('tear down worktrees'),
  tower_recover: towerOnly('recover Tower state'),
  tower_batch: towerOnly('manage evidence batches'),
  tower_resource: towerOnly('manage resource leases'),
  // #163 Phase 4: snapshot import and audit-only mapping share one resource.
  tower_import: towerOnly('import or map legacy state'),
  tower_test: Object.freeze({
    allow: Object.freeze([A.tower, A.worker, A.survey]),
    denial: (actor) =>
      isReviewerRole(actor.role)
        ? 'reviewers may not run test discovery'
        : `tower_test requires a registered roster agent or the tower${ownerRemedy(actor)}`,
  }),
  // tower_reload is repository-optional (#163): the tool may run without a
  // repository so a broken profile can still be reloaded. That contract is tool
  // identity registered in `host/tool-profiles.js`, not a guess about whether a
  // caller happened to pass repoRoot; supplying one still follows this
  // tower-only row.
  tower_reload: Object.freeze({ ...towerOnly('reload the Tower plugin') }),
  // Session tools: these report or change the calling session's Tower stance,
  // not repository state, so a repository access class cannot decide them.
  // #163 Phase 4: reads when `active` is absent; writes when it is present.
  // Public so a broken repository or state file stays diagnosable, and so the
  // entry, the mode policy (allowAgentControl) and the handler gates can decide
  // a write: the handler still requires a live calling agent, a non-empty
  // reason, the session's own mode entry, and the human approval path before an
  // ownership takeover.
  tower_mode: Object.freeze({ allow: EVERYONE }),
})

/**
 * True when a matrix row is explicitly public: it admits the anonymous access
 * class, so a caller whose state cannot be read may still reach its handler.
 *
 * @param {string} tool
 */
export function allowsAnonymous(tool) {
  const rule = AUTHORIZATION_MATRIX[tool]
  return Array.isArray(rule?.allow) && rule.allow.includes(A.unknown)
}

/**
 * True when a matrix row declares the config-diagnostic contract (F41): a
 * config-resolution failure while opening the repository is a fact the handler
 * reports, not a failure of the call itself. Only a read-only diagnostic row may
 * opt in — the call continues as the anonymous actor and only that tool's row
 * decides whether the anonymous actor is allowed.
 *
 * @param {string} tool
 */
export function allowsConfigDiagnostic(tool) {
  return AUTHORIZATION_MATRIX[tool]?.configDiagnostic === true
}

/**
 * The config-resolution failure codes an opted-in diagnostic row may report. The
 * authorization kernel treats them as the one open-path failure that is a fact
 * for the handler rather than a failure of the call.
 *
 * @param {any} error
 */
export function isConfigResolutionError(error) {
  return error?.code === 'config-invalid' || error?.code === 'config-unknown-key'
}

/**
 * F41: open the Tower for authorization. Only a config-diagnostic row may treat a
 * config-resolution failure as a reportable fact: return null so the caller
 * authorizes the anonymous actor and the handler reports the failure. Every other
 * row and every other error still fails closed here.
 *
 * @param {string} tool
 * @param {any} repoRoot
 * @param {(repoRoot: any) => Promise<any>} open
 */
export async function openForAuthorization(tool, repoRoot, open) {
  try {
    return await open(repoRoot)
  } catch (error) {
    if (!allowsConfigDiagnostic(tool) || !isConfigResolutionError(error)) throw error
    return null
  }
}

/**
 * True when a tool is registered as repository-optional in the profile registry
 * (#163). The registry is the single source: the matrix row no longer carries a
 * duplicate `repoOptional` flag.
 *
 * @param {string} tool
 */
export function isRepositoryOptional(tool) {
  return isRepositoryOptionalTool(tool)
}

/**
 * Resolve the calling agent to a roster access class.
 *
 * Never returns the tower for an agent it cannot prove: the owner, a roster row
 * with the tower role, or a known roster role are required. `state.towerAgentId`
 * is the only proof of ownership, so an ownerless (legacy) state resolves to
 * unknown until tower_init re-claims it.
 *
 * @param {any} tower opened Tower instance
 * @param {any} exec tool execution context
 * @returns {Promise<{name: string, role: string, access: string, agentId: string | null, missionId: string | null, owner: string | null, ownerMissing: boolean}>}
 */
export async function resolveActor(tower, exec) {
  const agentId = exec?.agent?.id !== undefined ? String(exec.agent.id) : null
  /** @type {any} */
  const anonymous = {
    name: ROLE.unknown,
    role: ROLE.unknown,
    access: A.unknown,
    agentId,
    missionId: null,
    owner: null,
    ownerMissing: false,
  }
  if (!agentId) return anonymous
  let state
  try {
    state = await tower.load()
  } catch (error) {
    // No readable state: only tower_init's bootstrap path may act, and it will
    // fail closed in the handler if the caller cannot claim ownership.
    if (error?.code !== 'not-initialized') throw error
    return { ...anonymous, ownerMissing: true }
  }
  const owner = state.towerAgentId ? String(state.towerAgentId) : null
  // An ownerless state proves nothing about the caller. Bootstrap is tower_init
  // only; every other tool stays denied until an owner exists.
  if (!owner) return { ...anonymous, ownerMissing: true }
  if (owner === agentId) {
    return { name: ROLE.tower, role: ROLE.tower, access: A.tower, agentId, missionId: null, owner, ownerMissing: false }
  }
  const self = rosterProjection(state).roster.find((entry) => entry.agentId === agentId)
  if (!self) return { ...anonymous, owner }
  const base = { agentId, missionId: self.missionId ?? null, owner, ownerMissing: false }
  if (isTowerRole(self.role)) return { ...base, name: self.name, role: ROLE.tower, access: A.tower }
  if (isReviewerRole(self.role)) return { ...base, name: self.name, role: self.role, access: A.reviewer }
  if (isWorkerRole(self.role)) return { ...base, name: self.name, role: self.role, access: workerAccess(state, self.missionId) }
  // A roster row carrying an unrecognized role is not evidence of a known actor.
  return { ...base, name: self.name, role: self.role, access: A.unknown }
}

/**
 * A worker is a survey actor when its mission's shape has no branch to merge.
 * Shape facts decide the access class; the role is not compared to a shape.
 *
 * @param {any} state
 * @param {string | null | undefined} missionId
 */
function workerAccess(state, missionId) {
  const mission = (state.missions ?? []).find((entry) => entry.id === missionId)
  if (!mission) return A.worker
  let branchless = false
  try {
    branchless = shapeFor(mission.kind).canMerge === false
  } catch {
    branchless = false
  }
  return branchless ? A.survey : A.worker
}

/**
 * The anonymous actor used when no Tower state can be opened at all. The
 * bootstrap exception (tower_init) treats it as "no owner yet"; every other
 * tool denies it.
 *
 * @param {any} exec
 */
export function anonymousActor(exec) {
  const agentId = exec?.agent?.id !== undefined ? String(exec.agent.id) : null
  return {
    name: ROLE.unknown,
    role: ROLE.unknown,
    access: A.unknown,
    agentId,
    missionId: null,
    owner: null,
    ownerMissing: true,
  }
}

/**
 * Apply the matrix to one tool call. Default deny: an unknown tool, an unknown
 * access class, or an unlisted access class throws `[tower:not-authorized]`.
 *
 * @param {string} tool registered tool name
 * @param {any} actor result of resolveActor
 * @param {{ args?: any, tower?: any, repositoryAbsent?: boolean }} [context]
 */
export async function authorize(tool, actor, context = {}) {
  const rule = AUTHORIZATION_MATRIX[tool]
  const access = actor?.access ?? A.unknown
  if (!rule) {
    throw new TowerToolError('not-authorized', `${tool} has no authorization policy; this tool is denied by default`)
  }
  // An explicit repository-optional call without a repository has no repository
  // ownership to check. Only the anonymous actor can take this path: no
  // repository identity can be proven without one. The tool identity is
  // registered in `host/tool-profiles.js`, and supplying a repository opts back
  // into the matrix row (tower-only for tower_reload).
  if (context.repositoryAbsent === true && isRepositoryOptional(tool) && access === A.unknown) {
    return { tool, access, bootstrap: false, repositoryAbsent: true }
  }
  if (access === A.unknown) {
    const bootstrap = rule.bootstrap === true && !actor?.owner
    if (!rule.allow.includes(A.unknown) && !bootstrap) throw denial(tool, actor, rule)
    // #163 Phase 3: a public row may still narrow some of its views (roster and
    // diff are participant-bound). The bootstrap exception never gets a
    // participant check: the handler must resolve the repository itself.
    if (bootstrap) return { tool, access, bootstrap }
    if (typeof rule.check === 'function') await rule.check({ actor, args: context.args ?? {}, tower: context.tower })
    return { tool, access, bootstrap }
  }
  if (!rule.allow.includes(access)) throw denial(tool, actor, rule)
  if (typeof rule.check === 'function') await rule.check({ actor, args: context.args ?? {}, tower: context.tower })
  return { tool, access, bootstrap: false }
}

/** A denial error with a stable `[tower:not-authorized]` code. */
function denial(tool, actor, rule) {
  if (typeof rule.denial === 'function') return new TowerToolError('not-authorized', rule.denial(actor ?? {}))
  if (!actor || isUnknownRole(actor.role)) {
    return new TowerToolError('not-authorized', `${tool} requires a registered roster agent or the tower${ownerRemedy(actor)}`)
  }
  return new TowerToolError(
    'not-authorized',
    `only the tower can ${rule.action ?? tool}; ${actor.name} is a ${actor.role}${ownerRemedy(actor)}`,
  )
}

/**
 * #163 Phase 3: view-level narrowing for the one public `tower_inspect` row.
 * status/preflight/doctor stay public (a broken repository must be diagnosable),
 * roster needs a known actor, and diff additionally needs mission participation.
 *
 * @param {{ actor: any, args: any }} input
 */
async function inspectViewAccess({ actor, args }) {
  if (args?.view === 'roster') requireKnownActor(actor, 'read the roster')
  if (args?.view === 'diff') {
    requireKnownActor(actor, 'inspect a mission branch')
    await requireParticipant({ actor, args })
  }
}

/**
 * tower_diff is readable by the tower and by an agent recorded on that mission.
 * The roster row's mission id is authoritative: it is written when the spawn is
 * recorded, so a non-participant cannot inspect another mission's branch.
 *
 * @param {{ actor: any, args: any }} input
 */
async function requireParticipant({ actor, args }) {
  if (actor?.access === A.tower) return
  const missionId = typeof args?.missionId === 'string' ? args.missionId : null
  if (missionId && actor?.missionId && actor.missionId === missionId) return
  throw new TowerToolError('not-authorized', `${actor?.role ?? ROLE.unknown} ${actor?.name ?? ROLE.unknown} does not participate in mission ${missionId ?? '(unknown)'}`)
}

/** Actionable owner hint for an authorization failure. */
export function ownerRemedy(actor) {
  if (actor?.ownerMissing || !actor?.owner) {
    return '; repository state has no towerAgentId — run tower_init to re-claim'
  }
  return `; repository owner is ${actor.owner} — in this session run /tower takeover <reason>, or use the owner session`
}

/**
 * Known-actor guard retained for tool handlers that keep their own defence in
 * depth. The kernel is authoritative; this mirror only repeats its message.
 */
export function requireKnownActor(actor, action) {
  if (!actor || isUnknownRole(actor.role)) {
    throw new TowerToolError('not-authorized', `${action} requires a registered roster agent or the tower${ownerRemedy(actor)}`)
  }
}

/**
 * Tower-only guard retained for tool handlers that keep their own defence in
 * depth. The kernel is authoritative; this mirror only repeats its message.
 */
export function requireTowerActor(actor, action) {
  if (!isTowerRole(actor.role)) {
    throw new TowerToolError('not-authorized', `only the tower can ${action}; ${actor.name} is a ${actor.role}${ownerRemedy(actor)}`)
  }
}
