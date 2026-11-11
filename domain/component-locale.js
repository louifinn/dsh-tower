// Locale and label coverage checks (W5-A).
//
// Split out of `domain/components.js` without behavior change: the visible
// component labels, the group `meta` consequence copy, and the package-local
// `meta` rows (#132/#134). `domain/components.js` re-exports them for the gate
// and the tests. Pure: no fs.
import { LOCALE_FIELDS, LOCALE_FILES } from './component-surface.js'

/**
 * Every visible component must carry `title`, `summary` and `disables` in every
 * shipped locale. The locale set itself must only name known components, so a
 * typo cannot pass as coverage.
 *
 * `options.ids` restricts the required set to the components whose labels live in
 * these locale files. #134: the `tower-ui` row ships in `ui-bundle/` and is
 * labelled by that package's own `meta` block, not by the root `components` block.
 *
 * @param {any} surface
 * @param {Record<string, any>} locales file path -> parsed locale JSON
 * @param {{ ids?: string[] }} [options]
 */
export function checkLocaleCoverage(surface, locales, options = {}) {
  const findings = []
  const record = (code, message) => findings.push({ code, level: 'error', message })
  const known = new Set(surface.components.map((component) => component.id))
  const required = options.ids === undefined ? null : new Set(options.ids)
  for (const component of surface.components) {
    if (component.scope !== 'visible') continue
    if (required && !required.has(component.id)) continue
    for (const file of LOCALE_FILES) {
      const entry = locales?.[file]?.components?.[component.id]
      if (!entry || typeof entry !== 'object') {
        record('component-locale', `visible component "${component.id}" has no entry in ${file}`)
        continue
      }
      for (const field of LOCALE_FIELDS) {
        const value = typeof entry[field] === 'string' ? entry[field].trim() : ''
        if (!value) record('component-locale', `visible component "${component.id}" misses "${field}" in ${file}`)
      }
    }
  }
  for (const file of LOCALE_FILES) {
    for (const id of Object.keys(locales?.[file]?.components ?? {})) {
      if (!known.has(id)) record('component-locale-unknown', `${file} labels "${id}", which is not a shipped component`)
    }
  }
  return findings
}

/**
 * #132: the plugin page renders a group row from the root locale `meta.title` /
 * `meta.description`. The off consequence of the `tower` group (off equals
 * uninstalling Tower) must therefore appear in `meta.description`, in every
 * shipped language — otherwise the most important consequence is dead copy.
 *
 * @param {any} surface
 * @param {Record<string, any>} locales file path -> parsed locale JSON
 */
export function checkGroupLabelCoverage(surface, locales) {
  const findings = []
  const record = (code, message) => findings.push({ code, level: 'error', message })
  for (const component of surface.components) {
    if (component.scope !== 'visible' || component.kind !== 'group') continue
    for (const file of LOCALE_FILES) {
      const meta = locales?.[file]?.meta
      const title = typeof meta?.title === 'string' ? meta.title.trim() : ''
      const description = typeof meta?.description === 'string' ? meta.description.trim() : ''
      if (!title) record('group-locale', `${file} misses meta.title for group component "${component.id}"`)
      if (!description) {
        record('group-locale', `${file} misses meta.description for group component "${component.id}"`)
        continue
      }
      const disables = locales?.[file]?.components?.[component.id]?.disables
      const consequence = typeof disables === 'string' ? disables.trim() : ''
      if (!consequence) continue
      if (!description.includes(consequence)) {
        record(
          'group-locale',
          `${file} meta.description does not state the off consequence of group component "${component.id}"`,
        )
      }
    }
  }
  return findings
}

/**
 * #134: a row that ships in its own package is labelled by that package's
 * `meta.title` / `meta.description`, and DSH shows the "when off" consequence in
 * the description. Require both meta strings and the off marker for every
 * visible row of a meta-labelled patch, in every language file it ships.
 *
 * @param {string[]} ids row ids whose labels live in `locales`
 * @param {Record<string, any>} locales file path -> parsed locale JSON
 * @param {Record<string, string>} markers language -> off-effect marker
 */
export function checkMetaLabelCoverage(ids, locales, markers) {
  const findings = []
  const record = (code, message) => findings.push({ code, level: 'error', message })
  for (const id of ids) {
    for (const [file, payload] of Object.entries(locales ?? {})) {
      const lang = /([a-z]{2})\.json$/.exec(file)?.[1] ?? ''
      const marker = markers?.[lang] ?? ''
      const title = typeof payload?.meta?.title === 'string' ? payload.meta.title.trim() : ''
      const description = typeof payload?.meta?.description === 'string' ? payload.meta.description.trim() : ''
      if (!title) record('meta-locale', `row "${id}" misses meta.title in ${file}`)
      if (!description) {
        record('meta-locale', `row "${id}" misses meta.description in ${file}`)
        continue
      }
      if (marker && !description.includes(marker)) {
        record('meta-locale', `row "${id}" meta.description does not state the off consequence in ${file}`)
      }
    }
  }
  return findings
}
