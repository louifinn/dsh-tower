// Legacy snapshots: Tower Codex schemaVersion:1 and DSH state validation,
// immutable hash-addressed import, inside-state/relative/invalid rejection, and
// audit-only legacy mapping. Offline, temp dirs only.
// Run with: node --test tests/legacy.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { importLegacySnapshot, validateLegacyMap, validateLegacySnapshot } from '../lib/legacy.js'

const HASH = 'a'.repeat(64)

function codexSnapshot() {
  return {
    schemaVersion: 1,
    repoRoot: 'D:/legacy/repo',
    baseBranch: 'main',
    revision: 7,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    missions: [
      {
        id: 'T0001',
        title: 'Legacy paused mission',
        kind: 'build',
        status: 'paused',
        scope: ['src/a/**'],
        tasks: [{ text: 'fix a', status: 'done' }],
        deps: [],
        reviews: [],
        scopeGeneration: 2,
        pauseCause: 'user',
      },
      {
        id: 'T0002',
        title: 'Legacy merged mission',
        kind: 'build',
        status: 'merged',
        scope: ['src/b/**'],
        tasks: ['single task'],
        deps: ['T0001'],
        reviews: [{ reviewedCommit: 'b'.repeat(40), status: 'clean', findings: [], mergeVerdict: 'merge' }],
        mergedCommit: 'c'.repeat(40),
      },
      {
        id: 'T0003',
        title: 'Legacy survey',
        kind: 'survey',
        status: 'planned',
        scope: [],
        tasks: [],
        deps: [],
        reviews: [],
      },
    ],
    events: [{ type: 'plan' }, { type: 'merge' }],
    legacySnapshots: [],
    mergeIntent: null,
  }
}

function dshSnapshot() {
  return {
    schemaVersion: 1,
    repoRoot: 'D:/dsh/repo',
    commonDir: 'D:/dsh/repo/.git',
    base: 'main',
    revision: 3,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_200_000,
    missions: [
      {
        id: 'M1',
        title: 'DSH paused mission',
        kind: 'build',
        status: 'paused',
        scope: ['lib/**'],
        tasks: [{ text: 'do it', status: 'open' }],
        deps: [],
        reviews: [],
      },
      {
        id: 'M2',
        title: 'DSH completed mission',
        kind: 'build',
        status: 'completed',
        scope: ['tests/**'],
        tasks: [{ text: 'test it', status: 'done' }],
        deps: ['M1'],
        reviews: [],
      },
    ],
    roster: [],
    reviews: [],
    findings: [],
  }
}

function tempRepo(prefix = 'dsh-tower-legacy-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  const commonDir = path.join(repo, '.git')
  fs.mkdirSync(commonDir, { recursive: true })
  return { root, repo, commonDir }
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function expectCode(code, pattern) {
  return (error) => {
    assert.equal(error.code, code, error.message)
    if (pattern) assert.match(error.message, pattern)
    return true
  }
}

test('validateLegacySnapshot: Tower Codex schemaVersion 1 missions (T####) are summarised as read-only', () => {
  const payload = codexSnapshot()
  const before = JSON.parse(JSON.stringify(payload))
  const result = validateLegacySnapshot(payload)
  assert.equal(result.ok, true)
  assert.equal(result.error, null)
  assert.equal(result.format, 'tower-codex')
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.missionCount, 3)
  assert.deepEqual(result.missionIds, ['T0001', 'T0002', 'T0003'])
  assert.deepEqual(result.missions, [
    { id: 'T0001', status: 'paused', kind: 'build' },
    { id: 'T0002', status: 'merged', kind: 'build' },
    { id: 'T0003', status: 'planned', kind: 'survey' },
  ])
  assert.deepEqual(result.paused, ['T0001'], 'a paused legacy mission stays paused')
  assert.equal(result.events, 2)
  assert.equal(result.legacySnapshots, 0)
  assert.equal(result.repoRoot, 'D:/legacy/repo')
  assert.equal(result.baseBranch, 'main')
  assert.deepEqual(payload, before, 'validation must not mutate the payload')
})

test('validateLegacySnapshot: DSH state (M#) is accepted as its own format', () => {
  const result = validateLegacySnapshot(dshSnapshot())
  assert.equal(result.ok, true)
  assert.equal(result.format, 'dsh')
  assert.deepEqual(result.missionIds, ['M1', 'M2'])
  assert.deepEqual(result.paused, ['M1'])
  assert.equal(result.baseBranch, 'main')
  assert.equal(result.events, null)
})

test('validateLegacySnapshot: empty mission lists infer the format from top-level fields', () => {
  const codex = validateLegacySnapshot({ schemaVersion: 1, repoRoot: 'D:/x', baseBranch: 'main', missions: [] })
  assert.equal(codex.ok, true)
  assert.equal(codex.format, 'tower-codex')
  assert.equal(codex.missionCount, 0)
  const dsh = validateLegacySnapshot({ schemaVersion: 1, repoRoot: 'D:/x', missions: [] })
  assert.equal(dsh.ok, true)
  assert.equal(dsh.format, 'dsh')
})

test('validateLegacySnapshot: malformed payloads return {ok:false,error} instead of throwing', () => {
  const cases = [
    { payload: null, error: /JSON object/ },
    { payload: [], error: /JSON object/ },
    { payload: { missions: [] }, error: /no schemaVersion/ },
    { payload: { schemaVersion: 2, missions: [] }, error: /unsupported legacy schemaVersion 2/ },
    { payload: { schemaVersion: 1 }, error: /no missions array/ },
    { payload: { schemaVersion: 1, missions: [{ id: 'X1' }] }, error: /unsupported legacy mission id "X1"/ },
  ]
  for (const entry of cases) {
    const result = validateLegacySnapshot(entry.payload)
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(entry.payload)}`)
    assert.equal(typeof result.error, 'string')
    assert.match(result.error, entry.error)
    assert.deepEqual(result.missions, [])
  }

  const duplicate = codexSnapshot()
  duplicate.missions.push({ ...duplicate.missions[0] })
  assert.match(validateLegacySnapshot(duplicate).error, /duplicate legacy mission id T0001/)

  const badStatus = codexSnapshot()
  badStatus.missions[0].status = 'sleeping'
  assert.match(validateLegacySnapshot(badStatus).error, /mission T0001 has unknown status "sleeping"/)

  const badScope = codexSnapshot()
  badScope.missions[0].scope = ['/absolute']
  assert.match(validateLegacySnapshot(badScope).error, /scope must be relative/)

  const badDeps = codexSnapshot()
  badDeps.missions[0].deps = [42]
  assert.match(validateLegacySnapshot(badDeps).error, /deps entries must be non-empty mission ids/)

  const badReviews = codexSnapshot()
  badReviews.missions[0].reviews = [null]
  assert.match(validateLegacySnapshot(badReviews).error, /review entries must be objects/)

  const noRepo = codexSnapshot()
  delete noRepo.repoRoot
  assert.match(validateLegacySnapshot(noRepo).error, /no repoRoot string/)

  const noBase = codexSnapshot()
  delete noBase.baseBranch
  assert.match(validateLegacySnapshot(noBase).error, /no baseBranch string/)

  const badEvents = codexSnapshot()
  badEvents.events = {}
  assert.match(validateLegacySnapshot(badEvents).error, /events must be an array/)
})

test('importLegacySnapshot: writes exact bytes to the hash-addressed legacy store and is idempotent', async () => {
  const { root, repo, commonDir } = tempRepo()
  try {
    const source = path.join(root, 'legacy-state.json')
    const raw = Buffer.from(JSON.stringify(codexSnapshot()), 'utf8')
    fs.writeFileSync(source, raw)
    const expectedHash = sha256(raw)

    const first = await importLegacySnapshot({ repoRoot: repo, commonDir, sourcePath: source })
    assert.equal(first.summary.format, 'tower-codex')
    assert.equal(first.summary.sourceHash, expectedHash)
    assert.equal(first.summary.missionCount, 3)
    assert.deepEqual(first.summary.paused, ['T0001'])
    assert.equal(first.summary.pausedCount, 1)
    assert.equal(first.summary.events, 2)
    assert.equal(first.summary.bytes, raw.length)
    assert.equal(first.summary.idempotent, false)
    const storedPath = path.join(commonDir, 'dsh-tower', 'legacy', `${expectedHash}.json`)
    assert.equal(first.summary.storedPath, storedPath)
    assert.ok(fs.existsSync(storedPath))
    assert.deepEqual(fs.readFileSync(storedPath), raw, 'the full payload is stored byte-for-byte')
    assert.deepEqual(fs.readFileSync(source), raw, 'the source file is never modified')

    assert.deepEqual(first.snapshot, {
      sourceHash: expectedHash,
      sourcePath: source,
      storedPath,
      format: 'tower-codex',
      schemaVersion: 1,
      repoRoot: 'D:/legacy/repo',
      baseBranch: 'main',
      missionIds: ['T0001', 'T0002', 'T0003'],
      missionCount: 3,
      pausedMissionIds: ['T0001'],
      bytes: raw.length,
      importedAt: first.snapshot.importedAt,
    })
    assert.ok(Number.isFinite(first.snapshot.importedAt))

    // Importing the same bytes again is idempotent, not a duplicate error.
    const again = await importLegacySnapshot({ repoRoot: repo, commonDir, sourcePath: source })
    assert.equal(again.summary.idempotent, true)
    assert.equal(again.summary.sourceHash, expectedHash)
    assert.equal(again.summary.storedPath, storedPath)
    assert.deepEqual(fs.readdirSync(path.join(commonDir, 'dsh-tower', 'legacy')), [`${expectedHash}.json`])
    assert.equal(fs.existsSync(path.join(commonDir, 'dsh-tower', 'state.json')), false, 'import must not create state.json')
  } finally {
    cleanup(root)
  }
})

test('importLegacySnapshot: DSH state payloads import into the same store', async () => {
  const { root, repo, commonDir } = tempRepo()
  try {
    const source = path.join(root, 'dsh-state.json')
    fs.writeFileSync(source, JSON.stringify(dshSnapshot()))
    const { summary } = await importLegacySnapshot({ repoRoot: repo, commonDir, sourcePath: source })
    assert.equal(summary.format, 'dsh')
    assert.deepEqual(summary.missionIds, ['M1', 'M2'])
    assert.deepEqual(summary.paused, ['M1'])
    assert.ok(fs.existsSync(summary.storedPath))
  } finally {
    cleanup(root)
  }
})

test('importLegacySnapshot: paused stays paused and no state.json is adopted or rewritten', async () => {
  const { root, repo, commonDir } = tempRepo()
  try {
    const stateDir = path.join(commonDir, 'dsh-tower')
    fs.mkdirSync(stateDir, { recursive: true })
    const stateFile = path.join(stateDir, 'state.json')
    const stateText = JSON.stringify({ schemaVersion: 1, repoRoot: repo, base: 'main', revision: 9, missions: [] })
    fs.writeFileSync(stateFile, stateText)

    const source = path.join(root, 'legacy-state.json')
    fs.writeFileSync(source, JSON.stringify(codexSnapshot()))
    const { summary } = await importLegacySnapshot({ repoRoot: repo, commonDir, sourcePath: source })

    assert.deepEqual(summary.paused, ['T0001'])
    assert.equal(fs.readFileSync(stateFile, 'utf8'), stateText, 'import must not touch the canonical state')
    const legacyFiles = fs.readdirSync(path.join(stateDir, 'legacy'))
    assert.equal(legacyFiles.length, 1)
  } finally {
    cleanup(root)
  }
})

test('importLegacySnapshot: rejects relative, inside-state, non-file, invalid JSON and unknown versions', async () => {
  const { root, repo, commonDir } = tempRepo()
  try {
    await assert.rejects(
      () => importLegacySnapshot({ repoRoot: repo, commonDir, sourcePath: 'relative.json' }),
      expectCode('invalid-argument', /sourcePath must be an absolute path/),
    )
    await assert.rejects(
      () => importLegacySnapshot({ repoRoot: 'relative', commonDir, sourcePath: path.join(root, 'x.json') }),
      expectCode('invalid-argument', /repoRoot must be an absolute path/),
    )
    await assert.rejects(
      () => importLegacySnapshot({ repoRoot: repo, commonDir, sourcePath: path.join(root, 'missing.json') }),
      expectCode('invalid-argument', /does not exist/),
    )
    await assert.rejects(
      () => importLegacySnapshot({ repoRoot: repo, commonDir, sourcePath: root }),
      expectCode('invalid-argument', /not a regular file/),
    )

    // The canonical state dir is off-limits, including its legacy subdirectory.
    const stateDir = path.join(commonDir, 'dsh-tower')
    fs.mkdirSync(path.join(stateDir, 'legacy'), { recursive: true })
    const inside = path.join(stateDir, 'legacy', 'payload.json')
    fs.writeFileSync(inside, JSON.stringify(codexSnapshot()))
    await assert.rejects(
      () => importLegacySnapshot({ repoRoot: repo, commonDir, sourcePath: inside }),
      expectCode('legacy-invalid', /must not be inside the Tower state directory/),
    )

    const invalidJson = path.join(root, 'invalid.json')
    fs.writeFileSync(invalidJson, '{not json')
    await assert.rejects(
      () => importLegacySnapshot({ repoRoot: repo, commonDir, sourcePath: invalidJson }),
      expectCode('legacy-invalid', /invalid legacy JSON/),
    )

    const badVersion = path.join(root, 'version-2.json')
    fs.writeFileSync(badVersion, JSON.stringify({ ...codexSnapshot(), schemaVersion: 2 }))
    await assert.rejects(
      () => importLegacySnapshot({ repoRoot: repo, commonDir, sourcePath: badVersion }),
      expectCode('legacy-invalid', /unsupported legacy schemaVersion 2/),
    )

    const duplicate = path.join(root, 'duplicate.json')
    const payload = codexSnapshot()
    payload.missions.push({ ...payload.missions[0] })
    fs.writeFileSync(duplicate, JSON.stringify(payload))
    await assert.rejects(
      () => importLegacySnapshot({ repoRoot: repo, commonDir, sourcePath: duplicate }),
      expectCode('legacy-invalid', /duplicate legacy mission id T0001/),
    )

    assert.deepEqual(
      fs.readdirSync(path.join(commonDir, 'dsh-tower', 'legacy')),
      ['payload.json'],
      'rejections must not write a hash-addressed snapshot',
    )
  } finally {
    cleanup(root)
  }
})

function mapState({ maps = [], missions = [{ id: 'M1', status: 'active' }], missionIds = ['T0001'] } = {}) {
  return {
    schemaVersion: 1,
    repoRoot: 'D:/dsh/repo',
    base: 'main',
    revision: 1,
    missions,
    legacySnapshots: [{ sourceHash: HASH, format: 'tower-codex', missionIds, missionCount: missionIds.length }],
    legacyMaps: maps,
  }
}

test('validateLegacyMap: audit-only mapping accepts known ids and never adopts', () => {
  const state = mapState()
  const before = JSON.parse(JSON.stringify(state))
  const mapped = validateLegacyMap(state, { sourceHash: HASH, oldId: 'T0001', newMissionId: 'M1' })
  assert.deepEqual(mapped, {
    ok: true,
    duplicate: false,
    map: { sourceHash: HASH, oldId: 'T0001', newMissionId: 'M1' },
  })
  assert.deepEqual(state, before, 'mapping validation must not mutate state')

  const auditOnly = validateLegacyMap(state, { sourceHash: HASH, oldId: 'T0001' })
  assert.deepEqual(auditOnly.map, { sourceHash: HASH, oldId: 'T0001', newMissionId: null })

  // An old id that is also a current mission id is allowed by the contract.
  assert.equal(validateLegacyMap(state, { sourceHash: HASH, oldId: 'M1' }).ok, true)

  const identical = validateLegacyMap(
    mapState({ maps: [{ sourceHash: HASH, oldId: 'T0001', newMissionId: 'M1', at: 5 }] }),
    { sourceHash: HASH, oldId: 'T0001', newMissionId: 'M1' },
  )
  assert.equal(identical.duplicate, true)
  assert.equal(identical.map.at, 5)
})

test('validateLegacyMap: unknown snapshot/id/target and rewritten duplicates are rejected', () => {
  const state = mapState({ missions: [{ id: 'M1' }, { id: 'M2' }] })

  assert.throws(
    () => validateLegacyMap(state, { sourceHash: 'b'.repeat(64), oldId: 'T0001' }),
    expectCode('legacy-invalid', /unknown legacy snapshot/),
  )
  assert.throws(
    () => validateLegacyMap(state, { sourceHash: HASH, oldId: 'T9999', newMissionId: 'M1' }),
    expectCode('legacy-invalid', /not in snapshot .* not a known mission/),
  )
  assert.throws(
    () => validateLegacyMap(state, { sourceHash: HASH, oldId: 'T0001', newMissionId: 'M9' }),
    expectCode('legacy-invalid', /unknown new mission "M9"/),
  )

  const conflict = mapState({
    missions: [{ id: 'M1' }, { id: 'M2' }],
    maps: [{ sourceHash: HASH, oldId: 'T0001', newMissionId: 'M1' }],
  })
  assert.throws(
    () => validateLegacyMap(conflict, { sourceHash: HASH, oldId: 'T0001', newMissionId: 'M2' }),
    expectCode('legacy-invalid', /append-only/),
  )

  assert.throws(() => validateLegacyMap(null, { sourceHash: HASH, oldId: 'T0001' }), expectCode('invalid-argument', /state is required/))
  assert.throws(() => validateLegacyMap(state, { sourceHash: 'nope', oldId: 'T0001' }), expectCode('invalid-argument', /64-character hex/))
  assert.throws(() => validateLegacyMap(state, { sourceHash: HASH }), expectCode('invalid-argument', /oldId is required/))
})
