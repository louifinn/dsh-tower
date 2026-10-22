#!/usr/bin/env node
// Release gate (#97, #76): a tag is a claim, so make it cost evidence.
//
// The gate compares three facts on every run:
//
//   1. `package.json` version vs the previous reachable tag,
//   2. whether the CHANGELOG carries release content (a non-empty Unreleased
//      section, or a non-empty section whose heading names the version),
//   3. on a tag push, that the pushed tag is exactly `v<version>`.
//
// It always prints `git describe`, the previous tag, the commit count since
// that tag and whether Unreleased is non-empty, so a large backlog is visible
// before an audit finds it. On a PR/branch push findings are warnings (exit 0);
// on a tag push a contradiction is an error (exit 1).
//
// Tag-push pitfall: `git describe --tags --abbrev=0` returns the *pushed* tag
// itself, so the previous tag is resolved from `<tag>^` (falling back to the
// newest version tag that is an ancestor).
//
// Usage:
//   node scripts/release-check.mjs [--mode pr|tag] [--tag <name>]
//                                  [--root <dir>] [--package <file>]
//                                  [--changelog <file>] [--json]
//
// On CI the mode comes from GITHUB_REF_TYPE (`tag` on a tag push) and the tag
// name from GITHUB_REF_NAME. Locally, verify before tagging with
// `npm run release:check -- --mode tag --tag v<version>`.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compareVersions } from '../lib/compatibility.js'

const USAGE = `usage: node scripts/release-check.mjs [--mode pr|tag] [--tag <name>]
                                      [--root <dir>] [--package <file>]
                                      [--changelog <file>] [--json] [--help]

  --mode       "pr" warns only (default); "tag" fails on a contradiction
  --tag        pushed tag name (default: GITHUB_REF_NAME in tag mode)
  --root       Git work tree to inspect (default: current directory)
  --package    package.json to read (default: <root>/package.json)
  --changelog  CHANGELOG.md to read (default: <root>/CHANGELOG.md)
  --json       print the facts and findings as JSON
  --help       print this text`

const VERSION_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

class UsageError extends Error {}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function trimSection(lines) {
  return lines.join('\n').trim()
}

function sectionBody(text, headingMatches) {
  const lines = String(text ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => /^##\s+/.test(line) && headingMatches(line))
  if (start < 0) return null
  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) break
    body.push(lines[index])
  }
  return trimSection(body)
}

export function unreleasedSection(changelog) {
  return sectionBody(changelog, (line) => /unreleased|未发布/i.test(line))
}

export function versionSection(changelog, version) {
  if (!version) return null
  const pattern = new RegExp(`(?:^|[^0-9A-Za-z.-])${escapeRegExp(version)}(?![0-9A-Za-z.-])`)
  return sectionBody(changelog, (line) => pattern.test(line.replace(/^##\s+/, '')))
}

// A section that only holds an HTML comment or a horizontal rule is a
// placeholder, not release notes.
export function hasContent(text) {
  if (text === null || text === undefined) return false
  const cleaned = String(text)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .trim()
  return cleaned.length > 0
}

export function evaluateRelease(input = {}) {
  const version = String(input.version ?? '').trim()
  if (!version) throw new UsageError('package.json has no version')
  const mode = input.mode ?? 'pr'
  if (mode !== 'pr' && mode !== 'tag') throw new UsageError(`--mode must be "pr" or "tag", not ${JSON.stringify(mode)}`)
  const tag = input.tag ? String(input.tag) : null
  const previousTag = input.previousTag ? String(input.previousTag) : null
  const changelog = input.changelog ?? ''
  const commitsSince = Number.isFinite(input.commitsSince) ? input.commitsSince : null
  const describe = input.describe ?? null
  const isTag = mode === 'tag'
  const level = isTag ? 'error' : 'warning'
  const suffix = isTag ? '' : ' (warning only outside a tag push)'
  const count = commitsSince === null ? 'unknown' : String(commitsSince)

  const unreleasedText = unreleasedSection(changelog)
  const unreleased = hasContent(unreleasedText)
  const versionNotes = versionSection(changelog, version)
  const notes = unreleased ? 'unreleased' : hasContent(versionNotes) ? 'version-section' : 'none'
  const previousVersion = previousTag ? previousTag.replace(/^v/i, '') : null
  const findings = []
  const record = (code, findingLevel, message) => findings.push({ code, level: findingLevel, message })

  if (!previousTag) {
    record('no-baseline', 'warning', `no reachable previous tag; cannot compare version ${version} against a release${suffix}`)
  } else {
    const direction = compareVersions(version, previousVersion)
    // An unparseable version pair is treated as "did not move": publishing a
    // version the release math cannot reason about is not evidence.
    if (direction === null || direction <= 0) {
      const relation = direction === 0 || direction === null ? 'equals' : 'is older than'
      record(
        'version-not-bumped',
        level,
        `version did not move: package.json ${version} ${relation} the previous tag ${previousTag}; ` +
          `${count} commits since that tag; Unreleased is ${unreleased ? 'non-empty' : 'empty'}${suffix}`,
      )
    }
  }
  if (notes === 'none') {
    record(
      'no-release-notes',
      level,
      `CHANGELOG has no release notes for ${version}: the Unreleased section is empty and there is ` +
        `no non-empty "## ${version}（…）" section${suffix}`,
    )
  }

  if (isTag) {
    if (!tag) {
      record('tag-missing', 'error', 'tag push mode needs the tag name (GITHUB_REF_NAME or --tag)')
    } else if (tag !== `v${version}`) {
      record('tag-name-mismatch', 'error', `tag ${tag} does not match package version ${version}; expected v${version}`)
    }
  }

  const errors = findings.filter((finding) => finding.level === 'error').length
  const warnings = findings.filter((finding) => finding.level === 'warning').length
  return {
    ok: errors === 0,
    mode,
    findings,
    errors,
    warnings,
    facts: { version, mode, tag, previousTag, previousVersion, commitsSince, describe, unreleased, notes },
  }
}

// --- Git facts ---------------------------------------------------------------

function runGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error || result.status !== 0) return null
  return (result.stdout ?? '').trim()
}

function versionTags(root) {
  const output = runGit(root, ['tag', '--list'])
  if (!output) return []
  return output.split('\n').map((line) => line.trim()).filter((tag) => VERSION_TAG.test(tag))
}

function newestAncestorTag(root, revision, exclude) {
  const tags = versionTags(root).filter((tag) => tag !== exclude && runGit(root, ['merge-base', '--is-ancestor', tag, revision]) !== null)
  tags.sort((left, right) => (compareVersions(right, left) ?? 0))
  return tags[0] ?? null
}

// The latest reachable *version* tag. `git describe` happily reports any tag
// near HEAD, so a maintenance tag (`ui-0.2.2`) must be filtered out here or the
// release math compares a version against a non-version string.
function describeVersionTag(root, revision) {
  const described = runGit(root, ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', revision])
  return described && VERSION_TAG.test(described) ? described : null
}

export function resolvePreviousTag(root, tag) {
  const tagExists = tag ? runGit(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]) !== null : false
  const revision = tag && tagExists ? tag : 'HEAD'
  // Never compare against the pushed tag itself: it is the release, not its
  // predecessor. `<tag>^` is the commit that was HEAD before the tag existed.
  if (tagExists) {
    const parent = describeVersionTag(root, `${tag}^`)
    if (parent && parent !== tag) return parent
  }
  const described = describeVersionTag(root, revision)
  if (described && described !== tag) return described
  return newestAncestorTag(root, revision, tag)
}

export function collectFacts(root, options = {}) {
  if (runGit(root, ['rev-parse', '--git-dir']) === null) {
    throw new UsageError(`${root} is not a Git repository; the release gate compares the version against tags`)
  }
  const previousTag = options.previousTag ?? resolvePreviousTag(root, options.tag ?? null)
  const commitsSince = previousTag ? Number(runGit(root, ['rev-list', '--count', `${previousTag}..HEAD`])) : null
  const describe = runGit(root, ['describe', '--tags', '--always'])
  return {
    previousTag,
    commitsSince: Number.isFinite(commitsSince) ? commitsSince : null,
    describe: describe ?? null,
  }
}

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const options = { mode: null, tag: null, root: process.cwd(), packagePath: null, changelogPath: null, json: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${arg} needs a value`)
      index += 1
      return next
    }
    switch (arg) {
      case '--mode':
        options.mode = value()
        break
      case '--tag':
        options.tag = value()
        break
      case '--root':
        options.root = path.resolve(value())
        break
      case '--package':
        options.packagePath = path.resolve(value())
        break
      case '--changelog':
        options.changelogPath = path.resolve(value())
        break
      case '--json':
        options.json = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(arg)}`)
    }
  }
  return options
}

function printFacts(facts) {
  const dash = (value) => (value === null || value === undefined || value === '' ? '-' : value)
  console.log(
    `release-check: version=${facts.version} mode=${facts.mode} tag=${dash(facts.tag)} ` +
      `previous-tag=${dash(facts.previousTag)} commits-since=${dash(facts.commitsSince)} ` +
      `describe=${dash(facts.describe)} unreleased=${facts.unreleased ? 'yes' : 'no'} notes=${facts.notes}`,
  )
}

function cli(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`release-check: ${error.message}`)
    console.error(USAGE)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const mode = options.mode ?? (process.env.GITHUB_REF_TYPE === 'tag' ? 'tag' : 'pr')
  let tag = options.tag
  if (!tag && mode === 'tag' && process.env.GITHUB_REF_TYPE === 'tag') tag = process.env.GITHUB_REF_NAME || null

  const packagePath = options.packagePath ?? path.join(options.root, 'package.json')
  const changelogPath = options.changelogPath ?? path.join(options.root, 'CHANGELOG.md')
  let version
  try {
    version = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version
  } catch (error) {
    console.error(`release-check: cannot read ${packagePath}: ${error?.message ?? error}`)
    return 2
  }
  let changelog
  try {
    changelog = fs.readFileSync(changelogPath, 'utf8')
  } catch (error) {
    console.error(`release-check: cannot read ${changelogPath}: ${error?.message ?? error}`)
    return 2
  }

  let result
  try {
    const gitFacts = collectFacts(options.root, { tag })
    result = evaluateRelease({ version, mode, tag, changelog, ...gitFacts })
  } catch (error) {
    console.error(`release-check: ${error.message}`)
    return 2
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          root: options.root,
          package: packagePath,
          changelog: changelogPath,
          ...result,
        },
        null,
        2,
      ),
    )
    return result.ok ? 0 : 1
  }

  printFacts(result.facts)
  for (const finding of result.findings) console.log(`${finding.level} [${finding.code}] ${finding.message}`)
  if (result.ok) {
    console.log(
      result.warnings > 0
        ? `release-check: ok (${result.warnings} warning(s), no tag blocking this run)`
        : 'release-check: ok',
    )
  } else {
    console.log(`release-check: ${result.errors} error(s), ${result.warnings} warning(s); refusing the release claim`)
  }
  return result.ok ? 0 : 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exitCode = cli(process.argv.slice(2))
