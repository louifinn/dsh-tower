// Opt-in live HMR acceptance against an isolated `towertest` server.
//
// Safety: this script never edits the desktop profile, the user's live
// `$DSH_HOME` state or a live session. It drives only the tokenized URL in
// DSH_TEST_URL (the throwaway profile booted per tests/README.md), and when
// DSH_TEST_HMR_ROOT names a scratch copy *inside the OS temp directory* that
// the isolated profile watches, it appends a probe comment to one loaded file
// of that copy so the watcher has something to reload.
//
// Usage (PowerShell):
//   $env:DSH_TEST_URL='http://127.0.0.1:59001/?token=<token printed at boot>'
//   # optional, for the automatic marker edit (must be under $env:TEMP):
//   $env:DSH_TEST_HMR_ROOT="$env:TEMP\dsh-tower-hmr-copy"
//   node tests/live/hmr.cjs
//
// Missing Playwright or DSH_TEST_URL prints SKIP and exits 0. Progress,
// screenshots and the observed page text are written under tests/live/
// (hmr.log, hmr-*.png), which are gitignored.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const env = require('./_env.cjs')

const OUT = __dirname
const LOG = `${OUT}/hmr.log`
const DSH_TEST_URL = process.env.DSH_TEST_URL
const SCREENSHOT = (name) => `${OUT}/${name}.png`

fs.writeFileSync(LOG, '')
const log = (message) => {
  const line = `[${new Date().toISOString()}] ${message}`
  fs.appendFileSync(LOG, `${line}\n`)
  console.log(line)
}

function skip(reason) {
  log(`SKIP: ${reason}`)
  console.log('Live HMR acceptance needs Playwright plus the isolated server URL from tests/README.md (section 2).')
  process.exit(0)
}

if (!DSH_TEST_URL) skip('DSH_TEST_URL is not set')

let playwright
try {
  playwright = require('playwright')
} catch (error) {
  skip(`Playwright is not installed (${error && error.code ? error.code : error})`)
}
const { chromium } = playwright

function realOrNull(value) {
  try {
    return fs.realpathSync(value)
  } catch {
    return null
  }
}

function isInside(parent, child) {
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const relative = path.relative(normalize(parent), normalize(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

// Only an obvious scratch copy under the OS temp directory may be edited.
// The real repository, $DSH_HOME and anything outside temp are refused.
function scratchRoot() {
  const configured = process.env.DSH_TEST_HMR_ROOT
  if (!configured) return null
  const real = realOrNull(configured)
  if (!real) {
    log(`marker: refused, DSH_TEST_HMR_ROOT does not exist: ${configured}`)
    return null
  }
  const repo = realOrNull(path.resolve(OUT, '..', '..'))
  const home = realOrNull(env.DSH_HOME)
  if (repo && isInside(repo, real)) {
    log('marker: refused, DSH_TEST_HMR_ROOT points at the real repository')
    return null
  }
  if (home && isInside(home, real)) {
    log('marker: refused, DSH_TEST_HMR_ROOT points inside $DSH_HOME')
    return null
  }
  if (!isInside(realOrNull(os.tmpdir()), real)) {
    log('marker: refused, DSH_TEST_HMR_ROOT must be under the OS temp directory')
    return null
  }
  return real
}

// Touch a file the isolated profile actually loads when it is a copy of this
// repository, so HMR replaces a module; fall back to a plain probe file.
function touchMarker(root) {
  const probe = `dsh-tower hmr probe ${new Date().toISOString()}`
  const candidates = ['host/hmr.js', 'domain/errors.js', 'index.js']
  for (const candidate of candidates) {
    const file = path.join(root, candidate)
    if (!fs.existsSync(file)) continue
    fs.appendFileSync(file, `\n// ${probe}\n`)
    return { file, probe, reloadsModule: true }
  }
  const file = path.join(root, 'hmr-probe.txt')
  fs.writeFileSync(file, `${probe}\n`)
  return { file, probe, reloadsModule: false }
}

async function submit(page, line) {
  const composer = page.locator('div[role="textbox"][contenteditable="true"]').first()
  log(`submit:wait-composer ${line}`)
  await composer.waitFor({ state: 'visible', timeout: 15000 })
  await composer.click({ timeout: 15000 })
  await composer.pressSequentially(line, { delay: 20 })
  await page.waitForTimeout(400)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2500)
  log('submit:done')
}

async function pageText(page) {
  return page.evaluate(() => document.body.innerText)
}

;(async () => {
  const watchRoot = scratchRoot()
  log(`launch url=${DSH_TEST_URL}`)
  let browser
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: env.chromePath(),
    })
  } catch (error) {
    const firstLine = String((error && error.message) || error).split('\n')[0]
    log(`SKIP: Playwright could not launch Chromium (${firstLine})`)
    console.log('Install the browser with `npx playwright install`, or set DSH_TEST_CHROME to an executable.')
    process.exit(0)
  }
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => log(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') log(`console: ${message.text()}`)
  })

  await page.goto(DSH_TEST_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)
  await page.screenshot({ path: SCREENSHOT('40-hmr-boot') })
  log('screenshot:boot')

  // First-run preview notice is a modal with a 继续 button; dismiss it.
  const continueButton = page.getByRole('button', { name: '继续', exact: true })
  if (await continueButton.count()) {
    await continueButton.first().click({ timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(800)
    log('dismissed notice')
  }

  const newSession = page.getByText('新会话', { exact: true }).first()
  if (await newSession.count()) {
    await newSession.click({ timeout: 15000 })
    await page.waitForTimeout(2500)
    log('new-session:clicked')
  }

  // Baseline: an explicit reload with no edits must report, not crash.
  await submit(page, '/tower reload')
  await page.screenshot({ path: SCREENSHOT('41-hmr-reload') })
  log('=== /tower reload (no edits) ===')
  log((await pageText(page)).slice(-1200))

  if (watchRoot) {
    log(`marker: editing scratch copy ${watchRoot}`)
    const marker = touchMarker(watchRoot)
    log(`marker: ${marker.reloadsModule ? 'appended to loaded file' : 'wrote probe file'} ${marker.file}`)
    // Let the profile watcher debounce and reconcile, then force one explicit
    // reconcile as well (covers root: [] profiles that do not auto-watch).
    await page.waitForTimeout(2500)
    await page.screenshot({ path: SCREENSHOT('42-hmr-after-edit') })
    await submit(page, '/tower reload')
    await page.screenshot({ path: SCREENSHOT('43-hmr-reload-after-edit') })
    log('=== /tower reload (after marker edit) ===')
    log((await pageText(page)).slice(-1600))
    log('RESULT: compare 41 and 43 and the DSH server log; the log should mention reloading the changed module or a restart reason.')
  } else {
    log('marker: skipped (DSH_TEST_HMR_ROOT unset or refused)')
    const manual = [
      'MANUAL live HMR check (the automatic marker edit was skipped):',
      ' 1. Make a scratch copy of this repository under the OS temp directory:',
      '      Copy-Item -Recurse <repo-root> "$env:TEMP\\dsh-tower-hmr-copy"',
      ' 2. Point the throwaway profile at that copy (never at the desktop profile):',
      '      $env:DSH_HOME="<temp DSH_HOME for towertest>"',
      '      node scripts/enable-dev-hmr.mjs --profile towertest --root "$env:TEMP\\dsh-tower-hmr-copy"',
      ' 3. Restart the isolated server once (HMR root changes need a restart) and set',
      '    DSH_TEST_URL to the tokenized URL it prints.',
      ' 4. Re-run this script with DSH_TEST_HMR_ROOT="$env:TEMP\\dsh-tower-hmr-copy".',
      ' 5. Expected: the DSH server log shows "reload plugin at ..." after the edit or',
      '    "restart required: ..." when the change cannot be replaced in place, and',
      '    /tower reload in the page reports warnings/pending without a Host restart.',
    ]
    for (const line of manual) log(line)
    log('RESULT: explicit /tower reload is captured; the automatic edit path is documented above.')
  }

  log('close')
  await browser.close()
  log('RESULT: live HMR acceptance finished; inspect tests/live/hmr.log and hmr-*.png.')
})().catch((error) => {
  log(`FATAL ${error && error.stack ? error.stack : error}`)
  process.exitCode = 1
})
