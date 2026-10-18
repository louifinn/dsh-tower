// Opt-in live check for the optional Tower Client hint (ui-bundle/).
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
//                       fail when the `/tower` hint is not rendered; use this
//                       after installing ui-bundle into that isolated profile.
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
  if (dock.count > 0 && dock.visible === 0) failures.push('composer dock outlet is not visible')
  if (EXPECT_HINT && !hintRendered) failures.push('/tower hint not rendered (DSH_TEST_EXPECT_HINT=1)')

  if (failures.length > 0) {
    console.error(`FAIL ui-slots: ${failures.join('; ')}`)
    process.exitCode = 1
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
