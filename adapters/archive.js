// Terminal-mission archive storage (#73).
//
// Layout, under the Tower state directory:
//
//   archive/index.json      compact entries; tower_status pages from here
//   archive/<year>.json     full missions plus their linked reviews/findings
//
// Both files carry `archiveVersion` (independent of the state SCHEMA_VERSION).
// Reads are deliberately tolerant: a truncated or foreign archive returns a
// diagnostic result and never throws, so `tower_status` still renders the hot
// state. Writes happen before the state document is compacted, and dedupe by
// mission id, so a crash between the two files is recoverable on the next
// mutation instead of losing a mission.
import path from 'node:path'
import { fsp } from './store-fs.js'
import {
  ARCHIVE_VERSION,
  archiveDocumentError,
  dedupeById,
  indexEntryFromArchived,
} from '../domain/state/archive.js'

/** @typedef {import('../types/index.js').Mission} Mission */

/**
 * @param {{ dir: string }} paths
 * @returns {{ dir: string, index: string, year: (year: number) => string }}
 */
export function archivePaths(paths) {
  const dir = path.join(paths.dir, 'archive')
  return { dir, index: path.join(dir, 'index.json'), year: (year) => path.join(dir, `${year}.json`) }
}

/**
 * @param {any} error
 * @returns {boolean}
 */
function isMissing(error) {
  return error?.code === 'ENOENT'
}

/**
 * @param {string} where
 * @param {string} message
 * @returns {string}
 */
function diagnostic(where, message) {
  return `tower archive is unreadable at ${where}: ${message}`
}

/**
 * Read `archive/index.json` without throwing. A missing index means "no
 * archive yet"; a corrupt one is reported as `ok:false` with the diagnostic.
 * @param {{ readJson: (file: string) => Promise<any> }} store
 * @param {{ dir: string }} paths
 * @returns {Promise<{ ok: boolean, file: string, missions: any[], error?: string, exists: boolean }>}
 */
export async function readArchiveIndex(store, paths) {
  const file = archivePaths(paths).index
  let document
  try {
    document = await store.readJson(file)
  } catch (error) {
    if (isMissing(error)) return { ok: true, file, missions: [], exists: false }
    return { ok: false, file, missions: [], error: diagnostic(file, String(error?.message ?? error)), exists: true }
  }
  const error = archiveDocumentError(document, 'index', ` at ${file}`)
  if (error) return { ok: false, file, missions: [], error, exists: true }
  return { ok: true, file, missions: document.missions, exists: true }
}

/**
 * @param {{ readJson: (file: string) => Promise<any> }} store
 * @param {{ dir: string }} paths
 * @param {number} year
 * @returns {Promise<{ ok: boolean, file: string, missions: any[], error?: string, exists: boolean }>}
 */
export async function readArchiveYear(store, paths, year) {
  const file = archivePaths(paths).year(year)
  let document
  try {
    document = await store.readJson(file)
  } catch (error) {
    if (isMissing(error)) return { ok: true, file, missions: [], exists: false }
    return { ok: false, file, missions: [], error: diagnostic(file, String(error?.message ?? error)), exists: true }
  }
  const error = archiveDocumentError(document, 'year', ` at ${file}`)
  if (error) return { ok: false, file, missions: [], error, exists: true }
  return { ok: true, file, missions: document.missions, exists: true }
}

/**
 * Append full entries to their year files, then to the index. Returns
 * `ok:false` (and writes nothing for the index) when an existing archive file
 * is unreadable, so a corrupt archive is never silently replaced.
 * @param {{ readJson: (file: string) => Promise<any>, writeJsonAtomic: (file: string, value: unknown) => Promise<void>, ensureDir: (dir: string) => Promise<void> }} store
 * @param {{ dir: string }} paths
 * @param {{ entries: Array<Record<string, any>>, now: number }} input
 * @returns {Promise<{ ok: boolean, count: number, files: string[], error?: string }>}
 */
export async function writeArchiveEntries(store, paths, { entries, now }) {
  if (entries.length === 0) return { ok: true, count: 0, files: [] }
  const target = archivePaths(paths)

  // Read the index first: if it is corrupt, refusing to write keeps the old
  // history byte-identical and leaves the state missions intact for a retry.
  const index = await readArchiveIndex(store, paths)
  if (!index.ok) return { ok: false, count: 0, files: [], error: index.error }

  /** @type {Map<number, Array<Record<string, any>>>} */
  const byYear = new Map()
  for (const entry of entries) {
    const year = entry.archivedYear
    if (!Number.isInteger(year)) return { ok: false, count: 0, files: [], error: `archive entry ${entry.id} has no archivedYear` }
    const bucket = byYear.get(year) ?? []
    bucket.push(entry)
    byYear.set(year, bucket)
  }

  /** @type {Array<{ year: number, file: string, missions: any[] }>} */
  const yearDocuments = []
  for (const [year, batch] of [...byYear.entries()].sort((left, right) => left[0] - right[0])) {
    const existing = await readArchiveYear(store, paths, year)
    if (!existing.ok) return { ok: false, count: 0, files: [], error: existing.error }
    yearDocuments.push({
      year,
      file: existing.file,
      missions: dedupeById([...existing.missions, ...batch]),
    })
  }

  await store.ensureDir(target.dir)
  for (const document of yearDocuments) {
    await store.writeJsonAtomic(document.file, {
      archiveVersion: ARCHIVE_VERSION,
      year: document.year,
      updatedAt: now,
      missions: document.missions,
    })
  }

  const indexed = dedupeById([...index.missions, ...entries.map(indexEntryFromArchived)])
  await store.writeJsonAtomic(target.index, {
    archiveVersion: ARCHIVE_VERSION,
    updatedAt: now,
    missions: indexed,
  })

  return {
    ok: true,
    count: entries.length,
    files: [...yearDocuments.map((document) => document.file), target.index],
  }
}

/**
 * Load one archived mission with its linked reviews/findings.
 * @param {{ readJson: (file: string) => Promise<any> }} store
 * @param {{ dir: string }} paths
 * @param {string} missionId
 * @returns {Promise<{ ok: boolean, entry?: Record<string, any>, unreadable?: boolean, missing?: boolean, error?: string }>}
 */
export async function readArchivedEntry(store, paths, missionId) {
  const index = await readArchiveIndex(store, paths)
  if (!index.ok) return { ok: false, unreadable: true, error: index.error }
  const indexEntry = index.missions.find((entry) => entry.id === missionId)
  if (!indexEntry) return { ok: false, missing: true }
  const year = await readArchiveYear(store, paths, indexEntry.archivedYear)
  if (!year.ok) return { ok: false, unreadable: true, error: year.error }
  const entry = year.missions.find((candidate) => candidate.id === missionId)
  if (!entry) {
    return {
      ok: false,
      unreadable: true,
      error: `tower archive index lists ${missionId} in ${year.file}, but the year file has no such entry`,
    }
  }
  return { ok: true, entry }
}

/**
 * @param {string} file
 * @param {string} kind
 * @returns {Promise<{ file: string, kind: string, ok: boolean, bytes: number, missions: number, error?: string, document?: any }>}
 */
async function inspectFile(file, kind) {
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    return { file, kind, ok: false, bytes: 0, missions: 0, error: diagnostic(file, String(error?.message ?? error)) }
  }
  const bytes = Buffer.byteLength(text)
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    return { file, kind, ok: false, bytes, missions: 0, error: diagnostic(file, `invalid JSON (${error.message})`) }
  }
  const error = archiveDocumentError(document, /** @type {'index'|'year'} */ (kind), ` at ${file}`)
  if (error) return { file, kind, ok: false, bytes, missions: 0, error, document }
  return { file, kind, ok: true, bytes, missions: document.missions.length, document }
}

/**
 * Read-only inventory for `tower_doctor`: file sizes, mission counts, year
 * files and every unreadable file's diagnostic. A missing archive directory is
 * a healthy empty archive, not an error.
 * @param {{ dir: string, state?: string }} paths
 * @returns {Promise<{
 *   dir: string, exists: boolean, bytes: number, missions: number, years: number[],
 *   files: Array<Record<string, any>>, unreadable: string[],
 *   index: { ok: boolean, count: number, error?: string } | null,
 * }>}
 */
export async function inspectArchive(paths) {
  const target = archivePaths(/** @type {{ dir: string }} */ (paths))
  let names
  try {
    names = await fsp.readdir(target.dir)
  } catch (error) {
    if (isMissing(error)) {
      return { dir: target.dir, exists: false, bytes: 0, missions: 0, years: [], files: [], unreadable: [], index: null }
    }
    return {
      dir: target.dir,
      exists: true,
      bytes: 0,
      missions: 0,
      years: [],
      files: [],
      unreadable: [diagnostic(target.dir, String(error?.message ?? error))],
      index: null,
    }
  }

  const jsonFiles = names.filter((name) => name.endsWith('.json')).sort()
  const files = []
  let bytes = 0
  let index = null
  const yearIds = new Set()
  for (const name of jsonFiles) {
    const file = path.join(target.dir, name)
    const kind = name === 'index.json' ? 'index' : 'year'
    const inspected = await inspectFile(file, kind)
    files.push({
      file,
      kind,
      ok: inspected.ok,
      bytes: inspected.bytes,
      missions: inspected.missions,
      ...(inspected.error ? { error: inspected.error } : {}),
    })
    bytes += inspected.bytes
    if (kind === 'index') {
      index = { ok: inspected.ok, count: inspected.missions, ...(inspected.error ? { error: inspected.error } : {}) }
    } else if (inspected.ok) {
      for (const entry of inspected.document.missions) yearIds.add(entry.id)
    }
  }
  const unreadable = files
    .filter((file) => !file.ok && typeof file.error === 'string')
    .map((file) => /** @type {string} */ (file.error))
  const years = files
    .filter((file) => file.kind === 'year' && file.ok)
    .map((file) => Number(path.basename(file.file, '.json')))
    .filter((year) => Number.isInteger(year))
    .sort((left, right) => left - right)
  return {
    dir: target.dir,
    exists: true,
    bytes,
    missions: index?.ok ? index.count : yearIds.size,
    years,
    files,
    unreadable,
    index,
  }
}
