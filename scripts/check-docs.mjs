// Documentation consistency check: tool names, blocker codes, error codes,
// process-local events, hand-written surface counts and local links must not
// drift from the implementation. The Chinese reference pages must cover the same
// names and state the same counts. Run: node scripts/check-docs.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVENT_COUNT, LEGACY_TOOL_EVENT_NAMES } from '../domain/events.js'
import { ERROR_CODES } from '../domain/errors.js'
import { BLOCKER_CODE_VALUES } from '../domain/shapes/blockers.js'
import { configSurface } from '../domain/config/schema.js'
import { COMPONENT_SURFACE_FILE, parseComponentSurface } from '../domain/components.js'
import { parseArgs, runMain } from './lib/cli.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = `usage: node scripts/check-docs.mjs [--root <dir>]

  --root   repository root to check (default: this package)
  --help   print this text

Checks the hand-written reference pages, the READMEs and the architecture
overview against the live registries, and verifies that relative markdown links
resolve. Fails with one line per problem.`

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g
const FENCED_CODE = /```[\s\S]*?```/g
const INLINE_CODE = /`[^`\n]*`/g

/**
 * Every relative link in the docs tree and the top-level READMEs must point at a
 * file that exists. Anchors are not resolved; external, protocol-relative,
 * root-absolute and same-page links are not repository references.
 *
 * @param {string} root repository root
 * @returns {string[]} one problem per missing target
 */
export function linkProblems(root = packageRoot) {
  const pages = []
  const docs = path.join(root, 'docs')
  if (fs.existsSync(docs)) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.md')) pages.push(full)
      }
    }
    walk(docs)
  }
  for (const name of ['README.md', 'README.en.md', 'GLOSSARY.md']) {
    if (fs.existsSync(path.join(root, name))) pages.push(path.join(root, name))
  }
  const problems = []
  for (const page of pages.sort()) {
    // Links shown as examples inside code are not references.
    const text = fs.readFileSync(page, 'utf8').replace(FENCED_CODE, '').replace(INLINE_CODE, '')
    for (const match of text.matchAll(MARKDOWN_LINK)) {
      const target = match[1]
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(target)) continue
      const [withoutAnchor] = target.split('#')
      if (!withoutAnchor) continue
      const resolved = path.resolve(path.dirname(page), withoutAnchor)
      if (!fs.existsSync(resolved)) {
        problems.push(`${path.relative(root, page)} links to missing ${target}`)
      }
    }
  }
  return problems
}

/**
 * Check one repository root. The registries are imported from this package, so a
 * fixture root may carry a copy of the documentation without duplicating the
 * implementation data the counts are compared against.
 *
 * @param {string} root repository root
 */
export function checkDocs(root = packageRoot) {
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
  const exists = (file) => fs.existsSync(path.join(root, file))

  const toolModuleSources = fs.existsSync(path.join(root, 'tools'))
    ? fs.readdirSync(path.join(root, 'tools'))
        .filter((name) => name.endsWith('.js'))
        .map((name) => read(`tools/${name}`))
        .join('\n')
    : ''
  const indexSource = read('index.js')
  const toolsSource = read('tools/index.js') + toolModuleSources + read('host/tool-registry.js') + indexSource
  const documentedTools = read('docs/reference/tools.md')
  const toolNames = [...new Set([...toolsSource.matchAll(/name: '(tower_[a-z_]+)'/g)].map((match) => match[1]))]
    .filter((name) => name !== 'tower-control')
    .sort()
  const missingTools = toolNames.filter((name) => !documentedTools.includes(`\`${name}\``))

  // #M62 W2-A: the blocker vocabulary has one registry (the same module the
  // generated reference renders from). This gate no longer greps app/tower.js or
  // carries a second list, so adding a registry entry is the only way to add a
  // documented code, and it cannot be missed here.
  const blockersSource = read('docs/reference/blockers.md')
  const blockerCodes = new Set(BLOCKER_CODE_VALUES)
  const missingBlockers = [...blockerCodes].filter((code) => !blockersSource.includes(`\`${code}\``)).sort()

  // #75: the legacy alias list comes from the same event table the generated
  // reference and the runtime use, so a renamed alias fails here first.
  const eventNames = LEGACY_TOOL_EVENT_NAMES.map((name) => name.replace(/^tower\//, ''))
  const documentedEvents = read('docs/reference/events.md')
  const missingEvents = eventNames.filter((name) => !documentedEvents.includes(`\`tower/${name}\``))

  // #M62 W2-A: import the catalogue instead of re-parsing domain/errors.js;
  // the same object feeds the generated error reference.
  const documentedErrors = read('docs/reference/errors.md')
  const errorCodes = Object.keys(ERROR_CODES).sort()
  const missingErrors = errorCodes.filter((code) => !documentedErrors.includes(`\`${code}\``))

  const packageJson = JSON.parse(read('package.json'))
  const changelog = read('CHANGELOG.md')
  const missingChangelog = !changelog.includes(`## ${packageJson.version}`)

  const problems = []
  if (missingTools.length > 0) problems.push(`docs/reference/tools.md misses tools: ${missingTools.join(', ')}`)
  if (missingBlockers.length > 0) problems.push(`docs/reference/blockers.md misses codes: ${missingBlockers.join(', ')}`)
  if (missingErrors.length > 0) problems.push(`docs/reference/errors.md misses codes: ${missingErrors.join(', ')}`)
  if (missingEvents.length > 0) problems.push(`docs/reference/events.md misses events: ${missingEvents.join(', ')}`)
  if (missingChangelog) problems.push(`CHANGELOG.md misses version ${packageJson.version}`)

  // Counts are part of the contract, not just names. The config reference and
  // its defaults are owned by scripts/check-config-reference.mjs (#M64): this
  // file must not restate config keys, because the Schemastery tree is the
  // source. The component count comes from the same surface the generated
  // component page renders.
  const toolsDoc = read('docs/reference/tools.md')
  const blockersDoc = read('docs/reference/blockers.md')
  const errorsDoc = read('docs/reference/errors.md')
  const eventsDoc = read('docs/reference/events.md')
  const config = configSurface()
  const counts = {
    tools: toolNames.length,
    errors: errorCodes.length,
    events: EVENT_COUNT,
    configKeys: config.count,
    sections: config.sections.length,
    blockers: blockerCodes.size,
    visibleComponents: parseComponentSurface(read(COMPONENT_SURFACE_FILE)).components
      .filter((component) => component.scope === 'visible').length,
  }
  if (!toolsDoc.includes(`up to ${counts.tools} tools`)) {
    problems.push(`docs/reference/tools.md must state "up to ${counts.tools} tools"`)
  }
  if (!blockersDoc.includes(`${counts.blockers} stable blocker/failure codes`)) {
    problems.push(`docs/reference/blockers.md must state ${counts.blockers} stable blocker/failure codes`)
  }
  if (!errorsDoc.includes(`${counts.errors} tool error codes`)) {
    problems.push(`docs/reference/errors.md must state ${counts.errors} tool error codes`)
  }
  if (!eventsDoc.includes(`${counts.events} process-local events`)) {
    problems.push(`docs/reference/events.md must state ${counts.events} process-local events`)
  }
  const doctorSurfaceLine = `config keys: ${counts.configKeys} · sections: ${counts.sections} · tools: ${counts.tools}`
  if (!read('docs/reference/doctor.md').includes(doctorSurfaceLine)) {
    problems.push(`docs/reference/doctor.md sample output must state "${doctorSurfaceLine}"`)
  }

  // F43: the READMEs and the architecture overview state the whole live surface
  // in one checked sentence. The checker derives every number from the registry
  // above, so it cannot drift into a second hard-coded list.
  const surfaceEn = `Surface counts (live, checked by \`npm run docs:check\`): ${counts.tools} tools, ${counts.errors} tool error codes, ${counts.events} process-local events, ${counts.configKeys} config keys, ${counts.blockers} stable blocker/failure codes, ${counts.visibleComponents} visible components.`
  const surfaceZh = `表面计数（实时，由 \`npm run docs:check\` 校验）：${counts.tools} 个工具、${counts.errors} 个工具错误码、${counts.events} 个进程内事件、${counts.configKeys} 个配置键、${counts.blockers} 个稳定 blocker/failure code、${counts.visibleComponents} 个可见组件。`
  const surfacePages = [
    ['README.md', surfaceZh],
    ['README.en.md', surfaceEn],
    ['docs/architecture/overview.md', surfaceEn],
  ]
  for (const [page, sentence] of surfacePages) {
    if (!read(page).includes(sentence)) {
      problems.push(`${page} must state the live surface counts: "${sentence}"`)
    }
  }

  // The README tool headings and their "up to N tools" sentence carry a second
  // hand-written breakdown; both must add up to the live tool count.
  const toolBreakdowns = [
    ['README.md', /^## 工具（(\d+) 个：(\d+) 个核心 \+ (\d+) 个可选）/m],
    ['README.md', /最多 (\d+) 个工具：(\d+) 个核心 \+ (\d+) 个可选/],
    ['README.en.md', /^## Tools \((\d+): (\d+) core \+ (\d+) optional\)$/m],
    ['README.en.md', /up to (\d+) tools: (\d+) core \+ (\d+) optional/],
  ]
  for (const [page, pattern] of toolBreakdowns) {
    const match = read(page).match(pattern)
    if (!match) {
      problems.push(`${page} must state the "N tools: N core + N optional" breakdown (${pattern})`)
      continue
    }
    const [total, core, optional] = match.slice(1).map(Number)
    if (total !== counts.tools || core + optional !== counts.tools) {
      problems.push(
        `${page} says ${total} tools (${core} core + ${optional} optional); the live registry has ${counts.tools}`,
      )
    }
  }

  // The architecture tree also counts the tools registered through define().
  // tower_mode is registered directly by the Host entry, so that
  // number is derived from index.js instead of being restated by hand.
  const directSessionTools = new Set(
    [...indexSource.matchAll(/recordToolRegistration\('(tower_[a-z_]+)'\)/g)].map((match) => match[1]),
  )
  const defineRegistered = toolNames.filter((name) => !directSessionTools.has(name)).length
  const overview = read('docs/architecture/overview.md')
  const defineMatch = overview.match(/\+ (\d+) define\(\)-registered tools/)
  if (!defineMatch) {
    problems.push(`docs/architecture/overview.md must state the define()-registered tool count`)
  } else if (Number(defineMatch[1]) !== defineRegistered) {
    problems.push(
      `docs/architecture/overview.md says ${defineMatch[1]} define()-registered tools; the live registry has ${defineRegistered}`,
    )
  }
  const totalMatch = overview.match(/(\d+) total/)
  if (!totalMatch || Number(totalMatch[1]) !== counts.tools) {
    problems.push(`docs/architecture/overview.md must state "${counts.tools} total" tools`)
  }

  // Chinese parity: when the translation tree exists it must cover the same
  // reference names and state the same counts, so a tool or code cannot be added
  // only in English.
  if (exists('docs/zh')) {
    const zhPages = {
      'docs/zh/README.md': null,
      'docs/zh/reference/tools.md': (text) => toolNames.filter((name) => !text.includes(`\`${name}\``)),
      'docs/zh/reference/blockers.md': (text) => [...blockerCodes].filter((code) => !text.includes(`\`${code}\``)),
      'docs/zh/reference/errors.md': (text) => errorCodes.filter((code) => !text.includes(`\`${code}\``)),
      'docs/zh/reference/events.md': (text) => eventNames.filter((name) => !text.includes(`\`tower/${name}\``)),
      'docs/zh/reference/config.md': null,
      'docs/zh/guide/hot-reload.md': null,
    }
    for (const [page, check] of Object.entries(zhPages)) {
      if (!exists(page)) {
        problems.push(`${page} is missing (Chinese docs parity)`)
        continue
      }
      if (!check) continue
      const missing = check(read(page))
      if (missing.length > 0) problems.push(`${page} misses: ${missing.join(', ')}`)
    }
    const zhCounts = [
      ['docs/zh/reference/tools.md', `最多 ${counts.tools} 个工具`],
      ['docs/zh/reference/blockers.md', `${counts.blockers} 个稳定 blocker/failure code`],
      ['docs/zh/reference/errors.md', `${counts.errors} 个工具错误码`],
      ['docs/zh/reference/events.md', `${counts.events} 个进程内事件`],
    ]
    for (const [page, phrase] of zhCounts) {
      if (exists(page) && !read(page).includes(phrase)) {
        problems.push(`${page} must state "${phrase}"`)
      }
    }
  }

  problems.push(...linkProblems(root))
  return {
    problems,
    counts,
    toolNames,
    blockerCodes: [...blockerCodes].sort(),
    errorCodes,
    eventNames,
    version: packageJson.version,
  }
}

await runMain(
  import.meta.url,
  async () => {
    const { root, help } = parseArgs(process.argv.slice(2), {
      initial: { root: packageRoot },
      values: { '--root': 'root' },
      flags: { '--help': 'help' },
    })
    if (help) {
      console.log(USAGE)
      return 0
    }
    const result = checkDocs(path.resolve(root))
    if (result.problems.length > 0) {
      console.error('documentation check failed:')
      for (const problem of result.problems) console.error(`- ${problem}`)
      return 1
    }
    console.log(
      `docs ok: ${result.toolNames.length} tools, ${result.blockerCodes.length} blocker codes, ${result.errorCodes.length} error codes, ${result.counts.events} events, ${result.counts.configKeys} config keys, ${result.counts.visibleComponents} visible components, version ${result.version}`,
    )
    return 0
  },
  { errorPrefix: 'documentation check', usage: USAGE },
)
