// Model-driven live acceptance on the isolated authed towertest server
// (port 59002): tower_control, guard denial, and mode reporting through real
// tool calls. Requires the account overlay patch and a signed-in account.
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
const LOG = `${OUT}/model.log`
fs.writeFileSync(LOG, '')
const log = (message) => {
  const line = `[${new Date().toISOString()}] ${message}`
  fs.appendFileSync(LOG, `${line}\n`)
  console.log(line)
}

async function waitForStable(page, label, timeoutMs = 180000) {
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
  log(`timeout waiting for ${label}`)
  return page.evaluate(() => document.body.innerText)
}

async function submit(page, line) {
  const composer = page.locator('div[role="textbox"][contenteditable="true"]').first()
  await composer.waitFor({ state: 'visible', timeout: 20000 })
  await composer.click({ timeout: 20000 })
  await composer.pressSequentially(line, { delay: 10 })
  await page.waitForTimeout(400)
  await page.keyboard.press('Enter')
  log(`submitted: ${line.slice(0, 60)}`)
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

  const turns = [
    {
      id: 't1-control-enter',
      prompt:
        "Use the tower_control tool with action 'enter' and reason 'isolated live test'. Then use the tower_mode tool with empty arguments. Then report the exact tool results.",
      shot: '10-tower-control-enter.png',
    },
    {
      id: 't2-guard',
      prompt:
        "Now use the create_goal tool with objective 'live guard probe'. Report exactly what happens.",
      shot: '11-guard-create-goal.png',
    },
    {
      id: 't3-control-exit',
      prompt:
        "Use the tower_control tool with action 'exit' and reason 'live test finished'. Then use the tower_mode tool and report its mode field.",
      shot: '12-tower-control-exit.png',
    },
  ]

  for (const turn of turns) {
    await submit(page, turn.prompt)
    const text = await waitForStable(page, turn.id)
    await page.screenshot({ path: `${OUT}/${turn.shot}` })
    log(`=== ${turn.id} ===`)
    log(text.slice(Math.max(0, text.length - 2500)))
    log('')
  }

  await browser.close()
  log('closed')
})().catch((error) => {
  log(`FATAL ${error && error.stack ? error.stack : error}`)
  process.exitCode = 1
})
