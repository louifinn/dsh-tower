// Machine-check the CI contract for .github/workflows/test.yml (#M72).
// Run: node scripts/check-workflow.mjs [--json] [--root <dir>]
//
// The workflow is the published claim about how a change is gated. This gate
// keeps that claim tied to `npm run check`, to the runtime the package
// supports, and to the branch-protection context names that must keep
// reporting during the one-cycle cutover (docs/operations/ci.md). It is
// deliberately string/structure based: no runtime dependency, and a tampered
// workflow text is testable in memory (tests/workflow-contract.test.mjs).
//
// The two tag-pin exceptions are documented, not accidental: their pin forms
// are asserted by contract tests outside this file's mission scope
// (tests/mount-smoke.test.mjs and tests/live-harness.test.mjs). Pinning them by
// SHA is the follow-up named in docs/operations/ci.md; this gate fails until
// the exception list and those tests agree, so the reminder cannot be lost.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const WORKFLOW_FILE = '.github/workflows/test.yml'

// Branch protection on `main` requires these context strings byte for byte.
// They stay until step 1 of the two-step cutover (docs/operations/ci.md).
export const REQUIRED_CONTEXTS = ['test (22)', 'test (24)', 'test (22, windows)']
export const REQUIRED_MOUNT_CONTEXT = 'mount'

// The transition contexts: the supported runtime, one canonical gate each.
export const SUPPORTED_CONTEXTS = ['test (24.9)', 'test (25)', 'test (24.9, windows)']
export const SUPPORTED_NODES = {
  'test (24.9)': '24.9',
  'test (25)': '25',
  'test (24.9, windows)': '24.9',
}
export const SUPPORTED_OS = {
  'test (24.9)': 'ubuntu-latest',
  'test (25)': 'ubuntu-latest',
  'test (24.9, windows)': 'windows-latest',
}

// action ref (as written in `uses:`) -> the tag it stays on for this cycle.
export const LEGACY_TAG_PINS = {
  'actions/cache@v4': 'v4.2.3',
  'actions/upload-artifact@v4': 'v4.6.2',
}

const SHA = /^[0-9a-f]{40}$/
const VERSION_COMMENT = /^v\d+\.\d+\.\d+$/

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Remove a trailing ` # comment`, respecting single/double quoted spans. */
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote !== null) {
      if (ch === quote && line[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i).trimEnd()
    }
  }
  return line.trimEnd()
}

/** A YAML scalar in the subset this file uses. */
function parseScalar(raw) {
  const value = raw.trim()
  if (value === '') return ''
  if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
    return value.slice(1, -1)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}

const linesOf = (text) => text.split(/\r?\n/)

/** Split the `jobs:` section into job id -> { id, line, lines, text }. */
function parseJobs(text) {
  const lines = linesOf(text)
  const at = lines.findIndex((line) => /^jobs:\s*$/.test(line))
  const jobs = {}
  if (at < 0) return jobs
  let current = null
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^[^\s#]/.test(line)) break
    const start = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line)
    if (start) {
      current = { id: start[1], line: i + 1, lines: [line] }
      jobs[current.id] = current
      continue
    }
    if (current) current.lines.push(line)
  }
  for (const job of Object.values(jobs)) job.text = job.lines.join('\n')
  return jobs
}

/** A job-level field at four-tab indentation (the workflow's job level). */
function jobField(job, name) {
  const match = new RegExp(`^ {4}${escapeRe(name)}:\\s*(.*)$`, 'm').exec(job.text)
  return match ? parseScalar(stripComment(match[1] ?? '')) : null
}

/** A block sequence under a job-level `needs:` (inline `[a, b]` also accepted). */
function jobList(job, name) {
  const inline = jobField(job, name)
  if (typeof inline === 'string' && inline.startsWith('[') && inline.endsWith(']')) {
    return inline
      .slice(1, -1)
      .split(',')
      .map((item) => parseScalar(stripComment(item)))
      .filter((item) => item !== '')
  }
  const at = job.lines.findIndex((line) => new RegExp(`^ {4}${escapeRe(name)}:\\s*$`).test(line))
  if (at < 0) return []
  const out = []
  for (let i = at + 1; i < job.lines.length; i++) {
    const item = /^ {6}- (.+)$/.exec(job.lines[i])
    if (!item) {
      if (job.lines[i].trim() === '' || /^\s*#/.test(job.lines[i])) continue
      break
    }
    out.push(parseScalar(stripComment(item[1])))
  }
  return out
}

/** Read a nested map at `indent + 2` below the line `indent: key` that starts at `at`. */
function readMap(lines, at, indent) {
  const map = {}
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    const entry = new RegExp(`^ {${indent + 2}}([A-Za-z0-9_-]+):\\s*(.*)$`).exec(line)
    if (!entry) break
    map[entry[1]] = parseScalar(stripComment(entry[2]))
  }
  return map
}

/** A literal block scalar whose key line is at `indent`; returns the text and the next line index. */
function blockScalar(lines, at, indent) {
  const body = []
  let base = null
  let i = at + 1
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      body.push('')
      continue
    }
    const lineIndent = line.length - line.trimStart().length
    if (lineIndent <= indent) break
    if (base === null) base = lineIndent
    body.push(line.slice(Math.min(base, lineIndent)))
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  return { value: body.join('\n'), end: i }
}

/** Normalize `   - uses: x` so a step's keys all sit at eight-space indentation. */
function stepLines(rawLines) {
  const lines = rawLines.slice()
  lines[0] = `        ${lines[0].slice(8)}`
  return lines
}

function stepWithMap(lines, key) {
  const at = lines.findIndex((line) => new RegExp(`^ {8}${escapeRe(key)}:\\s*$`).test(line))
  if (at < 0) return {}
  const map = {}
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    const entry = /^ {10}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!entry) break
    const raw = stripComment(entry[2]).trim()
    if (raw === '|' || raw === '>') {
      const block = blockScalar(lines, i, 10)
      map[entry[1]] = block.value
      i = block.end - 1
      continue
    }
    map[entry[1]] = parseScalar(raw)
  }
  return map
}

/** Parse one step: { name, uses, usesComment, run, if, with, env, line, text }. */
function parseStep(rawLines) {
  const lines = stepLines(rawLines)
  const find = (key) => {
    const at = lines.findIndex((line) => new RegExp(`^ {8}${escapeRe(key)}:\\s*(.*)$`).test(line))
    if (at < 0) return null
    const raw = new RegExp(`^ {8}${escapeRe(key)}:\\s*(.*)$`).exec(lines[at])[1] ?? ''
    return { at, raw: stripComment(raw).trim() }
  }
  const uses = find('uses')
  const name = find('name')
  const ifField = find('if')
  const run = find('run')
  let usesRef = null
  let usesComment = ''
  if (uses) {
    const match = /^(\S+)(?:\s+#\s*(.*))?$/.exec(uses.raw)
    if (match) {
      usesRef = match[1]
      usesComment = (match[2] ?? '').trim()
    }
  }
  let runValue = null
  if (run) runValue = run.raw === '|' || run.raw === '>' ? blockScalar(lines, run.at, 8).value : run.raw
  return {
    name: name ? parseScalar(name.raw) : null,
    uses: usesRef,
    usesComment,
    run: runValue,
    if: ifField ? parseScalar(ifField.raw) : null,
    with: stepWithMap(lines, 'with'),
    env: stepWithMap(lines, 'env'),
    text: lines.join('\n'),
  }
}

/** The ordered steps of a job. */
function parseSteps(job) {
  const at = job.lines.findIndex((line) => /^ {4}steps:\s*$/.test(line))
  if (at < 0) return []
  const starts = []
  for (let i = at + 1; i < job.lines.length; i++) {
    if (/^ {6}- \S/.test(job.lines[i])) starts.push(i)
  }
  const steps = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : job.lines.length
    steps.push(parseStep(job.lines.slice(starts[k], end)))
  }
  return steps
}

/** The `matrix.include` entries of a job, in order. */
function matrixEntries(job) {
  const at = job.lines.findIndex((line) => /^ {8}include:\s*$/.test(line))
  if (at < 0) return []
  const entries = []
  let current = null
  for (let i = at + 1; i < job.lines.length; i++) {
    const line = job.lines[i]
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    const start = /^ {10}- (.*)$/.exec(line)
    if (start) {
      if (current) entries.push(current)
      current = {}
      const key = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(start[1])
      if (key) current[key[1]] = parseScalar(stripComment(key[2]))
      continue
    }
    const continuation = /^ {12}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (continuation && current) {
      current[continuation[1]] = parseScalar(stripComment(continuation[2]))
      continue
    }
    break
  }
  if (current) entries.push(current)
  return entries
}

/** Every `uses:` reference in the workflow, with its inline comment and line number. */
function actionUses(text) {
  const out = []
  linesOf(text).forEach((line, index) => {
    const match = /^\s*(?:- )?uses:\s*(\S+)(?:\s+#\s*(.*))?\s*$/.exec(line)
    if (match) out.push({ line: index + 1, uses: match[1], comment: (match[2] ?? '').trim() })
  })
  return out
}

/** The failing-job list the nightly reporter builds from the Actions jobs API. */
function evaluateNightlyReporter(job, problems) {
  const condition = String(jobField(job, 'if') ?? '')
  if (!/always\(\)/.test(condition)) {
    problems.push('nightly failure: the reporter must use always() so it still runs after a failure')
  }
  if (!/github\.event_name == 'schedule'/.test(condition)) {
    problems.push('nightly failure: the reporter must be schedule-only (github.event_name == \'schedule\')')
  }
  if (!/contains\(needs\.\*\.result, 'failure'\)/.test(condition)) {
    problems.push('nightly failure: the reporter condition must test contains(needs.*.result, \'failure\')')
  }
  const needs = jobList(job, 'needs')
  for (const id of ['test', 'canonical', 'mount']) {
    if (!needs.includes(id)) problems.push(`nightly failure: needs must include "${id}"`)
  }
  const at = job.lines.findIndex((line) => /^ {4}permissions:\s*$/.test(line))
  const permissions = at < 0 ? {} : readMap(job.lines, at, 4)
  if (permissions.issues !== 'write') problems.push('nightly failure: the job must grant issues: write')
  if (permissions.actions !== 'read') problems.push('nightly failure: the job must grant actions: read to name failing jobs')
  if (permissions.contents !== 'read') problems.push('nightly failure: the job must keep contents: read')
  const steps = parseSteps(job)
  const text = steps.map((step) => step.text).join('\n')
  const required = [
    ['gh api', 'call the Actions jobs API'],
    ['.jobs[]', 'iterate the run jobs'],
    ['conclusion ==', 'select failed jobs'],
    ['gh issue list', 'find the existing issue'],
    ['gh issue comment', 'update the existing issue'],
    ['gh issue create', 'open the issue when absent'],
    ['github.token', 'use the workflow token'],
    ['github.run_id', 'link the run URL'],
    ['github.server_url', 'build the run URL'],
    ['Nightly test workflow failure', 'keep one stable issue title'],
  ]
  for (const [needle, why] of required) {
    if (!text.includes(needle)) problems.push(`nightly failure: reporter must ${why} (missing ${JSON.stringify(needle)})`)
  }
}

function evaluatePermissions(text, jobs, problems) {
  const lines = linesOf(text)
  const at = lines.findIndex((line) => /^permissions:\s*$/.test(line))
  if (at < 0) {
    problems.push('permissions: the workflow must declare a least-privilege top-level permissions block')
  } else {
    const permissions = readMap(lines, at, 0)
    const keys = Object.keys(permissions)
    if (keys.length !== 1 || permissions.contents !== 'read') {
      problems.push(`permissions: top-level permissions must be exactly "contents: read"; found ${JSON.stringify(permissions)}`)
    }
  }
  for (const job of Object.values(jobs)) {
    if (job.id === 'nightly-failure') continue
    if (job.lines.some((line) => /^ {4}permissions:\s*$/.test(line))) {
      problems.push(`permissions: only the nightly failure reporter may override top-level permissions (job "${job.id}")`)
    }
  }
}

function evaluateConcurrency(text, problems) {
  const lines = linesOf(text)
  const at = lines.findIndex((line) => /^concurrency:\s*$/.test(line))
  if (at < 0) {
    problems.push('concurrency: the workflow must declare a per-ref concurrency group')
    return
  }
  const concurrency = readMap(lines, at, 0)
  if (typeof concurrency.group !== 'string' || !concurrency.group.includes('github.ref')) {
    problems.push('concurrency: group must be per-ref (include github.ref)')
  }
  const cancel = String(concurrency['cancel-in-progress'] ?? '')
  for (const token of ['github.event_name', "'push'", "'pull_request'"]) {
    if (!cancel.includes(token)) {
      problems.push(`concurrency: cancel-in-progress must be limited to pushes/PRs (missing ${token})`)
    }
  }
}

function evaluateActionPins(text, problems) {
  let pinned = 0
  const uses = actionUses(text)
  for (const entry of uses) {
    const at = entry.uses.lastIndexOf('@')
    if (at < 0) {
      problems.push(`action pin: ${entry.uses} (line ${entry.line}) has no ref`)
      continue
    }
    const action = entry.uses.slice(0, at)
    const ref = entry.uses.slice(at + 1)
    const legacy = LEGACY_TAG_PINS[`${action}@${ref}`]
    if (SHA.test(ref)) {
      pinned += 1
      if (!VERSION_COMMENT.test(entry.comment)) {
        problems.push(`action pin: ${entry.uses} (line ${entry.line}) is SHA-pinned but needs a "# vX.Y.Z" version comment`)
      }
      continue
    }
    if (legacy !== undefined) {
      if (!/tag pin/i.test(entry.comment)) {
        problems.push(`action pin: exception ${action}@${ref} must say "tag pin" in its comment`)
      } else if (!entry.comment.includes(legacy)) {
        problems.push(`action pin: exception ${action}@${ref} must record ${legacy} in its comment`)
      }
      continue
    }
    problems.push(`action pin: ${entry.uses} (line ${entry.line}) is not pinned to a 40-hex commit SHA`)
  }
  for (const [ref, version] of Object.entries(LEGACY_TAG_PINS)) {
    const found = uses.filter((entry) => entry.uses === ref).length
    if (found !== 1) {
      problems.push(
        `action pin: the documented tag-pin exception ${ref} (${version}) must appear exactly once, found ${found}; ` +
          'pin it by SHA and drop the exception when its contract test accepts the pinned form',
      )
    }
  }
  return pinned
}

function evaluateArtifacts(jobs, problems) {
  for (const job of Object.values(jobs)) {
    for (const step of parseSteps(job)) {
      if (!step.uses || !step.uses.startsWith('actions/upload-artifact@')) continue
      const days = Number(step.with['retention-days'])
      if (!Number.isInteger(days) || days < 1 || days > 14) {
        problems.push(`artifact retention: job "${job.id}" step "${step.name ?? step.uses}" must set retention-days between 1 and 14`)
      }
    }
  }
}

function evaluateNpmCache(jobs, problems) {
  for (const job of Object.values(jobs)) {
    const steps = parseSteps(job)
    const installs = steps.some((step) => typeof step.run === 'string' && /^npm ci\b/.test(step.run))
    if (!installs) continue
    const setup = steps.find((step) => step.uses && step.uses.startsWith('actions/setup-node@'))
    if (!setup) {
      problems.push(`setup-node cache: job "${job.id}" runs npm ci without an actions/setup-node step`)
    } else if (setup.with.cache !== 'npm') {
      problems.push(`setup-node cache: job "${job.id}" must set cache: npm on its setup-node step`)
    }
  }
}

function evaluateSupportedNodes(jobs, problems) {
  for (const job of Object.values(jobs)) {
    for (const step of parseSteps(job)) {
      if (!step.uses || !step.uses.startsWith('actions/setup-node@')) continue
      const node = step.with['node-version']
      if (typeof node !== 'string' || node.includes('${{')) continue
      if (!['24.9', '25'].includes(node)) {
        problems.push(`node matrix: job "${job.id}" runs on unsupported Node ${node} (supported: 24.9, 25)`)
      }
    }
  }
}

function evaluateLegacyContexts(jobs, problems) {
  const legacy = jobs.test
  if (!legacy) {
    problems.push('required context: the frozen legacy job "test" is missing')
  } else {
    if (String(jobField(legacy, 'name') ?? '') !== '${{ matrix.name }}') {
      problems.push('required context: the legacy job must keep name: ${{ matrix.name }}')
    }
    const entries = matrixEntries(legacy)
    const names = entries.map((entry) => String(entry.name))
    if (JSON.stringify(names) !== JSON.stringify(REQUIRED_CONTEXTS)) {
      problems.push(`required context: the legacy matrix must be exactly ${JSON.stringify(REQUIRED_CONTEXTS)}, found ${JSON.stringify(names)}`)
    }
    const expectedNodes = { 'test (22)': 22, 'test (24)': 24, 'test (22, windows)': 22 }
    for (const entry of entries) {
      const name = String(entry.name)
      if (expectedNodes[name] !== undefined && Number(entry.node) !== expectedNodes[name]) {
        problems.push(`required context: "${name}" must stay on Node ${expectedNodes[name]}, found ${entry.node}`)
      }
      if (name === 'test (22, windows)' && entry.os !== 'windows-latest') {
        problems.push('required context: "test (22, windows)" must stay on windows-latest')
      }
    }
  }
  const mount = jobs.mount
  if (!mount || String(jobField(mount, 'name') ?? '') !== REQUIRED_MOUNT_CONTEXT) {
    problems.push('required context: the required "mount" job context is missing')
  }
}

function evaluateCanonicalGate(jobs, problems) {
  const canonical = Object.values(jobs).find((job) => {
    const labels = matrixEntries(job).map((entry) => String(entry.label))
    return labels.length === SUPPORTED_CONTEXTS.length && SUPPORTED_CONTEXTS.every((label) => labels.includes(label))
  })
  if (!canonical) {
    problems.push(`canonical gate: no job carries the supported contexts ${JSON.stringify(SUPPORTED_CONTEXTS)}`)
    return false
  }
  if (!String(jobField(canonical, 'name') ?? '').includes('matrix.label')) {
    problems.push('canonical gate: the canonical job must take its context from matrix.label')
  }
  const entries = matrixEntries(canonical)
  for (const entry of entries) {
    const label = String(entry.label)
    if (SUPPORTED_NODES[label] !== undefined && String(entry.node) !== SUPPORTED_NODES[label]) {
      problems.push(`node matrix: canonical leg "${label}" must run Node ${SUPPORTED_NODES[label]}, found ${entry.node}`)
    }
    if (SUPPORTED_OS[label] !== undefined && entry.os !== SUPPORTED_OS[label]) {
      problems.push(`node matrix: canonical leg "${label}" must run on ${SUPPORTED_OS[label]}, found ${entry.os}`)
    }
    const expectsExtras = label === 'test (24.9)'
    if (entry.release !== expectsExtras) {
      problems.push(`canonical gate: canonical leg "${label}" must set release: ${expectsExtras} (the Node-24-only extras)` )
    }
  }
  const steps = parseSteps(canonical)
  const runSteps = steps.filter((step) => typeof step.run === 'string')
  const exact = (command) => runSteps.filter((step) => step.run.trim() === command)
  const check = exact('npm run check')
  if (check.length !== 1) {
    problems.push(`canonical gate: the canonical job must run "npm run check" exactly once, found ${check.length}`)
  }
  const install = runSteps.filter((step) => /^npm ci\b/.test(step.run.trim()))
  if (install.length !== 1) {
    problems.push(`canonical gate: the canonical job must run "npm ci" exactly once, found ${install.length}`)
  }
  const extras = [
    { command: 'npm run release:check', text: 'Release check' },
    { command: 'npm run test:coverage', text: 'Coverage (Node 24.9)' },
  ]
  for (const extra of extras) {
    const found = exact(extra.command)
    if (found.length !== 1) {
      problems.push(`canonical gate: the canonical job must run "${extra.command}" exactly once, found ${found.length}`)
    } else if (String(found[0].if ?? '') !== 'matrix.release') {
      problems.push(`canonical gate: "${extra.command}" must be gated by matrix.release so it stays Node-24-only`)
    }
  }
  const liveCheck = runSteps.filter((step) => step.run.includes('npm run test:live -- --check'))
  if (liveCheck.length !== 1) {
    problems.push(`canonical gate: the canonical job must run the live harness check exactly once, found ${liveCheck.length}`)
  } else if (String(liveCheck[0].if ?? '') !== 'matrix.release') {
    problems.push('canonical gate: the live harness check must be gated by matrix.release so it stays Node-24-only')
  }
  const reimplemented = runSteps.filter((step) =>
    /^npm (test|run (test:property|support:check|docs:check|pack:check|surface:check|blockers:check|shape:audit|architecture:check|types:|domain:check))/.test(
      step.run.trim(),
    ),
  )
  if (reimplemented.length > 0) {
    problems.push(
      `canonical gate: the canonical job must not reimplement gate steps; found ${JSON.stringify(reimplemented.map((step) => step.run.trim()))}`,
    )
  }
  return true
}

function evaluateTriggers(text, problems) {
  const start = text.indexOf('on:')
  const end = text.indexOf('\njobs:')
  const on = start >= 0 && end > start ? text.slice(start, end) : ''
  for (const trigger of ['push', 'pull_request', 'schedule', 'workflow_dispatch']) {
    if (!new RegExp(`^ {2}${trigger}:`, 'm').test(on)) problems.push(`triggers: the workflow must keep the ${trigger} trigger`)
  }
  if (!/cron: '\d+ \d+ \* \* \*'/.test(on)) problems.push('triggers: the schedule must keep a daily cron')
}

function evaluateName(text, problems) {
  if (!/^name: test\s*$/m.test(text)) problems.push('workflow name: the workflow must stay named "test"')
}

/**
 * Evaluate the workflow text. Returns { ok, problems, facts }.
 * `problems` is empty on success; each entry names the contract it broke.
 */
export function evaluateWorkflow(text) {
  const problems = []
  evaluateName(text, problems)
  evaluateTriggers(text, problems)
  const jobs = parseJobs(text)
  evaluatePermissions(text, jobs, problems)
  evaluateConcurrency(text, problems)
  const pinned = evaluateActionPins(text, problems)
  evaluateArtifacts(jobs, problems)
  evaluateNpmCache(jobs, problems)
  evaluateSupportedNodes(jobs, problems)
  evaluateLegacyContexts(jobs, problems)
  const canonical = evaluateCanonicalGate(jobs, problems)
  const nightly = jobs['nightly-failure']
  if (!nightly) {
    problems.push('nightly failure: the "nightly-failure" job is missing')
  } else {
    evaluateNightlyReporter(nightly, problems)
  }
  return {
    ok: problems.length === 0,
    problems,
    facts: {
      canonicalLegs: SUPPORTED_CONTEXTS,
      requiredContexts: [...REQUIRED_CONTEXTS, REQUIRED_MOUNT_CONTEXT],
      pinnedActions: pinned,
      legacyTagPins: Object.keys(LEGACY_TAG_PINS),
      nightlyFailureJob: Boolean(nightly),
      canonicalJob: canonical,
    },
  }
}

/** The package wiring: workflow:check exists and runs inside npm run check. */
export function evaluatePackageWire(pkg) {
  const problems = []
  const scripts = pkg?.scripts ?? {}
  if (scripts['workflow:check'] !== 'node scripts/check-workflow.mjs') {
    problems.push('package.json: script "workflow:check" must be "node scripts/check-workflow.mjs"')
  }
  const chain = String(scripts.check ?? '')
    .split('&&')
    .map((step) => step.trim())
    .filter(Boolean)
  const wired = chain.indexOf('npm run workflow:check')
  if (wired < 0) {
    problems.push('package.json: "check" must include "npm run workflow:check"')
  } else {
    if (chain.filter((step) => step === 'npm run workflow:check').length !== 1) {
      problems.push('package.json: "check" must include "npm run workflow:check" exactly once')
    }
    const support = chain.indexOf('npm run support:check')
    const docs = chain.indexOf('npm run docs:check')
    if (support >= 0 && wired < support) problems.push('package.json: "npm run workflow:check" must run after "npm run support:check"')
    if (docs >= 0 && wired > docs) problems.push('package.json: "npm run workflow:check" must run before "npm run docs:check"')
  }
  return { ok: problems.length === 0, problems }
}

/** Read the repository's workflow and package wiring and evaluate both. */
export function checkRepository(root = ROOT) {
  const text = fs.readFileSync(path.join(root, WORKFLOW_FILE), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const workflow = evaluateWorkflow(text)
  const wire = evaluatePackageWire(pkg)
  return { ok: workflow.ok && wire.ok, problems: [...workflow.problems, ...wire.problems], facts: workflow.facts }
}

function main() {
  const rootArg = process.argv.indexOf('--root')
  const root = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : ROOT
  const json = process.argv.includes('--json')
  let result
  try {
    result = checkRepository(root)
  } catch (error) {
    console.error(`workflow check: ${String(error?.message ?? error)}`)
    process.exitCode = 1
    return
  }
  if (json) {
    console.log(JSON.stringify(result, null, 2))
  }
  if (!result.ok) {
    for (const problem of result.problems) console.error(`workflow check: ${problem}`)
    process.exitCode = 1
    return
  }
  if (!json) {
    const { facts } = result
    console.log(
      `workflow check: ${facts.canonicalLegs.length} canonical legs run "npm run check" once; ` +
        `${facts.requiredContexts.length} required legacy contexts preserved; ` +
        `${facts.pinnedActions} actions SHA-pinned; ` +
        `${facts.legacyTagPins.length} documented tag-pin exceptions; nightly failure issue job present`,
    )
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
