// CI workflow contract (#M72): the canonical gate, the one-cycle transition
// contexts, least-privilege permissions, pinned actions and the nightly failure
// reporter are checked in scripts/check-workflow.mjs. This file proves each
// rule is load-bearing: every case tampers with the real workflow (or the real
// package scripts) and expects the named problem, so the gate cannot silently
// stop checking something.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  evaluatePackageWire,
  evaluateWorkflow,
  SUPPORTED_CONTEXTS,
  WORKFLOW_FILE,
} from '../scripts/check-workflow.mjs'
import { removeTemp } from './helpers/cleanup.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(repoRoot, 'scripts', 'check-workflow.mjs')
const workflow = fs.readFileSync(path.join(repoRoot, WORKFLOW_FILE), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

/** Replace one anchor exactly once; a missing anchor means the fixture rotted. */
function tamper(from, to) {
  assert.ok(workflow.includes(from), `tamper anchor is missing from the workflow: ${JSON.stringify(from)}`)
  const next = workflow.replace(from, to)
  assert.notEqual(next, workflow, 'the tamper must change the workflow')
  return next
}

const problemsFor = (text) => evaluateWorkflow(text).problems

test('the checked-in workflow satisfies the CI contract', () => {
  const result = evaluateWorkflow(workflow)
  assert.deepEqual(result.problems, [])
  assert.equal(result.ok, true)
  assert.deepEqual(result.facts.canonicalLegs, SUPPORTED_CONTEXTS)
  assert.deepEqual(result.facts.requiredContexts, ['test (22)', 'test (24)', 'test (22, windows)', 'mount'])
  assert.ok(result.facts.pinnedActions >= 6, 'most actions must be SHA-pinned')
  assert.deepEqual(result.facts.legacyTagPins, ['actions/cache@v4', 'actions/upload-artifact@v4'])
  assert.equal(result.facts.nightlyFailureJob, true)
  assert.deepEqual(evaluatePackageWire(pkg).problems, [])
})

test('tamper: a canonical leg that does not run the canonical gate is rejected', () => {
  const text = tamper(
    '      - name: Canonical gate (npm run check)\n        run: npm run check',
    '      - name: Canonical gate (npm run check)\n        run: npm test',
  )
  const problems = problemsFor(text)
  assert.ok(problems.some((problem) => problem.includes('must run "npm run check" exactly once')), JSON.stringify(problems))
})

test('tamper: a second canonical step is rejected', () => {
  const text = tamper(
    '      - name: Canonical gate (npm run check)\n        run: npm run check',
    '      - name: Canonical gate (npm run check)\n        run: npm run check\n      - name: Second canonical gate\n        run: npm run check',
  )
  const problems = problemsFor(text)
  assert.ok(problems.some((problem) => problem.includes('found 2')), JSON.stringify(problems))
})

test('tamper: removing a required legacy context is rejected', () => {
  const text = tamper('          - name: test (22)\n', '          - name: test (22, legacy)\n')
  const problems = problemsFor(text)
  assert.ok(problems.some((problem) => problem.includes('legacy matrix must be exactly')), JSON.stringify(problems))
})

test('tamper: renaming the required mount context is rejected', () => {
  const text = tamper('    name: mount\n', '    name: mount-legacy\n')
  const problems = problemsFor(text)
  assert.ok(problems.some((problem) => problem.includes('"mount" job context is missing')), JSON.stringify(problems))
})

test('tamper: an unpinned action is rejected', () => {
  const text = tamper(
    'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2',
    'actions/checkout@v4',
  )
  const problems = problemsFor(text)
  assert.ok(problems.some((problem) => problem.includes('is not pinned to a 40-hex commit SHA')), JSON.stringify(problems))
})

test('tamper: a SHA pin without a version comment is rejected', () => {
  const text = tamper(
    'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2',
    'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
  )
  const problems = problemsFor(text)
  assert.ok(problems.some((problem) => problem.includes('needs a "# vX.Y.Z" version comment')), JSON.stringify(problems))
})

test('tamper: dropping the tag-pin exception comment is rejected', () => {
  const text = tamper('uses: actions/cache@v4 # tag pin: v4.2.3', 'uses: actions/cache@v4')
  const problems = problemsFor(text)
  assert.ok(problems.some((problem) => problem.includes('must say "tag pin"')), JSON.stringify(problems))
})

test('tamper: widening the top-level permissions is rejected', () => {
  const text = tamper('permissions:\n  contents: read\n', 'permissions:\n  contents: write\n')
  const problems = problemsFor(text)
  assert.ok(problems.some((problem) => problem.includes('top-level permissions must be exactly')), JSON.stringify(problems))
})

test('tamper: a per-job permissions override is rejected', () => {
  const text = tamper(
    '  mount:\n    name: mount\n    runs-on: ubuntu-latest',
    '  mount:\n    name: mount\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest',
  )
  const problems = problemsFor(text)
  assert.ok(problems.some((problem) => problem.includes('only the nightly failure reporter')), JSON.stringify(problems))
})

test('tamper: cancelling scheduled runs is rejected', () => {
  const text = tamper(
    "cancel-in-progress: ${{ github.event_name == 'push' || github.event_name == 'pull_request' }}",
    'cancel-in-progress: true',
  )
  const problems = problemsFor(text)
  assert.ok(problems.some((problem) => problem.includes('cancel-in-progress must be limited to pushes/PRs')), JSON.stringify(problems))
})

test('tamper: an unsupported canonical Node version is rejected', () => {
  const text = tamper("            node: '25'\n", "            node: '22'\n")
  const problems = problemsFor(text)
  assert.ok(problems.some((problem) => problem.includes('must run Node 25')), JSON.stringify(problems))
})

test('tamper: moving the Node-24-only extras onto every leg is rejected', () => {
  const text = tamper('            release: false\n            label: test (24.9, windows)', '            release: true\n            label: test (24.9, windows)')
  const problems = problemsFor(text)
  assert.ok(problems.some((problem) => problem.includes('must set release: false')), JSON.stringify(problems))
})

test('tamper: a job that runs npm ci without the npm cache is rejected', () => {
  const text = tamper('          cache: npm\n', '')
  const problems = problemsFor(text)
  assert.ok(problems.some((problem) => problem.includes('must set cache: npm')), JSON.stringify(problems))
})

test('tamper: unbounded artifact retention is rejected', () => {
  const text = tamper('          retention-days: 7', '          retention-days: 90')
  const problems = problemsFor(text)
  assert.ok(problems.some((problem) => problem.includes('retention-days between 1 and 14')), JSON.stringify(problems))
})

test('tamper: a nightly reporter without issues:write is rejected', () => {
  const text = tamper('      issues: write\n', '      issues: read\n')
  const problems = problemsFor(text)
  assert.ok(problems.some((problem) => problem.includes('must grant issues: write')), JSON.stringify(problems))
})

test('tamper: the nightly reporter must not run on every event', () => {
  const text = tamper(
    "if: always() && github.event_name == 'schedule' && contains(needs.*.result, 'failure')",
    'if: always()',
  )
  const problems = problemsFor(text)
  assert.ok(problems.some((problem) => problem.includes("must be schedule-only")), JSON.stringify(problems))
})

test('tamper: the nightly reporter must update the existing issue, not open one per failure', () => {
  const text = tamper('gh issue comment "$number" --body "$body"', 'gh issue close "$number"')
  const problems = problemsFor(text)
  assert.ok(problems.some((problem) => problem.includes('update the existing issue')), JSON.stringify(problems))
})

test('tamper: package.json must keep workflow:check inside npm run check', () => {
  const missingScript = JSON.parse(JSON.stringify(pkg))
  delete missingScript.scripts['workflow:check']
  assert.ok(
    evaluatePackageWire(missingScript).problems.some((problem) => problem.includes('script "workflow:check" must be')),
  )

  const missingStep = JSON.parse(JSON.stringify(pkg))
  missingStep.scripts.check = missingStep.scripts.check.replace('npm run workflow:check && ', '')
  assert.ok(
    evaluatePackageWire(missingStep).problems.some((problem) => problem.includes('"check" must include "npm run workflow:check"')),
  )
})

test('the CLI is green on the checkout and fails on a tampered copy', (t) => {
  const ok = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(
    ok.stdout,
    /^workflow check: 3 canonical legs run "npm run check" once; 4 required legacy contexts preserved; \d+ actions SHA-pinned; 2 documented tag-pin exceptions; nightly failure issue job present$/m,
  )

  const json = spawnSync(process.execPath, [script, '--json'], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(json.status, 0, json.stderr)
  const parsed = JSON.parse(json.stdout)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.problems, [])

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-workflow-'))
  t.after(() => removeTemp(root))
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true })
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'test.yml'), tamper('permissions:\n  contents: read\n', 'permissions:\n  contents: write\n'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2))
  const bad = spawnSync(process.execPath, [script, '--root', root], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /workflow check: permissions: top-level permissions must be exactly/)
})
