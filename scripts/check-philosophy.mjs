#!/usr/bin/env node
// Engineering-philosophy gate (#83).
//
// The repository writes down what it refuses to do and points every principle at
// the thing that enforces it. A pointer that does not resolve is a slogan, so
// this check fails on it. It also keeps the ADR set dated/structure-complete and
// makes every "Non-goals" heading in docs/ auditable: it must either name an
// existing enforcement file or be explicitly labelled `unowned`.
//
// Usage:
//   node scripts/check-philosophy.mjs [--root <dir>] [--json]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, runMain } from './lib/cli.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PRINCIPLES_FILE = 'PRINCIPLES.md'
const ADR_DIR = 'docs/adr'
const MIN_PRINCIPLES = 8
const MIN_ADRS = 3
const ADR_REQUIRED_SECTIONS = ['Context', 'Decision', 'Consequences', 'Rejected alternatives']
const ADR_REQUIRED_TOPICS = ['ports', 'state.json', 'allowAgentControl']
const USAGE = `usage: node scripts/check-philosophy.mjs [--root <dir>] [--json]

  --root   repository root to check (default: this package)
  --json   print the report as JSON
  --help   print this text

Every principle needs "Refused because of this:" and "Enforced by:" where the
enforcement names an existing file and a test or gate. Every docs/ "Non-goals"
heading needs an existing enforcement pointer or the word "unowned". At least
${MIN_ADRS} dated ADRs need Context, Decision, Consequences and Rejected alternatives.`

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function finding(code, message) {
  return { code, level: 'error', message }
}

function listMarkdown(dir) {
  const files = []
  if (!fs.existsSync(dir)) return files
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listMarkdown(full))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full)
  }
  return files
}

/** Candidate repository paths: backticked tokens with a slash or a file suffix. */
function backtickedPaths(text) {
  const paths = []
  for (const match of String(text ?? '').matchAll(/`([^`]+)`/g)) {
    const token = match[1].trim().replace(/\\/g, '/')
    if (!token || token.startsWith('npm ') || token.startsWith('gh ') || token.includes(' ')) continue
    if (!token.includes('/') && !/\.(?:mjs|js|cjs|ts|md|json|ya?ml)$/.test(token)) continue
    paths.push(token)
  }
  return paths
}

function fieldText(body, label) {
  const lines = String(body ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^\\s*(?:[-*]\\s*)?\\**${label}:?\\**\\s*(.*)$`, 'i').test(line))
  if (start < 0) return null
  const match = new RegExp(`^\\s*(?:[-*]\\s*)?\\**${label}:?\\**\\s*(.*)$`, 'i').exec(lines[start])
  const parts = [match?.[1] ?? '']
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) break
    if (/^\s*(?:[-*]\s*)?\**Refused because of this:?/i.test(line)) break
    if (/^\s*(?:[-*]\s*)?\**Enforced by:?/i.test(line)) break
    if (/^#{1,6}\s+/.test(line)) break
    parts.push(line.trim())
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim() || null
}

/**
 * Read PRINCIPLES.md into sections, then check each section's refusal and
 * enforcement pointer. A section without both is not a principle.
 * @param {string} text
 * @param {(relative: string) => boolean} exists
 */
export function checkPrinciplesText(text, exists) {
  const findings = []
  const headings = [...String(text ?? '').matchAll(/^##\s+(\d+)\.\s+(.+?)\s*$/gm)]
  if (headings.length < MIN_PRINCIPLES) {
    findings.push(finding('principles-count', `${PRINCIPLES_FILE} has ${headings.length} numbered principles; at least ${MIN_PRINCIPLES} are required`))
  }
  const principles = []
  headings.forEach((heading, index) => {
    const start = heading.index + heading[0].length
    const end = index + 1 < headings.length ? headings[index + 1].index : text.length
    const body = text.slice(start, end)
    const number = Number(heading[1])
    const title = heading[2].trim()
    const refusal = fieldText(body, 'Refused because of this')
    const enforcement = fieldText(body, 'Enforced by')
    const record = { number, title, refusal, enforcement }
    principles.push(record)
    if (!record.refusal) {
      findings.push(finding('principle-refusal', `principle ${number} (${title}) has no "Refused because of this:" line`))
    }
    if (!record.enforcement) {
      findings.push(finding('principle-enforcement', `principle ${number} (${title}) has no "Enforced by:" line`))
      return
    }
    const candidates = backtickedPaths(record.enforcement)
    const missing = candidates.filter((candidate) => !exists(candidate))
    if (candidates.length === 0) {
      findings.push(finding('principle-pointer-missing', `principle ${number} (${title}) names no backticked file in "Enforced by:"`))
    } else {
      for (const candidate of missing) {
        findings.push(
          finding('principle-pointer-missing', `principle ${number} (${title}) points at a missing file: ${candidate}`),
        )
      }
    }
    if (!/(?:tests\/|\.test\.|npm run [a-z0-9:_-]+)/i.test(record.enforcement)) {
      findings.push(
        finding('principle-enforcement-weak', `principle ${number} (${title}) names no test or gate in "Enforced by:"`),
      )
    }
  })
  return { principles, findings }
}

/**
 * Check that the ADR set is dated, structured and covers the three load-bearing
 * decisions the issue asked to backfill.
 * @param {string} root
 */
export function checkAdrs(root) {
  const findings = []
  const dir = path.join(root, ADR_DIR)
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => /^\d{4}-.+\.md$/.test(name))
        .sort()
    : []
  if (files.length < MIN_ADRS) {
    findings.push(finding('adr-count', `${ADR_DIR} has ${files.length} numbered ADRs; at least ${MIN_ADRS} are required`))
  }
  const combined = []
  for (const name of files) {
    const relative = `${ADR_DIR}/${name}`
    const text = fs.readFileSync(path.join(dir, name), 'utf8')
    combined.push(text)
    for (const section of ADR_REQUIRED_SECTIONS) {
      const heading = new RegExp(`^#{1,6}\\s+${section}\\b`, 'im')
      if (!heading.test(text)) findings.push(finding('adr-section', `${relative} misses the "${section}" section`))
    }
    if (!/^\s*(?:[-*]\s*)?Date:\s*(\d{4}-\d{2}-\d{2})\s*$/im.test(text)) {
      findings.push(finding('adr-date', `${relative} needs a "Date: YYYY-MM-DD" line`))
    }
    if (!/^\s*(?:[-*]\s*)?Status:\s*\S+/im.test(text)) {
      findings.push(finding('adr-status', `${relative} needs a "Status:" line`))
    }
  }
  const all = combined.join('\n')
  for (const topic of ADR_REQUIRED_TOPICS) {
    if (!new RegExp(topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(all)) {
      findings.push(finding('adr-topic', `no ADR explains the "${topic}" decision`))
    }
  }
  return { adrDir: ADR_DIR, adrs: files, findings }
}

/**
 * Every "Non-goals" heading in docs/ must carry an enforcement pointer that
 * resolves or the explicit word `unowned`. No heading may be an orphan refusal.
 * @param {string} root
 */
export function checkNonGoals(root) {
  const findings = []
  const files = listMarkdown(path.join(root, 'docs'))
  let headings = 0
  for (const file of files) {
    const relative = path.relative(root, file).replace(/\\/g, '/')
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
      if (!heading || !/\bnon[-\s]?goals?\b/i.test(heading[2])) return
      headings += 1
      const level = heading[1].length
      const body = []
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const next = /^(#{1,6})\s+/.exec(lines[cursor])
        if (next && next[1].length <= level) break
        body.push(lines[cursor])
      }
      const text = body.join('\n')
      const enforcement = /^\s*(?:[-*]\s*)?\**Enforced by:?\**\s*(.+)$/im.exec(text)
      const unowned = /\bunowned\b/i.test(text)
      const enforced =
        Boolean(unowned) ||
        Boolean(enforcement && backtickedPaths(enforcement[1]).some((candidate) => fs.existsSync(path.join(root, candidate))))
      if (!enforced) {
        findings.push(
          finding(
            'non-goal-unowned',
            `${relative}:${index + 1} has a "Non-goals" heading with no existing enforcement pointer and no "unowned" label`,
          ),
        )
      }
    })
  }
  return { headings, findings }
}

/** Run all three checks against one repository root. */
export function checkPhilosophy(root) {
  const findings = []
  const principlesFile = path.join(root, PRINCIPLES_FILE)
  let principles = []
  if (!fs.existsSync(principlesFile)) {
    findings.push(finding('principles-missing', `${PRINCIPLES_FILE} is missing`))
  } else {
    const result = checkPrinciplesText(fs.readFileSync(principlesFile, 'utf8'), (relative) =>
      fs.existsSync(path.join(root, relative)),
    )
    principles = result.principles
    findings.push(...result.findings)
  }
  const adr = checkAdrs(root)
  findings.push(...adr.findings)
  const nonGoals = checkNonGoals(root)
  findings.push(...nonGoals.findings)
  return {
    ok: findings.length === 0,
    principles,
    adrs: adr.adrs,
    nonGoals,
    findings,
  }
}

function main(argv) {
  const options = parseArgs(argv, {
    initial: { root: PACKAGE_ROOT, json: false, help: false },
    values: { '--root': { key: 'root', parse: path.resolve } },
    flags: { '--json': 'json', '--help': 'help', '-h': 'help' },
  })
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const report = checkPhilosophy(path.resolve(options.root))
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
    return report.ok ? 0 : 1
  }
  console.log(
    `philosophy: ${report.principles.length} principles, ${report.adrs.length} ADRs, ${report.nonGoals.headings} non-goal heading(s)`,
  )
  for (const item of report.findings) console.log(`philosophy: ${item.level} [${item.code}] ${item.message}`)
  if (report.ok) console.log('philosophy: ok — every refusal points at an existing test or gate')
  else console.log(`philosophy: ${report.findings.length} unenforced statement(s)`)
  return report.ok ? 0 : 1
}

await runMain(import.meta.url, () => main(process.argv.slice(2)), { errorPrefix: 'philosophy', usage: USAGE })
