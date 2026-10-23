// Live boot smoke: prove that the reproducible live harness can drive a real,
// isolated DSH Web runtime through the resolved Playwright install.
//
//   $env:DSH_LIVE='1'
//   $env:DSH_HOME=(New-Item -ItemType Directory "$env:TEMP\dsh-live").FullName
//   $env:DSH_TEST_URL='http://127.0.0.1:59001/?token=...'
//   npm run test:live -- --script boot-smoke
//
// The first line prints the resolved DSH_HOME and the host version (#47).
// Missing DSH_TEST_URL or a browser that cannot launch is an environment gap:
// the script prints SKIP and exits 0 unless DSH_LIVE_REQUIRE=1 (the nightly CI
// job sets it so a silent skip cannot pass as evidence).
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const env = require('./_env.cjs')

env.announce()

const { loadOrExit } = require('./resolve-playwright.cjs')

const URL = process.env.DSH_TEST_URL
const REDACTED_URL = typeof URL === 'string' ? URL.replace(/token=[^&]+/, 'token=<redacted>') : URL
const REQUIRE = process.env.DSH_LIVE_REQUIRE === '1'
const OUT = __dirname
const LOG = path.join(OUT, 'boot-smoke.log')

fs.writeFileSync(LOG, '')
const log = (message) => {
  const line = `[${new Date().toISOString()}] ${message}`
  fs.appendFileSync(LOG, `${line}\n`)
  console.log(line)
}

function skip(reason) {
  log(`SKIP live boot smoke: ${reason}`)
  if (REQUIRE) {
    console.error('live boot smoke: DSH_LIVE_REQUIRE=1, so this skip is a failure.')
    process.exit(1)
  }
  process.exit(0)
}

if (!URL) {
  skip('DSH_TEST_URL is not set; boot an isolated server first (tests/README.md, section 2)')
}

const { playwright } = loadOrExit()
const { chromium } = playwright

const BENIGN_CONSOLE = [/favicon/i, /ResizeObserver loop/i, /net::ERR_ABORTED/i]

;(async () => {
  log(`launch url=${REDACTED_URL}`)
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: env.chromePath() })
  } catch (error) {
    skip(`Playwright could not launch a browser (${String((error && error.message) || error).split('\n')[0]})`)
    return
  }
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.setDefaultTimeout(15000)
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (BENIGN_CONSOLE.some((pattern) => pattern.test(text))) return
    consoleErrors.push(text)
  })

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)
  await page.screenshot({ path: path.join(OUT, 'boot-smoke.png') })
  log('screenshot:boot-smoke.png')

  const signals = await page.evaluate(() => {
    const composer = document.querySelector('div[role="textbox"][contenteditable="true"], textarea[contenteditable], [contenteditable="true"]')
    return {
      title: document.title,
      href: location.href,
      composer: composer !== null,
      newSession: document.body.innerText.includes('新会话'),
      textLength: document.body.innerText.length,
    }
  })
  log(`signals: ${JSON.stringify(signals)}`)
  await browser.close()
  log('closed')

  const failures = []
  if (pageErrors.length > 0) failures.push(`${pageErrors.length} page error(s): ${pageErrors.join(' | ').slice(0, 400)}`)
  if (consoleErrors.length > 0) failures.push(`${consoleErrors.length} console error(s): ${consoleErrors.join(' | ').slice(0, 400)}`)
  if (!signals.composer && !signals.newSession) failures.push('the page rendered neither a composer nor the new-session entry')
  if (signals.textLength === 0) failures.push('the page rendered an empty body')

  if (failures.length > 0) {
    console.error(`FAIL live boot smoke: ${failures.join('; ')}`)
    process.exit(1)
  }
  console.log(`PASS live boot smoke (title=${JSON.stringify(signals.title)}, composer=${signals.composer}, newSession=${signals.newSession})`)
})().catch((error) => {
  log(`FATAL ${error && error.stack ? error.stack : error}`)
  process.exit(1)
})
