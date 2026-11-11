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

import { checkDocs, linkProblems } from '../scripts/check-docs.mjs'
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

test('linkProblems reports a broken relative link', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-docs-link-'))
  t.after(() => removeTemp(root))
  fs.mkdirSync(path.join(root, 'docs'))
  fs.writeFileSync(path.join(root, 'docs', 'broken.md'), '# Broken\n\n[missing](missing.md)\n')

  const problems = linkProblems(root)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /docs[\\/]broken\.md links to missing missing\.md/)
})
