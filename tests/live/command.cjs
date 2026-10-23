// Instrumented live `/tower` command acceptance against the isolated towertest
// server. Writes progress to command.log so a hung step is visible.
const fs = require('node:fs')

const env = require('./_env.cjs')

env.announce()

const { chromium } = require('./resolve-playwright.cjs').loadOrExit().playwright

const URL = process.env.DSH_TEST_URL
if (!URL) {
  console.error('Set DSH_TEST_URL to the URL printed when booting the isolated test server.')
  process.exit(1)
}
const OUT = __dirname
const LOG = `${OUT}/command.log`

fs.writeFileSync(LOG, '')
const log = (message) => {
  const line = `[${new Date().toISOString()}] ${message}`
  fs.appendFileSync(LOG, `${line}\n`)
  console.log(line)
}

async function submit(page, line) {
  const composer = page.locator('div[role="textbox"][contenteditable="true"]').first()
  log(`submit:wait-composer ${line}`)
  await composer.waitFor({ state: 'visible', timeout: 15000 })
  log('submit:click-composer')
  await composer.click({ timeout: 15000 })
  log('submit:type')
  await composer.pressSequentially(line, { delay: 20 })
  log('submit:typed')
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/typed.png` })
  log('submit:escape')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  log('submit:enter')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(3000)
  log('submit:done')
}

;(async () => {
  log('launch')
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.DSH_TEST_CHROME,
  })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => log(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') log(`console: ${message.text()}`)
  })

  log('goto')
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  log('goto:done')
  await page.waitForTimeout(5000)
  await page.screenshot({ path: `${OUT}/00-boot.png` })
  log('screenshot:boot')

  // A first-run preview notice is a modal with a 继续 button; dismiss it.
  const continueButton = page.getByRole('button', { name: '继续', exact: true })
  if (await continueButton.count()) {
    log('dismiss-notice')
    await continueButton.first().click({ timeout: 10000 })
    await page.waitForTimeout(800)
    log('dismiss-notice:done')
  }

  const newSession = page.getByText('新会话', { exact: true }).first()
  log(`new-session-count:${await newSession.count()}`)
  if (await newSession.count()) {
    await newSession.click({ timeout: 15000 })
    log('new-session:clicked')
    await page.waitForTimeout(2500)
    await page.screenshot({ path: `${OUT}/00b-new-session.png` })
    log('new-session:shot')
  }

  const variants = [
    { line: '/tower on 继续', shot: '01-on-with-message.png' },
    { line: '/tower', shot: '02-bare.png' },
    { line: '/tower off 继续', shot: '03-off-with-message.png' },
    { line: '/tower 继续', shot: '04-message-only.png' },
  ]

  for (const variant of variants) {
    await submit(page, variant.line)
    const text = await page.evaluate(() => document.body.innerText)
    await page.screenshot({ path: `${OUT}/${variant.shot}` })
    log(`=== ${variant.line} ===`)
    log(text.slice(Math.max(0, text.length - 1500)))
    log('')
  }

  log('close')
  await browser.close()
  log('closed')
})().catch((error) => {
  log(`FATAL ${error && error.stack ? error.stack : error}`)
  process.exitCode = 1
})
