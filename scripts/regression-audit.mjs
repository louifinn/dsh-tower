#!/usr/bin/env node
// Regression closure audit (#85): a closed `regression` issue must name a
// `Regression test:` path that exists.
//
// A regression is "worked in a released version, then stopped". The project's
// own closure standard is a pointer, not prose: the incident template
// (docs/operations/incident.md) carries six fields and the regression test path
// is the one that can be checked. This script reads a local tracker export, the
// same format as `npm run audit:issues`, so it never touches the network:
//
//   { "issues": [ { number, title, state, labels, closedAt, body, comments } ] }
//
// Usage:
//   node scripts/regression-audit.mjs [--tracker <file>] [--root <dir>] [--json]
//
// Exit codes: 0 all checked regressions point at an existing test; 1 at least
// one is missing or points at a nonexistent/non-test path; 2 the export is
// missing or malformed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectPointer, isClosed, labelsOf, parseTracker } from './issue-audit.mjs'
import { findingRecorder, parseArgs, runMain } from './lib/cli.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_TRACKER = path.join('tracker', 'issues.json')
const USAGE = `usage: node scripts/regression-audit.mjs [--tracker <file>] [--root <dir>] [--json]

  --tracker  local tracker export (default: tracker/issues.json)
  --root     repository the Regression test paths resolve against (default: this package)
  --json     print the report as JSON
  --help     print this text

A regression issue is closed when state is closed (or closedAt is set) and its
labels include "regression". Its body or newest comment must carry:

  Regression test: tests/<file>.test.mjs

The path must exist under --root and must be a test file. Produce the export once
with gh (see CONTRIBUTING.md, "Regressions and incidents"); the audit itself is
offline.`

function cleanValue(value) {
  return String(value)
    .trim()
    .replace(/^`+|`+$/g, '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim()
}

/**
 * The newest text (body first, then comments oldest to newest) that carries a
 * `Regression test:` line is the closure evidence. Returns `{ pointer }` or
 * `{ error: 'missing' }`.
 * @param {any} issue
 */
export function selectRegressionField(issue) {
  const sources = []
  if (typeof issue.body === 'string' && issue.body.trim()) sources.push(issue.body)
  const comments = Array.isArray(issue.comments) ? issue.comments : []
  for (const comment of comments) {
    const body = typeof comment === 'string' ? comment : comment?.body
    if (typeof body === 'string' && body.trim()) sources.push(body)
  }
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    for (const rawLine of sources[index].split(/\r?\n/)) {
      const line = rawLine.replace(/^\s*(?:[-*+]\s+|>\s*)+/, '')
      const match = /^Regression test\s*:\s*(.+)$/i.exec(line)
      if (!match) continue
      const pointer = cleanValue(match[1])
      if (pointer) return { pointer }
    }
  }
  return { error: 'missing' }
}

/**
 * Audit closed regression issues against the repository test tree.
 * @param {any[]} issues parsed tracker issues
 * @param {{ root?: string }} [options]
 */
export function auditRegressions(issues, options = {}) {
  const root = path.resolve(options.root ?? PACKAGE_ROOT)
  const findings = []
  let checked = 0
  for (const issue of issues) {
    if (!isClosed(issue)) continue
    const labels = labelsOf(issue).map((label) => label.toLowerCase())
    if (!labels.includes('regression')) continue
    checked += 1
    const label = `#${issue.number} ${String(issue.title ?? '').trim()}`
    const record = findingRecorder(findings, { number: issue.number, title: issue.title })
    const field = selectRegressionField(issue)
    if (field.error) {
      record(
        'missing-regression-test',
        'error',
        `${label}: closed regression has no "Regression test:" field (see docs/operations/incident.md)`,
      )
      continue
    }
    const problem = inspectPointer(field.pointer, root)
    if (!problem) continue
    if (problem.code === 'missing-test') {
      record('missing-regression-test', 'error', `${label}: Regression test names a missing file: ${field.pointer}`)
    } else if (problem.code === 'not-a-test') {
      record('not-a-test', 'error', `${label}: Regression test is not a test file: ${field.pointer} (${problem.detail})`)
    } else {
      record(
        'invalid-regression-test',
        'error',
        `${label}: Regression test must be a repository-relative path: ${field.pointer} (${problem.detail})`,
      )
    }
  }
  const errors = findings.filter((item) => item.level === 'error')
  return { ok: errors.length === 0, checked, findings, errors: errors.length }
}

function main(argv) {
  const options = parseArgs(argv, {
    initial: { tracker: null, root: PACKAGE_ROOT, json: false, help: false },
    values: {
      '--tracker': 'tracker',
      '--root': { key: 'root', parse: path.resolve },
    },
    flags: { '--json': 'json', '--help': 'help', '-h': 'help' },
  })
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const tracker = options.tracker ? path.resolve(process.cwd(), options.tracker) : path.join(PACKAGE_ROOT, DEFAULT_TRACKER)
  let text
  try {
    text = fs.readFileSync(tracker, 'utf8')
  } catch (error) {
    console.error(`regression-audit: cannot read tracker export ${tracker}: ${error?.message ?? error}`)
    console.error('regression-audit: produce one with the gh command in CONTRIBUTING.md ("Regressions and incidents")')
    return 2
  }
  let issues
  let result
  try {
    issues = parseTracker(text)
    result = auditRegressions(issues, { root: options.root })
  } catch (error) {
    console.error(`regression-audit: ${error.message}`)
    return 2
  }
  if (options.json) {
    console.log(JSON.stringify({ tracker, root: path.resolve(options.root), ...result }, null, 2))
    return result.ok ? 0 : 1
  }
  console.log(`regression-audit: ${tracker}`)
  console.log(`regression-audit: ${result.checked} closed regression(s) checked, ${result.errors} error(s)`)
  for (const item of result.findings) console.log(`${item.level} [${item.code}] ${item.message}`)
  if (result.ok) console.log('regression-audit: every closed regression names an existing test file')
  else console.log('regression-audit: a closed regression has no verifiable test pointer; see docs/operations/incident.md')
  return result.ok ? 0 : 1
}

await runMain(import.meta.url, () => main(process.argv.slice(2)), { errorPrefix: 'regression-audit', usage: USAGE })
