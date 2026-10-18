// Opt-in live check for the optional Tower Client bundle (ui-bundle/).
//
// Read-only: this script never installs anything and never opens the live
// desktop profile. Point DSH_TEST_URL at an isolated DSH Web server that you
// booted yourself (see tests/README.md, "Real Web runtime"), for example:
//
//   dsh --profile towertest --from-default-profile web --dump-config
//   dsh plugin --profile towertest add <repo-root>\ui-bundle
//   dsh --profile towertest --port 59001 --no-open
//   $env:DSH_TEST_URL='http://127.0.0.1:59001/?token=<token printed at boot>'
//   node tests/live/ui-slots.cjs
//
// Optional environment:
//   DSH_TEST_CHROME     force a browser executable (Playwright browser by default)
//   DSH_TEST_EXPECT_HINT=1
//                       require the bundle to be installed: fail when the
//                       bundle's dock entry (static hint, latest summary, or
//                       the Tower-mode chip) or the
//                       `window.__TOWER_UI_DIAG__` registration report is
//                       missing. Without it the script still passes on an
//                       empty dock (bundle not installed).
//   DSH_TEST_EXPECT_MODE=1
//                       fail when the session-bound `/tower` bind step did not
//                       produce the history-derived `Tower · on` dock chip
//                       (#11). Otherwise a missing chip is only a warning,
//                       because the bind step is best-effort across DSH UIs.
//
// When the bundle is installed, the client module exposes a read-only
// diagnostic object (window.__TOWER_UI_DIAG__) naming every slot registration
// it applied; this script asserts the toolview keys, dock id and overlay id.
// The script binds a fresh session with a bare `/tower` host command when one
// is available; once bound and the bundle is installed, the history-derived
// Tower-mode chip (`Tower · on`, #11) must be rendered in the dock.
//
// The script prints SKIP and exits 0 when DSH_TEST_URL or Playwright is
// missing, so it is safe to run in the offline CI checkout.
//
// Artifacts (gitignored): tests/live/ui-slots.png and tests/live/ui-slots.log.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const OUT = __dirname
const LOG = path.join(OUT, 'ui-slots.log')
const URL = process.env.DSH_TEST_URL
const EXPECT_HINT = process.env.DSH_TEST_EXPECT_HINT === '1'
const EXPECT_MODE = process.env.DSH_TEST_EXPECT_MODE === '1'

// Keys ui-bundle/client.js must have registered with the Chat tool-call tree.
const EXPECTED_TOOLVIEWS = [
  'tower_batch',
  'tower_complete',
  'tower_doctor',
  'tower_interrupt',
  'tower_merge',
  'tower_mission',
  'tower_preflight',
  'tower_review',
  'tower_roster',
  'tower_spawn',
  'tower_status',
  'tower_teardown',
]

function skip(reason) {
  console.log(`SKIP ui-slots: ${reason}`)
  process.exit(0)
}

if (!URL) skip('set DSH_TEST_URL to the isolated test server URL printed at boot')

let chromium
try {
  ({ chromium } = require('playwright'))
} catch (error) {
  skip(`Playwright is not installed (${error && error.message ? error.message : error})`)
}

fs.writeFileSync(LOG, '')
const log = (message) => {
  const line = `[${new Date().toISOString()}] ${message}`
  fs.appendFileSync(LOG, `${line}\n`)
  console.log(line)
}

// Console noise that is unrelated to the slot registration: an isolated
// throwaway server may log asset/stream aborts while a turn is idle.
const BENIGN_CONSOLE = [/favicon/i, /ResizeObserver loop/i, /net::ERR_ABORTED/i]

;(async () => {
  log('launch')
  let browser
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.DSH_TEST_CHROME,
    })
  } catch (error) {
    // Missing browser binaries are an environment gap, not a bundle failure:
    // keep the offline/opt-in contract and skip cleanly.
    skip(
      `cannot launch a browser (${String(error && error.message ? error.message : error).split('\n')[0]}); ` +
        'install Playwright browsers or set DSH_TEST_CHROME',
    )
  }
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.setDefaultTimeout(15000)

  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (error) => {
    pageErrors.push(error.message)
    log(`pageerror: ${error.message}`)
  })
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (BENIGN_CONSOLE.some((pattern) => pattern.test(text))) return
    consoleErrors.push(text)
    log(`console:error: ${text}`)
  })

  log(`goto ${URL}`)
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)
  await page.screenshot({ path: path.join(OUT, 'ui-slots.png') })
  log('screenshot:ui-slots.png')

  // A first-run preview notice is a modal with a 继续 button; dismiss it.
  const continueButton = page.getByRole('button', { name: '继续', exact: true })
  if (await continueButton.count()) {
    log('dismiss-notice')
    await continueButton.first().click({ timeout: 10000 })
    await page.waitForTimeout(800)
  }

  // The dock only renders for an active composer (variant=composer plus a
  // bound Session), so open a fresh Session in this throwaway profile.
  const newSession = page.getByText('新会话', { exact: true }).first()
  if (await newSession.count()) {
    log('new-session')
    await newSession.click({ timeout: 15000 })
    await page.waitForTimeout(2500)
    await page.screenshot({ path: path.join(OUT, 'ui-slots-dock.png') })
    log('screenshot:ui-slots-dock.png')
  } else {
    log('new-session:not-found (continuing with the current view)')
  }

  // On DSH 0.2.1-rc.2 a brand-new Session mounts the hero composer and the
  // session-scoped dock outlet stays hidden until a session-bound conversation
  // exists. Bind one with a host-handled command (no model turn) before probing
  // the dock; the bundle's own registration report does not depend on this.
  // The bare `/tower` command also turns Tower mode on (host semantics), which
  // is the live signal for the history-derived `Tower · on` chip (#11).
  let sessionBound = false
  try {
    const composer = page.locator('div[role="textbox"][contenteditable="true"]').first()
    await composer.waitFor({ state: 'visible', timeout: 10000 })
    await composer.click({ timeout: 10000 })
    await composer.pressSequentially('/tower', { delay: 20 })
    await page.waitForTimeout(400)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(3000)
    await page.waitForFunction(() => {
      const nodes = [...document.querySelectorAll('[data-composer-dock]')]
      return nodes.some((node) => {
        const rect = node.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
    }, { timeout: 8000 })
    sessionBound = true
    log('session-bound-by-command')
    await page.screenshot({ path: path.join(OUT, 'ui-slots-bound.png') })
    log('screenshot:ui-slots-bound.png')
  } catch (error) {
    log(`session-bind:not-confirmed (${String(error && error.message ? error.message : error).split('\n')[0]})`)
  }

  // `conversation.composer.dock` hosts a session-scoped list slot; the
  // ui-conversation Client renders its outlet as div[data-composer-dock].
  const dock = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[data-composer-dock]')]
    const visible = nodes.filter((node) => {
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
    return {
      count: nodes.length,
      visible: visible.length,
      text: nodes.map((node) => node.innerText.trim()).join('\n'),
      childCounts: nodes.map((node) => node.childElementCount),
    }
  })
  log(`dock: ${JSON.stringify(dock)}`)

  const hintRendered = dock.text.includes('/tower')
  log(`hint:/tower rendered=${hintRendered}`)

  // The bundle exposes a read-only registration report (not DOM, not Host
  // state). Present means the Client half applied; absent means the bundle is
  // not installed in this isolated profile.
  const ui = await page.evaluate(() => {
    let diag = null
    try {
      diag = window.__TOWER_UI_DIAG__ ? JSON.parse(JSON.stringify(window.__TOWER_UI_DIAG__)) : null
    } catch (error) {
      diag = { errors: [{ where: 'read-diagnostics', message: String(error) }] }
    }
    return {
      diag,
      dockHints: document.querySelectorAll('[data-tower-ui="dock-hint"]').length,
      dockSummaries: document.querySelectorAll('[data-tower-ui="dock"]').length,
      dockModes: document.querySelectorAll('[data-tower-ui="dock-mode"]').length,
      dockModesOn: document.querySelectorAll('[data-tower-ui="dock-mode"][data-tower-mode="on"]').length,
      deniedRows: document.querySelectorAll('[data-tower-denied-view]').length,
      statusStrips: document.querySelectorAll('[data-tower-ui="status-strip"]').length,
      toolviewCards: document.querySelectorAll('[data-tower-toolview]').length,
    }
  })
  log(`ui: ${JSON.stringify(ui)}`)

  await browser.close()
  log('closed')

  console.log('')
  console.log('Manual ui-bundle install/remove (isolated profile ONLY; never the desktop profile):')
  console.log('  install:')
  console.log('    dsh --profile towertest --from-default-profile web --dump-config')
  console.log('    dsh plugin --profile towertest add <absolute path to ui-bundle>')
  console.log('    dsh --profile towertest --port 59001 --no-open   # note the tokenized URL')
  console.log('    $env:DSH_TEST_URL=\'http://127.0.0.1:59001/?token=<token>\'')
  console.log('    $env:DSH_TEST_EXPECT_HINT=\'1\'; node tests/live/ui-slots.cjs')
  console.log('    # From a session in that profile, plugin_manager({action:"install_bundle",')
  console.log('    # target:"<absolute path to ui-bundle>"}) performs the same add + enable.')
  console.log('  remove:')
  console.log('    dsh plugin --profile towertest remove dsh-tower-ui')
  console.log('    # or remove the throwaway profile entirely:')
  console.log('    Remove-Item -Recurse -Force "$env:USERPROFILE\\.dsh\\profiles\\towertest"')
  console.log('')

  const failures = []
  if (pageErrors.length > 0) failures.push(`${pageErrors.length} page error(s)`)
  if (consoleErrors.length > 0) failures.push(`${consoleErrors.length} console error(s)`)
  if (dock.count === 0) failures.push('no [data-composer-dock] outlet in the page')
  if (dock.count > 0 && EXPECT_HINT && dock.visible === 0) failures.push('composer dock outlet is not visible')

  const dockEntryRendered = ui.dockHints + ui.dockSummaries + ui.dockModes > 0

  // Full registration assertions only when the bundle actually loaded.
  if (ui.diag === null) {
    if (EXPECT_HINT) {
      failures.push('Tower UI client module did not load (window.__TOWER_UI_DIAG__ missing)')
    }
  } else {
    log('tower-ui:diagnostics-present')
    if (ui.diag.applied !== true) failures.push('tower-ui diagnostics: apply() did not run')
    if (Array.isArray(ui.diag.errors) && ui.diag.errors.length > 0) {
      failures.push(`tower-ui registration error(s): ${JSON.stringify(ui.diag.errors).slice(0, 400)}`)
    }
    const toolviews = Array.isArray(ui.diag.toolviews) ? [...ui.diag.toolviews].sort() : []
    if (JSON.stringify(toolviews) !== JSON.stringify(EXPECTED_TOOLVIEWS)) {
      failures.push(`tower-ui toolview keys mismatch: ${JSON.stringify(toolviews)}`)
    }
    const slots = Array.isArray(ui.diag.slots) ? ui.diag.slots : []
    for (const required of ['tool.call.toolview', 'conversation.composer.dock', 'shell.overlay']) {
      if (!slots.some((entry) => entry && entry.slot === required)) {
        failures.push(`tower-ui missing ${required} registration`)
      }
    }
    if (!dockEntryRendered) failures.push('tower-ui dock entry did not render')
    if (ui.dockHints > 0) log('tower-ui:dock-hint-rendered')
    if (ui.dockSummaries > 0) log('tower-ui:dock-summary-rendered (conversation already has a Tower tool result)')
    if (ui.dockModes > 0) log(`tower-ui:mode-chip-rendered modeOn=${ui.dockModesOn}`)
    if (ui.deniedRows > 0) log(`tower-ui:denied-rows-rendered count=${ui.deniedRows}`)
    if (ui.statusStrips > 0) log('tower-ui:status-strip-rendered')
    // The bind step runs a bare `/tower`, which turns the Host mode on; the
    // bundle must then derive the stance from that durable command and show the
    // chip instead of the static hint (#11).
    if (sessionBound && ui.dockModesOn === 0) {
      if (EXPECT_MODE) {
        failures.push('Tower-mode chip not rendered after the /tower bind command (DSH_TEST_EXPECT_MODE=1, #11)')
      } else {
        console.warn('WARN ui-slots: Tower-mode chip not observed after the /tower bind step (set DSH_TEST_EXPECT_MODE=1 to require it)')
      }
    }
  }
  if (EXPECT_HINT && !dockEntryRendered) failures.push('bundle dock entry not rendered (DSH_TEST_EXPECT_HINT=1)')

  if (failures.length > 0) {
    console.error(`FAIL ui-slots: ${failures.join('; ')}`)
    process.exitCode = 1
    return
  }
  if (ui.diag !== null) {
    console.log('PASS ui-slots (dock present, tower-ui registrations verified, mode chip checked, no page/console errors)')
    return
  }
  if (!hintRendered) {
    console.log('PASS ui-slots (dock present, no page/console errors; hint absent — ui-bundle not installed here)')
    return
  }
  console.log('PASS ui-slots (dock present, /tower hint rendered, no page/console errors)')
})().catch((error) => {
  log(`FATAL ${error && error.stack ? error.stack : error}`)
  process.exitCode = 1
})
