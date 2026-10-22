// Terminal-mission archival (#73).
//
// A merged/abandoned mission keeps its tasks, reviews, findings and completion
// report, but every mutation rewrites the whole state document. These tests pin
// the archive contract:
//   - the trigger policy (age and hot-terminal cap) archives only terminal
//     missions whose worktree is gone;
//   - the hot state shrinks by a recorded margin and archived history is no
//     longer written by mutations;
//   - archived data is retrievable (compact summaries and full detail);
//   - re-running the sweep is a no-op;
//   - a corrupt archive degrades to a diagnostic, never a thrown dashboard;
//   - preflight/merge keep behaving the same for an archived mission;
//   - a repository with no archive directory stays fully usable.
//
// Run with: node --test tests/archive.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { removeTemp } from './helpers/cleanup.mjs'
import os from 'node:os'
import path from 'node:path'

import { Tower } from '../app/tower.js'
import { registerTowerTools } from '../lib/tool-registry.js'
import { writeJsonAtomic } from '../lib/store.js'
import { validateState } from '../domain/state.js'
import { SCHEMA_VERSION } from '../domain/mission.js'
import { Config, resolveTowerConfig } from '../domain/config/schema.js'
import { archivePaths, readArchiveIndex, writeArchiveEntries } from '../lib/archive.js'
import {
  ARCHIVE_VERSION,
  archivedEntry,
  archiveDocumentError,
  dedupeById,
  selectForArchive,
} from '../domain/state/archive.js'

const DAY = 24 * 60 * 60 * 1000
const towerExec = { agent: { id: 'tower-agent' } }

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

const cleanup = (root) => removeTemp(root)

function makeRepo(prefix = 'dsh-tower-archive-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'tower@test'])
  git(repo, ['config', 'user.name', 'Tower Test'])
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'seed'])
  return { root, repo }
}

function makeCtx() {
  const tools = new Map()
  const subagents = {
    list: () => ['spawn'],
    sendMessage: async () => {},
    listDescendants: async () => [],
    interrupt: () => {},
  }
  const agentPresets = { list: async () => [{ id: 'tower-worker' }, { id: 'tower-reviewer' }] }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'subagents') return subagents
      if (name === 'agentPresets') return agentPresets
      return undefined
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
      guard() {
        return () => {}
      },
      restrict() {},
    },
    systemPrompt: { section() {} },
    inject(_deps, callback) {
      callback(ctx)
    },
  }
  registerTowerTools(ctx)
  return { ctx, tools }
}

async function call(tools, name, args, exec = towerExec) {
  const tool = tools.get(name)
  assert.ok(tool, `${name} is registered`)
  return tool.execute(args, exec)
}

function writeRepoConfig(repo, value) {
  const file = path.join(repo, '.git', 'dsh-tower', 'config.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

function stateBytes(tower) {
  return fs.statSync(tower.paths.state).size
}

function stateText(tower) {
  return fs.readFileSync(tower.paths.state, 'utf8')
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Append terminal fixtures directly to state. This is the state an installation
 * accumulates after repeated merge + teardown cycles; seeding it avoids running
 * 20 real merges in a unit test.
 */
async function seedTerminalMissions(tower, count, options = {}) {
  const {
    status = 'merged',
    ageDays = 60,
    worktree = 'removed',
    reportSize = 2000,
    findingsPerMission = 1,
    includeReview = true,
  } = options
  const now = Date.now()
  const state = await tower.load()
  for (let index = 0; index < count; index += 1) {
    const id = `M${index + 1}`
    // M1 is the oldest, so cap/age expectations read naturally.
    const at = now - (ageDays + count - index) * DAY
    const mission = {
      id,
      title: `Terminal mission ${index + 1}`,
      kind: 'build',
      status,
      scope: [`area-${index + 1}/**`],
      deps: [],
      tasks: [
        { text: `implement ${index + 1}`, status: 'done' },
        { text: `verify ${index + 1}`, status: 'done' },
      ],
      blockers: [],
      notes: [`note ${index + 1}`, `merged note ${index + 1}`],
      owner: `worker-${index + 1}`,
      reviewPolicy: 'required-clean',
      mergedCommit: 'a'.repeat(40),
      mergedAt: status === 'merged' ? at : null,
      updatedAt: at,
      completionReport: {
        report: `ARCHIVED_PAYLOAD_${index + 1}_` + 'x'.repeat(reportSize),
        by: `worker-${index + 1}`,
        at,
        checks: [{ name: 'check', exitCode: 0, evidence: 'ok' }],
      },
      worktree:
        worktree === 'removed' || worktree === 'live'
          ? { path: path.join(tower.root, '..', 'worktrees', id), branch: `tower/${id.toLowerCase()}-x`, baseCommit: 'b'.repeat(40) }
          : null,
    }
    if (worktree === 'removed') mission.worktreeRemovedAt = at
    state.missions.push(mission)
    if (includeReview) {
      if (!Array.isArray(state.reviews)) state.reviews = []
      state.reviews.push({
        id: `R${index + 1}`,
        seq: index + 1,
        missionId: id,
        branch: mission.worktree?.branch ?? `tower/${id.toLowerCase()}-x`,
        round: 1,
        status: 'clean',
        mergeVerdict: 'merge',
        reviewedCommit: 'c'.repeat(40),
        at,
        reviewer: 'reviewer-1',
        reviewerRole: 'reviewer',
      })
    }
    for (let findingIndex = 0; findingIndex < findingsPerMission; findingIndex += 1) {
      if (!Array.isArray(state.findings)) state.findings = []
      state.findings.push({
        id: `F${index + 1}-${findingIndex + 1}`,
        type: 'improve',
        title: `finding ${index + 1}`,
        summary: 'summary',
        details: 'details',
        suggested_fix: 'fix',
        // Even missions are closed and leave state with the archive; odd ones
        // stay actionable in the hot state.
        status: index % 2 === 0 ? 'fixed' : 'open',
        missionId: id,
        at,
      })
    }
  }
  state.revision += 1
  state.updatedAt = now
  validateState(state, tower.paths.state)
  await writeJsonAtomic(tower.paths.state, state)
  return state
}

test('archive policy: only old terminal missions without a live worktree are selected', () => {
  const now = 1_000 * DAY
  const old = now - 60 * DAY
  const fresh = now - DAY
  /** @type {any[]} */
  const missions = [
    { id: 'M1', status: 'merged', mergedAt: old, updatedAt: old, worktree: null },
    { id: 'M2', status: 'abandoned', updatedAt: old, worktree: null },
    { id: 'M3', status: 'merged', mergedAt: fresh, updatedAt: fresh, worktree: null },
    { id: 'M4', status: 'merged', mergedAt: old, updatedAt: old, worktree: { path: '/w', branch: 'b' } },
    { id: 'M5', status: 'active', updatedAt: old, worktree: null },
    { id: 'M6', status: 'completed', updatedAt: old, worktree: null },
    { id: 'M7', status: 'paused', updatedAt: old, worktree: null },
    { id: 'M8', status: 'planned', updatedAt: old, worktree: null },
    { id: 'M9', status: 'merged', mergedAt: old, updatedAt: old, worktree: { path: '/w', branch: 'b' }, worktreeRemovedAt: old },
  ]

  const selected = selectForArchive(missions, { enabled: true, afterDays: 30, maxMissions: 100 }, { now })
  assert.deepEqual(selected.map((mission) => mission.id), ['M1', 'M2', 'M9'])

  // Age alone is the trigger; the cap is separately tested below.
  assert.deepEqual(
    selectForArchive(missions, { enabled: true, afterDays: 3650, maxMissions: 100 }, { now }).map((mission) => mission.id),
    [],
  )
  // Disabled and force still respect the "terminal + no live worktree" rule.
  assert.deepEqual(selectForArchive(missions, { enabled: false, afterDays: 0 }, { now, force: true }), [])
  assert.deepEqual(
    selectForArchive(missions, { enabled: true, afterDays: 3650, maxMissions: 100 }, { now, force: true }).map(
      (mission) => mission.id,
    ),
    ['M1', 'M2', 'M3', 'M9'],
    'force overrides age but never selects a live worktree or a non-terminal mission',
  )
  // Protected ids (open batch members / live agents) are never selected.
  assert.deepEqual(
    selectForArchive(missions, { enabled: true, afterDays: 30, maxMissions: 100 }, { now, protectedIds: ['M1'] }).map(
      (mission) => mission.id,
    ),
    ['M2', 'M9'],
  )
})

test('archive policy: the hot-terminal cap archives the oldest eligible missions', () => {
  const now = 1_000 * DAY
  /** @type {any[]} */
  const missions = Array.from({ length: 6 }, (_, index) => ({
    id: `M${index + 1}`,
    status: 'merged',
    // M1 is the oldest, M6 the newest; all are inside afterDays=3650.
    mergedAt: now - (6 - index) * DAY,
    updatedAt: now - (6 - index) * DAY,
    worktree: null,
  }))
  const selected = selectForArchive(missions, { enabled: true, afterDays: 3650, maxMissions: 2 }, { now })
  assert.deepEqual(selected.map((mission) => mission.id), ['M1', 'M2', 'M3', 'M4'])
  const all = selectForArchive(missions, { enabled: true, afterDays: 3650, maxMissions: 0 }, { now })
  assert.deepEqual(all.map((mission) => mission.id), ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'])
})

test('archive documents: version header, duplicate ids and foreign versions', () => {
  assert.deepEqual(dedupeById([{ id: 'M1' }, { id: 'M1' }, { id: 'M2' }]).map((entry) => entry.id), ['M1', 'M2'])
  assert.equal(archiveDocumentError({ archiveVersion: 1, missions: [] }, 'index'), null)
  assert.match(archiveDocumentError({ archiveVersion: 99, missions: [] }, 'index'), /unsupported archiveVersion/)
  assert.match(archiveDocumentError({ archiveVersion: 1, missions: [{ title: 'no id' }] }, 'index'), /without id/)
  assert.match(
    archiveDocumentError({ archiveVersion: 1, missions: [{ id: 'M1', status: 'merged' }] }, 'year'),
    /no full mission/,
  )
  assert.equal(ARCHIVE_VERSION, 1)
})

test('fixture: 20 merged missions, teardown shrinks state and status still lists them as archived', async () => {
  const { root, repo } = makeRepo()
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    await seedTerminalMissions(tower, 20, { reportSize: 2000 })
    const before = stateBytes(tower)
    const beforeState = readJson(tower.paths.state)
    assert.equal(beforeState.missions.length, 20)
    assert.equal(beforeState.reviews.length, 20)
    assert.equal(beforeState.findings.length, 20)

    const torn = await call(tools, 'tower_teardown', { repoRoot: repo })
    assert.equal(torn.ok, true)
    assert.deepEqual(torn.removed, [], 'no worktree is live: teardown only archives')
    assert.equal(torn.archived.length, 20)

    const after = stateBytes(tower)
    assert.ok(after < before * 0.5, `state.json must shrink substantially: ${before} -> ${after}`)
    const hot = readJson(tower.paths.state)
    assert.equal(hot.missions.length, 0)
    assert.equal(hot.reviews.length, 0, 'archived missions take their reviews with them')
    assert.equal(
      hot.findings.length,
      10,
      'closed findings leave with the mission; open findings stay actionable',
    )

    const paths = archivePaths(tower.paths)
    const index = readJson(paths.index)
    assert.equal(index.archiveVersion, ARCHIVE_VERSION)
    assert.equal(index.missions.length, 20)
    const yearFile = paths.year(index.missions[0].archivedYear)
    const year = readJson(yearFile)
    assert.equal(year.archiveVersion, ARCHIVE_VERSION)
    assert.equal(year.missions.length, 20)
    assert.equal(year.missions[0].mission.tasks.length, 2)
    assert.equal(year.missions[0].reviews.length, 1)
    assert.ok(year.missions[0].findings.length >= 1)

    // Default dashboard and board list active missions only.
    const dashboard = await call(tools, 'tower_status', { repoRoot: repo })
    assert.equal(dashboard.total, 0)
    assert.equal(dashboard.archivedMissions, 20)
    assert.equal(dashboard.archive.count, 20)
    assert.equal(dashboard.missions.length, 0)
    assert.equal(dashboard.markdown, undefined)

    // On demand: compact summaries, flagged archived, no report body.
    const withArchived = await call(tools, 'tower_status', { repoRoot: repo, includeArchived: true, limit: 100 })
    assert.equal(withArchived.total, 20)
    assert.equal(withArchived.missions.length, 20)
    assert.ok(withArchived.missions.every((mission) => mission.archived === true))
    assert.ok(withArchived.missions.every((mission) => mission.completionReport === undefined))
    assert.ok(withArchived.missions.every((mission) => mission.tasks?.total === 0))
    assert.ok(!JSON.stringify(withArchived.missions).includes('ARCHIVED_PAYLOAD'))

    // Full detail is loaded from the year file and includes tasks, reviews,
    // findings and the completion report.
    const detail = await call(tools, 'tower_status', { repoRoot: repo, missionId: 'M1' })
    assert.equal(detail.missionId, 'M1')
    assert.equal(detail.missions[0].archived, true)
    assert.equal(detail.detail.archived, true)
    assert.equal(detail.detail.mission.status, 'merged')
    assert.equal(detail.detail.mission.tasks.length, 2)
    assert.ok(detail.detail.mission.completionReport.report.startsWith('ARCHIVED_PAYLOAD_1_'))
    assert.equal(detail.detail.reviews.length, 1)
    assert.ok(detail.detail.findings.length >= 1)

    // The markdown board reports the archive without listing its rows.
    const markdown = await call(tools, 'tower_status', { repoRoot: repo, format: 'markdown' })
    assert.match(markdown.markdown, /Archived: 20 terminal mission/)
    assert.ok(!markdown.markdown.includes('| M1 |'), 'archived rows are not on the default board')

    // Mission ids are never reused after the missions leave state.json.
    const planned = await call(tools, 'tower_plan', { repoRoot: repo, missions: [{ title: 'After archive', scope: ['next/**'] }] })
    assert.equal(planned.missions[0].id, 'M21')
    assert.equal(planned.archived, undefined, 'nothing else is eligible right now')

    // An archived merged mission is still a known, satisfied dependency.
    const dependent = await call(tools, 'tower_plan', {
      repoRoot: repo,
      missions: [{ title: 'Depends on archived', scope: ['dep/**'], deps: ['M1'] }],
    })
    assert.equal(dependent.missions[0].id, 'M22')
    assert.deepEqual(dependent.missions[0].deps, ['M1'])
    const dependentPreflight = await call(tools, 'tower_preflight', { repoRoot: repo, missionId: 'M22' })
    assert.equal(
      dependentPreflight.blockers.some((blocker) => blocker.code === 'deps-unmerged'),
      false,
      'an archived merged dependency must not read as unmerged',
    )

    // Re-running teardown is idempotent: no archive writes, byte-identical state.
    const indexHash = sha256(paths.index)
    const yearHash = sha256(yearFile)
    const revision = readJson(tower.paths.state).revision
    const again = await call(tools, 'tower_teardown', { repoRoot: repo })
    assert.deepEqual(again.archived, [])
    assert.equal(readJson(tower.paths.state).revision, revision, 'a no-op sweep must not bump the revision')
    assert.equal(sha256(paths.index), indexHash)
    assert.equal(sha256(yearFile), yearHash)
  } finally {
    cleanup(root)
  }
})

test('mutations after archiving do not write archived history into state.json', async () => {
  const { root, repo } = makeRepo('dsh-tower-archive-size-')
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    await seedTerminalMissions(tower, 20, { reportSize: 4000 })
    await call(tools, 'tower_teardown', { repoRoot: repo })
    await call(tools, 'tower_plan', { repoRoot: repo, missions: [{ title: 'Live mission', scope: ['live/**'] }] })
    const baseline = stateBytes(tower)
    const paths = archivePaths(tower.paths)
    const beforeIndex = readJson(paths.index)

    // "Adding 20 archive entries": write directly to the archive the way more
    // history would arrive, then run a mutation.
    const now = Date.now()
    const year = new Date(now).getUTCFullYear()
    const entries = Array.from({ length: 20 }, (_, index) => ({
      id: `X${index + 1}`,
      title: `External archive ${index + 1}`,
      status: 'merged',
      kind: 'build',
      scope: [],
      deps: [],
      owner: null,
      branch: null,
      mergedCommit: 'd'.repeat(40),
      mergedAt: now,
      updatedAt: now,
      archivedAt: now,
      archivedYear: year,
      mission: {
        id: `X${index + 1}`,
        title: `External archive ${index + 1}`,
        kind: 'build',
        status: 'merged',
        scope: [],
        deps: [],
        tasks: [],
        notes: [],
        completionReport: { report: `ARCHIVE_ONLY_${index + 1}_` + 'y'.repeat(8000) },
      },
      reviews: [],
      findings: [],
    }))
    const written = await writeArchiveEntries(tower.deps.store, tower.paths, { entries, now })
    assert.equal(written.ok, true)
    assert.equal(readJson(paths.index).missions.length, beforeIndex.missions.length + 20)

    await call(tools, 'tower_mission', { repoRoot: repo, id: 'M21', note: 'size check after archive growth' })
    const after = stateBytes(tower)
    assert.ok(after - baseline < 512, `state growth must not follow archive entries: ${baseline} -> ${after}`)
    assert.ok(!stateText(tower).includes('ARCHIVE_ONLY_'), 'archived payloads never enter state.json')

    // The same mutation after another 20 archive entries still costs the same.
    const more = entries.map((entry, index) => ({ ...entry, id: `Y${index + 1}` }))
    await writeArchiveEntries(tower.deps.store, tower.paths, { entries: more, now })
    await call(tools, 'tower_mission', { repoRoot: repo, id: 'M21', note: 'size check after archive growth' })
    assert.ok(stateBytes(tower) - after < 512)
    assert.ok(!stateText(tower).includes('ARCHIVE_ONLY_'))
  } finally {
    cleanup(root)
  }
})

test('the configured cap triggers archival at the next mutation; non-terminal missions never move', async () => {
  const { root, repo } = makeRepo('dsh-tower-archive-threshold-')
  const { tools } = makeCtx()
  try {
    writeRepoConfig(repo, { archive: { enabled: true, afterDays: 3650, maxMissions: 5 } })
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    await seedTerminalMissions(tower, 10, { ageDays: 1, reportSize: 50 })
    const state = await tower.load()
    // Non-terminal fixtures with no worktree and ancient timestamps.
    for (const [index, status] of ['planned', 'active', 'completed', 'blocked', 'paused'].entries()) {
      state.missions.push({
        id: `N${index + 1}`,
        title: `Non-terminal ${status}`,
        kind: 'build',
        status,
        scope: [`n${index + 1}/**`],
        deps: [],
        tasks: [],
        blockers: [],
        notes: [],
        updatedAt: Date.now() - 400 * DAY,
        worktree: null,
        worktreeRemovedAt: Date.now() - 400 * DAY,
      })
    }
    state.revision += 1
    validateState(state, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, state)

    const planned = await call(tools, 'tower_plan', { repoRoot: repo, missions: [{ title: 'Threshold trigger', scope: ['t/**'] }] })
    assert.equal(planned.archived.length, 5, 'cap 5 over 10 eligible archives the oldest 5')
    assert.deepEqual(planned.archived, ['M1', 'M2', 'M3', 'M4', 'M5'])

    const hot = await tower.load()
    const remainingTerminal = hot.missions.filter((mission) => mission.status === 'merged')
    assert.deepEqual(remainingTerminal.map((mission) => mission.id), ['M6', 'M7', 'M8', 'M9', 'M10'])
    assert.equal(hot.missions.filter((mission) => mission.id.startsWith('N')).length, 5, 'non-terminal missions never move')
    assert.equal(planned.missions[0].id, 'M11', 'id allocation still sees the active missions')
    const index = await readArchiveIndex(tower.deps.store, tower.paths)
    assert.equal(index.missions.length, 5)
    assert.ok(index.missions.every((mission) => mission.status === 'merged'))

    // A terminal mission with a live worktree is never archived, even though
    // the cap is exceeded.
    const liveState = await tower.load()
    liveState.missions.push({
      id: 'M99',
      title: 'Live worktree terminal',
      kind: 'build',
      status: 'merged',
      scope: ['z/**'],
      deps: [],
      tasks: [],
      blockers: [],
      notes: [],
      mergedAt: Date.now() - 400 * DAY,
      updatedAt: Date.now() - 400 * DAY,
      worktree: { path: path.join(root, 'live-worktree'), branch: 'tower/m99', baseCommit: 'e'.repeat(40) },
      reviewPolicy: 'required-clean',
    })
    liveState.revision += 1
    validateState(liveState, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, liveState)
    await call(tools, 'tower_teardown', { repoRoot: repo, exclude: ['M99'] })
    assert.ok((await tower.load()).missions.some((mission) => mission.id === 'M99'), 'live worktree stays hot')
  } finally {
    cleanup(root)
  }
})

test('preflight and merge behave the same for an archived mission', async () => {
  const { root, repo } = makeRepo('dsh-tower-archive-gate-')
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    await seedTerminalMissions(tower, 1, { includeReview: false })

    const preflightBefore = await call(tools, 'tower_preflight', { repoRoot: repo, missionId: 'M1' })
    const mergeBefore = await call(tools, 'tower_merge', { repoRoot: repo, missionId: 'M1' })
    assert.equal(preflightBefore.ok, false)
    assert.equal(mergeBefore.ok, true)
    assert.equal(mergeBefore.alreadyMerged, true)

    const torn = await call(tools, 'tower_teardown', { repoRoot: repo })
    assert.deepEqual(torn.archived, ['M1'])
    assert.equal((await tower.load()).missions.length, 0)

    const preflightAfter = await call(tools, 'tower_preflight', { repoRoot: repo, missionId: 'M1' })
    const mergeAfter = await call(tools, 'tower_merge', { repoRoot: repo, missionId: 'M1' })
    assert.equal(preflightAfter.archived, true)
    assert.deepEqual(preflightAfter.blockers, preflightBefore.blockers)
    assert.equal(mergeAfter.ok, true)
    assert.equal(mergeAfter.alreadyMerged, true)
    assert.equal(mergeAfter.mergedCommit, mergeBefore.mergedCommit)
  } finally {
    cleanup(root)
  }
})

test('a truncated archive is a diagnostic in status and doctor; nothing is lost', async () => {
  const { root, repo } = makeRepo('dsh-tower-archive-corrupt-')
  const { tools } = makeCtx()
  try {
    await call(tools, 'tower_init', { repoRoot: repo })
    const tower = await Tower.open(repo)
    await seedTerminalMissions(tower, 2, { reportSize: 10 })
    await call(tools, 'tower_teardown', { repoRoot: repo })
    const paths = archivePaths(tower.paths)
    fs.writeFileSync(paths.index, '{"archiveVersion":1,"missions":[')

    const dashboard = await call(tools, 'tower_status', { repoRoot: repo })
    assert.equal(dashboard.archive.unreadable, true)
    assert.equal(dashboard.archivedMissions, null)
    assert.match(dashboard.archive.message, /unreadable/)
    assert.equal(dashboard.total, 0)

    const withArchived = await call(tools, 'tower_status', { repoRoot: repo, includeArchived: true })
    assert.equal(withArchived.archive.unreadable, true)
    assert.deepEqual(withArchived.missions, [])

    const detail = await call(tools, 'tower_status', { repoRoot: repo, missionId: 'M1' })
    assert.equal(detail.detail.archived, true)
    assert.equal(detail.detail.mission, null)
    assert.match(detail.detail.error, /unreadable/)

    const doctor = await call(tools, 'tower_doctor', { repoRoot: repo })
    assert.ok(doctor.archive.unreadable.length >= 1)
    const archiveCheck = doctor.checks.find((check) => check.id === 'archive')
    assert.equal(archiveCheck.status, 'warn')
    assert.match(archiveCheck.action, /archive/)

    // Archiving is paused while the index is corrupt: the mission stays hot
    // instead of being dropped, and the diagnostic is returned.
    const towerState = await tower.load()
    towerState.missions.push({
      id: 'M3',
      title: 'Unarchived while corrupt',
      kind: 'build',
      status: 'merged',
      scope: ['c/**'],
      deps: [],
      tasks: [],
      blockers: [],
      notes: [],
      mergedAt: Date.now() - 400 * DAY,
      updatedAt: Date.now() - 400 * DAY,
      worktree: null,
      reviewPolicy: 'required-clean',
    })
    towerState.revision += 1
    validateState(towerState, tower.paths.state)
    await writeJsonAtomic(tower.paths.state, towerState)
    const attempted = await call(tools, 'tower_teardown', { repoRoot: repo })
    assert.deepEqual(attempted.archived, [])
    assert.match(attempted.archiveError, /unreadable/)
    assert.ok((await tower.load()).missions.some((mission) => mission.id === 'M3'), 'mission is never lost')

    // Repairing the index lets the next sweep archive it.
    const goodIndex = {
      archiveVersion: ARCHIVE_VERSION,
      updatedAt: Date.now(),
      missions: [
        {
          id: 'M1',
          title: 'Terminal mission 1',
          status: 'merged',
          kind: 'build',
          scope: ['area-1/**'],
          deps: [],
          owner: 'worker-1',
          branch: 'tower/m1-x',
          mergedCommit: 'a'.repeat(40),
          mergedAt: Date.now() - 60 * DAY,
          updatedAt: Date.now() - 60 * DAY,
          archivedAt: Date.now() - 60 * DAY,
          archivedYear: new Date().getUTCFullYear(),
        },
        {
          id: 'M2',
          title: 'Terminal mission 2',
          status: 'merged',
          kind: 'build',
          scope: ['area-2/**'],
          deps: [],
          owner: 'worker-2',
          branch: 'tower/m2-x',
          mergedCommit: 'a'.repeat(40),
          mergedAt: Date.now() - 61 * DAY,
          updatedAt: Date.now() - 61 * DAY,
          archivedAt: Date.now() - 61 * DAY,
          archivedYear: new Date().getUTCFullYear(),
        },
      ],
    }
    fs.writeFileSync(paths.index, JSON.stringify(goodIndex, null, 2))
    const repaired = await call(tools, 'tower_teardown', { repoRoot: repo })
    assert.deepEqual(repaired.archived, ['M3'])
    assert.equal(readJson(paths.index).missions.length, 3)
  } finally {
    cleanup(root)
  }
})

test('a repository with no archive directory still init/status/doctor normally', async () => {
  const { root, repo } = makeRepo('dsh-tower-archive-empty-')
  const { tools } = makeCtx()
  try {
    const initialized = await call(tools, 'tower_init', { repoRoot: repo })
    assert.equal(initialized.created, true)
    const tower = await Tower.open(repo)
    assert.equal(fs.existsSync(archivePaths(tower.paths).dir), false)

    const dashboard = await call(tools, 'tower_status', { repoRoot: repo })
    assert.equal(dashboard.archive.present, false)
    assert.equal(dashboard.archive.count, 0)
    assert.equal(dashboard.archive.unreadable, false)

    const doctor = await call(tools, 'tower_doctor', { repoRoot: repo })
    assert.equal(doctor.ok, true)
    assert.equal(doctor.archive.archivedMissions, 0)
    assert.equal(doctor.archive.missions, 0)
    assert.ok(doctor.archive.stateBytes > 0)
    assert.deepEqual(doctor.archive.policy, { enabled: true, afterDays: 30, maxMissions: 100 })
    assert.equal(doctor.checks.find((check) => check.id === 'archive').status, 'pass')
  } finally {
    cleanup(root)
  }
})

test('archive config has safe defaults and rejects invalid policy values', () => {
  assert.deepEqual(resolveTowerConfig({}).archive, { enabled: true, afterDays: 30, maxMissions: 100 })
  assert.deepEqual(resolveTowerConfig({ archive: { afterDays: 0, maxMissions: 0 } }).archive, {
    enabled: true,
    afterDays: 0,
    maxMissions: 0,
  })
  assert.equal(Config({ archive: { enabled: false } }).archive.enabled, false)
  assert.throws(
    () => resolveTowerConfig({ archive: { afterDays: -1 } }),
    (error) => error.code === 'config-invalid',
  )
  assert.throws(
    () => resolveTowerConfig({ archive: { maxMissions: 1.5 } }),
    (error) => error.code === 'config-invalid',
  )
  assert.throws(
    () => resolveTowerConfig({ archive: { typo: 1 } }),
    (error) => error.code === 'config-unknown-key',
  )
})

test('archivedEntry nests the untouched mission and its linked history', () => {
  const mission = {
    id: 'M1',
    title: 'T',
    kind: 'build',
    status: 'merged',
    scope: ['x/**'],
    deps: [],
    tasks: [{ text: 't', status: 'done' }],
    completionReport: { report: 'kept' },
    worktree: null,
    mergedAt: 10,
    updatedAt: 10,
  }
  const entry = archivedEntry(mission, {
    archivedAt: 20,
    archivedYear: 1970,
    reviews: [{ id: 'R1', missionId: 'M1', branch: 'b', round: 1, status: 'clean', mergeVerdict: 'merge', reviewedCommit: 'c', at: 1 }],
    findings: [{ id: 'F1', type: 'bug', title: 'x', summary: 's', details: 'd', suggested_fix: 'f', missionId: 'M1' }],
  })
  assert.equal(entry.id, 'M1')
  assert.equal(entry.archivedYear, 1970)
  assert.equal(entry.mission.completionReport.report, 'kept')
  assert.equal(entry.reviews.length, 1)
  assert.equal(entry.findings.length, 1)
  assert.equal(entry.status, 'merged')
  assert.equal(entry.branch, null)
})
