// State recording use cases for test receipts and imported legacy snapshots.
import { TowerToolError } from '../errors.js'
import { validateState } from '../domain/state.js'
import { withLock, writeJsonAtomic, appendJsonl } from '../store.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

export async function recordTestRun(tower, input = {}) {
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    const mission = state.missions.find((entry) => entry.id === input.missionId)
    if (!mission) fail(`unknown mission "${input.missionId}"`)
    if (!mission.testRuns) mission.testRuns = []
    const rawReceipt = { ...input.receipt, recordedAt: Date.now() }
    // Keep state bounded even when a repository reports a huge suite.
    const tests = Array.isArray(rawReceipt.tests) ? rawReceipt.tests : []
    const receipt = tests.length > 100
      ? { ...rawReceipt, tests: tests.slice(0, 100), testsTotal: rawReceipt.count ?? tests.length, testsTruncated: true }
      : rawReceipt
    mission.testRuns.push(receipt)
    if (mission.testRuns.length > 50) mission.testRuns = mission.testRuns.slice(-50)
    const MAX_RUNS_BYTES = 512 * 1024
    while (mission.testRuns.length > 1 && Buffer.byteLength(JSON.stringify(mission.testRuns), 'utf8') > MAX_RUNS_BYTES) {
      mission.testRuns.shift()
    }
    state.revision += 1
    state.updatedAt = Date.now()
    validateState(state, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, state)
    await appendJsonl(tower.paths.activity, {
      at: Date.now(),
      type: 'test',
      missionId: mission.id,
      text: receipt.ok === true ? `passed ${receipt.tests?.length ?? 0} test(s)` : `failed: ${String(receipt.error ?? 'unknown').slice(0, 200)}`,
    })
    return receipt
  })
}

export async function recordLegacySnapshot(tower, snapshot) {
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    if (!Array.isArray(state.legacySnapshots)) state.legacySnapshots = []
    const existing = state.legacySnapshots.find((entry) => entry.sourceHash === snapshot.sourceHash)
    if (existing) return { snapshot: existing, duplicate: true }
    state.legacySnapshots.push(snapshot)
    state.revision += 1
    state.updatedAt = Date.now()
    validateState(state, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, state)
    return { snapshot, duplicate: false }
  })
}

export async function recordLegacyMap(tower, map) {
  return withLock(tower.paths, async () => {
    const state = await tower.load()
    if (!Array.isArray(state.legacyMaps)) state.legacyMaps = []
    const existing = state.legacyMaps.find(
      (entry) => entry.sourceHash === map.sourceHash && entry.oldId === map.oldId,
    )
    if (existing) return { map: existing, duplicate: true }
    state.legacyMaps.push(map)
    state.revision += 1
    state.updatedAt = Date.now()
    validateState(state, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, state)
    return { map, duplicate: false }
  })
}
