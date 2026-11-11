#!/usr/bin/env node
// Release gate (#97, #76, #M74): a tag is a claim, so make it cost evidence.
//
// Three modes:
//
//   pr          — compare the version, the previous tag and the CHANGELOG on
//                 every push/PR; a contradiction is a warning (exit 0).
//   tag         — a pushed tag must be provable: an annotated tag object that is
//                 in HEAD's history, a clean tree, package/version/tag agreement,
//                 a non-empty CHANGELOG section for the version, and the support
//                 manifest in agreement with its restatements. Any miss is an
//                 error (exit 1).
//   prepublish  — the same release checks before `npm publish`, where the tag may
//                 not exist yet (the documented order is publish, then tag). An
//                 existing `v<version>` tag must be annotated and in HEAD's
//                 history, no *other* version tag may point at HEAD, and the tree
//                 must be clean.
//
// Every run prints `git describe`, the previous tag, the commit count since that
// tag, the tag object type, whether it is reachable from HEAD and whether the
// tree is clean, so a large backlog or a lightweight tag is visible before an
// audit finds it.
//
// Tag-push pitfall: `git describe --tags --abbrev=0` returns the *pushed* tag
// itself (and otherwise the nearest tag of any shape), so the previous tag is
// resolved from `<tag>^` and filtered to `v<semver>` (falling back to the newest
// version tag that is an ancestor).
//
// `npm publish` runs this in prepublish mode through `prepublishOnly` (see
// `npm run release:prepublish`), so the local publish path is the same gate as
// the tag push. The support comparison imports ./check-support.mjs dynamically:
// package.json `files` ships scripts/ but excludes check-support.mjs and
// support.json, and the published copy must still start (in pr mode the import
// never runs; in the release modes it fails closed with `support-unavailable`).
//
// Usage:
//   node scripts/release-check.mjs [--mode pr|tag|prepublish] [--tag <name>] [--json]
//
// On CI the mode comes from GITHUB_REF_TYPE (`tag` on a tag push) and the tag
// name from GITHUB_REF_NAME. Locally, verify a tagged release claim with
// `node scripts/release-check.mjs --mode tag --tag v<version>` on a clean commit
// (invoke it directly: the npm PowerShell shim does not forward `--` flags
// reliably), and verify the publish path with `npm run release:prepublish`.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { compareVersions } from '../host/compatibility.js'
import { findingRecorder, parseArgs, runMain, UsageError } from './lib/cli.mjs'

const USAGE = `usage: node scripts/release-check.mjs [--mode pr|tag|prepublish] [--tag <name>] [--json] [--help]

  --mode       "pr" warns only (default); "tag" and "prepublish" fail closed
  --tag        released tag name (default: GITHUB_REF_NAME in tag mode, v<version>
               in prepublish mode)
  --json       print the facts and findings as JSON
  --help       print this text`

const VERSION_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

// A version is stored without its tag prefix; a tag is `v` + that version. The
// release gate talks about both, so the conversion lives in one place.
function versionTag(version) {
  return `v${stripTag(version)}`
}

function stripTag(tag) {
  return String(tag).replace(/^v/i, '')
}

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

// `undefined` means "the caller did not inspect the repository" (the pure
// comparator in tests); `null` means "inspected, and the fact does not exist"
// (the CLI). The CLI always supplies the facts, so a release claim cannot pass
// by omission — only by proving each one.
export function evaluateRelease(input = {}) {
  const version = String(input.version ?? '').trim()
  if (!version) throw new UsageError('package.json has no version')
  const mode = input.mode ?? 'pr'
  if (mode !== 'pr' && mode !== 'tag' && mode !== 'prepublish') {
    throw new UsageError(`--mode must be "pr", "tag" or "prepublish", not ${JSON.stringify(mode)}`)
  }
  const strict = mode !== 'pr'
  const tag = input.tag ? String(input.tag) : null
  const expectedTag = versionTag(version)
  const previousTag = input.previousTag ? String(input.previousTag) : null
  const changelog = input.changelog ?? ''
  const commitsSince = Number.isFinite(input.commitsSince) ? input.commitsSince : null
  const describe = input.describe ?? null
  const tagKind = input.tagKind === undefined ? undefined : input.tagKind
  const tagReachable = input.tagReachable === undefined ? undefined : input.tagReachable
  const dirty = Array.isArray(input.dirty) ? input.dirty : undefined
  const headTags = Array.isArray(input.headTags) ? input.headTags : undefined
  const support = input.support === undefined ? undefined : input.support
  const level = strict ? 'error' : 'warning'
  const suffix = strict ? '' : ' (warning only outside a release claim)'
  const count = commitsSince === null ? 'unknown' : String(commitsSince)

  const unreleasedText = unreleasedSection(changelog)
  const unreleased = hasContent(unreleasedText)
  const versionNotes = versionSection(changelog, version)
  const versionHasNotes = hasContent(versionNotes)
  const notesKind = versionHasNotes ? 'version-section' : unreleased ? 'unreleased' : 'none'
  const previousVersion = previousTag ? stripTag(previousTag) : null
  const findings = []
  const record = findingRecorder(findings)

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

  // A release claim must file its notes under the version being released. On a
  // PR the "bump first, rename later" window is allowed (no finding); outside a
  // PR, a non-empty Unreleased section is *not* a substitute for the version
  // heading, because the GitHub Release body is extracted by version.
  if (!versionHasNotes) {
    if (unreleased) {
      if (strict) {
        record(
          'no-version-notes',
          'error',
          `CHANGELOG has no non-empty "## ${version}（…）" heading: the Unreleased section is ` +
            'non-empty, but a release claim needs the notes under the version being released',
        )
      }
    } else {
      record(
        'no-release-notes',
        level,
        `CHANGELOG has no release notes for ${version}: the Unreleased section is empty and there is ` +
          `no non-empty "## ${version}（…）" section${suffix}`,
      )
    }
  }

  if (mode === 'tag') {
    if (!tag) {
      record('tag-missing', 'error', 'tag push mode needs the tag name (GITHUB_REF_NAME or --tag)')
    } else {
      if (tag !== expectedTag) {
        record(
          'tag-name-mismatch',
          'error',
          `tag ${tag} does not match package version ${version}; expected ${expectedTag}`,
        )
      }
      if (tagKind !== undefined) {
        if (tagKind === null) {
          record(
            'tag-not-found',
            'error',
            `no refs/tags/${tag} in this checkout; fetch tags (git fetch --tags) before claiming a ` +
              'released tag',
          )
        } else {
          if (tagKind !== 'tag') {
            record(
              'tag-lightweight',
              'error',
              `refs/tags/${tag} is a ${tagKind}, not an annotated tag object; create it with ` +
                `git tag -a ${tag} -m "dsh-tower ${version}"`,
            )
          }
          if (tagReachable === false) {
            record(
              'tag-unreachable',
              'error',
              `tag ${tag} is not in HEAD's history; a release tag must name a commit that HEAD contains`,
            )
          }
        }
      }
    }
  }

  if (mode === 'prepublish') {
    if (tag && tag !== expectedTag) {
      record(
        'tag-name-mismatch',
        'error',
        `tag ${tag} does not match package version ${version}; expected ${expectedTag}`,
      )
    }
    if (tagKind !== undefined && tagKind !== null) {
      if (tagKind !== 'tag') {
        record(
          'tag-lightweight',
          'error',
          `refs/tags/${expectedTag} exists but is a ${tagKind}, not an annotated tag object; ` +
            `delete it and recreate it with git tag -a ${expectedTag} -m "dsh-tower ${version}"`,
        )
      } else if (tagReachable === false) {
        record(
          'tag-unreachable',
          'error',
          `tag ${expectedTag} is not in HEAD's history; publish the tagged commit or delete the stale tag`,
        )
      }
    }
    if (headTags !== undefined) {
      const conflicting = headTags.filter((name) => VERSION_TAG.test(name) && name !== expectedTag)
      if (conflicting.length > 0) {
        record(
          'tag-name-mismatch',
          'error',
          `HEAD is tagged ${conflicting.join(', ')}, but package.json says ${version}; a publish from ` +
            `this commit would contradict the existing tag (expected ${expectedTag})`,
        )
      }
    }
  }

  if (strict && dirty !== undefined && dirty.length > 0) {
    const shown = dirty.slice(0, 5).join(', ')
    record(
      'dirty-worktree',
      'error',
      `working tree is not clean: ${dirty.length} path(s) differ (${shown}${dirty.length > 5 ? ', …' : ''}); ` +
        'commit or stash them so the release claim names a commit',
    )
  }

  if (strict && support !== undefined) {
    if (!support || typeof support !== 'object' || support.unavailable === true) {
      const detail = support && Array.isArray(support.problems) && support.problems.length > 0
        ? support.problems.join('; ')
        : 'the support manifest could not be evaluated; run npm run support:check'
      record('support-unavailable', 'error', detail)
    } else if (support.ok !== true) {
      const problems = Array.isArray(support.problems) && support.problems.length > 0
        ? support.problems
        : ['the support check reported no problem text, which is not evidence of agreement']
      record(
        'support-drift',
        'error',
        `the support manifest disagrees with its restatements: ${problems.join('; ')}`,
      )
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
    facts: {
      version,
      mode,
      tag,
      expectedTag,
      tagKind: tagKind === undefined ? null : tagKind,
      tagReachable: tagReachable === undefined ? null : tagReachable,
      previousTag,
      previousVersion,
      commitsSince,
      describe,
      unreleased,
      versionNotes: versionHasNotes,
      notesKind,
      headTags: headTags === undefined ? null : headTags,
      dirty: dirty === undefined ? null : dirty,
      support: support === undefined ? null : support,
    },
  }
}

// --- Git facts ---------------------------------------------------------------

function gitProcess(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' })
}

function runGit(root, args) {
  const result = gitProcess(root, args)
  if (result.error || result.status !== 0) return null
  return (result.stdout ?? '').trim()
}

function gitExit(root, args) {
  const result = gitProcess(root, args)
  return result.error ? null : result.status
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

// `git cat-file -t` names the object a ref resolves to: `tag` for an annotated
// tag, `commit` for a lightweight tag (which silently shares its name with the
// commit). A missing ref is null, which the caller must treat as a finding.
function tagObjectType(root, tag) {
  if (!tag) return null
  const output = runGit(root, ['cat-file', '-t', `refs/tags/${tag}`])
  return output || null
}

// True when the tag's commit is contained in HEAD's history. `merge-base
// --is-ancestor` exits 1 for "not an ancestor" and non-zero for a broken ref; an
// unprovable ancestry is not a pass.
function tagInHistory(root, tag) {
  if (!tag) return null
  if (runGit(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]) === null) return null
  return gitExit(root, ['merge-base', '--is-ancestor', `refs/tags/${tag}`, 'HEAD']) === 0
}

// Paths `git status --porcelain` reports, in file order. Untracked files count:
// `npm publish` packs the working tree, not the commit.
function dirtyPaths(root) {
  const status = gitProcess(root, ['status', '--porcelain'])
  if (status.error || status.status !== 0) return null
  // Keep the two status columns: trimming a line would eat the leading space of
  // ` D path` and shift the path one character to the left.
  return (status.stdout ?? '')
    .split(/\r?\n/)
    .filter((line) => line.length > 3)
    .map((line) => {
      const renamed = line.indexOf(' -> ')
      return renamed === -1 ? line.slice(3) : line.slice(3, renamed)
    })
}

function tagsAtHead(root) {
  const output = runGit(root, ['tag', '--points-at', 'HEAD'])
  if (!output) return []
  return output.split('\n').map((line) => line.trim()).filter(Boolean)
}

export function collectFacts(root, options = {}) {
  if (runGit(root, ['rev-parse', '--git-dir']) === null) {
    throw new UsageError(`${root} is not a Git repository; the release gate compares the version against tags`)
  }
  const tag = options.tag ?? null
  const previousTag = options.previousTag ?? resolvePreviousTag(root, tag)
  const commitsSince = previousTag ? Number(runGit(root, ['rev-list', '--count', `${previousTag}..HEAD`])) : null
  const describe = runGit(root, ['describe', '--tags', '--always'])
  return {
    previousTag,
    commitsSince: Number.isFinite(commitsSince) ? commitsSince : null,
    describe: describe ?? null,
    tagKind: tagObjectType(root, tag),
    tagReachable: tagInHistory(root, tag),
    dirty: dirtyPaths(root),
    headTags: tagsAtHead(root),
  }
}

// The support manifest is repository-only (package.json `files` excludes
// check-support.mjs and support.json), so the import stays lazy: the published
// copy starts and reports `support-unavailable` from a release mode instead of
// crashing before it can explain itself.
async function collectSupport(root) {
  try {
    const { evaluateSupport, readSupportInputs } = await import('./check-support.mjs')
    const result = evaluateSupport(readSupportInputs(root))
    return { ok: result.ok, problems: result.problems, facts: result.facts }
  } catch (error) {
    return {
      ok: false,
      unavailable: true,
      problems: [`the support manifest cannot be evaluated (${error?.message ?? error}); run npm run support:check`],
      facts: null,
    }
  }
}

// --- CLI ---------------------------------------------------------------------

function printFacts(facts) {
  const dash = (value) => (value === null || value === undefined || value === '' ? '-' : value)
  const reachable = facts.tagReachable === null ? '-' : facts.tagReachable ? 'yes' : 'no'
  const worktree = facts.dirty === null ? '-' : facts.dirty.length === 0 ? 'clean' : `${facts.dirty.length}-dirty`
  console.log(
    `release-check: version=${facts.version} mode=${facts.mode} tag=${dash(facts.tag)} ` +
      `previous-tag=${dash(facts.previousTag)} commits-since=${dash(facts.commitsSince)} ` +
      `describe=${dash(facts.describe)} unreleased=${facts.unreleased ? 'yes' : 'no'} notes=${facts.notesKind} ` +
      `tag-type=${dash(facts.tagKind)} reachable=${reachable} worktree=${worktree}`,
  )
}

async function cli(argv) {
  const options = parseArgs(argv, {
    initial: { mode: null, tag: null, json: false, help: false },
    values: { '--mode': 'mode', '--tag': 'tag' },
    flags: { '--json': 'json', '--help': 'help', '-h': 'help' },
  })
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const mode = options.mode ?? (process.env.GITHUB_REF_TYPE === 'tag' ? 'tag' : 'pr')
  let claimedTag = options.tag
  if (!claimedTag && mode === 'tag' && process.env.GITHUB_REF_TYPE === 'tag') claimedTag = process.env.GITHUB_REF_NAME || null

  const root = process.cwd()
  const packagePath = path.join(root, 'package.json')
  const changelogPath = path.join(root, 'CHANGELOG.md')
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

  const expectedTag = versionTag(String(version ?? ''))
  // tag mode guards the pushed tag; prepublish guards the tag the version will
  // create, which may legitimately not exist yet.
  const tag = mode === 'prepublish' ? claimedTag ?? expectedTag : claimedTag ?? null
  const refUnderTest = mode === 'prepublish' ? expectedTag : tag

  let result
  try {
    const gitFacts = collectFacts(root, { tag: refUnderTest })
    const support = mode === 'pr' ? undefined : await collectSupport(root)
    result = evaluateRelease({ version, mode, tag, changelog, ...gitFacts, support })
  } catch (error) {
    console.error(`release-check: ${error.message}`)
    return 2
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          root,
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

await runMain(import.meta.url, () => cli(process.argv.slice(2)), { errorPrefix: 'release-check', usage: USAGE })
