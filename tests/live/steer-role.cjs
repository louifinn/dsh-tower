// Regression: `/tower <message>` must forward a complete UserMessage.
// On 2026-10-18 the forwarded message lacked `role`, so the next model request
// failed with 422 "messages[N]: missing field `role`". After the fix the same
// command must produce a successful model turn.
const fs = require('node:fs')

const env = require('./_env.cjs')

env.announce()

const { chromium } = require('./resolve-playwright.cjs').loadOrExit().playwright

const URL = process.env.DSH_TEST_URL
if (!URL) {
  console.error('Set DSH_TEST_URL to the isolated server URL printed at boot.')
  process.exit(1)
}
const OUT = __dirname
const LOG = `${OUT}/steer-role.log`
fs.writeFileSync(LOG, '')
const log = (message) => {
  const line = `[${new Date().toISOString()}] ${message}`
  fs.appendFileSync(LOG, `${line}\n`)
  console.log(line)
}

async function waitForStable(page, timeoutMs = 180000) {
  const start = Date.now()
  let previous = -1
  let stableSince = 0
  while (Date.now() - start < timeoutMs) {
    const text = await page.evaluate(() => document.body.innerText)
    if (text.length === previous) {
      if (!stableSince) stableSince = Date.now()
      if (Date.now() - stableSince > 6000) return text
    } else {
      previous = text.length
      stableSince = 0
    }
    await page.waitForTimeout(2000)
  }
  return page.evaluate(() => document.body.innerText)
}

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.DSH_TEST_CHROME,
  })
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  page.setDefaultTimeout(20000)
  page.on('pageerror', (error) => log(`pageerror: ${error.message}`))

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(5000)
  const continueButton = page.getByRole('button', { name: '继续', exact: true })
  if (await continueButton.count()) {
    await continueButton.first().click({ timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(800)
  }
  const newSession = page.getByText('新会话', { exact: true }).first()
  if (await newSession.count()) {
    await newSession.click({ timeout: 15000 })
    await page.waitForTimeout(2500)
  }

  const composer = page.locator('div[role="textbox"][contenteditable="true"]').first()
  await composer.waitFor({ state: 'visible', timeout: 20000 })
  await composer.click()
  await composer.pressSequentially('/tower 这是一条测试消息', { delay: 15 })
  await page.waitForTimeout(4000)
  await page.screenshot({ path: `${OUT}/30-typed-not-autocomplete.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  await page.keyboard.press('Enter')
  log('submitted /tower 这是一条测试消息')

  const text = await waitForStable(page)
  await page.screenshot({ path: `${OUT}/31-steer-role-fixed.png` })
  log('=== transcript tail ===')
  log(text.slice(Math.max(0, text.length - 2000)))
  const failed = /missing field `role`|INVALID_REQUEST|Failed to deserialize/i.test(text)
  log(`role-error-present: ${failed}`)
  await browser.close()
  log('closed')
})().catch((error) => {
  log(`FATAL ${error && error.stack ? error.stack : error}`)
  process.exitCode = 1
})
