// Findings use cases.
import { validateState } from '../domain/state.js'
import { TowerToolError } from '../domain/errors.js'
import {
  normalizeFindingInput,
  newFinding,
  normalizeFindingActor,
  wantsFindingUpdate,
  readFindingsView,
  applyFindingUpdate,
  findingUpdateView,
} from '../domain/missions/findings.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

export async function addFinding(tower, input) {
    return tower.deps.store.withLock(tower.paths, async () => {
      const state = await tower.load()
      if (!Array.isArray(state.findings)) state.findings = []
      const fields = normalizeFindingInput(input, state.missions)
      const now = Date.now()
      const seq = (state.findingSeq ?? 0) + 1
      state.findingSeq = seq
      const finding = newFinding(fields, { seq, now, reportedBy: input.reportedBy })
      state.findings.push(finding)
      state.revision += 1
      state.updatedAt = now

      validateState(state, tower.paths.state)
      await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
      await tower.deps.store.appendJsonl(tower.paths.activity, {
        at: now,
        type: 'finding',
        missionId: finding.missionId,
        text: `${finding.id} ${finding.type}: ${finding.title}`,
      })
      return finding
    })
  }

  /** List or read findings. Read-only paths never take the writer lock. */
  export async function readFindings(tower, input = {}) {
    const state = await tower.load()
    return readFindingsView(state.findings ?? [], input)
  }

  /**
   * List, read, or transition findings. Listing and reading are lock-free;
   * only a transition takes the writer lock. Reviewers may only read.
   */
  export async function findings(tower, input = {}) {
    const actor = normalizeFindingActor(input.actor)
    if (!wantsFindingUpdate(input)) return tower.readFindings(input)

    return tower.deps.store.withLock(tower.paths, async () => {
      const state = await tower.load()
      const all = state.findings ?? []
      const finding = all.find((entry) => entry.id === input.id)
      if (!finding) fail(`unknown finding "${input.id}"`, 'finding-not-found')
      const now = Date.now()
      const { noteAdded } = applyFindingUpdate({ finding, input, actor, now })
      state.revision += 1
      state.updatedAt = now
      validateState(state, tower.paths.state)
      await tower.deps.store.writeJsonAtomic(tower.paths.state, state)
      await tower.deps.store.appendJsonl(tower.paths.activity, {
        at: now,
        type: 'finding',
        missionId: finding.missionId,
        text: `${finding.id} ${finding.status}${noteAdded ? ' +note' : ''} (${actor.name})`,
      })
      // Counts must reflect the transition just recorded.
      return findingUpdateView(finding, all)
    })
  }
