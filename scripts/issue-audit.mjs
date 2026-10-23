#!/usr/bin/env node
// Offline tracker audit (#96, #79): every closed P0/P1 must point at evidence.
//
// A closure is checkable when its closing comment carries the two-line contract:
//
//   verified-by: tests/<file>.test.mjs
//   commit: <sha>
//
// This script reads a *local tracker export* (no network, no credentials), finds
// every closed P0/P1, and requires `verified-by:` to name a test file that exists
// in the repository. A missing, nonexistent, non-test or repository-escaping
// pointer exits non-zero, so "closed" stops being an assertion by the author.
//
// Usage:
//   node scripts/issue-audit.mjs [--tracker <file>] [--root <dir>]
//                                [--since <YYYY-MM-DD>] [--strict] [--json]
//
// CONTRIBUTING.md ("Commits, closures and evidence") documents the export
// command and the rule; `npm run audit:issues` is the short form.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findingRecorder, parseArgs, runMain, UsageError } from './lib/cli.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_TRACKER = path.join('tracker', 'issues.json')
const TEST_PATTERN = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/
const USAGE = `usage: node scripts/issue-audit.mjs [--tracker <file>] [--root <dir>] [--since <YYYY-MM-DD>] [--strict] [--json]

  --tracker  local tracker export (default: tracker/issues.json)
  --root     repository the verified-by paths resolve against (default: this package)
  --since    only audit issues closed on or after this UTC date
  --strict   treat a missing "commit:" field as an error
  --json     print the report as JSON
  --help     print this text

The export is {"issues": [...]} or a bare array; each issue needs number, title,
state (or closedAt), labels, body and comments. Produce it once with gh (see
CONTRIBUTING.md); the audit itself never touches the network.`

// `verified-by:` / `commit:` are line fields, not prose. Backticks, a leading
// bullet or blockquote, and Windows path separators are tolerated because the
// contract is about the pointer, not the formatting.
function cleanValue(value) {
  return String(value)
    .trim()
    .replace(/^`+|`+$/g, '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim()
}

export function extractFields(text) {
  const fields = { verifiedBy: [], commit: null }
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(?:[-*+]\s+|>\s*)+/, '')
    const match = /^(verified-by|commit)\s*:\s*(.+)$/i.exec(line)
    if (!match) continue
    const value = cleanValue(match[2])
    if (!value) continue
    if (match[1].toLowerCase() === 'verified-by') fields.verifiedBy.push(value)
    else fields.commit = value
  }
  return fields
}

function textSources(issue) {
  const sources = []
  if (typeof issue.body === 'string' && issue.body.trim()) sources.push(issue.body)
  const comments = Array.isArray(issue.comments) ? issue.comments : []
  for (const comment of comments) {
    const body = typeof comment === 'string' ? comment : comment?.body
    if (typeof body === 'string' && body.trim()) sources.push(body)
  }
  return sources
}

// The newest text that carries a `verified-by:` line is the closure evidence;
// an older comment cannot keep an issue closed after an edit. Every verified-by
// line in that text is checked, so listing two tests cannot hide one gap.
export function selectEvidence(issue) {
  const sources = textSources(issue)
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    const fields = extractFields(sources[index])
    if (fields.verifiedBy.length > 0) return fields
  }
  return null
}

export function labelsOf(issue) {
  const labels = Array.isArray(issue.labels) ? issue.labels : []
  return labels.map((label) => (typeof label === 'string' ? label : label?.name ?? '')).filter(Boolean)
}

export function priorityOf(issue) {
  const labels = labelsOf(issue).map((label) => label.toUpperCase())
  if (labels.includes('P0')) return 'P0'
  if (labels.includes('P1')) return 'P1'
  // The historical record uses `[P0]`/`[P1]` title prefixes; a label that was
  // never backfilled must not make a critical closure invisible to the audit.
  const match = /(?:^|\s)\[(P[01])\]/i.exec(String(issue.title ?? ''))
  return match ? match[1].toUpperCase() : null
}

export function isClosed(issue) {
  const state = String(issue.state ?? '').toLowerCase()
  return state === 'closed' || Boolean(issue.closedAt ?? issue.closed_at)
}

function closedAtOf(issue) {
  const raw = issue.closedAt ?? issue.closed_at
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

// A pointer must stay inside the repository and name a real test file: an
// existing script or doc is not evidence of a regression test.
export function inspectPointer(pointer, root) {
  const normalized = String(pointer).replace(/\\/g, '/').trim()
  if (!normalized) return { code: 'invalid-pointer', detail: 'empty' }
  if (path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')) {
    return { code: 'invalid-pointer', detail: 'must be repository-relative' }
  }
  const resolved = path.resolve(root, normalized)
  const relative = path.relative(root, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { code: 'invalid-pointer', detail: 'escapes the repository' }
  }
  if (!fs.existsSync(resolved)) return { code: 'missing-test', detail: 'does not exist' }
  if (!fs.statSync(resolved).isFile()) return { code: 'missing-test', detail: 'is not a file' }
  const isTest = normalized.startsWith('tests/') || TEST_PATTERN.test(normalized)
  if (!isTest) return { code: 'not-a-test', detail: 'not under tests/ and not named *.test.* / *.spec.*' }
  return null
}

export function parseTracker(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`tracker export is not valid JSON: ${error?.message ?? error}`)
  }
  const issues = Array.isArray(parsed) ? parsed : parsed?.issues
  if (!Array.isArray(issues)) throw new Error('tracker export must be an array of issues or { "issues": [...] }')
  for (const issue of issues) {
    if (!issue || typeof issue !== 'object' || typeof issue.number !== 'number') {
      throw new Error('tracker export must be an array of issues or { "issues": [...] }: every issue needs a numeric number')
    }
  }
  return issues
}

export function auditIssues(issues, options = {}) {
  const root = path.resolve(options.root ?? PACKAGE_ROOT)
  const strict = Boolean(options.strict)
  let since = null
  if (options.since) {
    since = new Date(`${String(options.since).slice(0, 10)}T00:00:00.000Z`)
    if (Number.isNaN(since.getTime())) throw new UsageError(`--since is not a date: ${options.since}`)
  }
  const findings = []
  let checked = 0
  for (const issue of issues) {
    if (!isClosed(issue)) continue
    const priority = priorityOf(issue)
    if (!priority) continue
    const closedAt = closedAtOf(issue)
    if (since && closedAt && closedAt < since) continue
    checked += 1
    const label = `#${issue.number} ${String(issue.title ?? '').trim()}`
    const record = findingRecorder(findings, { number: issue.number, title: issue.title, priority })

    const fields = selectEvidence(issue)
    if (!fields) {
      record('missing-evidence', 'error', `${label}: no verified-by: field in the body or comments`)
      continue
    }
    for (const pointer of fields.verifiedBy) {
      const problem = inspectPointer(pointer, root)
      if (!problem) continue
      if (problem.code === 'missing-test') {
        record('missing-test', 'error', `${label}: verified-by names a missing test file: ${pointer}`)
      } else if (problem.code === 'not-a-test') {
        record('not-a-test', 'error', `${label}: verified-by is not a test file: ${pointer} (${problem.detail})`)
      } else {
        record('invalid-pointer', 'error', `${label}: verified-by must be a repository-relative path: ${pointer} (${problem.detail})`)
      }
    }
    if (!fields.commit) {
      record('missing-commit', strict ? 'error' : 'warning', `${label}: no commit: <sha> field (warning; --strict fails)`)
    }
  }
  const errors = findings.filter((finding) => finding.level === 'error')
  const warnings = findings.filter((finding) => finding.level === 'warning')
  return {
    ok: errors.length === 0,
    checked,
    findings,
    errors: errors.length,
    warnings: warnings.length,
    strict,
    since: options.since ?? null,
  }
}

function parseOptions(argv) {
  return parseArgs(argv, {
    initial: { tracker: null, root: PACKAGE_ROOT, since: null, strict: false, json: false, help: false },
    values: {
      '--tracker': 'tracker',
      '--root': { key: 'root', parse: path.resolve },
      '--since': 'since',
    },
    flags: { '--strict': 'strict', '--json': 'json', '--help': 'help', '-h': 'help' },
  })
}

function cli(argv) {
  const options = parseOptions(argv)
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const tracker = options.tracker ? path.resolve(process.cwd(), options.tracker) : path.join(PACKAGE_ROOT, DEFAULT_TRACKER)
  let text
  try {
    text = fs.readFileSync(tracker, 'utf8')
  } catch (error) {
    console.error(`issue-audit: cannot read tracker export ${tracker}: ${error?.message ?? error}`)
    console.error('issue-audit: produce one with the gh command in CONTRIBUTING.md ("Commits, closures and evidence")')
    return 2
  }
  let issues
  let result
  try {
    issues = parseTracker(text)
    result = auditIssues(issues, { root: options.root, since: options.since, strict: options.strict })
  } catch (error) {
    console.error(`issue-audit: ${error.message}`)
    return 2
  }

  if (options.json) {
    console.log(JSON.stringify({ tracker, root: path.resolve(options.root), ...result }, null, 2))
    return result.ok ? 0 : 1
  }
  console.log(`issue-audit: ${tracker}`)
  console.log(`issue-audit: ${result.checked} closed P0/P1 checked, ${result.errors} errors, ${result.warnings} warnings`)
  for (const finding of result.findings) console.log(`${finding.level} [${finding.code}] ${finding.message}`)
  if (result.ok) {
    console.log('issue-audit: every checked closure names an existing test file')
  } else {
    console.log(`issue-audit: ${result.errors} closure(s) are not verifiable; see CONTRIBUTING.md`)
  }
  return result.ok ? 0 : 1
}

await runMain(import.meta.url, () => cli(process.argv.slice(2)), { errorPrefix: 'issue-audit', usage: USAGE })
