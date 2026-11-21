#!/usr/bin/env node
// Cumulative Release notes.
//
// Policy: every GitHub Release aggregates every CHANGELOG section since the
// previous GitHub Release, not just the section that names its own version.
// Tag-only versions have no Release, so their sections roll into the next
// Release. Example: when 2.1.0 was the previous Release, the 2.3.0 Release
// includes 2.1.1, 2.1.2, 2.2.0 and 2.3.0; 2.1.0-beta.1 is older than 2.1.0 and
// stays out of the window.
//
// The script is the authority for a Release body: it reads `<root>/CHANGELOG.md`
// and emits
//
//   # dsh-tower <version>
//
//   > <provenance line naming the previous Release>
//
//   ---
//
//   <CHANGELOG section> --- <CHANGELOG section> ...
//
// in ascending SemVer order (`1.0.0-beta.2 < 1.0.0-beta.10 < 1.0.0`). The
// window is `since < v <= version`. `--check <file>` compares an existing notes
// file byte-for-byte with the generated text so a published Release body can be
// re-verified.
//
// Usage:
//   node scripts/release-notes.mjs [--version <semver>] --since <semver> \
//     [--output <file>] [--check <file>] [--root <dir>]
//
// The body is rendered in memory and validated before anything is written: it
// must start with the `# dsh-tower <version>` heading and be at least
// MIN_BODY_BYTES long. `--version` defaults to the root package.json version;
// `--since` must name an existing tag. A run that fails any check exits non-zero
// and never creates or truncates the output file, so a mangled npm invocation
// cannot leave a stub Release body behind.
//
// Exit codes: 0 success or matching --check; 1 --check mismatch; 2 bad
// arguments, an unreadable CHANGELOG or package.json, `since >= version`, an
// empty window, a missing `--since` tag, or a body below the minimum.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { compareVersions } from '../host/compatibility.js'
import { parseArgs, runMain, UsageError } from './lib/cli.mjs'

// A Release body shorter than this is a stub, not notes: the historical npm
// wrapper bug wrote a 9-byte file while exiting 0, so the CLI refuses anything
// this small rather than publishing it.
export const MIN_BODY_BYTES = 200

const USAGE = `usage: node scripts/release-notes.mjs [--version <semver>] --since <semver>
                                     [--output <file>] [--check <file>] [--root <dir>] [--help]

  --version  release version to generate notes for (default: the root package.json version)
  --since    previous GitHub Release version, exclusive; must name an existing tag
  --output   write the notes to this file instead of stdout (alias: --out)
  --check    compare the generated notes with this file byte-for-byte
  --root     repository root that holds CHANGELOG.md and package.json (default: current directory)
  --help     print this text

A version may be written with or without its "v" tag prefix; --since is accepted
as either the tag name or its version. Each value option may be given at most
once. The window (since, version] is emitted in ascending SemVer order, so
tag-only versions between the two Releases are included. The generated body must
be at least ${MIN_BODY_BYTES} bytes; a shorter body is refused instead of written.`


// SemVer 2.0.0 without build metadata: X.Y.Z with an optional pre-release.
// Numeric core and numeric pre-release identifiers have no leading zeros, so
// "2.3.0" is a version and "2.3" or "2.3.0-01" are not.
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/

// A level-2 heading whose first token is a version. The loose token keeps the
// pre-release suffix intact (`2.1.0-beta.1`, not `2.1.0`); SEMVER then rejects
// a heading such as `## Unreleased`. `### Added` never matches: the third `#`
// is not whitespace.
const HEADING = /^##[ \t]+(?:\[[ \t]*)?v?([0-9A-Za-z.-]+)/

function usageError(message) {
  const error = new UsageError(message)
  error.showUsage = true
  return error
}

// Every value option is single-use. lib/cli's parseArgs overwrites silently, so
// the repeat is caught here before parsing. `--out` is the same option as
// `--output`; `--help` is harmless when repeated.
const SINGLE_USE = new Map([
  ['--version', '--version'],
  ['--since', '--since'],
  ['--output', '--output'],
  ['--out', '--output'],
  ['--check', '--check'],
  ['--root', '--root'],
])

function rejectRepeatedOptions(argv) {
  const seen = new Set()
  for (const arg of argv) {
    const canonical = SINGLE_USE.get(arg)
    if (!canonical) continue
    if (seen.has(canonical)) throw usageError(`${canonical} may be given only once`)
    seen.add(canonical)
  }
}

// A missing --version is not an error: the release being cut is the version the
// root package.json already declares. An unreadable or versionless manifest is.
function defaultVersion(root) {
  const file = path.join(root, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw usageError(`--version <semver> is required (cannot read ${file}: ${error?.message ?? error})`)
  }
  if (typeof manifest?.version !== 'string' || manifest.version.trim() === '') {
    throw usageError(`--version <semver> is required (${file} has no version)`)
  }
  return manifest.version
}

// `--since` names the previous GitHub Release, which must exist as a tag before
// notes can be built. Both the "vX.Y.Z" and "X.Y.Z" spellings are accepted.
function requireExistingTag(root, since) {
  const tags = spawnSync('git', ['-C', root, 'tag', '--list'], { encoding: 'utf8', windowsHide: true })
  if (tags.error) throw new UsageError(`cannot list git tags under ${root}: ${tags.error.message}`)
  if (tags.status !== 0) {
    const detail = String(tags.stderr ?? '').trim() || `git exited ${tags.status}`
    throw new UsageError(`cannot list git tags under ${root}: ${detail}`)
  }
  const names = new Set(String(tags.stdout ?? '').split(/\r?\n/).filter(Boolean))
  if (!names.has(since) && !names.has(`v${since}`)) {
    throw new UsageError(
      `--since ${JSON.stringify(since)} is not an existing tag in ${root} ` +
        `(looked for ${since} and v${since}); create the release tag first`,
    )
  }
}

// The write guard: the rendered body must be real notes, not a 9-byte stub. It
// runs before --output touches the file and before --check compares anything.
export function assertUsableNotes(text, version) {
  const heading = `# dsh-tower ${version}`
  if (typeof text !== 'string' || !text.startsWith(`${heading}\n`)) {
    throw new Error(`generated notes are missing the "${heading}" heading`)
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes < MIN_BODY_BYTES) {
    throw new Error(
      `generated notes for ${version} are ${bytes} bytes, below the ${MIN_BODY_BYTES}-byte minimum; ` +
        'refusing to write a stub',
    )
  }
  return bytes
}

function normalizeVersion(value, flag) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw usageError(`${flag} <semver> is required`)
  }
  const text = value.trim().replace(/^v/, '')
  if (!SEMVER.test(text)) {
    throw usageError(`${flag} ${JSON.stringify(value)} is not a SemVer version (expected X.Y.Z or X.Y.Z-pre)`)
  }
  return text
}

/**
 * Read every `## <version>` section from CHANGELOG text, in file order.
 *
 * The body ends at the next level-2 heading. Leading and trailing blank lines
 * are dropped, so a section touched by the next heading without an intervening
 * blank line (the real CHANGELOG has a few) still produces stable output.
 * Duplicate version headings are a malformed changelog, not a choice.
 */
export function extractSections(changelog) {
  const lines = String(changelog ?? '').split(/\r?\n/)
  const sections = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = HEADING.exec(lines[index])
    if (!match || !SEMVER.test(match[1])) continue
    const body = []
    let cursor = index + 1
    while (cursor < lines.length && !/^##[ \t]/.test(lines[cursor])) {
      body.push(lines[cursor])
      cursor += 1
    }
    while (body.length > 0 && body[0].trim() === '') body.shift()
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
    const heading = lines[index].trimEnd()
    sections.push({
      version: match[1],
      heading,
      body: body.join('\n'),
      text: body.length > 0 ? `${heading}\n\n${body.join('\n')}` : heading,
    })
    index = cursor - 1
  }
  const seen = new Set()
  for (const section of sections) {
    if (seen.has(section.version)) {
      throw new Error(`CHANGELOG.md has more than one section for version ${section.version}`)
    }
    seen.add(section.version)
  }
  return sections
}

/**
 * Build the cumulative Release body for `version`, containing every CHANGELOG
 * section with `since < v <= version` in ascending SemVer order.
 */
export function generateReleaseNotes({ changelog, version, since }) {
  const target = normalizeVersion(version, '--version')
  const previous = normalizeVersion(since, '--since')
  const relation = compareVersions(target, previous)
  if (relation !== null && relation <= 0) {
    throw usageError(`--since ${previous} must be older than --version ${target}`)
  }
  const sections = extractSections(changelog)
    .filter((section) => {
      const afterSince = compareVersions(section.version, previous)
      const atOrBeforeTarget = compareVersions(section.version, target)
      return afterSince > 0 && atOrBeforeTarget <= 0
    })
    .sort((left, right) => compareVersions(left.version, right.version))

  if (sections.length === 0) {
    throw usageError(
      `no CHANGELOG section falls in the window (${previous}, ${target}]; ` +
        'bump the changelog or check --since (it is the previous GitHub Release, not the previous tag)',
    )
  }

  const versions = sections.map((section) => section.version)
  const quote =
    versions.length === 1
      ? `> 自上一个 Release \`v${previous}\` 起的变更。`
      : `> 本 Release 包含自上一个 Release \`v${previous}\` 以来的全部变更：${versions.join('、')}。`
  const text = `# dsh-tower ${target}\n\n${quote}\n\n---\n\n${sections
    .map((section) => section.text)
    .join('\n\n---\n\n')}\n`
  return { version: target, since: previous, versions, sections, text }
}

function firstDifference(expected, actual) {
  const expectedLines = expected.split('\n')
  const actualLines = actual.split('\n')
  const limit = Math.max(expectedLines.length, actualLines.length)
  for (let index = 0; index < limit; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return {
        line: index + 1,
        expected: expectedLines[index] ?? '<end of file>',
        actual: actualLines[index] ?? '<end of file>',
      }
    }
  }
  return null
}

function compareWithFile(file, result) {
  const expected = Buffer.from(result.text, 'utf8')
  let existing
  try {
    existing = fs.readFileSync(file)
  } catch (error) {
    console.error(`release-notes: cannot read ${file}: ${error?.message ?? error}`)
    return 2
  }
  if (existing.equals(expected)) {
    console.log(
      `release-notes: ${file} matches the generated notes for ${result.version} ` +
        `(${result.versions.length} section(s): ${result.versions.join(', ')})`,
    )
    return 0
  }
  const found = existing.toString('utf8')
  const difference = firstDifference(result.text, found)
  console.error(`release-notes: ${file} does not match the generated notes for ${result.version}`)
  if (difference) {
    console.error(`  first difference at line ${difference.line}: expected ${JSON.stringify(difference.expected)}`)
    console.error(`  found ${JSON.stringify(difference.actual)}`)
  }
  console.error(`  expected ${expected.length} bytes, found ${existing.length} bytes`)
  return 1
}

function cli(argv) {
  rejectRepeatedOptions(argv)
  const options = parseArgs(argv, {
    initial: { version: null, since: null, output: null, check: null, root: null, help: false },
    values: {
      '--version': 'version',
      '--since': 'since',
      '--output': 'output',
      '--out': 'output',
      '--check': 'check',
      '--root': 'root',
    },
    flags: { '--help': 'help', '-h': 'help' },
  })
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (options.output && options.check) {
    throw usageError('--output and --check are mutually exclusive')
  }

  const root = path.resolve(options.root ?? process.cwd())
  const changelogPath = path.join(root, 'CHANGELOG.md')
  let changelog
  try {
    changelog = fs.readFileSync(changelogPath, 'utf8')
  } catch (error) {
    console.error(`release-notes: cannot read ${changelogPath}: ${error?.message ?? error}`)
    return 2
  }

  let result
  try {
    // Render and validate entirely in memory. The tag check and the stub guard
    // run before --output creates/truncates a file or --check compares one.
    const version = options.version ?? defaultVersion(root)
    result = generateReleaseNotes({ changelog, version, since: options.since })
    requireExistingTag(root, result.since)
    assertUsableNotes(result.text, result.version)
  } catch (error) {
    // UsageError messages already name the offending flag; file/data errors are
    // reported with the same prefix and exit 2 (never a partial Release).
    console.error(`release-notes: ${error?.message ?? error}`)
    if (error?.showUsage) console.error(USAGE)
    return 2
  }

  if (options.check) return compareWithFile(path.resolve(options.check), result)
  if (options.output) {
    const outputPath = path.resolve(options.output)
    fs.writeFileSync(outputPath, result.text, 'utf8')
    console.log(
      `release-notes: wrote ${outputPath} (${result.versions.length} section(s): ${result.versions.join(', ')})`,
    )
    return 0
  }
  process.stdout.write(result.text)
  return 0
}

await runMain(import.meta.url, () => cli(process.argv.slice(2)), { errorPrefix: 'release-notes', usage: USAGE })
