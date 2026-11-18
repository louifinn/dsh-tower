// Release compatibility provenance. COMPATIBILITY.md is shipped in the package;
// no network lookup is involved.
import { fs } from '../adapters/store-fs.js'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// #F75: the environment-health remedy a reader acts on. It is copy, so it lives
// in one table the component gate reads (`scripts/check-components.mjs`): no tool
// id (`tower_inspect`), no view syntax and no configuration key. The diagnostic
// facts — the version, its source and the probe detail — stay in `detail`.
const DOCTOR_ACTION_COPY = Object.freeze({
  secondaryVersion:
    'the version came from a profile dependency; record the running version in DSH_VERSION (empty values are ignored) or make the install package readable, then run the environment health check again',
  unknownVersion:
    'record the running version in DSH_VERSION or a readable DSH_INSTALL_DIR package.json (a packaged app archive is not readable by ordinary fs), or add a COMPATIBILITY.md row, then run the environment health check again',
})

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

const VERSION_ENV_KEYS = ['DSH_VERSION', 'DSH_HOST_VERSION', 'npm_config_dsh_version']
// #F65: the desktop host ships inside `resources/app.asar`; only an asar-aware
// fs can read through that container. The packager keeps files it could not
// pack in a sibling `app.asar.unpacked` directory, which ordinary fs can read.
const ASAR_SEGMENT = /\.asar$/i
const PROFILE_PACKAGE = '@deepseek-ai/dsh-tool-subagent'

/**
 * A trimmed non-empty string; empty and whitespace-only values are absent.
 * The desktop host exports DSH_VERSION/DSH_HOST_VERSION as empty strings, so an
 * empty value must never be read as a version or shadow the sources behind it.
 * @param {unknown} value
 * @returns {string}
 */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/**
 * Read the version a package.json in `dir` declares.
 * Returns the failure reason as well as the value so doctor can report why a
 * probed source failed instead of a bare miss. Never throws: doctor must not
 * fail because a package is missing, unreadable or malformed.
 * @param {string} dir
 * @returns {{ version: string | null, reason: string }}
 */
function readPackageVersion(dir) {
  const file = path.join(dir, 'package.json')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { version: null, reason: `no readable package.json at ${file} (${error?.code ?? 'read failed'})` }
  }
  let document
  try {
    document = JSON.parse(text)
  } catch {
    return { version: null, reason: `${file} is not valid JSON` }
  }
  const declared = nonEmpty(document?.version)
  if (!declared) return { version: null, reason: `${file} declares no version string` }
  if (!parseVersion(declared)) {
    return { version: null, reason: `${file} declares ${JSON.stringify(declared)}, which is not a parsable version` }
  }
  return { version: declared, reason: `${file} declares ${declared}` }
}

/**
 * Describe the first `.asar` segment in an absolute path and the matching
 * `.asar.unpacked` sibling. Returns null when the path is outside an archive.
 * @param {string} dir
 * @returns {{ container: string, unpackedDir: string, segment: string } | null}
 */
function asarLayout(dir) {
  const resolved = path.resolve(dir)
  const parts = resolved.split(/[\\/]/)
  const index = parts.findIndex((segment) => ASAR_SEGMENT.test(segment))
  if (index === -1) return null
  const unpacked = [...parts.slice(0, index), `${parts[index]}.unpacked`, ...parts.slice(index + 1)]
  return {
    container: parts.slice(0, index + 1).join(path.sep) || path.sep,
    unpackedDir: unpacked.join(path.sep) || path.sep,
    segment: parts[index],
  }
}

/**
 * Pick the host-lockstep package installed in one profile. The known live
 * example is `@deepseek-ai/dsh-tool-subagent`; the host package itself and any
 * `@deepseek-ai/dsh*` sibling are accepted so a differently bundled profile
 * still answers. The plugin's own tower package is excluded: its version is the
 * plugin's, not the host's.
 * @param {string} scopeDir
 */
function profilePackage(scopeDir) {
  let entries
  try {
    entries = fs.readdirSync(scopeDir, { withFileTypes: true })
  } catch {
    return null
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^dsh(?:$|-)/.test(entry.name) || /tower/i.test(entry.name)) continue
    const dir = path.join(scopeDir, entry.name)
    const read = readPackageVersion(dir)
    if (!read.version) continue
    const rank = entry.name === 'dsh' ? 0 : entry.name === PROFILE_PACKAGE.split('/')[1] ? 1 : 2
    candidates.push({ name: `@deepseek-ai/${entry.name}`, dir, version: read.version, rank })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.rank - b.rank || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return candidates[0]
}

/**
 * Probe the package.json under DSH_INSTALL_DIR, its parent, and — when the
 * install dir is inside an asar archive — the matching app.asar.unpacked copy
 * and that copy's parent. Records one probe per attempt.
 * @param {Record<string, string | undefined>} env
 * @param {any[]} probes
 */
function probeInstallDir(env, probes) {
  const installDir = nonEmpty(env?.DSH_INSTALL_DIR)
  if (!installDir) {
    probes.push({
      source: 'env:DSH_INSTALL_DIR',
      target: null,
      status: 'skipped',
      reason: 'DSH_INSTALL_DIR is unset or whitespace-only; treated as absent',
      authoritative: true,
    })
    return { hit: null, asar: null }
  }
  const resolved = path.resolve(installDir)
  const layout = asarLayout(resolved)
  const asar = layout
    ? {
        container: layout.container,
        installDir: resolved,
        unpackedDir: layout.unpackedDir,
        directReadable: false,
        unpackedAnswered: false,
        note: `DSH_INSTALL_DIR is inside the ${layout.segment} container, which ordinary fs cannot read; doctor also tried the app.asar.unpacked copy`,
      }
    : null
  const attempts = layout
    ? [
        { source: 'DSH_INSTALL_DIR', dir: resolved, note: 'DSH_INSTALL_DIR names this path' },
        { source: 'DSH_INSTALL_DIR(parent)', dir: path.dirname(resolved), note: 'the parent of DSH_INSTALL_DIR' },
        { source: 'DSH_INSTALL_DIR.asar.unpacked', dir: layout.unpackedDir, note: 'app.asar.unpacked substitution' },
        { source: 'DSH_INSTALL_DIR.asar.unpacked(parent)', dir: path.dirname(layout.unpackedDir), note: 'app.asar.unpacked substitution (parent)' },
      ]
    : [
        { source: 'DSH_INSTALL_DIR', dir: resolved, note: 'DSH_INSTALL_DIR names this path' },
        { source: 'DSH_INSTALL_DIR(parent)', dir: path.dirname(resolved), note: 'DSH_INSTALL_DIR may name a subdirectory of the package' },
      ]
  const candidates = []
  const seen = new Set()
  for (const attempt of attempts) {
    const key = path.resolve(attempt.dir)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(attempt)
  }
  let hit = null
  for (const attempt of candidates) {
    const read = readPackageVersion(attempt.dir)
    const archive = asarLayout(attempt.dir) !== null
    const note = archive ? 'this path is inside an asar container, which ordinary fs cannot read' : attempt.note
    const viaUnpacked = layout !== null && (attempt.dir === layout.unpackedDir || attempt.dir === path.dirname(layout.unpackedDir))
    const selected = Boolean(read.version) && hit === null
    probes.push({
      source: attempt.source,
      target: attempt.dir,
      status: read.version ? 'hit' : 'miss',
      reason: !read.version
        ? `${note}; ${read.reason}`
        : selected
          ? read.reason
          : `${read.reason}; readable, but a higher-precedence source answered, so this candidate was recorded and not used`,
      authoritative: true,
    })
    if (!read.version) continue
    // A readable candidate answers for the archive-flags even when a
    // higher-precedence candidate supplied the version.
    if (asar && attempt.dir === resolved) asar.directReadable = true
    if (asar && viaUnpacked) asar.unpackedAnswered = true
    // The first readable candidate answers: DSH_INSTALL_DIR outranks its
    // parent, and the app.asar.unpacked package outranks that copy's parent.
    // A later readable candidate is recorded above but never overrides the
    // answer (F65: letting a parent's verified-but-older row win turned an
    // untested-newer host into a false `pass`).
    if (hit) continue
    hit = {
      version: read.version,
      source: attempt.source,
      authoritative: true,
      detail: viaUnpacked
        ? `${read.version} from the app.asar.unpacked copy of the install package at ${attempt.dir} (the asar container itself is not readable by ordinary fs)`
        : attempt.source === 'DSH_INSTALL_DIR(parent)'
          ? `${read.version} from the package.json at ${attempt.dir} (the parent of DSH_INSTALL_DIR)`
          : `${read.version} from the package.json at ${attempt.dir} named by DSH_INSTALL_DIR`,
    }
  }
  return { hit, asar }
}

/**
 * Probe the mounted services that may carry a host build version.
 * @param {any} ctx
 * @param {any[]} probes
 */
function probeServices(ctx, probes) {
  for (const name of ['app', 'runtime', 'host']) {
    let service
    try {
      service = ctx?.get?.(name)
    } catch (error) {
      probes.push({
        source: `service:${name}`,
        target: null,
        status: 'miss',
        reason: `looking up the ${name} service threw: ${String(error?.message ?? error)}`,
        authoritative: true,
      })
      continue
    }
    if (!service) {
      probes.push({
        source: `service:${name}`,
        target: null,
        status: 'skipped',
        reason: `the ${name} service is not mounted`,
        authoritative: true,
      })
      continue
    }
    const declared = nonEmpty(service.version) || nonEmpty(service.build?.version)
    if (!declared) {
      probes.push({
        source: `service:${name}`,
        target: null,
        status: 'miss',
        reason: `the ${name} service exposes no version`,
        authoritative: true,
      })
      continue
    }
    if (!parseVersion(declared)) {
      probes.push({
        source: `service:${name}`,
        target: null,
        status: 'miss',
        reason: `the ${name} service version ${JSON.stringify(declared)} is not a parsable version`,
        authoritative: true,
      })
      continue
    }
    probes.push({
      source: `service:${name}`,
      target: null,
      status: 'hit',
      reason: `the ${name} service reports ${declared}`,
      authoritative: true,
    })
    return {
      version: declared,
      source: `service:${name}`,
      authoritative: true,
      detail: `${declared} from the mounted ${name} service`,
    }
  }
  return null
}

/**
 * Last-resort secondary source: a profile-installed `@deepseek-ai/dsh*`
 * dependency. Those packages ship in lockstep with the host but may lag it, so
 * the hit is labelled and marked non-authoritative; it is never presented as
 * the host's own version (F65).
 * @param {Record<string, string | undefined>} env
 * @param {any[]} probes
 */
function probeProfileDependency(env, probes) {
  let home = nonEmpty(env?.DSH_HOME)
  if (!home) {
    let fallback
    try {
      fallback = nonEmpty(os.homedir())
    } catch (error) {
      probes.push({
        source: 'profile',
        target: null,
        status: 'miss',
        reason: `os.homedir() threw while locating the profile fallback (${String(error?.message ?? error)}); the profile dependency was not scanned`,
        authoritative: false,
      })
      return null
    }
    if (!fallback) {
      probes.push({
        source: 'profile',
        target: null,
        status: 'miss',
        reason: 'os.homedir() returned no home directory; the profile dependency was not scanned',
        authoritative: false,
      })
      return null
    }
    home = path.join(fallback, '.dsh')
  }
  const profilesDir = path.join(home, 'profiles')
  let entries
  try {
    entries = fs.readdirSync(profilesDir, { withFileTypes: true })
  } catch (error) {
    probes.push({
      source: 'profile',
      target: profilesDir,
      status: 'miss',
      reason: `no readable DSH profiles directory at ${profilesDir} (${error?.code ?? 'read failed'})`,
      authoritative: false,
    })
    return null
  }
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  if (names.length === 0) {
    probes.push({
      source: 'profile',
      target: profilesDir,
      status: 'miss',
      reason: `${profilesDir} has no profile directory`,
      authoritative: false,
    })
    return null
  }
  for (const name of names) {
    const scopeDir = path.join(profilesDir, name, 'node_modules', '@deepseek-ai')
    const winner = profilePackage(scopeDir)
    if (!winner) {
      probes.push({
        source: 'profile',
        target: scopeDir,
        status: 'miss',
        reason: `no @deepseek-ai/dsh* package with a parsable version under ${scopeDir}`,
        authoritative: false,
      })
      continue
    }
    probes.push({
      source: `profile:${winner.name}`,
      target: winner.dir,
      status: 'hit',
      reason: `${winner.name}@${winner.version} is installed in profile ${name}; it is a profile dependency, not the host install, and may lag the host`,
      authoritative: false,
    })
    return {
      version: winner.version,
      source: `profile:${winner.name}`,
      authoritative: false,
      detail: `${winner.version} from the profile-installed dependency ${winner.name} at ${winner.dir} (secondary source: it is versioned with the host but may lag it, so it is not authoritative)`,
    }
  }
  return null
}

/**
 * One line naming why every probed source failed, for the doctor detail.
 * @param {any[]} probes
 * @param {{ container: string, directReadable: boolean } | null} asar
 * @returns {string}
 */
function unknownDetail(probes, asar) {
  const parts = []
  for (const key of VERSION_ENV_KEYS) {
    const probe = probes.find((entry) => entry.source === `env:${key}`)
    parts.push(!probe || probe.status === 'skipped' ? `${key} is empty` : `${key} is not a parsable version`)
  }
  const installSkipped = probes.some((entry) => entry.source === 'env:DSH_INSTALL_DIR' && entry.status === 'skipped')
  if (asar) {
    parts.push(
      asar.directReadable
        ? `DSH_INSTALL_DIR points inside ${asar.container}; its package.json is missing or not a parsable version, and the app.asar.unpacked copy did not answer either`
        : `DSH_INSTALL_DIR points inside ${asar.container}, which ordinary fs cannot read, and its app.asar.unpacked copy has no readable package.json`,
    )
  } else if (installSkipped) {
    parts.push('DSH_INSTALL_DIR is empty')
  } else {
    parts.push('no package.json with a parsable version under DSH_INSTALL_DIR')
  }
  parts.push('no app/runtime/host service exposed a version')
  parts.push('no profile-installed @deepseek-ai/dsh* dependency supplied a version')
  return `no source answered (${parts.join('; ')})`
}

/**
 * Resolve the running host version with provenance. Sources are probed in
 * trust order: the version environment variables, the installed package
 * (including the app.asar.unpacked fallback for the desktop layout), the
 * mounted services, then the profile dependency as a labelled secondary source.
 *
 * The result records which source answered (`source`, `detail`,
 * `authoritative`), why every probed source failed (`probes`), and the asar
 * layout when DSH_INSTALL_DIR points into an archive (`asar`). `version` is
 * `null` when no source yields a parsable version.
 * @param {any} ctx
 * @param {Record<string, string | undefined>} [env]
 * @returns {{
 *   version: string | null,
 *   source: string | null,
 *   authoritative: boolean,
 *   detail: string,
 *   probes: any[],
 *   asar: any,
 * }}
 */
export function resolveHostVersion(ctx, env = process.env) {
  const probes = []
  for (const key of VERSION_ENV_KEYS) {
    const raw = env?.[key]
    if (typeof raw !== 'string' || !raw.trim()) {
      probes.push({
        source: `env:${key}`,
        target: null,
        status: 'skipped',
        reason: `${key} is ${typeof raw === 'string' ? 'empty or whitespace-only' : 'unset'}; treated as absent`,
        authoritative: true,
      })
      continue
    }
    const value = raw.trim()
    if (!parseVersion(value)) {
      probes.push({
        source: `env:${key}`,
        target: null,
        status: 'miss',
        reason: `${key}=${JSON.stringify(raw)} is not a parsable version; ignored`,
        authoritative: true,
      })
      continue
    }
    probes.push({
      source: `env:${key}`,
      target: null,
      status: 'hit',
      reason: `${key}=${value}`,
      authoritative: true,
    })
    return {
      version: value,
      source: `env:${key}`,
      authoritative: true,
      detail: `${value} from the ${key} environment variable`,
      probes,
      asar: null,
    }
  }
  const install = probeInstallDir(env, probes)
  if (install.hit) return { ...install.hit, probes, asar: install.asar }
  const service = probeServices(ctx, probes)
  if (service) return { ...service, probes, asar: install.asar }
  const profile = probeProfileDependency(env, probes)
  if (profile) return { ...profile, probes, asar: install.asar }
  return {
    version: null,
    source: null,
    authoritative: false,
    detail: unknownDetail(probes, install.asar),
    probes,
    asar: install.asar,
  }
}

/**
 * The running host version as a string, or null when no source yields a
 * parsable version. `resolveHostVersion` carries the provenance.
 * @param {any} ctx
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function detectHostVersion(ctx, env = process.env) {
  return resolveHostVersion(ctx, env).version
}

/**
 * Turn a resolved host report and its COMPATIBILITY.md assessment into the
 * doctor check text and the provenance fields doctor publishes. Kept here so
 * doctor.js stays a thin caller and within its aggregate-size budget.
 * @param {any} report
 * @param {{ verdict: string, detail: string }} assessment
 * @returns {{ status: 'pass' | 'warn', detail: string, action: string | undefined, contract: Record<string, any> }}
 */
export function diagnoseHostVersion(report, assessment) {
  const detected = report.version
  // A profile dependency is versioned with the host but may lag it, so its hit
  // is advisory even when the row matches: never present it as authoritative.
  const secondary = Boolean(detected) && !report.authoritative
  const passed = Boolean(detected) && !secondary && assessment.verdict === 'verified'
  return {
    status: passed ? 'pass' : 'warn',
    detail: detected
      ? `${detected}: ${assessment.detail}. Source: ${report.detail}.`
      : `unknown host version; ${assessment.detail}. ${report.detail}. Include the running host version and its COMPATIBILITY.md row in bug reports.`,
    action: passed
      ? undefined
      : secondary
        ? DOCTOR_ACTION_COPY.secondaryVersion
        : DOCTOR_ACTION_COPY.unknownVersion,
    contract: {
      hostVersion: detected,
      hostVersionSource: report.source,
      hostVersionSourceDetail: report.detail,
      hostVersionAuthoritative: Boolean(detected) && report.authoritative,
      hostVersionProbes: report.probes,
      hostAsar: report.asar,
    },
  }
}
