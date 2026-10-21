// Release compatibility provenance. COMPATIBILITY.md is shipped in the package;
// no network lookup is involved.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function parseVersion(value) {
  const text = String(value ?? '').trim()
  const match = text.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!match) return null
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1
    if (b[index] === undefined) return 1
    const aNumber = /^\d+$/.test(a[index])
    const bNumber = /^\d+$/.test(b[index])
    if (aNumber && bNumber) {
      const delta = Number(a[index]) - Number(b[index])
      if (delta !== 0) return delta
    } else if (aNumber !== bNumber) {
      return aNumber ? -1 : 1
    } else if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1
    }
  }
  return 0
}

export function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a
  const right = typeof b === 'string' ? parseVersion(b) : b
  if (!left || !right) return null
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] < right.numbers[index] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

export function parseCompatibility(text) {
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    if (!/^\|/.test(line)) continue
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.length < 4) continue
    if (!parseVersion(cells[0])) continue
    rows.push({ hostVersion: cells[0], commit: cells[1], verifiedOn: cells[2], ran: cells[3] })
  }
  return rows
}

export function readCompatibility(file = path.join(PACKAGE_ROOT, 'COMPATIBILITY.md')) {
  try {
    return parseCompatibility(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

export function assessHostVersion(hostVersion, rows) {
  const parsed = parseVersion(hostVersion)
  if (!parsed) return { verdict: 'unknown', row: null, detail: 'cannot parse the running host version' }
  const exact = rows.find((row) => compareVersions(row.hostVersion, parsed) === 0)
  if (exact) return { verdict: 'verified', row: exact, detail: `${exact.hostVersion} verified on ${exact.verifiedOn}` }
  const known = rows
    .map((row) => ({ row, cmp: compareVersions(parsed, row.hostVersion) }))
    .filter((entry) => entry.cmp !== null)
  if (known.length === 0) return { verdict: 'unknown', row: null, detail: 'COMPATIBILITY.md has no version rows' }
  const newest = known.reduce((best, entry) => (entry.cmp > best.cmp ? entry : best), known[0])
  if (newest.cmp > 0) {
    return {
      verdict: 'untested-newer',
      row: newest.row,
      detail: `${hostVersion} is newer than every verified build (latest row ${newest.row.hostVersion})`,
    }
  }
  return {
    verdict: 'untested-older',
    row: newest.row,
    detail: `${hostVersion} is older than the verified builds (latest row ${newest.row.hostVersion})`,
  }
}

export function detectHostVersion(ctx, env = process.env) {
  for (const value of [env.DSH_VERSION, env.DSH_HOST_VERSION, env.npm_config_dsh_version]) {
    if (typeof value === 'string' && parseVersion(value)) return value
  }
  for (const serviceName of ['app', 'runtime', 'host']) {
    try {
      const service = ctx?.get?.(serviceName)
      const value = service && (service.version ?? service.build?.version)
      if (typeof value === 'string' && parseVersion(value)) return value
    } catch {
      // defensive: a missing service is not a doctor failure
    }
  }
  return null
}
