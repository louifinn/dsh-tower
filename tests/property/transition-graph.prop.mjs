// Properties 3 and 4 (#130): the mission transition graph is total and closed,
// and a terminal mission can never leave the terminal set.
//
// The expected status/terminal vocabulary and the expected edge set are declared
// independently in ./model/tables.mjs (that module imports nothing from
// domain/), so a change to domain/mission.js cannot silently move the goalposts.
// The real TRANSITIONS table, `canTransition`, `isTerminal`, and
// `applyMissionUpdate` are the system under test:
//
//   * every declared status is a graph node;
//   * every edge references a declared status and no edge leaves a terminal;
//   * every non-terminal status has at least one legal successor that a tower
//     status patch can actually reach, and terminals have none;
//   * a terminal mission refuses every status patch and a blocker, byte-identical
//     (it never leaves `merged` / `abandoned`).
//
// Notes are annotations, not lifecycle transitions: a note-only patch on a
// terminal mission is accepted, so the property pins that it still cannot change
// the terminal status. The bare `tower_mission` override that completes a mission
// with open tasks is intentional and is not exercised here: it is
// `app/mission.js:19` calling `applyMissionUpdate`, which applies the transition
// table without the completion-admission checks in `app/checkCompletion.js:22`
// (`assertCompletionRequest`) or the gates composed in `app/gate.js:43`
// (`completionBlockers`) and `app/gate.js:94` (`mergeGateBlockers`).
// tests/state-machine.test.mjs:104 pins the allowed/denied transition table and
// tests/protocol.e2e.test.mjs:318 drives blocked → completed through
// `tower.mission`, but both fixtures carry no tasks, so neither pins the
// open-task aspect; the frozen example in tests/property/no-illegal-path.prop.mjs
// does. That file drives the guarded completion and merge pipelines instead.
//
// No shrunk domain counterexample has been observed for these properties across
// the three PR seeds (131, 40961, 978217) or the 2000-run long tier. The frozen
// terminal fixtures and the frozen matrix in ./no-illegal-path.prop.mjs are the
// permanent record, not a replay of a recorded failure.
import assert from 'node:assert/strict'
import fc from 'fast-check'

import { TowerToolError } from '../../domain/errors.js'
import { MISSION_STATUSES, TERMINAL_STATUSES, TRANSITIONS, canTransition, isTerminal } from '../../domain/mission.js'
import { applyMissionUpdate } from '../../domain/missions/lifecycle.js'
import { stateArb } from './arbitraries/index.mjs'
import { runProperty } from './helpers/harness.mjs'
import { MODEL_CONFIG, MODEL_STATUSES, MODEL_TERMINAL_STATUSES, MODEL_TRANSITIONS } from './model/tables.mjs'

const NOW = 1_700_000_000_000
const NOTE = 'terminal absorption probe'
const AUTHORIZATION = 'authorized-by-property'

/**
 * A minimal mission fixture for the status graph. It deliberately carries an
 * open task and no worktree: a status graph edge is about the status write, not
 * about the completion/merge admission.
 * @param {string} status
 * @returns {Record<string, any>}
 */
function probeMission(status) {
  return {
    id: 'M1',
    title: 'Transition graph probe',
    status,
    kind: 'build',
    scope: ['tests/property/**'],
    deps: [],
    tasks: [{ text: 'probe task', status: 'open' }],
    blockers: [],
    notes: [],
    owner: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

/**
 * A generated-shaped state around one frozen mission, for the frozen matrices.
 * @param {string} status
 * @returns {Record<string, any>}
 */
function frozenState(status) {
  return {
    schemaVersion: 3,
    revision: 7,
    missions: [probeMission(status)],
    roster: [],
    reviews: [],
    findings: [],
    messages: [],
    batches: [],
  }
}

/**
 * @param {() => void} callback
 * @returns {unknown | null}
 */
function rejectionOf(callback) {
  try {
    callback()
    return null
  } catch (error) {
    return error
  }
}

/**
 * Apply one status patch to a clone and assert the terminal refusal is
 * byte-identical: no field of the mission or of the surrounding state moved.
 * @param {{ label: string, mission: Record<string, any>, state: Record<string, any>, target: string }} input
 */
function assertTerminalStatusPatchRejected({ label, mission, state, target }) {
  const draftMission = structuredClone(mission)
  const draftState = structuredClone(state)
  const missionBefore = JSON.stringify(draftMission)
  const stateBefore = JSON.stringify(draftState)
  const error = rejectionOf(() =>
    applyMissionUpdate({
      mission: draftMission,
      state: draftState,
      input: { status: target, note: NOTE, authorization: AUTHORIZATION },
      config: MODEL_CONFIG,
    }),
  )
  assert.ok(error instanceof TowerToolError, `${label}: ${mission.status} -> ${target} was accepted, expected a rejection`)
  assert.equal(error.code, 'invalid-transition', `${label}: unexpected rejection code (${error.message})`)
  assert.equal(JSON.stringify(draftMission), missionBefore, `${label}: a rejected patch mutated the mission draft`)
  assert.equal(JSON.stringify(draftState), stateBefore, `${label}: a rejected patch mutated the state draft`)
  assert.ok(MODEL_TERMINAL_STATUSES.has(draftMission.status), `${label}: the mission left the terminal set`)
}

runProperty({
  name: 'transition graph: every declared status is a node, every edge references a declared status, and the table matches the independent declaration',
  arbitrary: fc.constant(null),
  predicate: () => {
    assert.deepEqual(
      [...MISSION_STATUSES].sort(),
      [...MODEL_STATUSES].sort(),
      'the production status vocabulary drifted from the independent declaration',
    )
    assert.deepEqual(
      Object.keys(TRANSITIONS).sort(),
      [...MODEL_STATUSES].sort(),
      'TRANSITIONS must have exactly one node per declared status',
    )
    assert.deepEqual(
      [...MODEL_TERMINAL_STATUSES].sort(),
      [...TERMINAL_STATUSES].sort(),
      'the production terminal set drifted from the independent declaration',
    )
    for (const status of MODEL_STATUSES) {
      const targets = TRANSITIONS[status]
      assert.ok(Array.isArray(targets), `${status}: TRANSITIONS entry is not an array`)
      assert.equal(new Set(targets).size, targets.length, `${status}: duplicate edge`)
      for (const target of targets) {
        assert.ok(MODEL_STATUSES.includes(target), `${status}: edge references unknown status ${target}`)
        assert.equal(canTransition(status, target), true, `${status} -> ${target}: canTransition disagrees with the table`)
        assert.equal(
          MODEL_TRANSITIONS[status].includes(target),
          true,
          `${status} -> ${target}: the domain gained an edge the independent table does not declare`,
        )
      }
      for (const target of MODEL_TRANSITIONS[status]) {
        assert.ok(targets.includes(target), `${status} -> ${target}: the independent table declares a missing edge`)
      }
      if (MODEL_TERMINAL_STATUSES.has(status)) {
        assert.deepEqual(targets, [], `${status}: a terminal status must have no outgoing edge`)
      } else {
        assert.ok(targets.length > 0, `${status}: a non-terminal status needs at least one legal successor`)
      }
      assert.equal(isTerminal(status), MODEL_TERMINAL_STATUSES.has(status), `${status}: isTerminal disagrees`)
    }
    for (const from of MODEL_STATUSES) {
      for (const to of MODEL_STATUSES) {
        assert.equal(
          canTransition(from, to),
          MODEL_TRANSITIONS[from].includes(to),
          `canTransition(${from}, ${to}) disagrees with the independent table`,
        )
      }
    }
  },
})

runProperty({
  name: 'transition graph: terminal missions have no legal successor and a non-terminal status reaches at least one; every declared edge is reachable by a tower status patch',
  arbitrary: fc.constantFrom(...MODEL_STATUSES),
  predicate: (status) => {
    const mission = probeMission(status)
    const state = frozenState(status)
    const targets = MODEL_TRANSITIONS[status]
    if (MODEL_TERMINAL_STATUSES.has(status)) {
      assert.equal(TRANSITIONS[status].length, 0, `${status}: a terminal status has a declared successor`)
      for (const target of MODEL_STATUSES) {
        assertTerminalStatusPatchRejected({ label: `${status} -> ${target}`, mission, state, target })
      }
      return
    }
    assert.ok(TRANSITIONS[status].length > 0, `${status}: a non-terminal status has no legal successor`)
    let reached = 0
    for (const target of TRANSITIONS[status]) {
      const draftMission = structuredClone(mission)
      const draftState = structuredClone(state)
      applyMissionUpdate({
        mission: draftMission,
        state: draftState,
        input: { status: target, note: NOTE, authorization: AUTHORIZATION },
        config: MODEL_CONFIG,
      })
      assert.equal(draftMission.status, target, `${status} -> ${target}: the accepted patch did not write the status`)
      assert.notEqual(target, 'merged', 'a status patch must never write merged')
      reached += 1
    }
    assert.ok(reached > 0, `${status}: no declared successor was reachable through tower_mission`)
  },
})

const terminalStateArb = stateArb.filter((state) =>
  (state.missions ?? []).some((mission) => MODEL_TERMINAL_STATUSES.has(mission.status)),
)

/** A trimmed, non-empty free-text value (blank input is not a legal note/blocker). */
const textArb = fc.string({ minLength: 1, maxLength: 40 }).map((raw) => raw.trim()).filter((text) => text.length > 0)

runProperty({
  name: 'terminal absorption: a generated terminal mission rejects every status patch and keeps the state byte-identical',
  arbitrary: fc.tuple(terminalStateArb, fc.constantFrom(...MODEL_STATUSES)),
  predicate: ([state, target]) => {
    const mission = state.missions.find((entry) => MODEL_TERMINAL_STATUSES.has(entry.status))
    assert.ok(mission, 'the filtered arbitrary produced no terminal mission')
    assertTerminalStatusPatchRejected({ label: `generated ${mission.id} ${mission.status} -> ${target}`, mission, state, target })
    assert.equal(canTransition(mission.status, target), false, `${mission.status} -> ${target}: terminal edge declared`)
  },
  examples: [
    [[frozenState('merged'), 'completed']],
    [[frozenState('abandoned'), 'active']],
    [[frozenState('merged'), 'merged']],
  ],
})

runProperty({
  name: 'terminal absorption: a terminal mission refuses a blocker update byte-identically',
  arbitrary: fc.tuple(terminalStateArb, textArb),
  predicate: ([state, blocker]) => {
    const mission = state.missions.find((entry) => MODEL_TERMINAL_STATUSES.has(entry.status))
    assert.ok(mission, 'the filtered arbitrary produced no terminal mission')
    const draftMission = structuredClone(mission)
    const draftState = structuredClone(state)
    const missionBefore = JSON.stringify(draftMission)
    const stateBefore = JSON.stringify(draftState)
    const error = rejectionOf(() =>
      applyMissionUpdate({ mission: draftMission, state: draftState, input: { blocker }, config: MODEL_CONFIG }),
    )
    assert.ok(error instanceof TowerToolError, `${mission.status}: a blocker reopened a terminal mission`)
    assert.equal(error.code, 'invalid-argument', `unexpected rejection code (${error.message})`)
    assert.match(String(error.message), /terminal mission/, 'the blocker must be refused by the terminal guard')
    assert.equal(JSON.stringify(draftMission), missionBefore, 'a rejected blocker mutated the mission draft')
    assert.equal(JSON.stringify(draftState), stateBefore, 'a rejected blocker mutated the state draft')
    assert.ok(MODEL_TERMINAL_STATUSES.has(draftMission.status), 'a rejected blocker changed the terminal status')
  },
})

runProperty({
  name: 'terminal absorption: a note-only update on a terminal mission is accepted and never changes the terminal status',
  arbitrary: fc.tuple(terminalStateArb, textArb),
  predicate: ([state, note]) => {
    const mission = state.missions.find((entry) => MODEL_TERMINAL_STATUSES.has(entry.status))
    assert.ok(mission, 'the filtered arbitrary produced no terminal mission')
    const draftMission = structuredClone(mission)
    const draftState = structuredClone(state)
    applyMissionUpdate({ mission: draftMission, state: draftState, input: { note }, config: MODEL_CONFIG })
    assert.equal(draftMission.status, mission.status, 'a note changed the mission status')
    assert.ok(MODEL_TERMINAL_STATUSES.has(draftMission.status), 'a note pushed the mission out of the terminal set')
    assert.ok(draftMission.notes.includes(note.trim()), 'the accepted note was not recorded')
  },
})
