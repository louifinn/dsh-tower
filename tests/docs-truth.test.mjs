// Documentation truth (#F43): the hand-written surface counts in the READMEs and
// the architecture overview, the reference-page counts, and every local markdown
// link must track the implementation. A tampered copy proves the check is
// load-bearing instead of a second hand-maintained list.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkDocs, currentDocPages, DENY_DOC_PAGE, DENY_DOC_PAGE_ZH, denyTableProblems, linkProblems, retiredToolNameProblems, toolTableRowProblems } from '../scripts/check-docs.mjs'
import { reviewerBriefing, workerBriefing } from '../app/briefing.js'
import { apply as applyReviewer } from '../reviewer.js'
import { apply as applyWorker } from '../worker.js'
import { DENY_OWNER_TOOLS } from '../domain/generated/deny-surface.js'
import { loadShippedToolSurface } from '../scripts/lib/tool-surface.mjs'
import { removeTemp } from './helpers/cleanup.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Copy the checkout (without .git or dependencies) so a test may tamper with it. */
function copyRepo(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-docs-truth-'))
  t.after(() => removeTemp(parent))
  const copy = path.join(parent, 'repo')
  fs.cpSync(repoRoot, copy, {
    recursive: true,
    filter: (source) => !['.git', 'node_modules'].includes(path.basename(source)),
  })
  return copy
}

test('F43: the checked docs state the live registry surface', () => {
  const result = checkDocs(repoRoot)
  assert.deepEqual(result.problems, [])
  // The counts come from the live registries; never restate their values here.
  assert.equal(result.counts.tools, result.toolNames.length)
  assert.equal(result.counts.blockers, result.blockerCodes.length)
  assert.equal(result.counts.errors, result.errorCodes.length)
  assert.ok(result.counts.events > 0)
})

test('docs references resolve locally', () => {
  assert.deepEqual(linkProblems(repoRoot), [])
})

test('F60: the English and Chinese tool tables list the same rows', (t) => {
  assert.deepEqual(toolTableRowProblems(repoRoot), [])

  const copy = copyRepo(t)
  const zh = path.join(copy, 'docs', 'zh', 'reference', 'tools.md')
  const original = fs.readFileSync(zh, 'utf8')
  const row = original.split('\n').find((line) => line.startsWith('| `tower_inbox` '))
  assert.ok(row, 'docs/zh/reference/tools.md must carry the tower_inbox row')
  fs.writeFileSync(zh, original.replace(`${row}\n`, ''))

  const problems = checkDocs(copy).problems
  assert.ok(
    problems.includes('docs/zh/reference/tools.md is missing tool rows: tower_inbox'),
    problems.join('\n'),
  )
})

test('F60: both tower_spawn rows must keep the survey null placement', (t) => {
  // English: the placement sentence is the documented output contract.
  const english = copyRepo(t)
  const enPage = path.join(english, 'docs', 'reference', 'tools.md')
  const enText = fs.readFileSync(enPage, 'utf8')
  assert.ok(enText.includes('`null` for a survey'), 'the English row must state the survey placement')
  fs.writeFileSync(enPage, enText.replace('`null` for a survey', '`nil` for a survey'))
  assert.ok(
    toolTableRowProblems(english).some((problem) =>
      problem.includes('must state that a survey placement is null'),
    ),
    'an English row without the null placement must be reported',
  )

  // Chinese: the same shape, translated — a dropped sentence is the drift.
  const chinese = copyRepo(t)
  const zhPage = path.join(chinese, 'docs', 'zh', 'reference', 'tools.md')
  const zhText = fs.readFileSync(zhPage, 'utf8')
  assert.ok(zhText.includes('为 `null`'), 'the Chinese row must state the survey placement')
  fs.writeFileSync(zhPage, zhText.replace('为 `null`', '为 `nil`'))
  assert.ok(
    toolTableRowProblems(chinese).some((problem) =>
      problem.includes('must state that a survey placement is null'),
    ),
    'a Chinese row without the null placement must be reported',
  )
})

test('F43: a tampered README blocker count fails the docs check', (t) => {
  const copy = copyRepo(t)
  assert.deepEqual(checkDocs(copy).problems, [])

  const counts = checkDocs(copy).counts
  const readme = path.join(copy, 'README.md')
  const original = fs.readFileSync(readme, 'utf8')
  const live = `${counts.blockers} 个稳定 blocker/failure code`
  assert.ok(original.includes(live), `README.md must contain "${live}"`)
  fs.writeFileSync(readme, original.replace(live, `${counts.blockers - 2} 个稳定 blocker/failure code`))

  const problems = checkDocs(copy).problems
  assert.ok(
    problems.some((problem) => problem.startsWith('README.md must state the live surface counts')),
    problems.join('\n'),
  )
})

test('F43: a tampered architecture tool total fails the docs check', (t) => {
  const copy = copyRepo(t)
  const counts = checkDocs(copy).counts
  const overview = path.join(copy, 'docs', 'architecture', 'overview.md')
  const original = fs.readFileSync(overview, 'utf8')
  const live = `${counts.tools} total`
  assert.ok(original.includes(live), `overview.md must contain "${live}"`)
  fs.writeFileSync(overview, original.replace(live, `${counts.tools - 1} total`))

  const problems = checkDocs(copy).problems
  assert.ok(
    problems.some((problem) => problem.includes(`must state "${counts.tools} total"`)),
    problems.join('\n'),
  )
})

test('F56: a retired tool name in a current page fails the docs check', (t) => {
  const copy = copyRepo(t)
  assert.deepEqual(checkDocs(copy).problems, [])

  const tools = path.join(copy, 'docs', 'reference', 'tools.md')
  fs.appendFileSync(tools, '\nWhen a config row fails, run `tower_doctor` to see the reason.\n')

  const problems = checkDocs(copy).problems
  assert.ok(
    problems.some(
      (problem) =>
        problem.includes('retired tool name "tower_doctor"') && problem.includes('tower_inspect'),
    ),
    problems.join('\n'),
  )
})

test('F56: every markdown page in the shipped manifest is scanned for retired tool names', () => {
  const pages = new Set(
    currentDocPages(repoRoot).map((page) => path.relative(repoRoot, page).split(path.sep).join('/')),
  )
  // scripts/pack-manifest.txt is the test-side oracle for what the tarball ships;
  // production still derives the scan from package.json `files`, which pack:check
  // keeps in agreement with the manifest.
  const manifest = fs
    .readFileSync(path.join(repoRoot, 'scripts', 'pack-manifest.txt'), 'utf8')
    .split('\n')
    .filter(Boolean)
  const shipped = manifest.filter(
    (file) => file.endsWith('.md') && file !== 'CHANGELOG.md' && !file.startsWith('docs/adr/'),
  )
  assert.ok(shipped.length > 0, 'scripts/pack-manifest.txt must list the shipped markdown')
  for (const page of shipped) {
    assert.ok(pages.has(page), `${page} must be a current page (scanned ${pages.size} pages)`)
  }
  // tests/README.md is contributor-facing but not in the tarball; the three skills
  // pages come from the shipped `skills/` directory, not a root file entry.
  for (const page of [
    'tests/README.md',
    'skills/tower-recovery.md',
    'skills/tower-review.md',
    'skills/tower-worker-protocol.md',
  ]) {
    assert.ok(pages.has(page), `${page} must be a current page (scanned ${pages.size} pages)`)
  }
  // The ADR tree is history and stays out of the scan.
  assert.ok(!pages.has('docs/adr/0001-ports-adapters-as-data.md'))
})

test('F56: a retired name appended to a shipped page fails the scan', (t) => {
  const copy = copyRepo(t)
  assert.deepEqual(retiredToolNameProblems(copy), [])

  fs.appendFileSync(
    path.join(copy, 'SECURITY.md'),
    '- The merge gate: run `tower_preflight` before you merge.\n',
  )

  const problems = retiredToolNameProblems(copy)
  assert.ok(
    problems.some(
      (problem) => problem.startsWith('SECURITY.md:') && problem.includes('"tower_preflight"'),
    ),
    problems.join('\n'),
  )
})

test('F56: a "2.3.0" line no longer exempts a retired name', (t) => {
  const copy = copyRepo(t)
  assert.deepEqual(retiredToolNameProblems(copy), [])

  fs.appendFileSync(
    path.join(copy, 'docs', 'reference', 'tools.md'),
    'At 2.3.0 the doctor surface was `tower_doctor`.\n',
  )

  const problems = retiredToolNameProblems(copy)
  assert.ok(
    problems.some(
      (problem) =>
        problem.startsWith('docs/reference/tools.md:') && problem.includes('"tower_doctor"'),
    ),
    problems.join('\n'),
  )
})

test('F56: only the marked 2.9.0 migration block may pair an old name with its replacement', (t) => {
  const copy = copyRepo(t)
  const file = path.join(copy, 'docs', 'guide', 'install-upgrade-migration.md')
  const begin = '<!-- tower-retired-names:begin 2.9.0-migration -->'
  const end = '<!-- tower-retired-names:end 2.9.0-migration -->'
  const original = fs.readFileSync(file, 'utf8')
  assert.ok(original.includes(begin) && original.includes(end), 'the migration page must carry its marker pair')

  // Inside the block, a line that also names the live replacement is allowed.
  const paired = original.replace(
    begin,
    `${begin}\n  \`tower_doctor\` is now the \`doctor\` view of \`tower_inspect\`.`,
  )
  fs.writeFileSync(file, paired)
  assert.deepEqual(retiredToolNameProblems(copy), [])

  // Unpaired inside the block, and anywhere outside it, still fails.
  fs.writeFileSync(
    file,
    paired.replace(
      end,
      `- \`tower_doctor\` was already retired.\n${end}\n\n\`tower_doctor\` must not be called in 2.9.0.\n`,
    ),
  )
  const problems = retiredToolNameProblems(copy).filter((problem) => problem.includes('"tower_doctor"'))
  assert.equal(problems.length, 2, problems.join('\n'))

  // A page that loses its marker pair fails closed instead of widening the block.
  const unmarked = copyRepo(t)
  const unmarkedFile = path.join(unmarked, 'docs', 'guide', 'install-upgrade-migration.md')
  fs.writeFileSync(unmarkedFile, fs.readFileSync(unmarkedFile, 'utf8').replace(begin, ''))
  assert.ok(
    retiredToolNameProblems(unmarked).some((problem) =>
      problem.includes('must keep its "<!-- tower-retired-names:begin 2.9.0-migration -->"'),
    ),
    'a missing begin marker must be reported',
  )
})

test('linkProblems reports a broken relative link', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-docs-link-'))
  t.after(() => removeTemp(root))
  fs.mkdirSync(path.join(root, 'docs'))
  fs.writeFileSync(path.join(root, 'docs', 'broken.md'), '# Broken\n\n[missing](missing.md)\n')

  const problems = linkProblems(root)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /docs[\\/]broken\.md links to missing missing\.md/)
})

// F76 (extended by F87/M120): the `tower_recover` description is the only tool
// text an agent reads, so it must advertise every record the tool repairs: the
// state lock, the short-lived state-commit mutex (M103) and the repository
// workspace lock (F87, the door out of a torn workspace lock). Assert the
// registered description AND its generated row; dropping one record is drift.
test('F76: the tower_recover description covers every writer fence', () => {
  const generated = fs.readFileSync(path.join(repoRoot, 'docs', 'reference', 'tools.generated.md'), 'utf8')
  const row = generated.split('\n').find((line) => line.startsWith('| `tower_recover` |'))
  assert.ok(row, 'docs/reference/tools.generated.md must carry the tower_recover row')
  assert.match(row, /state[- ]lock/i, 'the generated description must mention the state lock')
  assert.match(row, /commit/i, 'the generated description must mention the commit mutex')
  assert.match(row, /workspace[- ]lock/i, 'the generated description must mention the workspace lock')

  // The generated row is a rendering of the registered description; check the
  // source too so a stale generated file cannot hide a drift in tools/recover.js.
  const surface = loadShippedToolSurface()
  try {
    const definition = surface.definitions.get('tower_recover')
    assert.ok(definition, 'the shipped surface must register tower_recover')
    assert.match(definition.description, /state[- ]lock/i, 'tower_recover must advertise the state lock')
    assert.match(definition.description, /commit/i, 'tower_recover must advertise the commit mutex')
    assert.match(definition.description, /workspace[- ]lock/i, 'tower_recover must advertise the workspace lock')
  } finally {
    surface.dispose()
  }
})

// F81: README.md and README.en.md state the window the bundled patch installs.
// The number there is the install-time behavior a reader trusts, so compare it
// against cordis.patch.yml itself rather than a second hard-coded constant.
// (The comment in tests/tasks-command.test.mjs is not the install contract.)
test('F81: both READMEs quote the bundled spawn.staleMs window', () => {
  const patch = fs.readFileSync(path.join(repoRoot, 'cordis.patch.yml'), 'utf8')
  const patchMatch = patch.match(/^\s*staleMs:\s*(\d+)\s*$/m)
  assert.ok(patchMatch, 'cordis.patch.yml must set spawn.staleMs explicitly')
  const bundledMs = Number(patchMatch[1])
  const bundledSeconds = bundledMs / 1000

  const readmeWindows = [
    ['README.md', /`spawn\.staleMs`\s*设为\s*(\d+)s/],
    ['README.en.md', /`spawn\.staleMs`\s*to\s*(\d+)s/],
  ]
  for (const [page, pattern] of readmeWindows) {
    const text = fs.readFileSync(path.join(repoRoot, page), 'utf8')
    const match = text.match(pattern)
    assert.ok(match, `${page} must state the bundled spawn.staleMs window in seconds`)
    const seconds = Number(match[1])
    assert.equal(
      seconds * 1000,
      bundledMs,
      `${page} says ${seconds}s but cordis.patch.yml sets spawn.staleMs: ${bundledMs} (${bundledSeconds}s)`,
    )
  }
})

/** The one deny-table row for a capability id. */
function denyRow(page, id) {
  const row = fs
    .readFileSync(page, 'utf8')
    .split('\n')
    .find((line) => line.startsWith(`| \`${id}\` `))
  assert.ok(row, `${page} must carry the ${id} row`)
  return row
}

/** Replace one cell (0-based over the pipe-split line, so 1 is the capability). */
function replaceDenyCell(row, index, value) {
  const cells = row.split('|')
  cells[index] = ` ${value} `
  return cells.join('|')
}

test('#191: every deny-surface entry must have a documented deny-table row', (t) => {
  assert.deepEqual(denyTableProblems(repoRoot), [])

  // Seeding an owner the docs do not know about reddens exactly like adding it
  // to domain/generated/deny-surface.js would: inventory first, docs:check second.
  const seeded = denyTableProblems(repoRoot, {
    owners: { ...DENY_OWNER_TOOLS, 'tool-seeded': ['seeded_tool'] },
  })
  assert.ok(
    seeded.some((problem) => problem.includes('missing deny table rows for: tool-seeded')),
    seeded.join('\n'),
  )

  const copy = copyRepo(t)
  const page = path.join(copy, DENY_DOC_PAGE)
  const row = denyRow(page, 'tool-ralph')
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace(`${row}\n`, ''))

  const problems = denyTableProblems(copy)
  assert.ok(
    problems.some((problem) => problem.includes('missing deny table rows for: tool-ralph')),
    problems.join('\n'),
  )
})

test('#191: a denied-tools cell must track the generated deny surface', () => {
  const seeded = denyTableProblems(repoRoot, {
    owners: {
      ...DENY_OWNER_TOOLS,
      'tool-todo': [...DENY_OWNER_TOOLS['tool-todo'], 'todo_seeded'],
    },
  })
  assert.ok(
    seeded.some((problem) => problem.includes('tool-todo is missing denied tools: todo_seeded')),
    seeded.join('\n'),
  )
})

test('#191: a malformed deny row fails instead of being trusted', (t) => {
  // Stance must come from CAPABILITY_STANCE; "deny" is the only owner stance.
  const stanceCopy = copyRepo(t)
  const stancePage = path.join(stanceCopy, DENY_DOC_PAGE)
  const stanceRow = denyRow(stancePage, 'tool-goal')
  fs.writeFileSync(
    stancePage,
    fs.readFileSync(stancePage, 'utf8').replace(stanceRow, replaceDenyCell(stanceRow, 3, 'warn+allow')),
  )
  assert.ok(
    denyTableProblems(stanceCopy).some((problem) =>
      problem.includes('tool-goal is a denied owner, so its stance must be "deny"'),
    ),
  )

  // Coverage outside full/partial/none is a docs claim with no meaning.
  const coverageCopy = copyRepo(t)
  const coveragePage = path.join(coverageCopy, DENY_DOC_PAGE)
  const coverageRow = denyRow(coveragePage, 'tool-todo')
  fs.writeFileSync(
    coveragePage,
    fs.readFileSync(coveragePage, 'utf8').replace(coverageRow, replaceDenyCell(coverageRow, 5, 'most')),
  )
  assert.ok(
    denyTableProblems(coverageCopy).some((problem) =>
      problem.includes('tool-todo coverage "most" must be full, partial or none'),
    ),
  )

  // A "full" replacement that names no tower_ tool is a claim with no mechanism.
  const replacementCopy = copyRepo(t)
  const replacementPage = path.join(replacementCopy, DENY_DOC_PAGE)
  const replacementRow = denyRow(replacementPage, 'tool-subagent')
  fs.writeFileSync(
    replacementPage,
    fs
      .readFileSync(replacementPage, 'utf8')
      .replace(replacementRow, replaceDenyCell(replacementRow, 4, 'the same thing, somehow')),
  )
  assert.ok(
    denyTableProblems(replacementCopy).some((problem) =>
      problem.includes('tool-subagent has coverage full, so its replacement must name at least one tower_ tool'),
    ),
  )

  // Without the markers the table is prose, and prose is not checked.
  const markerCopy = copyRepo(t)
  const markerPage = path.join(markerCopy, DENY_DOC_PAGE)
  fs.writeFileSync(
    markerPage,
    fs.readFileSync(markerPage, 'utf8').replace('<!-- tower-deny-table:begin -->', ''),
  )
  assert.ok(
    denyTableProblems(markerCopy).some((problem) =>
      problem.includes('is missing the "<!-- tower-deny-table:begin -->" marker'),
    ),
  )
})

test('#191: a Chinese deny page must mirror the English rows in order', (t) => {
  // The committed mirror is required: deleting it fails instead of silently
  // skipping the parity block. Its header labels are translated, which the
  // first assertion proves the parser accepts while comparing every row cell.
  assert.deepEqual(denyTableProblems(repoRoot), [])

  const missing = copyRepo(t)
  fs.rmSync(path.join(missing, DENY_DOC_PAGE_ZH))
  assert.ok(
    denyTableProblems(missing).some((problem) => problem.includes(`${DENY_DOC_PAGE_ZH} is missing`)),
    'a missing Chinese deny page must fail the check',
  )

  const copy = copyRepo(t)
  const zhDir = path.join(copy, 'docs', 'zh', 'reference')
  fs.mkdirSync(zhDir, { recursive: true })
  const zhPage = path.join(zhDir, 'deny.md')
  fs.copyFileSync(path.join(copy, DENY_DOC_PAGE), zhPage)
  // Identical rows are a valid mirror, whatever the prose around them says.
  assert.deepEqual(denyTableProblems(copy), [])

  const original = fs.readFileSync(zhPage, 'utf8')
  const goal = denyRow(zhPage, 'tool-goal')
  const todo = denyRow(zhPage, 'tool-todo')
  assert.ok(original.includes(`${goal}\n${todo}\n`), 'the goal/todo rows must be adjacent')
  fs.writeFileSync(zhPage, original.replace(`${goal}\n${todo}\n`, `${todo}\n${goal}\n`))
  assert.ok(
    denyTableProblems(copy).some((problem) =>
      problem.includes('must list the same rows in the same order'),
    ),
  )

  fs.writeFileSync(zhPage, original)
  const mirrorRow = denyRow(zhPage, 'tool-agent-team')
  fs.writeFileSync(
    zhPage,
    original.replace(mirrorRow, replaceDenyCell(mirrorRow, 5, 'partial')),
  )
  assert.ok(
    denyTableProblems(copy).some((problem) =>
      problem.includes('tool-agent-team coverage "partial" must match the English row "full"'),
    ),
  )
})

/** Install a preset's protocol section against a stub ctx and return its text. */
function protocolSection(apply, sectionName) {
  let section = null
  apply({
    tools: { restrict() {} },
    systemPrompt: {
      section(value) {
        section = value
      },
    },
  })
  assert.ok(section, `${sectionName} must be installed`)
  assert.equal(section.name, sectionName)
  return section.text
}

// #191: the no-ask limitation is not a worker-only fact. The reviewer protocol
// and both child briefings must state the same limitation, or a child that
// needs an approval stalls instead of reporting: approvals fail closed, and an
// open question belongs in the report/blocker or the tower inbox. Dropping the
// sentence from any one of the four texts reddens here.
test('#191: worker/reviewer protocols and both briefings state the no-ask limitation', () => {
  const base = path.join(os.tmpdir(), 'tower-docs-truth-noask')
  const worktree = { path: path.join(base, 'wt'), branch: 'tower/m1-noask', baseCommit: 'a'.repeat(40) }
  const mission = {
    id: 'M1',
    title: 'no-ask fixture',
    kind: 'build',
    scope: ['app/**'],
    tasks: [{ text: 'do it', status: 'open' }],
    context: null,
    references: [],
    reviewPolicy: 'required-clean',
  }
  const texts = [
    ['worker.js', protocolSection(applyWorker, 'tower:worker-protocol')],
    ['reviewer.js', protocolSection(applyReviewer, 'tower:reviewer-protocol')],
    ['workerBriefing', workerBriefing({ repoRoot: base, base: 'main', mission, deps: [], worktree, instructions: null })],
    ['reviewerBriefing', reviewerBriefing({ repoRoot: base, base: 'main', mission, deps: [], worktree, review: null, instructions: null })],
  ]
  for (const [label, text] of texts) {
    assert.match(text, /cannot ask the user/i, `${label} must state that a child cannot ask the user`)
    assert.match(text, /no approval prompt/i, `${label} must state that there is no approval prompt`)
    assert.match(text, /fails closed/i, `${label} must state that an approval-gated call fails closed`)
    assert.match(text, /tower inbox/i, `${label} must name the tower inbox as an escalation path`)
  }
})
