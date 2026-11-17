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

import { checkDocs, currentDocPages, linkProblems, retiredToolNameProblems, toolTableRowProblems } from '../scripts/check-docs.mjs'
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
