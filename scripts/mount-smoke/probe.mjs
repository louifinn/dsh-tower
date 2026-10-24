// Boot one throwaway profile through the real DSH loader and report its
// loaded surface as JSON (#95).
//
// This is the only file that touches host internals. It is spawned by
// scripts/mount-smoke.mjs against the pinned @deepseek-ai/dsh install, so the
// entry points below are the ones `dsh` itself calls: `runProfile` composes the
// profile's patch layers, mounts the tree, and hands back the root context.
// No model call, no browser, no session.
//
// Usage: node probe.mjs --home <DSH_HOME> --host <host-install> --profile <name> --out <json>
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PRESET_SPECIFIERS } from './surface.mjs'

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key.startsWith('--') || value === undefined) throw new Error(`probe: bad argument ${JSON.stringify(key)}`)
    options[key.slice(2)] = value
    index += 1
  }
  for (const required of ['home', 'host', 'profile', 'out']) {
    if (!options[required]) throw new Error(`probe: --${required} is required`)
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const home = path.resolve(options.home)
const host = path.resolve(options.host)

// Read by dsh-home-paths through the host's own module graph, so this must be
// set before anything from the host is imported.
process.env.DSH_HOME = home
process.env.DSH_TELEMETRY_DISABLED = '1'

const hostPackage = path.join(host, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const hostVersion = JSON.parse(fs.readFileSync(hostPackage, 'utf8')).version
const profileBoot = path.join(host, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'profile-boot.js')
const appBoot = path.join(host, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
for (const file of [profileBoot, appBoot]) {
  if (!fs.existsSync(file)) throw new Error(`probe: ${file} is missing; host ${hostVersion} does not expose the loader entry point`)
}

const { runProfile } = await import(pathToFileURL(profileBoot).href)
const { loadLayeredEnv, readPluginMeta } = await import(pathToFileURL(appBoot).href)
if (typeof runProfile !== 'function') throw new Error(`probe: host ${hostVersion} does not export runProfile`)

/** Run one surface read, keeping a missing service a reportable value. */
async function read(run) {
  try {
    return { value: await run() }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

const { ctx, shutdown } = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: options.profile,
  patchFiles: [],
  args: [],
})

const surface = { host: { version: hostVersion }, profile: {}, tools: null, skills: null, presets: null, labels: null, commands: null, tree: null }
try {
  const profileContext = ctx.get('profileContext')
  surface.profile = {
    name: options.profile,
    dir: profileContext?.dir ?? path.join(home, 'profiles', options.profile),
    patchPath: profileContext?.patchPath ?? null,
  }

  const tools = ctx.get('tools')
  surface.tools = tools
    ? await read(() => tools.schemas().map((tool) => tool.name))
    : { error: 'the tools service is not mounted' }

  const skills = ctx.get('skills')
  surface.skills = skills
    ? await read(async () => {
        const all = await skills.list()
        return { tower: all.filter((skill) => skill.provider === 'dsh-tower').map((skill) => skill.name), total: all.length }
      })
    : { error: 'the skills service is not mounted' }

  const presets = ctx.get('agentPresets')
  surface.presets = presets
    ? await read(async () => {
        // Both preset rows declare themselves through Tower-owned modules
        // (`dsh-tower/preset-*`). Keep the display metadata and the activation
        // diagnostic so the smoke can prove each row still mounts, not only
        // that two ids exist (#121).
        const list = await presets.list()
        return {
          ids: list.map((preset) => preset.id),
          entries: list.map(({ id, name, description, order, broken }) => ({
            id,
            ...name === undefined ? {} : { name },
            ...description === undefined ? {} : { description },
            ...order === undefined ? {} : { order },
            ...broken === undefined ? {} : { broken },
          })),
        }
      })
    : { error: 'the agentPresets service is not mounted (profile has no preset registry)' }

  // The Plugins page labels a row through this exact call. Resolve both preset
  // row specifiers from the installed profile so the smoke proves the two rows
  // render distinct titles/descriptions instead of one shared label (#121).
  surface.labels =
    typeof readPluginMeta === 'function' && typeof profileContext?.dir === 'string'
      ? await read(() => {
          const base = pathToFileURL(path.join(profileContext.dir, 'cordis.yml')).href
          return Object.fromEntries(
            PRESET_SPECIFIERS.map((specifier) => [specifier, readPluginMeta(specifier, base) ?? null]),
          )
        })
      : { error: 'the host exports no readPluginMeta, so preset row labels cannot be read' }

  const commands = ctx.get('commands')
  surface.commands = commands
    ? await read(() => commands.list(undefined).map((command) => command.name))
    : { error: 'the commands service is not mounted' }

  const loader = ctx.get('loader')
  surface.tree = loader
    ? await read(() => {
        // `boot` mounts the profile behind one root include plugin; the composed
        // rows live in that include's subtree. Stay correct if the root ever
        // carries the tree directly.
        const includeRow = loader.root.data.find((row) => row && row.name === 'cordis:include')
        const tree = (includeRow && loader.store[includeRow.id]?.subtree) || loader
        const top = tree.root.data.map((row) => ({
          id: row?.id ?? null,
          name: row?.name ?? null,
          group: row?.group === true,
          disabled: row?.disabled === true,
          childIds: Array.isArray(row?.config)
            ? row.config.map((child) => (child && typeof child === 'object' && child.id !== undefined ? String(child.id) : null)).filter(Boolean)
            : [],
        }))
        const states = Object.fromEntries(Object.entries(tree.store).map(([id, entry]) => [id, entry?.fiber?.state ?? null]))
        return { top, states }
      })
    : { error: 'the loader service is not mounted' }
} finally {
  await shutdown.shutdown(0)
}

fs.writeFileSync(options.out, `${JSON.stringify(surface, null, 2)}\n`)
process.exit(0)
