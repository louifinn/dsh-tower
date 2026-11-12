// Ralph-stance reconciliation (#162): Tower and a Ralph loop cannot both own
// one repository.
//
// Ralph is owned by other packages (@deepseek-ai/dsh-tool-ralph and the
// community dsh-ralph), so Tower enforces the exclusivity from its own side at
// three layers:
//
//   names    — tool denial is owned by #161 (domain/deny-owners.js derives
//              mode.denyTools from the owners' generated surface); this file
//              adds the surface that list cannot see, the slash commands, and
//              shadows each command-owner name for the towered agent (an
//              actionable refusal, see ensureStanceCommands)
//   entry    — entering Tower mode with a live loop either stops it (default,
//              `mode.ralphPolicy:"stop"`) or refuses entry with the reason
//              (`mode.ralphPolicy:"refuse"`), and the release is recorded
//   rounds   — a Ralph round is a fresh agent, so per-agent mode keys can
//              never see it; the sensor below identifies round agents by their
//              observable stance facts (the workflow meta name and the round
//              label) and refuses their steps while the repository is under
//              Tower mode. That is what makes a renamed tool or command unable
//              to restart a loop under a live tower.
//
// Observable seams (all observe-only, none can be used to cancel a run):
//   workflow/start|end carry {id, meta}; the first-party loop's meta name is
//   "ralph-loop". Every accepted subagent start appends a "subagent/catalog"
//   session event to the parent with {childId, mode, label}; both Ralph
//   implementations label their rounds "ralph #N …" / "Ralph round N", and the
//   label is not configurable in either package.
//
// A Ralph loop *inside* a Tower worker is not a conflict (the worker owns one
// mission); the round refusal is scoped to the towered workspace, so a
// worker's loop in its isolated worktree keeps running untouched.
import path from 'node:path'
import { stanceDenyCommands } from '../domain/config/command-owners.js'
import { runtimeConfig } from './config.js'

/** First-party Ralph workflow runs carry this meta name. */
const RALPH_WORKFLOW_META = 'ralph-loop'
/** Both implementations prefix round-agent labels with "ralph". */
const RALPH_ROUND_LABEL = /^ralph\b/i
/** A recorded round counts as live for this long after it was seen. */
const RALPH_ROUND_TTL_MS = 5 * 60_000
/** Bound on remembered rounds so a long-lived process cannot grow the sensor. */
const RALPH_ROUNDS_CAP = 200

const RALPH_COMMAND_REFUSAL =
  'Tower mode is active for this session, so the Ralph loop cannot start; /tower off first, then run it again'

/**
 * @typedef {object} RalphRoundRecord
 * @property {string} childId
 * @property {string} label
 * @property {string} parentSessionId
 * @property {string|null} parentCwd
 * @property {number} at
 */

/** Process-local sensor state; host/** owns ambient state by architecture. */
let liveRuns = new Map()
let rounds = new Map()
/** Command-shadow disposers by mode key, so /tower off restores the surface. */
const commandGuards = new Map()

/** Normalize a path for containment comparison (case-insensitive on win32). */
export function normalizeWorkspace(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Whether `child` is inside or equal to `workspace` (both normalized). */
export function workspaceContains(workspace, child) {
  if (!workspace || !child) return false
  if (child === workspace) return true
  return child.startsWith(workspace.endsWith(path.sep) ? workspace : workspace + path.sep)
}

/** Test seam: reset the process-local sensor between test cases. */
export function __testResetRalphSensor() {
  liveRuns = new Map()
  rounds = new Map()
  for (const dispose of commandGuards.values()) dispose()
  commandGuards.clear()
}

/**
 * Install the observe-only listeners. Tolerates a host without the events
 * (fake contexts, minimal profiles): each seam degrades independently.
 * @param {object} ctx
 * @returns {() => void} disposer
 */
export function observeRalphStance(ctx) {
  const disposers = []
  const on = (name, listener) => {
    try {
      const dispose = ctx.on(name, listener)
      disposers.push(typeof dispose === 'function' ? dispose : () => {})
    } catch {
      // a composition without the event is not an error; the other seams stay
    }
  }
  if (typeof ctx?.on === 'function') {
    on('workflow/start', (info) => {
      if (info?.meta?.name === RALPH_WORKFLOW_META) liveRuns.set(String(info.id), { id: String(info.id), at: Date.now() })
    })
    on('workflow/end', (info) => {
      liveRuns.delete(String(info?.id))
    })
    on('session/event', (session, event) => {
      if (!event || event.type !== 'subagent/catalog') return
      const data = event.data
      if (!data || typeof data.childId !== 'string') return
      const label = typeof data.label === 'string' ? data.label : ''
      if (!RALPH_ROUND_LABEL.test(label)) return
      rounds.set(data.childId, {
        childId: data.childId,
        label,
        parentSessionId: String(session?.id ?? ''),
        parentCwd: session?.header?.cwd ?? null,
        at: Date.now(),
      })
      if (rounds.size > RALPH_ROUNDS_CAP) {
        // Drop the oldest remembered rounds first; disposal pruning below is
        // the primary bound, this cap is the safety net.
        const oldest = [...rounds.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, rounds.size - RALPH_ROUNDS_CAP)
        for (const [id] of oldest) rounds.delete(id)
      }
    })
    on('agent/disposed', (payload) => {
      const id = payload?.agent?.id ?? payload?.agent?.session?.id
      if (id !== undefined && id !== null) rounds.delete(String(id))
    })
  }
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Live Ralph activity seen by this process. `workspace` scopes the rounds to
 * one checkout (the towered repository); runs are process-wide because the
 * workflow events carry no cwd — their rounds are what place them.
 * @param {string|null} [workspace]
 * @returns {{ runs: number, rounds: RalphRoundRecord[], liveRounds: number, detail: string | null }}
 */
export function ralphLoopSnapshot(workspace = null) {
  const now = Date.now()
  const scoped = [...rounds.values()].filter(
    (round) =>
      workspace === null ||
      workspaceContains(normalizeWorkspace(workspace), normalizeWorkspace(round.parentCwd)),
  )
  const liveRounds = scoped.filter((round) => now - round.at <= RALPH_ROUND_TTL_MS).length
  const latest = scoped[scoped.length - 1] ?? null
  const detail = latest
    ? `${scoped.length} recorded round agent(s) (latest "${latest.label}" from session ${latest.parentSessionId})`
    : null
  return { runs: liveRuns.size, rounds: scoped, liveRounds, detail }
}

/**
 * Whether a live Ralph loop is reconciled at Tower entry for one workspace.
 * A loop is live when a round agent of that workspace was recorded and is
 * neither disposed nor expired, or a first-party ralph-loop workflow run is
 * live in the process. Without a workspace the rounds cannot be attributed,
 * so only the process-visible workflow runs decide.
 * @param {string|null} workspace
 * @returns {{ live: boolean, rounds: number, runs: number, detail: string | null }}
 */
export function liveRalphIn(workspace) {
  if (workspace === null) {
    return { live: liveRuns.size > 0, rounds: 0, runs: liveRuns.size, detail: null }
  }
  const snapshot = ralphLoopSnapshot(workspace)
  const fresh = snapshot.rounds.some((round) => Date.now() - round.at <= RALPH_ROUND_TTL_MS)
  const live = fresh || snapshot.runs > 0
  return { live, rounds: snapshot.rounds.length, runs: snapshot.runs, detail: snapshot.detail }
}

/**
 * Shadow every command-owner name for one agent while Tower mode is active
 * (#162 D1: commands are not tools; the dsh-ralph handler would start a loop
 * directly). Registration goes through the agent's own scoped context, which
 * is the documented way a per-agent command shadows the global one. Idempotent
 * per mode key; `releaseStanceCommands` restores the global surface.
 * @param {object} agent live DSH agent (needs `agent.ctx.inject`)
 * @param {string} key mode-store key of the towered session
 * @returns {boolean} whether a guard is mounted for this key
 */
export function ensureStanceCommands(agent, key) {
  if (!key || commandGuards.has(key)) return commandGuards.has(key)
  const scoped = agent?.ctx
  if (!scoped || typeof scoped.inject !== 'function') return false
  const names = stanceDenyCommands()
  if (names.length === 0) return false
  try {
    const disposePlugin = scoped.inject(['commands'], (injected) => {
      const disposers = []
      for (const name of names) {
        try {
          const dispose = injected.commands.register({
            name,
            description: `Refused while Tower mode is active (${name} owns an orchestration stance); /tower off restores it`,
            handler: () => ({ kind: 'error', text: `tower mode: /${name} is disabled while Tower mode is active; ${RALPH_COMMAND_REFUSAL}` }),
          })
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch {
          // A name another plugin already shadowed in this scope stays shadowed
          // by that registration; the loop sensor still refuses the rounds.
        }
      }
      return () => {
        for (const dispose of disposers) dispose()
      }
    })
    commandGuards.set(key, () => {
      try {
        if (typeof disposePlugin === 'function') disposePlugin()
      } catch {
        // the scoped context may already be gone
      }
    })
    return true
  } catch {
    return false
  }
}

/** Restore the command surface for one mode key (mode off / store reset). */
export function releaseStanceCommands(key) {
  const dispose = commandGuards.get(key)
  if (!dispose) return
  commandGuards.delete(key)
  dispose()
}

/**
 * The pre-step decision for a Ralph round agent while its workspace is under
 * Tower mode: the round is refused, which is how a loop that was already
 * iterating (or was started through a renamed entry point) is stopped. The
 * towered session's own agent and Tower workers (isolated worktrees) never
 * match: rounds are keyed by child id and scoped by parent workspace.
 * @param {object} agent agent proposing the step
 * @param {(workspace: string|null) => boolean} towered callback: is this workspace under Tower mode now
 * @returns {{ kind: 'reject' } | null}
 */
export function ralphRoundRejection(agent, towered) {
  const id = agent?.id ?? agent?.session?.id
  if (id === undefined || id === null) return null
  const round = rounds.get(String(id))
  if (!round) return null
  const workspace = normalizeWorkspace(round.parentCwd)
  if (!workspace) return null
  if (!towered(workspace)) return null
  return {
    kind: 'reject',
  }
}

/** The refusal text a rejected round surfaces in loop/agent logs. */
export const RALPH_ROUND_REFUSAL =
  'tower mode: this repository is under Tower mode, so a Ralph loop cannot run here; the round agent is refused — stop the loop and rerun it after /tower off'

/**
 * The health-contract projection of the stance: the doctor check row plus the
 * `environmentContract.ralphLoop` fact. It lives here, not in `host/doctor.js`,
 * so the doctor module stays under the host size budget.
 * @param {string} root repository root
 * @returns {{ ralphLoop: {scopedRounds: number, liveScopedRounds: number, processRuns: number, detail: string|null}, row: {status: 'pass'|'warn', detail: string, action?: string} }}
 */
export function ralphStanceDoctorFact(root) {
  const scoped = ralphLoopSnapshot(root)
  const processWide = ralphLoopSnapshot(null)
  const ralphLoop = {
    scopedRounds: scoped.rounds.length,
    liveScopedRounds: scoped.liveRounds,
    processRuns: processWide.runs,
    detail:
      scoped.detail ??
      (processWide.runs > 0
        ? `${processWide.runs} ralph-loop workflow run(s) in this DSH process (no round agents matched this repository yet)`
        : null),
  }
  if (ralphLoop.liveScopedRounds > 0 || (ralphLoop.scopedRounds === 0 && ralphLoop.processRuns > 0)) {
    return {
      ralphLoop,
      row: {
        status: 'warn',
        detail: `this repository has a Ralph loop in progress (${ralphLoop.detail}); Tower cannot co-own it`,
        action: 'finish or stop the loop before /tower on; entering Tower with mode.ralphPolicy:"stop" refuses the loop\'s rounds, "refuse" rejects the entry',
      },
    }
  }
  return {
    ralphLoop,
    row: {
      status: 'pass',
      detail:
        ralphLoop.scopedRounds > 0
          ? `no live Ralph loop in this repository (${ralphLoop.scopedRounds} recorded round(s) outside the liveness window)`
          : 'no live Ralph loop in this repository',
    },
  }
}

/** The config policy read at entry time (hostConfig indirection for tests). */
export function ralphPolicy() {
  const value = runtimeConfig().mode.ralphPolicy
  return value === 'refuse' ? 'refuse' : 'stop'
}
