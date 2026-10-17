// Desktop command check: exercises `/tower` (bare, repeated, off) in the real
// desktop profile through the live Web UI, with no model turn triggered.
// Run: node tests/live/desktop-command.cjs  (needs DSH_TEST_URL and Playwright)
const fs = require('node:fs')
const { chromium } = require('playwright')

const URL = process.env.DSH_TEST_URL
if (!URL) {
  console.error('Set DSH_TEST_URL to the desktop Web UI URL.')
  process.exit(1)
}
const OUT = __dirname
const LOG = `${OUT}/desktop-command.log`
fs.writeFileSync(LOG, '')
const log = (message) => {
  const line = `[${new Date().toISOString()}] ${message}`
  fs.appendFileSync(LOG, `${line}\n`)
  console.log(line)
}

async function submit(page, line) {
  const composer = page.locator('div[role="textbox"][contenteditable="true"]').first()
  await composer.waitFor({ state: 'visible', timeout: 20000 })
  await composer.click({ timeout: 20000 })
  await composer.pressSequentially(line, { delay: 20 })
  await page.waitForTimeout(400)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2500)
}

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.DSH_TEST_CHROME,
  })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.setDefaultTimeout(20000)
  page.on('pageerror', (error) => log(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') log(`console: ${message.text()}`)
  })

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  await page.screenshot({ path: `${OUT}/20-desktop-boot.png` })
  log(`title: ${await page.title()}`)

  const continueButton = page.getByRole('button', { name: '继续', exact: true })
  if (await continueButton.count()) {
    await continueButton.first().click({ timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(800)
    log('dismissed notice')
  }

  const newSession = page.getByText('新会话', { exact: true }).first()
  log(`new-session-count:${await newSession.count()}`)
  if (await newSession.count()) {
    await newSession.click({ timeout: 15000 })
    await page.waitForTimeout(2500)
  }

  const variants = [
    { line: '/tower', shot: '21-desktop-bare.png' },
    { line: '/tower', shot: '22-desktop-again.png' },
    { line: '/tower off', shot: '23-desktop-off.png' },
  ]
  for (const variant of variants) {
    await submit(page, variant.line)
    const text = await page.evaluate(() => document.body.innerText)
    await page.screenshot({ path: `${OUT}/${variant.shot}` })
    log(`=== ${variant.line} ===`)
    log(text.slice(Math.max(0, text.length - 900)))
    log('')
  }

  await browser.close()
  log('closed')
})().catch((error) => {
  log(`FATAL ${error && error.stack ? error.stack : error}`)
  process.exitCode = 1
})
