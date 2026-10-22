#!/usr/bin/env node
// Seeded failure fixtures for the mount smoke (#95).
//
//   npm run smoke:fixtures
//   node scripts/mount-smoke/fixtures.mjs --host-dir <installed-host> --keep
//
// The real smoke proves the current tree mounts. These fixtures prove it can
// still fail for the right reason: each one copies the package into a temp
// directory, breaks exactly one claim the bundle makes, runs the smoke against
// the copy, and requires a red run that names the cause. A green control run
// comes first, so a broken environment is never mistaken for a caught bug.
//
// The fixtures run in CI as the non-required `mount-fixtures` job, with one
// cached host install shared by the control and both seeds through --host-dir;
// locally the short form is `npm run smoke:fixtures`.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, runMain } from '../lib/cli.mjs'
import { removeTreeQuietly } from '../lib/tmp.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..', '..')
const smokePath = path.join(scriptDir, '..', 'mount-smoke.mjs')

function parseOptions(argv) {
  return parseArgs(argv, {
    initial: { root: repoRoot, hostDir: undefined, keep: false },
    values: {
      '--root': { key: 'root', parse: path.resolve },
      '--host-dir': { key: 'hostDir', parse: path.resolve },
    },
    flags: { '--keep': 'keep' },
    error: (message) => new Error(message),
    optionLikeValues: false,
  })
}

function copyPackage(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source)
      return base !== 'node_modules' && base !== '.git'
    },
  })
}

function replaceOnce(text, search, replacement, label) {
  const next = text.replace(search, replacement)
  if (next === text) throw new Error(`seed did not apply: ${label}`)
  return next
}

const fixtures = [
  {
    name: 'renamed-tool-id',
    what: 'one tool module registers an id the bundle does not claim',
    seed(root) {
      const file = path.join(root, 'tools', 'doctor.js')
      const text = fs.readFileSync(file, 'utf8')
      fs.writeFileSync(file, replaceOnce(text, "name: 'tower_doctor'", "name: 'tower_doctor_renamed'", 'tools/doctor.js tower_doctor'))
    },
    expect: ['tool: missing tower_doctor', 'tool: unexpected tower_doctor_renamed'],
  },
  {
    name: 'dropped-skills-section',
    what: 'the tower-skills row is removed from the bundle patch',
    seed(root) {
      const file = path.join(root, 'cordis.patch.yml')
      const text = fs.readFileSync(file, 'utf8')
      const next = replaceOnce(
        text,
        /\n {8}- id: tower-skills\n {10}name: 'dsh-tower\/skills'/,
        '',
        'cordis.patch.yml tower-skills row',
      )
      fs.writeFileSync(file, next)
    },
    expect: ['skill: missing tower-worker-protocol', 'bundle: tower-bundle is missing child tower-skills'],
  },
]

function runSmoke(root, hostDir) {
  const result = spawnSync(process.execPath, [smokePath, '--root', root, '--host-dir', hostDir], {
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}` }
}

function selfDescribing(output) {
  const missing = []
  if (!/^ {2}profile: /m.test(output)) missing.push('the resolved profile path')
  if (!/^ {2}host: {4}@deepseek-ai\/dsh@/m.test(output)) missing.push('the host build')
  return missing
}

function main() {
  const options = parseOptions(process.argv.slice(2))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-mount-fixtures-'))
  const hostDir = options.hostDir ?? path.join(tmp, 'host')
  let failures = 0

  try {
    process.stdout.write(`control: the unmodified package mounts green\n`)
    const control = runSmoke(options.root, hostDir)
    if (control.status !== 0) {
      console.error('control: FAILED — the fixtures cannot distinguish a seed from a broken environment')
      console.error(control.output.slice(-4000))
      failures += 1
    } else {
      console.log('control: PASS')
    }

    for (const fixture of fixtures) {
      const copyRoot = path.join(tmp, fixture.name)
      copyPackage(options.root, copyRoot)
      try {
        fixture.seed(copyRoot)
      } catch (error) {
        console.error(`fixture ${fixture.name}: FAILED to seed — ${error.message}`)
        failures += 1
        continue
      }
      const run = runSmoke(copyRoot, hostDir)
      const problems = []
      if (run.status === 0) problems.push('the smoke stayed green; the seeded break was not detected')
      for (const marker of fixture.expect) if (!run.output.includes(marker)) problems.push(`the red run did not say: ${marker}`)
      for (const missing of selfDescribing(run.output)) problems.push(`the red run did not print ${missing}`)
      if (run.status !== 0 && !run.output.includes('workspace kept:')) problems.push('the red run did not keep its workspace')

      if (problems.length > 0) {
        console.error(`fixture ${fixture.name}: FAILED (${fixture.what})`)
        for (const problem of problems) console.error(`  - ${problem}`)
        console.error(run.output.slice(-4000))
        failures += 1
      } else {
        const kept = /workspace kept: (.+)/.exec(run.output)?.[1]?.trim()
        console.log(`fixture ${fixture.name}: PASS — the smoke failed and named the cause${kept ? ` (workspace ${kept})` : ''}`)
      }
    }
  } finally {
    if (options.keep) {
      console.log(`fixtures workspace kept: ${tmp}`)
    } else {
      removeTreeQuietly(tmp)
    }
  }

  if (failures > 0) {
    console.error(`mount smoke fixtures: ${failures} of ${fixtures.length + 1} expectations failed`)
    return 1
  }
  console.log(`mount smoke fixtures: control + ${fixtures.length} seeded failures behave as required`)
  return 0
}

await runMain(import.meta.url, main, { errorPrefix: 'mount smoke fixtures failed' })
