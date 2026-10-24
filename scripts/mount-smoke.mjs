#!/usr/bin/env node
// Mount smoke (#95): does the *packed* bundle mount and register what it claims?
//
//   npm run smoke:mount              # pack, install the pinned host, boot, assert
//   node scripts/mount-smoke.mjs --root <repo> --host-dir <dir> --keep
//
// The command packs this package, installs the host build pinned in
// scripts/mount-smoke/host.json into a throwaway directory, creates a throwaway
// DSH home and profile, adds the tarball through the plugin CLI, and boots the
// composed profile through the real loader (scripts/mount-smoke/probe.mjs).
// It then asserts the LOADED surface — registered tool ids, the bundled skills,
// both presets, the /tower command, and the single top-level bundle row — never
// the text of cordis.patch.yml. No model call and no browser.
//
// A red run prints the resolved profile path, the host build, the loaded counts
// and every failed claim, and keeps the temporary workspace for inspection.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLE_ID,
  DEFAULT_OFF_ROW_IDS,
  INDEX_TOOL_IDS,
  PRESET_IDS,
  checkBundleRow,
  checkPresetLabels,
  checkPresetRows,
  checkRowStates,
  compareIds,
  expectedSkillIds,
  expectedToolIds,
} from './mount-smoke/surface.mjs'
import { parseArgs, runMain } from './lib/cli.mjs'
import { removeTreeQuietly } from './lib/tmp.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const probePath = path.join(scriptDir, 'mount-smoke', 'probe.mjs')
const pinPath = path.join(scriptDir, 'mount-smoke', 'host.json')

function parseOptions(argv) {
  return parseArgs(argv, {
    initial: { root: repoRoot, hostDir: undefined, profile: 'tower-smoke', keep: false },
    values: {
      '--root': { key: 'root', parse: path.resolve },
      '--host-dir': { key: 'hostDir', parse: path.resolve },
      '--profile': 'profile',
    },
    flags: { '--keep': 'keep' },
    error: (message) => new Error(message),
    optionLikeValues: false,
  })
}

/** npm's JS entry, so no shell (and no quoting) is involved on any platform. */
function npmInvocation() {
  const nodeDir = path.dirname(process.execPath)
  const candidates = [
    process.env.npm_execpath,
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate) => typeof candidate === 'string' && candidate.endsWith('.js'))
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { command: process.execPath, prefix: [candidate], shell: false }
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [], shell: process.platform === 'win32' }
}

function run(command, args, { cwd, env, timeout, label, shell = false }) {
  const result = spawnSync(command, args, { cwd, env, timeout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.error) throw new Error(`${label} could not run: ${result.error.message}\n${output.slice(-2000)}`)
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status}):\n${output.slice(-4000)}`)
  return result
}

function childEnv(home) {
  return { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
}

function readHostVersion(hostDir) {
  const manifest = path.join(hostDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (!fs.existsSync(manifest)) return null
  return JSON.parse(fs.readFileSync(manifest, 'utf8')).version
}

function ensureHost(hostDir, pin, npm, env) {
  const existing = readHostVersion(hostDir)
  if (existing !== null) {
    if (existing !== pin.dsh) throw new Error(`host: ${hostDir} has @deepseek-ai/dsh@${existing}; the pin is ${pin.dsh}`)
    return existing
  }
  fs.mkdirSync(hostDir, { recursive: true })
  run(
    npm.command,
    [...npm.prefix, 'install', '--prefix', hostDir, '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error', `@deepseek-ai/dsh@${pin.dsh}`],
    { cwd: hostDir, env, timeout: 300_000, label: `host install (@deepseek-ai/dsh@${pin.dsh})`, shell: npm.shell },
  )
  const installed = readHostVersion(hostDir)
  if (installed !== pin.dsh) throw new Error(`host install: installed @deepseek-ai/dsh@${installed}, expected pin ${pin.dsh}`)
  return installed
}

function pack(root, packDir, npm, env) {
  fs.mkdirSync(packDir, { recursive: true })
  const result = run(npm.command, [...npm.prefix, 'pack', '--json', '--pack-destination', packDir], {
    cwd: root,
    env,
    timeout: 120_000,
    label: 'npm pack',
    shell: npm.shell,
  })
  const stdout = result.stdout ?? ''
  const start = stdout.indexOf('[')
  if (start < 0) throw new Error(`npm pack: no JSON on stdout:\n${stdout.slice(-2000)}`)
  const parsed = JSON.parse(stdout.slice(start))
  const info = Array.isArray(parsed) ? parsed[0] : parsed
  if (!info?.filename) throw new Error(`npm pack: no filename in ${JSON.stringify(info)}`)
  return { tarball: path.join(packDir, info.filename), name: info.name, version: info.version }
}

/**
 * The smoke profile is a bare @deepseek-ai/dsh-base profile; the bundle's two
 * preset rows need the agent-preset registry that every shipped web profile
 * mounts. Add that one host row to the throwaway profile's own patch layer so
 * the preset claims are checked against the real registry, not row presence.
 */
const PROFILE_OVERLAY = `# Added by scripts/mount-smoke.mjs (#95).
- insert:
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: standard
        selectedDefault: standard
`

/** Read one surface area, or report why it is unavailable. */
function area(surface, key, label, failures) {
  const entry = surface?.[key]
  if (!entry) {
    failures.push(`${label}: the probe reported no ${key} surface`)
    return null
  }
  if (entry.error) {
    failures.push(`${label}: ${entry.error}`)
    return null
  }
  return entry.value
}

function toolModuleNames(root) {
  return fs.readdirSync(path.join(root, 'tools')).filter((name) => name.endsWith('.js'))
}

function verifySurface(surface, root) {
  const failures = []
  const expectedTools = expectedToolIds(toolModuleNames(root))
  const expectedSkills = expectedSkillIds(fs.readdirSync(path.join(root, 'skills')))

  const loadedTools = area(surface, 'tools', 'tool', failures)
  if (loadedTools) failures.push(...compareIds('tool', expectedTools, loadedTools.filter((name) => name.startsWith('tower_'))))

  const loadedSkills = area(surface, 'skills', 'skill', failures)
  if (loadedSkills) failures.push(...compareIds('skill', expectedSkills, loadedSkills.tower))

  const loadedPresets = area(surface, 'presets', 'preset', failures)
  if (loadedPresets) {
    failures.push(...compareIds('preset', PRESET_IDS, loadedPresets.ids ?? []))
    // Both preset rows must still activate: ids, display names/orders and no
    // registry activation diagnostic (#121).
    failures.push(...checkPresetRows(loadedPresets.entries ?? []))
  }

  // The Plugins page reads the label through `readPluginMeta`; the two preset
  // rows used to share one module and rendered the same title. Prove the
  // installed package now resolves a distinct label per row (#121).
  const loadedLabels = area(surface, 'labels', 'label', failures)
  if (loadedLabels) failures.push(...checkPresetLabels(loadedLabels))

  const loadedCommands = area(surface, 'commands', 'command', failures)
  if (loadedCommands && !loadedCommands.includes('tower')) failures.push('command: /tower is not registered in the loaded command registry')

  const tree = area(surface, 'tree', 'bundle', failures)
  if (tree) {
    failures.push(...checkBundleRow(tree.top, tree.states))
    // The bundle was replaced row-by-row (#121); prove no row failed to activate
    // or is still waiting, not only that the expected rows are active.
    failures.push(...checkRowStates(tree.states))
  }

  return failures
}

function summarize(surface, root) {
  const modules = toolModuleNames(root).filter((name) => name !== 'index.js').length
  const expected = expectedToolIds(toolModuleNames(root)).length
  const tools = Array.isArray(surface?.tools?.value) ? surface.tools.value.filter((name) => name.startsWith('tower_')).length : '?'
  const skills = Array.isArray(surface?.skills?.value?.tower) ? surface.skills.value.tower.length : '?'
  const presets = Array.isArray(surface?.presets?.value?.ids) ? surface.presets.value.ids.length : '?'
  const labels = surface?.labels?.value && typeof surface.labels.value === 'object' ? Object.keys(surface.labels.value).length : '?'
  const commands = Array.isArray(surface?.commands?.value) ? surface.commands.value.filter((name) => name === 'tower').length : '?'
  const rows = Array.isArray(surface?.tree?.value?.top) ? surface.tree.value.top.filter((row) => row.id === BUNDLE_ID).length : '?'
  return `${tools} of ${expected} tower tools (${modules} modules + ${INDEX_TOOL_IDS.length} entry tools; ${DEFAULT_OFF_ROW_IDS.join(', ')} off), ${skills} skills, ${presets} presets (${labels} distinct labels), /tower ${commands === 1 ? 'present' : 'missing'}, ${rows} top-level bundle row`
}

function reportFailure(state, pin, options, error) {
  const surface = state.surface
  console.error('')
  console.error(
    `mount smoke failed: ${state.packed ? `${state.packed.name}@${state.packed.version}` : 'dsh-tower'} did not mount as claimed on @deepseek-ai/dsh@${pin.dsh}`,
  )
  if (error) console.error(`  error:   ${error.message}`)
  console.error(`  host:    @deepseek-ai/dsh@${state.hostVersion ?? readHostVersion(state.hostDir) ?? pin.dsh} (${state.hostDir})`)
  console.error(`  profile: ${state.profileDir}`)
  console.error(`  tarball: ${state.tarball ?? '(not packed)'}`)
  if (surface) console.error(`  loaded:  ${summarize(surface, options.root)}`)
  for (const failure of state.failures) console.error(`  - ${failure}`)
  console.error(`  workspace kept: ${state.tmp}`)
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const root = options.root
  if (!fs.existsSync(path.join(root, 'package.json'))) throw new Error(`mount smoke: ${root} is not a package root`)
  const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'))
  const npm = npmInvocation()
  const started = Date.now()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tower-mount-'))
  const home = path.join(tmp, 'home')
  const hostDir = options.hostDir ?? path.join(tmp, 'host')
  const profileDir = path.join(home, 'profiles', options.profile)
  const state = { tmp, home, hostDir, profileDir, tarball: null, packed: null, surface: null, failures: [] }

  let error = null
  try {
    const hostVersion = ensureHost(hostDir, pin, npm, childEnv(home))
    state.hostVersion = hostVersion

    state.packed = pack(root, path.join(tmp, 'pack'), npm, childEnv(home))
    state.tarball = state.packed.tarball

    fs.mkdirSync(home, { recursive: true })
    const pluginBin = path.join(hostDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    run(process.execPath, [pluginBin, 'plugin', '--profile', options.profile, 'add', state.tarball], {
      cwd: tmp,
      env: childEnv(home),
      timeout: 180_000,
      label: `dsh plugin add (${path.basename(state.tarball)})`,
    })

    const profileManifestPath = path.join(profileDir, 'package.json')
    if (!fs.existsSync(profileManifestPath)) throw new Error(`profile: plugin add did not create ${profileManifestPath}`)
    const profileManifest = JSON.parse(fs.readFileSync(profileManifestPath, 'utf8'))
    const bundles = profileManifest?.dsh?.profile?.bundles ?? []
    if (!bundles.includes(state.packed.name)) {
      throw new Error(`profile: plugin add did not add ${state.packed.name} to dsh.profile.bundles (got ${JSON.stringify(bundles)})`)
    }
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), PROFILE_OVERLAY)

    const surfacePath = path.join(tmp, 'surface.json')
    run(process.execPath, [probePath, '--home', home, '--host', hostDir, '--profile', options.profile, '--out', surfacePath], {
      cwd: tmp,
      env: childEnv(home),
      timeout: 180_000,
      label: 'profile boot',
    })
    state.surface = JSON.parse(fs.readFileSync(surfacePath, 'utf8'))
    state.failures = verifySurface(state.surface, root)
  } catch (caught) {
    error = caught
  }

  if (error || state.failures.length > 0) {
    reportFailure(state, pin, options, error)
    return 1
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`mount smoke ok: ${state.packed.name}@${state.packed.version} mounts on @deepseek-ai/dsh@${state.hostVersion} (${seconds}s)`)
  console.log(`  profile: ${profileDir}`)
  console.log(`  loaded:  ${summarize(state.surface, root)}`)
  if (options.keep) {
    console.log(`  workspace kept: ${tmp}`)
  } else {
    removeTreeQuietly(tmp)
  }
  return 0
}

await runMain(import.meta.url, main, { errorPrefix: 'mount smoke failed' })
