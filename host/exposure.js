// Step-time exposure gate (#164 stages 2 and 4).
//
// The host session (a profile session that is not running a Tower role
// preset) sees the tower tools through the L1 phase ladder in
// `domain/exposure.js`; agents composed with a Tower role preset are gated by
// their preset's allow-list instead (a worker calls `tower_mission` with
// Tower mode off, so the ladder must not subtract there).
//
// Mechanism (ADR 0009): each tool is registered with a step-time activation
// condition (`ctx.tools.register(definition, { when })`). The host resolves
// conditions once per model step — a turn boundary — and the admitted set is
// frozen for that step, so the set that built request N is the set that
// validates calls in N. A tool hidden by the gate resolves as UNKNOWN_TOOL,
// exactly like a missing tool: hiding is not refusal and leaks nothing.
//
// Failure policy: exposure only subtracts, so this gate fails OPEN. Any error
// (no agent identity, unreadable state, a throwing preset probe) exposes the
// tool — the worst case is yesterday's unconditional surface, never a hidden
// way out.
import { exposes, phaseOfFacts, TOWER_PRESET_IDS } from '../domain/exposure.js'
import { agentKey } from './mode-state.js'

/**
 * @typedef {((name: string, context: { agent?: any }) => Promise<boolean>) & { reset: () => void }} ExposureGate
 */

/**
 * Build an exposure gate from injected facts. Pure coordination: the caller
 * supplies the mode bit, the preset probe and the state-existence probe, so
 * tests never touch mode-state or the filesystem.
 *
 * @param {{
 *   modeOn: (key: string) => boolean,
 *   presetOf: (agent: any) => string | null | undefined,
 *   stateExists: (agent: any) => Promise<boolean>,
 *   memoLimit?: number,
 * }} deps
 * @returns {ExposureGate} the `when` predicate for one registered tool
 */
export function createExposureGate(deps) {
  const memo = new Map()
  const memoLimit = Number(deps.memoLimit) > 0 ? Number(deps.memoLimit) : 64
  const stateExistsFor = async (agent) => {
    const key = agentKey(agent)
    if (!key) return true
    let pending = memo.get(key)
    if (!pending) {
      pending = Promise.resolve(deps.stateExists(agent)).catch(() => true)
      if (memo.size >= memoLimit) memo.clear()
      memo.set(key, pending)
    }
    return pending
  }
  const reset = () => {
    memo.clear()
  }
  const gate = async function expose(name, context) {
    try {
      const agent = context?.agent
      const key = agentKey(agent)
      if (!key) return true
      const preset = deps.presetOf(agent)
      if (typeof preset === 'string' && TOWER_PRESET_IDS.includes(preset)) return true
      const mode = deps.modeOn(key) ? 'on' : 'off'
      // The state probe only runs for the tower session itself (mode on), and
      // its result is memoized per agent until the next tower tool call or
      // mode change resets it — never recomputed per mutation.
      const stateExists = mode === 'on' ? await stateExistsFor(agent) : false
      const phase = phaseOfFacts({ mode, stateExists })
      return exposes(phase, name)
    } catch {
      return true
    }
  }
  gate.reset = reset
  return gate
}

/** @type {ExposureGate | null} */
let installedGate = null

/**
 * Install the process gate `define()` attaches to every registration. The
 * host entry (index.js) is the only installer; tests and embedders that call
 * the registrars directly keep the unconditional surface.
 *
 * @param {Parameters<typeof createExposureGate>[0]} deps
 * @returns {() => void} disposer that uninstalls the gate
 */
export function installExposureGate(deps) {
  const gate = createExposureGate(deps)
  installedGate = gate
  return () => {
    // Only clear our own installation: an HMR reload can install the next
    // gate before the previous effect disposes, and clearing it blindly would
    // silently restore the unconditional surface.
    if (installedGate === gate) installedGate = null
  }
}

/**
 * The step-time condition for one tool, or undefined when no gate is
 * installed (unconditional registration — the compatibility floor for
 * compositions that never installed one).
 * @param {string} name
 */
export function exposureWhen(name) {
  if (!installedGate) return undefined
  // Fail open if the gate is uninstalled while a registration is still live
  // (an HMR edge): exposure only subtracts, so the fallback is the
  // unconditional surface, never a hidden tool.
  return (context) => (installedGate ? installedGate(name, context) : true)
}

/** Reset the memoized phase facts (called after every tower tool execution). */
export function resetExposureMemo() {
  installedGate?.reset?.()
}
